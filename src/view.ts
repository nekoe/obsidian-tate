import { Editor, ItemView, MarkdownView, Notice, Platform, Scope, TFile, WorkspaceLeaf } from 'obsidian';
import type TatePlugin from './main';
import { SyncCoordinator } from './sync/SyncCoordinator';
import { EditorElement } from './ui/EditorElement';
import { SearchPanel } from './ui/SearchPanel';
import { ParagraphVirtualizer } from './ui/ParagraphVirtualizer';
import type { ParagraphRecord, VirtualSelection } from './ui/ParagraphVirtualizer';
import { buildSegmentMap, viewToSrc } from './ui/SegmentMap';
import { TatePluginSettings } from './settings';

export const TATE_VIEW_TYPE = 'tate-vertical-writing';


export class VerticalWritingView extends ItemView {
    private editorEl: EditorElement | null = null;
    private virtualizer: ParagraphVirtualizer | null = null;
    private syncCoordinator: SyncCoordinator | null = null;
    // Last committed text written to CM6.
    // Passed to SyncCoordinator as getEditorValue() so onModify() and checkAndApplyExternalChange()
    // compare vault content against committed text, not getValue() which may contain uncommitted IME.
    private lastCommittedContent = '';
    private commitTimer: number | null = null;
    private static readonly COMMIT_DEBOUNCE_MS = 500;
    // Deferred cursor offset: set when a file is loaded while the view is not active.
    // Applied (with scroll) on the next active-leaf-change for this view.
    private pendingCursorOffset: number | null = null;
    // Paragraph index set by jumpToParagraphIndex so onThisLeafActivated (triggered by revealLeaf)
    // can restore the cursor via paragraph index instead of the ambiguous viewOffset.
    private pendingParagraphJump: number | null = null;
    // View offset passed to editorEl.loadContent() to center the initial DOM window.
    // Set before loadFile() so the SyncCoordinator callback can read it synchronously.
    private pendingLoadViewOffset = 0;
    // Monotonic counter managed by beginScrollRestoring/cancelScrollRestoring.
    // Guards cleanup rAFs: a stale rAF from a superseded load will not hide
    // the spinner that belongs to a newer load (prevents fast-switching race condition).
    private scrollRestoringGeneration = 0;
    // Spinner element shown during file load + scroll restore.
    private spinnerEl: HTMLElement | null = null;
    // Last cursor offset observed while the editor had focus (updated on every selectionchange).
    // Fallback for save paths that run while the editor is unfocused: getViewCursorOffset()
    // returns 0 when the editor lacks focus, so this field preserves the last valid offset.
    private lastKnownViewOffset: number | null = null;
    private selectionChangeRafId: number | null = null;
    // Keymap scope pushed while this view is the active leaf. Intercepts Escape before
    // Obsidian's global handler, which would otherwise switch the active leaf to a
    // navigation=true view (e.g. MarkdownView). See docs/design/20260424_esc_key_scope.md.
    private readonly escScope: Scope;
    // Tracks whether escScope is currently on the keymap stack to prevent double-push.
    // active-leaf-change and notifyActivated() can both trigger activation; the flag
    // ensures pushScope/popScope are always balanced regardless of call order.
    private escScopeActive = false;
    private searchPanel: SearchPanel | null = null;
    // Set in compositionstart when IME begins over a non-collapsed (range) selection.
    // Consumed on the first isComposing=true input event to call adjustNow() once,
    // after the browser has deleted the range and inserted the composition text.
    private needsLayoutRepairOnFirstComposingInput = false;

    constructor(leaf: WorkspaceLeaf, private readonly plugin: TatePlugin) {
        super(leaf);
        // Parent must be app.scope (the root scope) so that keys not handled by this scope
        // (e.g. Cmd-P for the command palette) fall through to the root scope's handlers.
        this.escScope = new Scope(this.app.scope);
    }

    getViewType(): string { return TATE_VIEW_TYPE; }
    getDisplayText(): string { return '縦書き'; }
    getIcon(): string { return 'tally-3'; }

    async onOpen(): Promise<void> {
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass('tate-container');

        // Inner scroll wrapper: the editor lives here so that position:absolute elements in
        // container (spinner, search panel) are anchored to the visible area rather than the
        // scrollable content area, preventing them from moving during horizontal scroll.
        const scrollArea = container.createEl('div', { cls: 'tate-scroll-area' });

        // Assign to local variables to avoid non-null assertions inside closures
        const editorEl = new EditorElement(scrollArea);
        this.editorEl = editorEl;
        editorEl.applySettings(this.plugin.settings);

        // Captured as a local variable (same pattern as editorEl) so closures below can
        // reference it without null-asserting this.virtualizer on every event.
        const virtualizer = new ParagraphVirtualizer(editorEl.el, scrollArea);
        this.virtualizer = virtualizer;
        editorEl.setVirtualizer(virtualizer);
        virtualizer.attach();

        this.searchPanel = new SearchPanel(editorEl, container, this.app, virtualizer);
        this.searchPanel.setCommitCallback(() => this.commitToCm6());

        // Toolbar button to open the outline panel (added to this view's header).
        this.addAction('tally-3', 'アウトラインパネルを開く', () => {
            void this.plugin.activateOutlineView();
        });

        const spinnerEl = container.createEl('div', { cls: 'tate-loading-spinner' });
        this.spinnerEl = spinnerEl;

        const syncCoordinator = new SyncCoordinator(
            this.app.vault,
            // Use committed text for comparison (not getValue() which may contain uncommitted IME text)
            () => this.lastCommittedContent,
            (content, preserveCursor) => {
                this.lastCommittedContent = content;
                editorEl.el.removeClass('tate-empty');
                if (preserveCursor) {
                    // External edit: show spinner, rebuild all divs, then restore cursor and scroll
                    // identical to the file-load path.
                    // Prefer lastKnownViewOffset over getViewCursorOffset(): the latter returns 0
                    // when the editor is not focused (external edit often fires while unfocused).
                    const savedOffset = this.lastKnownViewOffset ?? editorEl.getViewCursorOffset();
                    this.beginScrollRestoring();
                    editorEl.setValue(content, false);
                    this.plugin.updateCharCount(countChars(content));
                    this.plugin.refreshOutline();
                    // restoreViewOffset handles both cases:
                    //   active view  → rAF 1: scroll, rAF 2: remove class
                    //   inactive view → pendingCursorOffset set; active-leaf-change scrolls
                    this.restoreViewOffset(savedOffset);
                } else {
                    // File load or file delete: create only the initial window around the
                    // saved cursor position to avoid loading all N paragraph divs at once.
                    editorEl.loadContent(content, this.pendingLoadViewOffset);
                    this.plugin.updateCharCount(countChars(content));
                    this.plugin.refreshOutline();
                }
            },
        );
        this.syncCoordinator = syncCoordinator;

        // Intercept Escape at the Obsidian keymap scope level. Obsidian's global Escape
        // handler (registered on the window in capture phase) fires before any DOM keydown
        // listener and switches the active leaf to a navigation=true view when the current
        // view has navigation=false. Pushing this scope while the tate view is active makes
        // our handler run first; returning false causes Obsidian to call preventDefault() +
        // stopPropagation(), preventing the global handler from running.
        // IME-cancel Escape (isComposing=true) is passed through so the IME candidate window
        // can still be dismissed normally.
        this.escScope.register([], 'Escape', (evt) => {
            if (evt.isComposing) return;
            this.collapseSelectionToFocusAndScroll(editorEl, virtualizer);
            return false;
        });

        this.registerEditorDomEvents(editorEl, virtualizer);

        // Shared unload logic for all three file-unload paths:
        // file-open(null), layout-change, and vault.on('delete').
        const clearForUnload = () => {
            syncCoordinator.clearCurrentFile();
            editorEl.clearContent();
            virtualizer.initRecords([]);
            this.lastCommittedContent = '';
            this.pendingCursorOffset = null;
            this.lastKnownViewOffset = null;
            this.plugin.updateCharCount(null);
            this.plugin.refreshOutline();
            this.cancelScrollRestoring();
        };

        this.registerVaultEvents(syncCoordinator, clearForUnload);

        this.registerWorkspaceEvents(syncCoordinator, clearForUnload);

        await this.loadInitialFile(syncCoordinator);

        // If the view is already active when it opens (the common case), push the scope now.
        // Otherwise the first active-leaf-change for this leaf will push it.
        if (this.app.workspace.getActiveViewOfType(VerticalWritingView) === this) {
            this.pushEscScope();
        }
    }

