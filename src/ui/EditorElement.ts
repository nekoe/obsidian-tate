import { sanitizeHTMLToDom } from 'obsidian';
import { DEFAULT_SETTINGS, TatePluginSettings } from '../settings';
import { buildSegmentMap, srcToView } from './SegmentMap';
import { parseToHtml, serializeNode } from './AozoraParser';
import { InlineEditor } from './InlineEditor';
import { InputTransformer } from './InputTransformer';

export class EditorElement {
    readonly el: HTMLDivElement;
    private readonly inlineEditor: InlineEditor;
    private readonly inputTransformer: InputTransformer;

    constructor(container: HTMLElement) {
        this.el = container.createEl('div');
        this.el.addClass('tate-editor');
        this.el.setAttribute('contenteditable', 'true');
        this.el.setAttribute('spellcheck', 'false');
        this.el.setAttribute('data-placeholder', 'ファイルを開いてください');
        this.inlineEditor = new InlineEditor(this.el);
        this.inputTransformer = new InputTransformer(this.el, DEFAULT_SETTINGS);
    }

    getValue(): string {
        return Array.from(this.el.childNodes)
            .map(n => serializeNode(n, this.el))
            .join('');
    }

    setValue(content: string, preserveCursor: boolean): void {
        // Reset expansion state and selection cache on external update (must run before the early return)
        this.inlineEditor.reset();
        if (this.getValue() === content) return;

        if (preserveCursor && document.activeElement === this.el) {
            const pos = this.getVisibleOffset();
            this.el.replaceChildren(sanitizeHTMLToDom(parseToHtml(content)));
            this.setVisibleOffset(pos);
        } else {
            this.el.replaceChildren(sanitizeHTMLToDom(parseToHtml(content)));
        }
    }

    // ---- Inline expand/collapse (call from selectionchange) ----

    handleSelectionChange(): boolean {
        return this.inlineEditor.handleSelectionChange();
    }

    // ---- Ruby / tcy live conversion (call from input/compositionend) ----

    handleRubyCompletion(): boolean {
        return this.inlineEditor.handleRubyCompletion();
    }

    handleTcyCompletion(): boolean {
        return this.inlineEditor.handleTcyCompletion();
    }

    handleBoutenCompletion(): boolean {
        return this.inlineEditor.handleBoutenCompletion();
    }

    // ---- Selection wrap methods called from the command palette ----

    wrapSelectionWithRuby(): boolean {
        return this.inlineEditor.wrapSelectionWithRuby();
    }

    wrapSelectionWithTcy(): boolean {
        return this.inlineEditor.wrapSelectionWithTcy();
    }

    wrapSelectionWithBouten(): boolean {
        return this.inlineEditor.wrapSelectionWithBouten();
    }

    // Paste handler: strips rich text and inserts plain text only
    handlePaste(e: ClipboardEvent): void {
        e.preventDefault();
        const text = e.clipboardData?.getData('text/plain') ?? '';
        if (!text) return;

        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;

        const range = sel.getRangeAt(0);
        range.deleteContents();

        // Split multi-line text into text nodes and <br> elements and insert them at the cursor
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (i > 0) {
                const br = document.createElement('br');
                range.insertNode(br);
                range.setStartAfter(br);
                range.collapse(true);
            }
            if (lines[i]) {
                const textNode = document.createTextNode(lines[i]);
                range.insertNode(textNode);
                range.setStartAfter(textNode);
                range.collapse(true);
            }
        }
        sel.removeAllRanges();
        sel.addRange(range);

        // beforeinput does not fire for paste, so set inBurst manually
        this.inlineEditor.onBeforeInput();
        // view.ts calls commitToCm6() after paste
    }

    applySettings(settings: TatePluginSettings): void {
        this.el.style.fontFamily = settings.fontFamily;
        this.el.style.fontSize = `${settings.fontSize}px`;
        this.el.style.lineBreak = settings.lineBreak;
        this.inputTransformer.updateSettings(settings);
    }

    adjustWidth(): void { /* no-op: contenteditable div auto-sizes */ }

    focus(): void {
        this.el.focus();
    }

    // Called on beforeinput event (registered from view.ts).
    onBeforeInput(e: InputEvent): void {
        this.inlineEditor.onBeforeInput();
        this.inputTransformer.handleBeforeInput(e);
    }

    // Called after Enter (insertParagraph input event) from view.ts.
    handleParagraphInsert(): void {
        this.inputTransformer.handleParagraphInsert();
    }

    // Called on compositionstart (registered from view.ts).
    onCompositionStart(): void {
        this.inputTransformer.handleCompositionStart();
    }

    // Called on compositionend (registered from view.ts), before commitToCm6.
    onCompositionEnd(): void {
        this.inputTransformer.handleCompositionEnd();
    }

    // Resets the burst flag (call after commitToCm6() completes or on navigation in view.ts).
    resetBurst(): void {
        this.inlineEditor.resetBurst();
    }

    // Called after CM6 Undo/Redo. Applies content to the vertical writing view and
    // restores the cursor by converting srcOffset (CM6 cursor position) via srcToView.
    applyFromCm6(content: string, srcOffset: number): void {
        // Clear any expanded span (CM6 state is the source of truth, so force reset)
        this.inlineEditor.reset();
        // Update DOM only if content changed
        if (this.getValue() !== content) {
            this.el.replaceChildren(sanitizeHTMLToDom(parseToHtml(content)));
        }
        // Convert CM6 source offset to visible offset and restore cursor
        const segs = buildSegmentMap(content);
        const viewOffset = srcToView(segs, srcOffset);
        this.setVisibleOffset(viewOffset);
    }

    /** Returns whether a tate-editing span is currently expanded (used by view.ts to decide cursor sync). */
    isInlineExpanded(): boolean {
        return this.inlineEditor.isExpanded();
    }

    /** Returns the current cursor position in the vertical writing view as a visible offset (used by view.ts for cursor sync). */
    getViewCursorOffset(): number {
        return this.getVisibleOffset();
    }

    // ---- Cursor operations (offset managed in visible character count, excluding <rt>) ----

    private getVisibleOffset(): number {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return 0;
        const range = sel.getRangeAt(0);
        let count = 0;
        const walker = document.createTreeWalker(this.el, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode() as Text | null;

        while (node) {
            if (node === range.startContainer) {
                if (!this.isInsideRt(node)) count += range.startOffset;
                break;
            }
            if (!this.isInsideRt(node)) count += node.length;
            node = walker.nextNode() as Text | null;
        }
        return count;
    }

    private setVisibleOffset(offset: number): void {
        const sel = window.getSelection();
        if (!sel) return;
        let remaining = offset;
        const walker = document.createTreeWalker(this.el, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode() as Text | null;

        while (node) {
            if (!this.isInsideRt(node)) {
                if (remaining <= node.length) {
                    const range = document.createRange();
                    range.setStart(node, remaining);
                    range.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(range);
                    return;
                }
                remaining -= node.length;
            }
            node = walker.nextNode() as Text | null;
        }

        const range = document.createRange();
        range.selectNodeContents(this.el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
    }

    private isInsideRt(node: Node): boolean {
        let parent = node.parentElement;
        while (parent && parent !== this.el) {
            if (parent.tagName === 'RT') return true;
            parent = parent.parentElement;
        }
        return false;
    }
}
