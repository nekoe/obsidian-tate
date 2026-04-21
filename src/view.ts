import { Editor, ItemView, MarkdownView, Notice, TFile, WorkspaceLeaf } from 'obsidian';
import type TatePlugin from './main';
import { SyncCoordinator } from './sync/SyncCoordinator';
import { EditorElement } from './ui/EditorElement';
import { buildSegmentMap, viewToSrc } from './ui/SegmentMap';
import { TatePluginSettings } from './settings';

export const TATE_VIEW_TYPE = 'tate-vertical-writing';

export class VerticalWritingView extends ItemView {
    private editorEl: EditorElement | null = null;
    private syncCoordinator: SyncCoordinator | null = null;
    // Last committed text written to CM6.
    // Used for comparison in onExternalModify to avoid confusion with getValue() which may contain uncommitted IME text.
    private lastCommittedContent = '';

    constructor(leaf: WorkspaceLeaf, private readonly plugin: TatePlugin) {
        super(leaf);
    }

    getViewType(): string { return TATE_VIEW_TYPE; }
    getDisplayText(): string { return '縦書き'; }
    getIcon(): string { return 'tally-3'; }

    async onOpen(): Promise<void> {
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass('tate-container');

        // Assign to local variables to avoid non-null assertions inside closures
        const editorEl = new EditorElement(container);
        this.editorEl = editorEl;
        editorEl.applySettings(this.plugin.settings);

        const syncCoordinator = new SyncCoordinator(
            this.app.vault,
            // Use committed text for comparison (not getValue() which may contain uncommitted IME text)
            () => this.lastCommittedContent,
            (content, preserveCursor) => {
                // Update committed content on file load and external change application
                this.lastCommittedContent = content;
                editorEl.setValue(content, preserveCursor);
                this.plugin.updateCharCount(countChars(content));
            },
        );
        this.syncCoordinator = syncCoordinator;

        // Registered via registerDomEvent so listeners are automatically removed on onClose

        this.registerDomEvent(editorEl.el, 'copy', (e: ClipboardEvent) => {
            editorEl.handleCopy(e); // No guardCm6: copy is read-only
        });
        this.registerDomEvent(editorEl.el, 'cut', (e: ClipboardEvent) => {
            if (!this.guardCm6(e)) return; // Block cut if CM6 is unavailable
            editorEl.handleCut(e);
            this.commitToCm6(); // Cut is an immediate commit point
        });
        this.registerDomEvent(editorEl.el, 'paste', (e: ClipboardEvent) => {
            if (!this.guardCm6(e)) return; // Block if CM6 is unavailable
            editorEl.handlePaste(e);
            this.commitToCm6(); // Paste is an immediate commit point
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
                    return;
                }
                const annotated = editorEl.handleRubyCompletion()
                               || editorEl.handleTcyCompletion()
                               || editorEl.handleBoutenCompletion();
                if (annotated) this.commitToCm6(); // Notation conversion is an immediate commit point
                editorEl.handleCursorAnchorInput(); // Manage U+200B placeholder in cursor anchor span
            }
        });
        this.registerDomEvent(editorEl.el, 'compositionstart', () => {
            if (!this.getCm6Editor()) return; // read-only mode, skip indent
            editorEl.onCompositionStart();
        });
        this.registerDomEvent(editorEl.el, 'compositionend', () => {
            editorEl.handleRubyCompletion();
            editorEl.handleTcyCompletion();
            editorEl.handleBoutenCompletion();
            editorEl.onCompositionEnd(); // bracket de-indent for IME input
            editorEl.handleCursorAnchorInput(); // Manage U+200B placeholder after IME input
            editorEl.handleBoutenPostCollapseInput(); // Move IME text out of post-collapse bouten span
            this.commitToCm6(); // IME confirmation is a commit point
        });
        this.registerDomEvent(document, 'selectionchange', () => {
            const contentChanged = editorEl.handleSelectionChange();
            if (contentChanged) this.commitToCm6(); // Commit only if collapse changed content
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
                    this.commitToCm6();
                    editorEl.afterNavigation();
                    return;
                }
            }
            // Navigation keys are commit points (to record the next input as a separate CM6 history entry)
            // Skip while isComposing=true (user is selecting IME candidates)
            if (!e.isComposing && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
                 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
                editorEl.notifyNavigationKey(e.key);
                this.commitToCm6();
                editorEl.afterNavigation();
            }
        });

        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                if (file instanceof TFile) void syncCoordinator.onExternalModify(file);
            })
        );
        this.registerEvent(
            this.app.vault.on('delete', (file) => {
                if (file instanceof TFile) syncCoordinator.onFileDelete(file);
            })
        );
        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                if (file instanceof TFile) syncCoordinator.onFileRename(file, oldPath);
            })
        );

        // file-open detects file switches more reliably than active-leaf-change
        this.registerEvent(
            this.app.workspace.on('file-open', (file) => {
                if (file === syncCoordinator.currentFile) return;
                if (!file) {
                    // file-open fires with null when the active file is cleared (e.g., the active
                    // Markdown view is closed while the tate view is not the active leaf).
                    syncCoordinator.clearCurrentFile();
                    editorEl.clearContent();
                    this.lastCommittedContent = '';
                    this.plugin.updateCharCount(null);
                    return;
                }
                void syncCoordinator.loadFile(file);
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
                    syncCoordinator.clearCurrentFile();
                    editorEl.clearContent();
                    this.lastCommittedContent = '';
                    this.plugin.updateCharCount(null);
                }
            })
        );

        this.registerEvent(
            this.app.workspace.on('active-leaf-change', (leaf) => {
                if (leaf === null) return; // transient null during Obsidian internal navigation
                if (leaf === this.leaf) {
                    this.plugin.updateCharCount(countChars(this.lastCommittedContent));
                } else if (!this.app.workspace.getLeavesOfType(TATE_VIEW_TYPE).includes(leaf)) {
                    // Hide only when the newly active leaf is not any tate view
                    this.plugin.updateCharCount(null);
                }
            })
        );

        await this.loadInitialFile(syncCoordinator);
    }

    private async loadInitialFile(syncCoordinator: SyncCoordinator): Promise<void> {
        // Use the file that was active just before the vertical writing view was opened
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
            await syncCoordinator.loadFile(activeFile);
            return;
        }
        // If no active file, fall back to the first file in an open Markdown view
        for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
            if (leaf.view instanceof MarkdownView && leaf.view.file) {
                await syncCoordinator.loadFile(leaf.view.file);
                return;
            }
        }
    }

    onClose(): Promise<void> {
        // Flush any uncommitted changes to CM6 before closing
        this.commitToCm6();
        this.syncCoordinator?.dispose();
        if (!this.app.workspace.getActiveViewOfType(VerticalWritingView)) {
            this.plugin.updateCharCount(null);
        }
        return Promise.resolve();
    }

    applySettings(settings: TatePluginSettings): void {
        this.editorEl?.applySettings(settings);
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

    /** Commits the current content of the vertical writing editor to CM6 using differential replaceRange.
     *  Only the changed region (excluding identical leading/trailing characters) is replaced.
     *  This lets CM6 record the exact edit position so the cursor lands at the edit site after Undo.
     *  When content changes, the CM6 cursor is also synced to the vertical writing view cursor.
     *  Cursor sync is skipped while tate-editing is expanded (synced via selectionchange on collapse). */
    private commitToCm6(): void {
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
        // Commit complete — update last committed content (prevents false positives in onExternalModify)
        this.lastCommittedContent = content;
        const segs = buildSegmentMap(content);
        this.plugin.updateCharCount(segs.reduce((sum, seg) => sum + seg.viewLen, 0));
        // Skip cursor sync while tate-editing is expanded (the cursor is inside raw text,
        // which is not in the same space as viewToSrc input). Sync happens in the next commitToCm6 after collapse.
        if (!el.isInlineExpanded()) {
            const srcOffset = viewToSrc(segs, el.getViewCursorOffset());
            cm6.setCursor(cm6.offsetToPos(srcOffset));
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
        editorEl.applyFromCm6(newContent, srcOffset);
        // Update last committed content to reflect the new CM6 state.
        // Without this, onExternalModify() would misfire on the CM6 autosave modify event,
        // causing the tate view DOM to reset and the cursor to jump during input right after undo.
        this.lastCommittedContent = newContent;
        this.plugin.updateCharCount(countChars(newContent));
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