    private registerEditorDomEvents(editorEl: EditorElement, virtualizer: ParagraphVirtualizer): void {
        // Registered via registerDomEvent so listeners are automatically removed on onClose

        this.registerDomEvent(editorEl.el, 'copy', (e: ClipboardEvent) => {
            editorEl.handleCopy(e); // No guardCm6: copy is read-only
        });
        this.registerDomEvent(editorEl.el, 'cut', (e: ClipboardEvent) => {
            if (!this.guardCm6(e)) return; // Block cut if CM6 is unavailable
            editorEl.handleCut(e);
            this.commitToCm6(); // Cut is an immediate commit point
            virtualizer.adjustNow(); // Repair layout: removing in-window divs shrinks scrollWidth
            this.searchPanel?.onContentChanged();
        });
        this.registerDomEvent(editorEl.el, 'paste', (e: ClipboardEvent) => {
            if (!this.guardCm6(e)) return; // Block if CM6 is unavailable
            const scrollArea = editorEl.el.parentElement!;
            const scrollWidthBefore = scrollArea.scrollWidth;
            editorEl.handlePaste(e);
            if (editorEl.cursorJumped) {
                // Cursor teleported to a distant paragraph: scroll to center it.
                editorEl.scrollCursorIntoView('center', 'center');
            } else {
                // initWindowFromLines (called inside handlePaste for multi-line paste) rebuilds
                // lSpacer with estimated widths, shifting scrollWidth and every paragraph's
                // absolute scroll coordinate by the same delta. Compensate by advancing scrollLeft
                // by that delta so the user's visual position is preserved.
                const delta = scrollArea.scrollWidth - scrollWidthBefore;
                if (delta !== 0) {
                    scrollArea.scrollLeft = Math.max(0,
                        Math.min(scrollArea.scrollWidth - scrollArea.clientWidth,
                            scrollArea.scrollLeft + delta));
                }
            }
            virtualizer.adjustNow(); // Build correct window for the (possibly updated) scrollLeft
            this.commitToCm6(); // Paste is an immediate commit point
            this.searchPanel?.onContentChanged();
        });
        this.registerDomEvent(editorEl.el, 'beforeinput', (e: InputEvent) => {
            if (!this.guardCm6(e)) return; // Block input if CM6 is unavailable (read-only)
            // VS insert: when a gap-spanning virtual selection is active and the user types or
            // presses Enter, delete the VS content first then perform the insertion.
            // Do NOT preventDefault: after deleteVirtualSelection repositions the cursor to the
            // deletion point, the browser processes the original insertText/insertParagraph event
            // at the new cursor position. The subsequent input event handles commit and search
            // panel update via the normal scheduling path.
            if (!e.isComposing && e.inputType.startsWith('insert') && virtualizer.getVirtualSelection()) {
                const vs = virtualizer.getVirtualSelection() as VirtualSelection;
                virtualizer.clearVirtualSelection();
                editorEl.deleteVirtualSelection(vs);
                // Fall through: browser inserts at new cursor, onBeforeInput (InputTransformer)
                // runs normally, then input event fires to handle commit and search updates.
            }
            if (!e.isComposing && e.inputType === 'insertParagraph' && editorEl.isInlineExpanded()) {
                e.preventDefault();
                const contentChanged = editorEl.collapseForEnter();
                if (contentChanged) this.commitToCm6();
                return;
            }
            // For non-collapsed selection deletion, bypass Chrome's contenteditable
            // processing (undo recording, NBSP injection, column layout recompute)
            // and use range.deleteContents() directly. This eliminates the O(N) slowness
            // and memory spike observed between beforeinput and input for multi-line
            // selections. Collapsed-cursor single-char deletion is left to the browser.
            if (editorEl.handleSelectionDelete(e)) {
                e.preventDefault();
                editorEl.normalizeEmptyDom();
                virtualizer.adjustNow(); // Repair layout: removing in-window divs shrinks scrollWidth
                this.scheduleCommit();
                this.searchPanel?.onContentChanged();
                return;
            }
            editorEl.onBeforeInput(e);
            // InputTransformer may call e.preventDefault() and perform direct DOM mutations
            // (e.g. half→full-width space conversion, auto-indent, bracket de-indent).
            // When default is prevented the browser cancels the corresponding input event,
            // so scheduleCommit() would never be called. Schedule it here instead.
            if (e.defaultPrevented && e.inputType === 'insertText' && !e.isComposing) {
                virtualizer.adjustNow(); // Repair layout after InputTransformer's direct DOM mutation
                this.scheduleCommit();
            }
        });
        this.registerDomEvent(editorEl.el, 'input', (e: Event) => {
            const inputEvent = e as InputEvent;
            // Skip during IME composition: normalizeEmptyDom resets the cursor, which would
            // interrupt the ongoing composition and misplace the candidate text.
            if (!inputEvent.isComposing) editorEl.normalizeEmptyDom();
            // Repair layout on the first composing input when IME started over a range selection.
            // The browser deletes the range and inserts composition text in this event, potentially
            // removing in-window divs; adjustNow restores the window to cover the viewport.
            if (inputEvent.isComposing && this.needsLayoutRepairOnFirstComposingInput) {
                virtualizer.adjustNow();
                this.needsLayoutRepairOnFirstComposingInput = false;
            }
            if (!inputEvent.isComposing) {
                if (inputEvent.inputType === 'insertParagraph') {
                    // Enter: commit before adjustNow so that syncRecordsFromDom() inside
                    // commitToCm6() reconciles domEnd with the new div BEFORE
                    // adjustWindowOnScroll() runs premeasureWindowWidths(). Without this
                    // ordering, premeasureWindowWidths() reads widths at shifted positions
                    // (the new empty div displaces existing divs) and shrinkLeft() may
                    // target the wrong div.
                    editorEl.handleParagraphInsert();
                    this.commitToCm6(); // syncRecordsFromDom runs inside; domEnd reconciled
                    virtualizer.adjustNow(); // safe: DOM and domEnd are consistent
                    this.searchPanel?.onContentChanged();
                    return;
                }
                // Repair layout in case the browser deleted in-window divs before inserting
                // (e.g. insertText with a non-collapsed selection).
                virtualizer.adjustNow();
                const annotated = editorEl.handleRubyCompletion()
                               || editorEl.handleTcyCompletion()
                               || editorEl.handleBoutenCompletion()
                               || editorEl.handleHeadingCompletion();
                if (annotated) {
                    this.commitToCm6(); // Notation conversion is an immediate commit point
                    this.searchPanel?.onContentChanged();
                } else if (inputEvent.inputType === 'deleteByCut') {
                    // Chrome's native cut-line behavior (collapsed cursor + Ctrl+X) fires
                    // this event AFTER the cut event handler (and its commitToCm6) already
                    // ran with the unchanged DOM. The div is removed by the browser after
                    // the cut event, so commitToCm6 must be called again here.
                    editorEl.cleanupEmptyParagraphDivs();
                    this.commitToCm6();
                    this.searchPanel?.onContentChanged();
                } else if (inputEvent.inputType === 'insertText'
                        || inputEvent.inputType.startsWith('deleteContent')) {
                    this.scheduleCommit(); // Debounced commit for plain typing and deletion
                    this.searchPanel?.onContentChanged();
                }
                editorEl.handleCursorAnchorInput(); // Manage U+200B placeholder in cursor anchor span
            }
        });
        this.registerDomEvent(editorEl.el, 'compositionstart', () => {
            if (!this.getCm6Editor()) return; // read-only mode, skip indent
            // If a gap-spanning VS is active, delete its content before IME composition begins.
            // compositionstart fires before the browser deletes the DOM proxy selection, so this
            // ensures off-window paragraphs in the VS are also removed.
            const vs = virtualizer.getVirtualSelection();
            if (vs) {
                virtualizer.clearVirtualSelection();
                editorEl.deleteVirtualSelection(vs);
            } else {
                // No VS: if a range selection exists, the browser will delete it and insert
                // composition text in the first isComposing input event — AFTER compositionstart.
                // Set a flag so that first input event calls adjustNow() to repair the layout.
                // The VS branch already gets adjustNow via deleteVirtualSelection → scrollCursorIntoView.
                const sel = window.getSelection();
                this.needsLayoutRepairOnFirstComposingInput = !!sel && !sel.isCollapsed;
            }
            editorEl.onCompositionStart();
        });
        this.registerDomEvent(editorEl.el, 'compositionend', (e: CompositionEvent) => {
            editorEl.handleRubyCompletion();
            editorEl.handleTcyCompletion();
            editorEl.handleBoutenCompletion();
            editorEl.handleHeadingCompletion();
            editorEl.onCompositionEnd(e); // bracket de-indent for IME input
            editorEl.handleCursorAnchorInput(); // Manage U+200B placeholder after IME input
            editorEl.handlePostCollapseInput(); // Move IME text out of post-collapse annotation element
            this.commitToCm6(); // IME confirmation is a commit point
            this.searchPanel?.onContentChanged();
        });
        this.registerDomEvent(activeDocument, 'selectionchange', () => {
            // Ensure the cursor paragraph and its neighbors are in the DOM window / thawed.
            if (activeDocument.activeElement === editorEl.el) virtualizer.ensureWindowAroundCursor();
            const contentChanged = editorEl.handleSelectionChange();
            if (contentChanged) this.commitToCm6(); // Commit only if collapse changed content
            // VS tracking: update focus when the user extends/shrinks a gap-spanning selection
            // via Shift+Arrow or mouse drag. Skip programmatic updates to avoid re-entry loops.
            if (activeDocument.activeElement === editorEl.el && !virtualizer.isSyncingSelection) {
                const sel = window.getSelection();
                if (sel) {
                    const vs = virtualizer.getVirtualSelection();
                    if (vs) {
                        if (sel.isCollapsed) {
                            virtualizer.clearVirtualSelection();
                        } else {
                            const changed = virtualizer.tryUpdateFocusFromDom(sel);
                            if (changed) {
                                virtualizer.syncDomRangeToVirtual();
                                virtualizer.scrollFocusIntoView();
                            }
                        }
                    } else if (!sel.isCollapsed && virtualizer.tryInitVsFromDomSelection(sel)) {
                        // DOM selection crosses an anchor island: initialize VS so that
                        // copy/cut use the VS-aware code path (correct paragraph range)
                        // rather than cloneContents() which includes spacer divs.
                        virtualizer.syncDomRangeToVirtual();
                    }
                }
            }
            // Track the cursor offset while the editor has focus so it can be restored after
            // focus() resets the caret on view re-activation.
            // Multiple selectionchange events can fire in a single frame (e.g. auto-indent inserts
            // text via insertText(), triggering one event per DOM mutation). Debounce with rAF so
            // only the final cursor position per frame is captured, avoiding redundant O(N) scans.
            if (activeDocument.activeElement === editorEl.el && !editorEl.isInlineExpanded()) {
                if (this.selectionChangeRafId !== null) window.cancelAnimationFrame(this.selectionChangeRafId);
                this.selectionChangeRafId = window.requestAnimationFrame(() => {
                    this.selectionChangeRafId = null;
                    if (activeDocument.activeElement === editorEl.el && !editorEl.isInlineExpanded()) {
                        this.lastKnownViewOffset = editorEl.getViewCursorOffset();
                    }
                });
            }
        });
        this.registerDomEvent(editorEl.el, 'mousedown', () => {
            this.commitToCm6(); // Click ends a burst = commit point
            virtualizer.clearVirtualSelection();
            editorEl.afterNavigation();
        });
        this.registerDomEvent(editorEl.el, 'keydown', (e: KeyboardEvent) => {
            this.handleEditorKeyDown(e, editorEl, virtualizer);
        });
    }

