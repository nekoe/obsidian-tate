import { Editor, ItemView, MarkdownView, Notice, Scope, TFile, WorkspaceLeaf } from 'obsidian';
import type TatePlugin from './main';
import { SyncCoordinator } from './sync/SyncCoordinator';
import { EditorElement } from './ui/EditorElement';
import { SearchPanel } from './ui/SearchPanel';
import { ParagraphVirtualizer } from './ui/ParagraphVirtualizer';
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
    private commitTimer: ReturnType<typeof setTimeout> | null = null;
    private static readonly COMMIT_DEBOUNCE_MS = 500;
    // Deferred cursor offset: set when a file is loaded while the view is not active.
    // Applied (with scroll) on the next active-leaf-change for this view.
    private pendingCursorOffset: number | null = null;
    // Monotonic counter managed by beginScrollRestoring/cancelScrollRestoring.
    // Guards cleanup rAFs: a stale rAF from a superseded load will not remove
    // the class that belongs to a newer load (prevents fast-switching race condition).
    private scrollRestoringGeneration = 0;
    // Spinner element shown while tate-scroll-restoring is active (file load + scroll restore).
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

        const spinnerEl = container.createEl('div', { cls: 'tate-loading-spinner' });
        this.spinnerEl = spinnerEl;

        const syncCoordinator = new SyncCoordinator(
            this.app.vault,
            // Use committed text for comparison (not getValue() which may contain uncommitted IME text)
            () => this.lastCommittedContent,
            (content, preserveCursor) => {
                this.lastCommittedContent = content;
                if (preserveCursor) {
                    // External edit: rebuild all divs under tate-scroll-restoring so they are
                    // born with content-visibility:visible → contain-intrinsic-block-size cache
                    // is accurate from their first paint. Then restore cursor and scroll,
                    // identical to the file-load path.
                    // Prefer lastKnownViewOffset over getViewCursorOffset(): the latter returns 0
                    // when the editor is not focused (external edit often fires while unfocused).
                    const savedOffset = this.lastKnownViewOffset ?? editorEl.getViewCursorOffset();
                    this.beginScrollRestoring();       // adds class BEFORE setValue
                    editorEl.setValue(content, false); // new divs born with class active
                    this.plugin.updateCharCount(countChars(content));
                    // restoreViewOffset handles both cases:
                    //   active view  → rAF 1: scroll, rAF 2: remove class
                    //   inactive view → pendingCursorOffset set; active-leaf-change scrolls
                    this.restoreViewOffset(savedOffset);
                } else {
                    // File load or file delete: caller manages the tate-scroll-restoring lifecycle.
                    editorEl.setValue(content, false);
                    this.plugin.updateCharCount(countChars(content));
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
            return false;
        });

        // Registered via registerDomEvent so listeners are automatically removed on onClose

        this.registerDomEvent(editorEl.el, 'copy', (e: ClipboardEvent) => {
            editorEl.handleCopy(e); // No guardCm6: copy is read-only
        });
        this.registerDomEvent(editorEl.el, 'cut', (e: ClipboardEvent) => {
            if (!this.guardCm6(e)) return; // Block cut if CM6 is unavailable
            editorEl.handleCut(e);
            this.commitToCm6(); // Cut is an immediate commit point
            this.searchPanel?.onContentChanged();
        });
        this.registerDomEvent(editorEl.el, 'paste', (e: ClipboardEvent) => {
            if (!this.guardCm6(e)) return; // Block if CM6 is unavailable
            const newDivs = editorEl.handlePaste(e);
            this.commitToCm6(); // Paste is an immediate commit point
            this.scheduleLayoutRefresh(newDivs);
            this.searchPanel?.onContentChanged();
        });
        this.registerDomEvent(editorEl.el, 'beforeinput', (e: InputEvent) => {
            if (!this.guardCm6(e)) return; // Block input if CM6 is unavailable (read-only)
            if (!e.isComposing && e.inputType === 'insertParagraph' && editorEl.isInlineExpanded()) {
                e.preventDefault();
                const contentChanged = editorEl.collapseForEnter();
                if (contentChanged) this.commitToCm6();
                return;
            }
            editorEl.onBeforeInput(e);
            // InputTransformer may call e.preventDefault() and perform direct DOM mutations
            // (e.g. half→full-width space conversion, auto-indent, bracket de-indent).
            // When default is prevented the browser cancels the corresponding input event,
            // so scheduleCommit() would never be called. Schedule it here instead.
            if (e.defaultPrevented && e.inputType === 'insertText' && !e.isComposing) {
                this.scheduleCommit();
            }
        });
        this.registerDomEvent(editorEl.el, 'input', (e: Event) => {
            const inputEvent = e as InputEvent;
            // Skip during IME composition: normalizeEmptyDom resets the cursor, which would
            // interrupt the ongoing composition and misplace the candidate text.
            if (!inputEvent.isComposing) editorEl.normalizeEmptyDom();
            if (!inputEvent.isComposing) {
                if (inputEvent.inputType === 'insertParagraph') {
                    editorEl.handleParagraphInsert();
                    this.commitToCm6(); // Enter is an immediate commit point
                    this.searchPanel?.onContentChanged();
                    return;
                }
                const annotated = editorEl.handleRubyCompletion()
                               || editorEl.handleTcyCompletion()
                               || editorEl.handleBoutenCompletion();
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
            editorEl.onCompositionStart();
        });
        this.registerDomEvent(editorEl.el, 'compositionend', (e: CompositionEvent) => {
            editorEl.handleRubyCompletion();
            editorEl.handleTcyCompletion();
            editorEl.handleBoutenCompletion();
            editorEl.onCompositionEnd(e); // bracket de-indent for IME input
            editorEl.handleCursorAnchorInput(); // Manage U+200B placeholder after IME input
            editorEl.handleBoutenPostCollapseInput(); // Move IME text out of post-collapse bouten span
            this.commitToCm6(); // IME confirmation is a commit point
            this.searchPanel?.onContentChanged();
        });
        this.registerDomEvent(document, 'selectionchange', () => {
            // Ensure the cursor paragraph and its neighbors are thawed before any DOM access.
            if (document.activeElement === editorEl.el) virtualizer.ensureThawedAtCursor();
            const contentChanged = editorEl.handleSelectionChange();
            if (contentChanged) this.commitToCm6(); // Commit only if collapse changed content
            // Track the cursor offset while the editor has focus so it can be restored after
            // focus() resets the caret on view re-activation.
            // Multiple selectionchange events can fire in a single frame (e.g. auto-indent inserts
            // text via insertText(), triggering one event per DOM mutation). Debounce with rAF so
            // only the final cursor position per frame is captured, avoiding redundant O(N) scans.
            if (document.activeElement === editorEl.el && !editorEl.isInlineExpanded()) {
                if (this.selectionChangeRafId !== null) cancelAnimationFrame(this.selectionChangeRafId);
                this.selectionChangeRafId = requestAnimationFrame(() => {
                    this.selectionChangeRafId = null;
                    if (document.activeElement === editorEl.el && !editorEl.isInlineExpanded()) {
                        this.lastKnownViewOffset = editorEl.getViewCursorOffset();
                    }
                });
            }
        });
        this.registerDomEvent(editorEl.el, 'mousedown', () => {
            this.commitToCm6(); // Click ends a burst = commit point
            editorEl.afterNavigation();
        });
        this.registerDomEvent(editorEl.el, 'keydown', (e: KeyboardEvent) => {
            // Ctrl+Z / Cmd+Z: Undo,  Ctrl+Shift+Z / Cmd+Shift+Z: Redo
            if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key === 'z') {
                e.preventDefault();
                this.doUndoRedo(editorEl, e.shiftKey);
                return;
            }
            // ArrowUp/ArrowDown inside a tcy span: move left/right within the horizontal text
            if (!e.isComposing && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                if (editorEl.handleTcyNavigation(e.key)) {
                    e.preventDefault();
                    if (this.commitTimer !== null) this.commitToCm6();
                    editorEl.afterNavigation();
                    return;
                }
            }
            // Navigation keys are commit points only when there are uncommitted changes
            // (commitTimer !== null means the debounce is running). Skipping the commit
            // when nothing is pending avoids an O(N) getValue() call on every keypress.
            // Skip while isComposing=true (user is selecting IME candidates)
            if (!e.isComposing && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
                 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
                editorEl.notifyNavigationKey(e.key);
                if (this.commitTimer !== null) this.commitToCm6();
                editorEl.afterNavigation();
            }
        });

        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                if (file instanceof TFile) {
                    void syncCoordinator.onModify(file);
                }
            })
        );
        this.registerEvent(
            this.app.vault.on('delete', (file) => {
                if (file instanceof TFile) {
                    void this.plugin.deleteCursorPosition(file.path);
                    syncCoordinator.onFileDelete(file);
                }
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

        // file-open detects file switches more reliably than active-leaf-change
        this.registerEvent(
            this.app.workspace.on('file-open', (file) => {
                if (file === syncCoordinator.currentFile) return;
                // Close search panel when the file changes
                this.closeSearch();
                if (!file) {
                    // file-open fires with null when the active file is cleared (e.g., the active
                    // Markdown view is closed while the tate view is not the active leaf).
                    syncCoordinator.clearCurrentFile();
                    editorEl.clearContent();
                    this.lastCommittedContent = '';
                    this.pendingCursorOffset = null;
                    this.lastKnownViewOffset = null;
                    this.plugin.updateCharCount(null);
                    this.cancelScrollRestoring();
                    return;
                }
                // Save cursor for the file being switched away from before loading the new one.
                // currentFile is captured before loadFile() changes it.
                const prevFile = syncCoordinator.currentFile;
                if (prevFile && this.lastKnownViewOffset !== null) {
                    void this.plugin.saveCursorPosition(prevFile.path, this.lastKnownViewOffset);
                }
                void (async () => {
                    const gen = this.beginScrollRestoring();
                    await syncCoordinator.loadFile(file);
                    if (syncCoordinator.currentFile !== file) {
                        this.scheduleScrollRestoringCleanup(gen);
                        return;
                    }
                    this.lastKnownViewOffset = null;
                    const savedOffset = this.plugin.getCursorPosition(file.path);
                    if (savedOffset !== undefined) {
                        this.restoreViewOffset(savedOffset); // rAF 1 hides spinner; rAF 2 removes class
                    } else {
                        this.scheduleScrollRestoringCleanup(gen);
                    }
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
                    syncCoordinator.clearCurrentFile();
                    editorEl.clearContent();
                    this.lastCommittedContent = '';
                    this.pendingCursorOffset = null;
                    this.lastKnownViewOffset = null;
                    this.plugin.updateCharCount(null);
                    this.cancelScrollRestoring();
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
                    this.virtualizer?.onViewDeactivated();
                    if (!this.app.workspace.getLeavesOfType(TATE_VIEW_TYPE).includes(leaf)) {
                        // Hide only when the newly active leaf is not any tate view
                        this.plugin.updateCharCount(null);
                    }
                }
            })
        );

        await this.loadInitialFile(syncCoordinator);

        // If the view is already active when it opens (the common case), push the scope now.
        // Otherwise the first active-leaf-change for this leaf will push it.
        if (this.app.workspace.getActiveViewOfType(VerticalWritingView) === this) {
            this.pushEscScope();
        }
    }

    private async loadInitialFile(syncCoordinator: SyncCoordinator): Promise<void> {
        // Use the file that was active just before the vertical writing view was opened
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
            const gen = this.beginScrollRestoring();
            await syncCoordinator.loadFile(activeFile);
            if (syncCoordinator.currentFile !== activeFile) {
                this.scheduleScrollRestoringCleanup(gen);
                return;
            }
            this.lastKnownViewOffset = null;
            const savedOffset = this.plugin.getCursorPosition(activeFile.path);
            if (savedOffset !== undefined) {
                this.restoreViewOffset(savedOffset); // rAF 1 hides spinner; rAF 2 removes class
            } else {
                this.scheduleScrollRestoringCleanup(gen);
            }
            return;
        }
        // If no active file, fall back to the first file in an open Markdown view
        for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
            if (leaf.view instanceof MarkdownView && leaf.view.file) {
                const file = leaf.view.file;
                const gen = this.beginScrollRestoring();
                await syncCoordinator.loadFile(file);
                if (syncCoordinator.currentFile !== file) {
                    this.scheduleScrollRestoringCleanup(gen);
                    return;
                }
                this.lastKnownViewOffset = null;
                const savedOffset = this.plugin.getCursorPosition(file.path);
                if (savedOffset !== undefined) {
                    this.restoreViewOffset(savedOffset); // rAF 1 hides spinner; rAF 2 removes class
                } else {
                    this.scheduleScrollRestoringCleanup(gen);
                }
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
        const offset = (el && document.activeElement === el.el && !el.isInlineExpanded())
            ? el.getViewCursorOffset()
            : this.lastKnownViewOffset;
        if (offset === null) return null;
        return this.plugin.saveCursorPosition(file.path, offset);
    }

    /** Restores a saved view offset. If the view is currently active, focuses the editor,
     *  sets the cursor, and scrolls into view. Otherwise defers to the next
     *  active-leaf-change event via pendingCursorOffset.
     *
     *  Callers must set tate-scroll-restoring on el.el BEFORE the loadFile() call that
     *  precedes this method. The class ensures new paragraph divs are built with real sizes
     *  (content-visibility:visible). scrollCursorIntoView is deferred one rAF so it runs
     *  after Obsidian's view-activation logic (focus resets, revealLeaf, etc.) completes. */
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
            requestAnimationFrame(() => {
                if (this.scrollRestoringGeneration !== gen) return; // newer load superseded this one
                // Hide spinner before scroll so it disappears at the same time content is revealed.
                this.hideLoadingSpinner();
                // Re-assert cursor in case focus() moved it between now and this frame.
                el.setViewCursorOffset(savedOffset);
                el.scrollCursorIntoView(); // tate-scroll-restoring still active → real sizes
                requestAnimationFrame(() => {
                    if (this.scrollRestoringGeneration === gen) {
                        el.el.classList.remove('tate-scroll-restoring');
                        this.virtualizer?.reobserveAll();
                    }
                });
            });
        } else {
            // View is not yet active; active-leaf-change will apply cursor + scroll.
            // The tate-scroll-restoring class set by the caller remains active until then.
            this.pendingCursorOffset = savedOffset;
        }
    }

    async onClose(): Promise<void> {
        this.searchPanel?.close();
        this.popEscScope();
        if (this.selectionChangeRafId !== null) {
            cancelAnimationFrame(this.selectionChangeRafId);
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
    }

    private showLoadingSpinner(): void {
        this.spinnerEl?.classList.add('tate-loading-visible');
    }

    private hideLoadingSpinner(): void {
        this.spinnerEl?.classList.remove('tate-loading-visible');
    }

    /** Starts a scroll-restore cycle: increments the generation counter, adds
     *  tate-scroll-restoring (must be called before loadFile() so new paragraph divs
     *  are created with content-visibility:visible and real sizes), and shows the spinner.
     *  Returns the generation number for use in rAF guards. */
    private beginScrollRestoring(): number {
        const gen = ++this.scrollRestoringGeneration;
        this.editorEl?.el.classList.add('tate-scroll-restoring');
        this.showLoadingSpinner();
        return gen;
    }

    /** Schedules a one-rAF cleanup for the scroll-restore cycle identified by gen.
     *  Used when no scroll is needed (no savedOffset or superseded load). */
    private scheduleScrollRestoringCleanup(gen: number): void {
        requestAnimationFrame(() => {
            if (this.scrollRestoringGeneration === gen) {
                this.editorEl?.el.classList.remove('tate-scroll-restoring');
                this.hideLoadingSpinner();
                this.virtualizer?.reobserveAll();
            }
        });
    }

    /** Cancels an in-flight scroll-restore cycle immediately (synchronous, no rAF).
     *  Increments the generation to invalidate any pending cleanup rAFs. */
    private cancelScrollRestoring(): void {
        ++this.scrollRestoringGeneration;
        this.editorEl?.el.classList.remove('tate-scroll-restoring');
        this.hideLoadingSpinner();
        this.virtualizer?.reobserveAll();
    }

    /** Proactively refreshes the contain-intrinsic-block-size:auto cache for divs that
     *  were mutated while off-screen (paste, Undo/Redo). Adds tate-layout-refreshing
     *  synchronously so Frame N's layout runs with content-visibility:visible and writes
     *  the actual size into the cache. Removes the class in the second rAF (Frame N+1)
     *  so Frame N's layout is not skipped. No spinner — two frames is imperceptible. */
    private scheduleLayoutRefresh(divs: HTMLDivElement[]): void {
        if (divs.length === 0) return;
        divs.forEach(d => d.classList.add('tate-layout-refreshing'));
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                divs.forEach(d => {
                    d.classList.remove('tate-layout-refreshing');
                    // Re-trigger the IntersectionObserver for divs that were off-screen throughout
                    // the mutation (Undo/Redo, paste). Continuously off-screen divs never produce a
                    // new IO callback, so without this they would stay thawed indefinitely. After
                    // reobserveOne, the IO fires isIntersecting:false → lastKnownWidths is updated
                    // with the correct post-mutation width (from the contain-intrinsic-block-size
                    // cache written by Frame N) → scheduleFreeze re-freezes the div.
                    this.virtualizer?.reobserveOne(d);
                });
            });
        });
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
        this.virtualizer?.onViewActivated();
        this.plugin.updateCharCount(countChars(this.lastCommittedContent));
        const el = this.editorEl;
        if (el) {
            // focus() resets the caret to the start; restore it immediately after.
            el.el.focus({ preventScroll: true });
            if (this.pendingCursorOffset !== null) {
                // New file was loaded in the background: restore the saved offset and scroll.
                // tate-scroll-restoring was set before loadFile(); real sizes are in effect.
                // Defer hide + scroll to rAF 1 so the spinner is visible on the first
                // paint when the tab becomes active (matches restoreViewOffset active path).
                const gen = this.scrollRestoringGeneration; // snapshot for rAF guard
                const offset = this.pendingCursorOffset;
                this.pendingCursorOffset = null;
                el.setViewCursorOffset(offset);
                this.lastKnownViewOffset = offset; // sync update
                requestAnimationFrame(() => {
                    if (this.scrollRestoringGeneration !== gen) return;
                    // Hide spinner before scroll so it disappears at the same time content is revealed.
                    this.hideLoadingSpinner();
                    // Re-assert cursor in case focus() moved it between now and this frame.
                    el.setViewCursorOffset(offset);
                    el.scrollCursorIntoView();
                    requestAnimationFrame(() => {
                        if (this.scrollRestoringGeneration === gen) {
                            el.el.classList.remove('tate-scroll-restoring');
                            this.virtualizer?.reobserveAll();
                        }
                    });
                });
            } else {
                // Normal tab switch: restore cursor, then check for external file changes
                // made while this view was inactive (e.g. edits in MarkdownView).
                // Skipped when pendingCursorOffset is set: the file was just loaded from vault
                // by loadFile(), so its content is already current.
                if (this.lastKnownViewOffset !== null) {
                    el.setViewCursorOffset(this.lastKnownViewOffset);
                }
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

    openSearch(): void {
        const el = this.editorEl;
        if (!el || !this.searchPanel) return;

        // If an inline element is expanded, collapse it before opening search
        if (el.isInlineExpanded()) {
            const contentChanged = el.collapseForEnter();
            if (contentChanged) this.commitToCm6();
        }

        const offset = el.getViewCursorOffset();
        this.searchPanel.open(offset);
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
        if (!this.editorEl.wrapSelectionWithRuby()) {
            new Notice('テキストを選択してください');
        }
        // Ruby enters inline-expand state; commitToCm6 is called when collapseEditing completes
    }
    applyTcy(): void    { this.applyAnnotation(el => el.wrapSelectionWithTcy()); }
    applyBouten(): void { this.applyAnnotation(el => el.wrapSelectionWithBouten()); }

    private applyAnnotation(wrap: (el: EditorElement) => boolean): void {
        if (!this.editorEl) return;
        if (!wrap(this.editorEl)) {
            new Notice('テキストを選択してください');
        } else {
            this.commitToCm6(); // tcy/bouten finalize immediately, so commit
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
        if (this.commitTimer !== null) clearTimeout(this.commitTimer);
        this.commitTimer = setTimeout(() => {
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
            clearTimeout(this.commitTimer);
            this.commitTimer = null;
        }
        const el = this.editorEl;
        if (!el) return;
        const cm6 = this.getCm6Editor();
        if (!cm6) return;
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
        if (changedDivs === null) {
            // hasCleanDivStructure failed → full rebuild. beginScrollRestoring adds
            // tate-scroll-restoring synchronously (class is pending before any layout).
            // Scroll is deferred to rAF 1 so the forced layout flush runs with the class
            // active → content-visibility:visible → accurate sizes → cache written.
            // Class removed in rAF 2 (two-rAF pattern ensures Frame N's layout sees class).
            const gen = this.beginScrollRestoring();
            requestAnimationFrame(() => {
                if (this.scrollRestoringGeneration !== gen) return;
                this.hideLoadingSpinner();
                editorEl.scrollCursorIntoView('nearest', 'nearest');
                requestAnimationFrame(() => {
                    if (this.scrollRestoringGeneration === gen) {
                        editorEl.el.classList.remove('tate-scroll-restoring');
                        this.virtualizer?.reobserveAll();
                    }
                });
            });
        } else {
            // Add tate-layout-refreshing synchronously first so the subsequent layout flush
            // from scrollCursorIntoView sees accurate sizes for changed divs and writes their
            // contain-intrinsic-block-size cache.
            this.scheduleLayoutRefresh(changedDivs);
            editorEl.scrollCursorIntoView('nearest', 'nearest');
        }
        // Update last committed content to reflect the new CM6 state.
        // Without this, onExternalModify() would misfire on the CM6 autosave modify event,
        // causing the tate view DOM to reset and the cursor to jump during input right after undo.
        this.lastCommittedContent = newContent;
        this.plugin.updateCharCount(countChars(newContent));
        this.searchPanel?.onContentChanged();
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