    // Dispatches a keydown on the editor to the specialized handlers below.
    // Each handler returns true when it consumes the event (no further handling needed).
    private handleEditorKeyDown(
        e: KeyboardEvent, editorEl: EditorElement, virtualizer: ParagraphVirtualizer,
    ): void {
        this.deleteVirtualSelectionOnPrintableKey(e, editorEl, virtualizer);
        if (this.handleUndoRedoKey(e, editorEl)) return;
        if (this.handleSelectAllKey(e, virtualizer)) return;
        if (this.handleDocumentBoundaryKey(e, editorEl, virtualizer)) return;
        this.handleArrowAndNavigationKeys(e, editorEl, virtualizer);
    }

    // Deletes VS content on printable key press before compositionstart fires.
    // The browser establishes the IME anchor when it passes the key to the IME engine,
    // which happens AFTER keydown handlers complete but BEFORE compositionstart fires.
    // Deleting VS here (rather than in compositionstart) ensures the cursor is already
    // at (si, so) when the IME records its anchor, so composition text lands correctly.
    // Does not consume the event: subsequent beforeinput/compositionstart proceed normally.
    private deleteVirtualSelectionOnPrintableKey(
        e: KeyboardEvent, editorEl: EditorElement, virtualizer: ParagraphVirtualizer,
    ): void {
        if (!e.isComposing && !e.metaKey && !e.ctrlKey && e.key.length === 1
                && virtualizer.getVirtualSelection()) {
            const vs = virtualizer.getVirtualSelection() as VirtualSelection;
            virtualizer.clearVirtualSelection();
            editorEl.deleteVirtualSelection(vs);
        }
    }

    // Ctrl+Z / Cmd+Z: Undo,  Ctrl+Shift+Z / Cmd+Shift+Z: Redo.
    private handleUndoRedoKey(e: KeyboardEvent, editorEl: EditorElement): boolean {
        if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key === 'z') {
            e.preventDefault();
            this.doUndoRedo(editorEl, e.shiftKey);
            return true;
        }
        return false;
    }

    // Cmd-A / Ctrl-A: initialize a VirtualSelection spanning the entire activeDocument.
    // The DOM Range is set to proxy positions (window boundaries) so native ::selection
    // highlights all in-window paragraphs; no full DOM expansion is required.
    private handleSelectAllKey(e: KeyboardEvent, virtualizer: ParagraphVirtualizer): boolean {
        if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === 'a') {
            e.preventDefault();
            if (virtualizer.paragraphRecords.length > 0) virtualizer.setVirtualSelectAll();
            return true;
        }
        return false;
    }

    // Cmd+↑/↓ (macOS) / Ctrl+Home/End (Windows/Linux): jump or extend selection to document boundary.
    // Without Shift: collapse cursor to start/end. With Shift: extend selection from anchor.
    private handleDocumentBoundaryKey(
        e: KeyboardEvent, editorEl: EditorElement, virtualizer: ParagraphVirtualizer,
    ): boolean {
        if (e.isComposing || e.altKey) return false;
        const toStart = Platform.isMacOS
            ? e.metaKey && e.key === 'ArrowUp'
            : e.ctrlKey && e.key === 'Home';
        const toEnd = Platform.isMacOS
            ? e.metaKey && e.key === 'ArrowDown'
            : e.ctrlKey && e.key === 'End';
        if (!toStart && !toEnd) return false;
        e.preventDefault();
        if (this.commitTimer !== null) this.commitToCm6();
        if (e.shiftKey) {
            virtualizer.extendSelectionToDocumentBoundary(toStart);
        } else {
            virtualizer.clearVirtualSelection();
            if (toStart) {
                this.jumpToViewOffset(0);
            } else {
                const totalLen = virtualizer.paragraphRecords.reduce((sum, r) => sum + r.viewLen, 0);
                this.jumpToViewOffset(totalLen);
            }
        }
        editorEl.afterNavigation();
        return true;
    }

    // Handles arrow keys inside a tcy span and plain navigation keys (arrows + Home/End/PageUp/Down).
    private handleArrowAndNavigationKeys(
        e: KeyboardEvent, editorEl: EditorElement, virtualizer: ParagraphVirtualizer,
    ): void {
        // Arrow keys inside a tcy span.
        // ArrowUp/Down: move within the horizontal TCY text (or escape with Shift).
        // ArrowLeft/Right: escape the span entirely to prevent the bounce-back loop.
        if (!e.isComposing && (e.key === 'ArrowUp' || e.key === 'ArrowDown' ||
                e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
            if (editorEl.handleTcyNavigation(e.key, e.shiftKey)) {
                e.preventDefault();
                if (!e.shiftKey) {
                    if (this.commitTimer !== null) this.commitToCm6();
                    editorEl.afterNavigation();
                    return;
                }
                // Shift: fall through to the navigation-keys block for notifyNavigationKey etc.
            }
        }
        // Navigation keys are commit points only when there are uncommitted changes
        // (commitTimer !== null means the debounce is running). Skipping the commit
        // when nothing is pending avoids an O(N) getValue() call on every keypress.
        // Skip while isComposing=true (user is selecting IME candidates)
        if (!e.isComposing && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
             'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
            editorEl.notifyNavigationKey(e.key);
            // Without Shift: the selection is being moved (not extended), so any
            // gap-spanning VS is no longer relevant. Clear it so the next selectionchange
            // does not try to re-sync the DOM Range to stale VS endpoints.
            if (!e.shiftKey) {
                if (this.collapseVirtualSelectionWithArrow(e, editorEl, virtualizer)) return;
                virtualizer.clearVirtualSelection();
            }
            if (this.commitTimer !== null) this.commitToCm6();
            editorEl.afterNavigation();
        }
    }

    // When VS is active and an Arrow key collapses the selection, the browser collapses to the
    // anchor PROXY (a window-boundary div), which triggers adjustWindowOnScroll to expand the
    // DOM window toward the real anchor. Intercept and explicitly jump to the correct VS endpoint.
    // Cmd+Up/Down are handled earlier (extendSelectionToDocumentBoundary) and return early, so
    // only Cmd+Left/Right can reach here with metaKey set.
    // Returns true if the key was consumed (a VS-aware jump was performed).
    private collapseVirtualSelectionWithArrow(
        e: KeyboardEvent, editorEl: EditorElement, virtualizer: ParagraphVirtualizer,
    ): boolean {
        const vs = !e.altKey && !e.ctrlKey &&
            (!e.metaKey || e.key === 'ArrowLeft' || e.key === 'ArrowRight')
            ? virtualizer.getVirtualSelection() : null;
        if (!vs || !(e.key === 'ArrowLeft' || e.key === 'ArrowRight' ||
                     e.key === 'ArrowUp'   || e.key === 'ArrowDown')) return false;
        e.preventDefault();
        // vertical-rl: ArrowLeft/ArrowDown moves toward later paragraphs (end).
        //              ArrowRight/ArrowUp moves toward earlier paragraphs (start).
        const towardEnd = e.key === 'ArrowLeft' || e.key === 'ArrowDown';
        const anchorIsEnd = vs.anchorParaIdx > vs.focusParaIdx ||
            (vs.anchorParaIdx === vs.focusParaIdx &&
             vs.anchorViewOff >= vs.focusViewOff);
        // Collapse toward the end of the selection (whichever endpoint is "more
        // in the direction of movement"), matching standard browser behavior.
        const useAnchor = towardEnd ? anchorIsEnd : !anchorIsEnd;
        const paraIdx = useAnchor ? vs.anchorParaIdx : vs.focusParaIdx;
        const viewOff = useAnchor ? vs.anchorViewOff : vs.focusViewOff;
        virtualizer.clearVirtualSelection();
        if (this.commitTimer !== null) this.commitToCm6();
        const abs = virtualizer.paragraphRecords
            .slice(0, paraIdx).reduce((s, r) => s + r.viewLen, 0) + viewOff;
        this.jumpToViewOffset(abs);
        editorEl.afterNavigation();
        return true;
    }

    private registerVaultEvents(syncCoordinator: SyncCoordinator, clearForUnload: () => void): void {
        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                if (file instanceof TFile) {
                    void syncCoordinator.onModify(file);
                }
            })
        );
        this.registerEvent(
            this.app.vault.on('delete', (file) => {
                if (!(file instanceof TFile)) return;
                void this.plugin.deleteCursorPosition(file.path);
                if (file === syncCoordinator.currentFile) clearForUnload();
            })
        );
        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                if (file instanceof TFile) {
                    this.plugin.renameCursorPosition(oldPath, file.path);
                    syncCoordinator.onFileRename(file, oldPath);
                }
            })
        );
    }

    private registerWorkspaceEvents(syncCoordinator: SyncCoordinator, clearForUnload: () => void): void {
        // file-open detects file switches more reliably than active-leaf-change
        this.registerEvent(
            this.app.workspace.on('file-open', (file) => {
                if (file === syncCoordinator.currentFile) return;
                // Close search panel when the file changes
                this.closeSearch();
                if (!file) {
                    // file-open fires with null when the active file is cleared (e.g., the active
                    // Markdown view is closed while the tate view is not the active leaf).
                    // Save cursor before clearing (symmetric with the layout-change path).
                    if (syncCoordinator.currentFile && this.lastKnownViewOffset !== null) {
                        void this.plugin.saveCursorPosition(
                            syncCoordinator.currentFile.path,
                            this.lastKnownViewOffset,
                        );
                    }
                    clearForUnload();
                    return;
                }
                // Save cursor for the file being switched away from before loading the new one.
                // currentFile is captured before loadFile() changes it.
                const prevFile = syncCoordinator.currentFile;
                if (prevFile && this.lastKnownViewOffset !== null) {
                    void this.plugin.saveCursorPosition(prevFile.path, this.lastKnownViewOffset);
                }
                void (async () => {
                    const savedOffset = this.plugin.getCursorPosition(file.path);
                    this.pendingLoadViewOffset = savedOffset ?? 0;
                    const gen = this.beginScrollRestoring();
                    await syncCoordinator.loadFile(file);
                    if (syncCoordinator.currentFile !== file) {
                        this.scheduleScrollRestoringCleanup(gen);
                        return;
                    }
                    this.lastKnownViewOffset = null;
                    this.restoreViewOffset(savedOffset ?? 0);
                })();
            })
        );

        // layout-change fires when a tab is closed. Clears the view if the Markdown view
        // for currentFile is gone and the tate view is active (file-open does not fire in that case).
        this.registerEvent(
            this.app.workspace.on('layout-change', () => {
                if (!syncCoordinator.currentFile) return;
                const stillOpen = this.app.workspace.getLeavesOfType('markdown').some(leaf => {
                    const mv = leaf.view;
                    return mv instanceof MarkdownView && mv.file === syncCoordinator.currentFile;
                });
                if (!stillOpen) {
                    // Save cursor before clearing (layout-change is the last chance for this file).
                    if (this.lastKnownViewOffset !== null) {
                        void this.plugin.saveCursorPosition(
                            syncCoordinator.currentFile.path,
                            this.lastKnownViewOffset,
                        );
                    }
                    clearForUnload();
                }
            })
        );

        this.registerEvent(
            this.app.workspace.on('active-leaf-change', (leaf) => {
                if (leaf === null) return; // transient null during Obsidian internal navigation
                if (leaf === this.leaf) {
                    this.onThisLeafActivated();
                } else {
                    this.popEscScope();
                    if (!this.app.workspace.getLeavesOfType(TATE_VIEW_TYPE).includes(leaf)) {
                        // Hide only when the newly active leaf is not any tate view
                        this.plugin.updateCharCount(null);
                    }
                }
            })
        );
    }

    private async loadInitialFile(syncCoordinator: SyncCoordinator): Promise<void> {
        // Use the file that was active just before the vertical writing view was opened
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
            const savedOffset = this.plugin.getCursorPosition(activeFile.path);
            this.pendingLoadViewOffset = savedOffset ?? 0;
            const gen = this.beginScrollRestoring();
            await syncCoordinator.loadFile(activeFile);
            if (syncCoordinator.currentFile !== activeFile) {
                this.scheduleScrollRestoringCleanup(gen);
                return;
            }
            this.lastKnownViewOffset = null;
            this.restoreViewOffset(savedOffset ?? 0);
            return;
        }
        // If no active file, fall back to the first file in an open Markdown view
        for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
            if (leaf.view instanceof MarkdownView && leaf.view.file) {
                const file = leaf.view.file;
                const savedOffset = this.plugin.getCursorPosition(file.path);
                this.pendingLoadViewOffset = savedOffset ?? 0;
                const gen = this.beginScrollRestoring();
                await syncCoordinator.loadFile(file);
                if (syncCoordinator.currentFile !== file) {
                    this.scheduleScrollRestoringCleanup(gen);
                    return;
                }
                this.lastKnownViewOffset = null;
                this.restoreViewOffset(savedOffset ?? 0);
                return;
            }
        }
    }

    /** Saves the current cursor position. Returns null if there is nothing to save.
     *  Used by both onClose() and the workspace quit handler. */
    saveCursorForQuit(): Promise<void> | null {
        const file = this.syncCoordinator?.currentFile;
        const el = this.editorEl;
        if (!file) return null;
        // When inline expanded, getViewCursorOffset() would return an offset inside the raw
        // editing span, which does not map to a valid collapsed view offset. Fall back to
        // lastKnownViewOffset (captured just before the expansion triggered) in that case.
        const offset = (el && activeDocument.activeElement === el.el && !el.isInlineExpanded())
            ? el.getViewCursorOffset()
            : this.lastKnownViewOffset;
        if (offset === null) return null;
        return this.plugin.saveCursorPosition(file.path, offset);
    }

    /** Restores a saved view offset. If the view is currently active, focuses the editor,
     *  sets the cursor, and scrolls into view. Otherwise defers to the next
     *  active-leaf-change event via pendingCursorOffset.
     *
     *  scrollCursorIntoView is deferred one rAF so it runs after Obsidian's view-activation
     *  logic (focus resets, revealLeaf, etc.) completes. */
    private restoreViewOffset(savedOffset: number): void {
        const el = this.editorEl;
        if (!el) return;
        if (this.app.workspace.getActiveViewOfType(VerticalWritingView) === this) {
            el.el.focus({ preventScroll: true });
            el.setViewCursorOffset(savedOffset);
            // Sync update: if active-leaf-change's focus() fires before the rAF below and
            // resets the caret, the else-if branch will re-set it via lastKnownViewOffset.
            this.lastKnownViewOffset = savedOffset;
            const gen = this.scrollRestoringGeneration; // snapshot for rAF guard
            window.requestAnimationFrame(() => {
                if (this.scrollRestoringGeneration !== gen) return; // newer load superseded this one
                // Hide spinner before scroll so it disappears at the same time content is revealed.
                this.hideLoadingSpinner();
                // Re-assert cursor in case focus() moved it between now and this frame.
                el.setViewCursorOffset(savedOffset);
                el.scrollCursorIntoView();
            });
        } else {
            // View is not yet active; active-leaf-change will apply cursor + scroll.
            this.pendingCursorOffset = savedOffset;
        }
    }

    async onClose(): Promise<void> {
        this.searchPanel?.close();
        this.searchPanel?.destroy();
        this.popEscScope();
        if (this.selectionChangeRafId !== null) {
            window.cancelAnimationFrame(this.selectionChangeRafId);
            this.selectionChangeRafId = null;
        }
        // Flush any uncommitted changes to CM6 before closing
        this.commitToCm6();
        const p = this.saveCursorForQuit();
        if (p) await p;
        this.syncCoordinator?.dispose();
        this.syncCoordinator = null;
        this.virtualizer?.detach();
        this.virtualizer = null;
        this.editorEl = null;
        this.lastCommittedContent = '';
        this.spinnerEl = null; // DOM is destroyed by Obsidian; clear reference
        if (!this.app.workspace.getActiveViewOfType(VerticalWritingView)) {
            this.plugin.updateCharCount(null);
        }
        // Clear the outline if this was the last open tate view.
        const remainingTateViews = this.app.workspace.getLeavesOfType(TATE_VIEW_TYPE)
            .filter(leaf => leaf.view !== this);
        if (remainingTateViews.length === 0) {
            this.plugin.clearOutline();
        }
    }

    private showLoadingSpinner(): void {
        this.spinnerEl?.classList.add('tate-loading-visible');
    }

    private hideLoadingSpinner(): void {
        this.spinnerEl?.classList.remove('tate-loading-visible');
    }

    /** Starts a file-load cycle: increments the generation counter and shows the spinner.
     *  Returns the generation number for use in rAF guards. */
    private beginScrollRestoring(): number {
        const gen = ++this.scrollRestoringGeneration;
        this.showLoadingSpinner();
        return gen;
    }

    /** Schedules a one-rAF cleanup for the load cycle identified by gen.
     *  Used when no scroll is needed (no savedOffset or superseded load). */
    private scheduleScrollRestoringCleanup(gen: number): void {
        window.requestAnimationFrame(() => {
            if (this.scrollRestoringGeneration === gen) {
                this.hideLoadingSpinner();
            }
        });
    }

    /** Cancels an in-flight load cycle immediately (synchronous, no rAF).
     *  Increments the generation to invalidate any pending cleanup rAFs. */
    private cancelScrollRestoring(): void {
        ++this.scrollRestoringGeneration;
        this.hideLoadingSpinner();
    }

    applySettings(settings: TatePluginSettings): void {
        this.editorEl?.applySettings(settings);
    }

    private pushEscScope(): void {
        if (this.escScopeActive) return;
        this.app.keymap.pushScope(this.escScope);
        this.escScopeActive = true;
    }

    private popEscScope(): void {
        if (!this.escScopeActive) return;
        this.app.keymap.popScope(this.escScope);
        this.escScopeActive = false;
    }

    // Body of the "this leaf became active" branch, shared between active-leaf-change
    // and notifyActivated() (called when revealLeaf doesn't fire active-leaf-change).
    private onThisLeafActivated(): void {
        this.pushEscScope();
        this.plugin.updateCharCount(countChars(this.lastCommittedContent));
        const el = this.editorEl;
        if (el) {
            if (this.pendingCursorOffset !== null) {
                // New file was loaded in the background: restore the saved offset and scroll.
                // focus() is called first so the caret can be placed immediately after.
                // Defer hide + scroll to rAF 1 so the spinner is visible on the first
                // paint when the tab becomes active (matches restoreViewOffset active path).
                el.el.focus({ preventScroll: true });
                const gen = this.scrollRestoringGeneration; // snapshot for rAF guard
                const offset = this.pendingCursorOffset;
                this.pendingCursorOffset = null;
                el.setViewCursorOffset(offset);
                this.lastKnownViewOffset = offset; // sync update
                window.requestAnimationFrame(() => {
                    if (this.scrollRestoringGeneration !== gen) return;
                    // Hide spinner before scroll so it disappears at the same time content is revealed.
                    this.hideLoadingSpinner();
                    // Re-assert cursor in case focus() moved it between now and this frame.
                    el.setViewCursorOffset(offset);
                    el.scrollCursorIntoView();
                });
            } else if (this.pendingParagraphJump !== null) {
                // Outline jump: revealLeaf triggered active-leaf-change before the safety-clear
                // rAF fired. Restore by paragraph index to avoid the viewOffset boundary ambiguity.
                // Do NOT call checkAndApplyExternalChange() here: jumpToParagraphIndex already
                // committed any pending changes to CM6, and the vault may not have been written yet
                // (CM6 autosave is async). Calling it would see vault < editor and overwrite our
                // just-committed content, creating a spurious CM6 history entry and causing Undo cycles.
                // External file changes are handled in real-time by onModify, so no check is needed.
                el.el.focus({ preventScroll: true });
                const idx = this.pendingParagraphJump;
                this.pendingParagraphJump = null;
                el.setViewCursorToParagraphIndex(idx);
                this.lastKnownViewOffset = el.getViewCursorOffset();
            } else {
                // Normal tab switch: preserve the scroll position exactly as the user left it.
                // focus() is intentionally skipped — calling it restores the browser's last
                // selection (which may be a VS proxy), triggering unwanted scroll.  The caret
                // is lost until the user clicks or types, which is an acceptable trade-off for
                // keeping the viewport stable.
                // Clear any active VS so anchor island divs are removed from the DOM before
                // checkAndApplyExternalChange() may rebuild it.
                this.virtualizer?.clearVirtualSelection();
                void this.syncCoordinator?.checkAndApplyExternalChange();
            }
        }
    }

    /** Called by activateView() when revealLeaf doesn't trigger active-leaf-change.
     *  Idempotent: pushEscScope() is guarded by escScopeActive, so calling this
     *  and then receiving a genuine active-leaf-change is safe. */
    notifyActivated(): void {
        this.onThisLeafActivated();
    }

    openSearch(): void { this.openSearchPanel(false); }
    openReplace(): void { this.openSearchPanel(true); }

    private openSearchPanel(expandReplace: boolean): void {
        const el = this.editorEl;
        if (!el || !this.searchPanel) return;

        // If an inline element is expanded, collapse it before opening search
        if (el.isInlineExpanded()) {
            const contentChanged = el.collapseForEnter();
            if (contentChanged) this.commitToCm6();
        }

        const offset = el.getViewCursorOffset();
        this.searchPanel.open(offset, expandReplace);
    }

    private closeSearch(): void {
        if (!this.searchPanel) return;
        // close() restores the cursor and focuses the editor; we only need to sync
        // lastKnownViewOffset so tab-switch restore uses the post-search position.
        const restoreOffset = this.searchPanel.close();
        if (restoreOffset !== null) {
            this.lastKnownViewOffset = restoreOffset;
        }
    }

    applyRuby(): void {
        if (!this.editorEl) return;
        if (this.virtualizer?.getVirtualSelection() || this.editorEl.selectionSpansMultipleParagraphs()) {
            new Notice('選択範囲が広すぎます。テキストを選択し直してください');
            return;
        }
        if (this.editorEl.hasAnnotationInSelection()) {
            new Notice('選択範囲に既存の青空記法が含まれています');
            return;
        }
        if (!this.editorEl.wrapSelectionWithRuby()) {
            new Notice('テキストを選択してください');
        }
        // Ruby enters inline-expand state; commitToCm6 is called when collapseEditing completes
    }
    applyTcy(): void    { this.applyAnnotation(el => el.wrapSelectionWithTcy()); }
    applyBouten(): void { this.applyAnnotation(el => el.wrapSelectionWithBouten()); }

    applyHeading(level: 'large' | 'mid' | 'small'): void {
        this.applyAnnotation(el => el.applyHeading(level));
    }

    removeAnnotations(): void {
        if (!this.editorEl) return;
        if (!this.editorEl.removeAnnotationsInSelection()) {
            new Notice('青空記法が見つかりません');
        } else {
            this.commitToCm6();
            this.searchPanel?.onContentChanged();
        }
    }

    /** Moves the editor cursor to viewOffset and scrolls it into view. Used by OutlineView. */
    jumpToViewOffset(offset: number): void {
        const el = this.editorEl;
        if (!el) return;
        el.el.focus({ preventScroll: true });
        el.setViewCursorOffset(offset);
        this.lastKnownViewOffset = offset;
        el.scrollCursorIntoView();
    }

    /** Moves the editor cursor to the start of the paragraph at paragraphIndex and scrolls into view.
     *  Uses paragraph index directly to avoid the viewOffset ambiguity at paragraph boundaries.
     *  Sets pendingParagraphJump so that onThisLeafActivated (fired by revealLeaf) also restores
     *  by index rather than re-applying the ambiguous lastKnownViewOffset. */
    jumpToParagraphIndex(idx: number): void {
        const el = this.editorEl;
        if (!el) return;
        this.commitToCm6(); // flush any uncommitted changes before jumping
        el.el.focus({ preventScroll: true });
        // Clear any active VS so the teleport-on-jump condition in adjustWindowOnScroll
        // cannot fire with the old focusParaIdx and override the jump target.
        this.virtualizer?.clearVirtualSelection();
        el.setViewCursorToParagraphIndex(idx);
        this.pendingParagraphJump = idx;
        this.lastKnownViewOffset = el.getViewCursorOffset();
        el.scrollCursorIntoView();
        // Safety clear: if active-leaf-change never fires (tate view already active),
        // clear the pending index after two frames so it doesn't affect later tab switches.
        window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
                this.pendingParagraphJump = null;
            });
        });
    }

    /** ESC: collapse any active range selection to its focus node and scroll the focus
     *  into view. Off-window focus (VirtualSelection) centers, in-window focus uses 'nearest' —
     *  the same scroll policy as Undo/Redo (see doUndoRedo). No-op when nothing is selected,
     *  so ESC still only blocks Obsidian's leaf switch in that case. */
    private collapseSelectionToFocusAndScroll(editorEl: EditorElement, virtualizer: ParagraphVirtualizer): void {
        const focusOffset = virtualizer.getVirtualSelectionFocusOffset();
        if (focusOffset !== null) {
            // VirtualSelection (Cmd-A / off-window selection): focus may be off-window.
            virtualizer.clearVirtualSelection();
            editorEl.el.focus({ preventScroll: true });
            editorEl.setViewCursorOffset(focusOffset); // teleports + sets cursorJumped when off-window
            const block = editorEl.cursorJumped ? 'center' : 'nearest';
            editorEl.scrollCursorIntoView(block, block);
            return;
        }
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.focusNode) {
            // Native DOM selection: focus is in-window (island-crossing selections are promoted to VS).
            sel.collapse(sel.focusNode, sel.focusOffset);
            editorEl.scrollCursorIntoView('nearest', 'nearest');
        }
    }

    /** Returns the current paragraphRecords for outline extraction. */
    getParagraphRecords(): readonly ParagraphRecord[] {
        return this.virtualizer?.paragraphRecords ?? [];
    }

    private applyAnnotation(wrap: (el: EditorElement) => boolean): void {
        if (!this.editorEl) return;
        if (this.virtualizer?.getVirtualSelection() || this.editorEl.selectionSpansMultipleParagraphs()) {
            new Notice('選択範囲が広すぎます。テキストを選択し直してください');
            return;
        }
        if (this.editorEl.hasAnnotationInSelection()) {
            new Notice('選択範囲に既存の青空記法が含まれています');
            return;
        }
        if (!wrap(this.editorEl)) {
            new Notice('テキストを選択してください');
        } else {
            this.commitToCm6(); // tcy/bouten finalize immediately, so commit
            this.searchPanel?.onContentChanged();
        }
    }

    // ---- CM6 integration helpers ----

    /** Returns the CM6 editor for the MarkdownView currently showing currentFile, or null if not found. */
    private getCm6Editor(): Editor | null {
        const file = this.syncCoordinator?.currentFile;
        if (!file) return null;
        for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
            const mv = leaf.view;
            if (mv instanceof MarkdownView && mv.file === file) {
                return mv.editor;
            }
        }
        return null;
    }

    /** Cancels the input event and shows a Notice if the CM6 editor is unavailable.
     *  Returns true if CM6 is available. */
    private guardCm6(e: Event): boolean {
        if (this.getCm6Editor()) return true;
        e.preventDefault();
        new Notice('縦書きエディタを使用するには、対応する Markdown ビューを開いてください');
        return false;
    }

    /** Schedules a debounced commit. Resets the timer on each call so the commit fires
     *  COMMIT_DEBOUNCE_MS after the last qualifying input event. */
    private scheduleCommit(): void {
        if (this.commitTimer !== null) window.clearTimeout(this.commitTimer);
        this.commitTimer = window.setTimeout(() => {
            this.commitTimer = null;
            this.commitToCm6();
        }, VerticalWritingView.COMMIT_DEBOUNCE_MS);
    }

    /** Commits the current content of the vertical writing editor to CM6 using differential replaceRange.
     *  Only the changed region (excluding identical leading/trailing characters) is replaced.
     *  This lets CM6 record the exact edit position so the cursor lands at the edit site after Undo.
     *  When content changes, the CM6 cursor is also synced to the vertical writing view cursor.
     *  Cursor sync is skipped while tate-editing is expanded (synced via selectionchange on collapse).
     *  Also cancels any pending debounce timer so immediate commit points preempt the timer. */
    private commitToCm6(): void {
        if (this.commitTimer !== null) {
            window.clearTimeout(this.commitTimer);
            this.commitTimer = null;
        }
        const el = this.editorEl;
        if (!el) return;
        const cm6 = this.getCm6Editor();
        if (!cm6) return;
        // Sync records from DOM before reading content. Handles Enter/Backspace div count
        // changes so getValue() reads from consistent records rather than live DOM.
        el.syncRecordsFromDom();
        const content = el.getValue();
        const cm6Content = cm6.getValue();
        if (content === cm6Content) return; // No diff

        // Replace only the changed region (skip identical leading/trailing characters)
        let fromStart = 0;
        while (fromStart < cm6Content.length && fromStart < content.length
               && cm6Content[fromStart] === content[fromStart]) {
            fromStart++;
        }
        let fromEndOld = cm6Content.length;
        let fromEndNew = content.length;
        while (fromEndOld > fromStart && fromEndNew > fromStart
               && cm6Content[fromEndOld - 1] === content[fromEndNew - 1]) {
            fromEndOld--;
            fromEndNew--;
        }

        cm6.replaceRange(
            content.slice(fromStart, fromEndNew),
            cm6.offsetToPos(fromStart),
            cm6.offsetToPos(fromEndOld),
        );
        // Commit complete — record in SyncCoordinator so vault.on('modify') can identify
        // this CM6 autosave as a self-write and ignore it.
        this.lastCommittedContent = content;
        this.syncCoordinator?.notifySelfWrite(content);
        const segs = buildSegmentMap(content);
        this.plugin.updateCharCount(segs.reduce((sum, seg) => sum + seg.viewLen, 0));
        // Skip cursor sync while tate-editing is expanded (the cursor is inside raw text,
        // which is not in the same space as viewToSrc input). Sync happens in the next commitToCm6 after collapse.
        if (!el.isInlineExpanded()) {
            const viewOffset = el.getViewCursorOffset();
            cm6.setCursor(cm6.offsetToPos(viewToSrc(segs, viewOffset)));
        }
        el.afterCommit();
        // Records were already updated by syncRecordsFromDom() at the start of this call,
        // so refreshOutline() sees current src/viewLen values for accurate jump offsets.
        this.plugin.refreshOutline();
    }

    /** Delegates Undo (isRedo=false) or Redo (isRedo=true) to CM6 and restores
     *  the cursor position derived from the content diff.
     *  cm6.getCursor() is not used: after undo, getCursor() returns the position set by the
     *  last setCursor() call before the undone transaction, which may be unrelated to the edit site. */
    private doUndoRedo(editorEl: EditorElement, isRedo: boolean): void {
        const cm6 = this.getCm6Editor();
        if (!cm6) return;
        // Commit any uncommitted changes first (to align the CM6 undo/redo baseline)
        this.commitToCm6();
        // lastCommittedContent after commitToCm6 is the confirmed content before undo/redo
        const prevContent = this.lastCommittedContent;
        // Execute Undo/Redo on the CM6 side
        if (isRedo) cm6.redo(); else cm6.undo();
        const newContent = cm6.getValue();
        // If content did not change (empty stack etc.), leave cursor as-is
        if (newContent === prevContent) return;
        // Derive cursor position from the diff (end of the restored/deleted text)
        const srcOffset = this.deriveUndoRedoCursor(prevContent, newContent);
        const changedDivs = editorEl.applyFromCm6(prevContent, newContent, srcOffset);
        // Use 'center' when the cursor jumped to an off-window paragraph (scrolled far away),
        // 'nearest' when it was already in the window (minimal scroll suffices).
        const block = editorEl.cursorJumped ? 'center' : 'nearest';
        if (changedDivs === null) {
            // hasCleanDivStructure failed → full rebuild. Show spinner and defer scroll
            // to rAF 1 so the layout flush completes before scrollIntoView runs.
            const gen = this.beginScrollRestoring();
            window.requestAnimationFrame(() => {
                if (this.scrollRestoringGeneration !== gen) return;
                this.hideLoadingSpinner();
                editorEl.scrollCursorIntoView(block, block);
            });
        } else {
            editorEl.scrollCursorIntoView(block, block);
        }
        // Update last committed content to reflect the new CM6 state.
        // Without this, onExternalModify() would misfire on the CM6 autosave modify event,
        // causing the tate view DOM to reset and the cursor to jump during input right after undo.
        this.lastCommittedContent = newContent;
        this.syncCoordinator?.notifySelfWrite(newContent);
        this.plugin.updateCharCount(countChars(newContent));
        this.searchPanel?.onContentChanged();
        this.plugin.refreshOutline();
    }

    /** Derives the appropriate cursor position from the content diff before and after undo/redo.
     *  Returns the end of the changed region in next (offset in next).
     *  undo (text restoration): end of restored text — e.g., undoing deletion of "うえお" → just after "お"
     *  redo (re-applying deletion): deletion point (start of changed region) — natural position for next input */
    private deriveUndoRedoCursor(prev: string, next: string): number {
        // Skip common prefix
        let fromStart = 0;
        while (fromStart < prev.length && fromStart < next.length
               && prev[fromStart] === next[fromStart]) {
            fromStart++;
        }
        // Skip common suffix
        let fromEndPrev = prev.length;
        let fromEndNext = next.length;
        while (fromEndPrev > fromStart && fromEndNext > fromStart
               && prev[fromEndPrev - 1] === next[fromEndNext - 1]) {
            fromEndPrev--;
            fromEndNext--;
        }
        // Return the end of the changed region in next
        return fromEndNext;
    }
}

function countChars(source: string): number {
    return buildSegmentMap(source).reduce((sum, seg) => sum + seg.viewLen, 0);
}
