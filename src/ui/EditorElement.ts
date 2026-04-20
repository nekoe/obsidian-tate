import { sanitizeHTMLToDom } from 'obsidian';
import { DEFAULT_SETTINGS, TatePluginSettings } from '../settings';
import { buildSegmentMap, srcToView } from './SegmentMap';
import { parseInlineToHtml, parseToHtml, serializeNode } from './AozoraParser';
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

    collapseForEnter(): boolean {
        return this.inlineEditor.collapseForEnter();
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

    // Copy handler: serializes the selected DOM to Aozora notation and writes it to text/plain.
    // This ensures ruby/tcy/bouten are preserved when copying within the editor.
    handleCopy(e: ClipboardEvent): void {
        this.serializeSelectionToClipboard(e);
    }

    // Cut handler: same as copy, then deletes the selected content.
    handleCut(e: ClipboardEvent): void {
        const range = this.serializeSelectionToClipboard(e);
        if (!range) return;
        range.deleteContents();
        // view.ts calls commitToCm6() after cut
    }

    // Serializes the current selection to Aozora notation and writes it to text/plain.
    // Returns the range on success (for cut to delete), or null if nothing to serialize.
    private serializeSelectionToClipboard(e: ClipboardEvent): Range | null {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return null;
        const range = sel.getRangeAt(0);
        if (range.collapsed || !this.el.contains(range.commonAncestorContainer)) return null;
        e.preventDefault();
        const fragment = range.cloneContents();
        const text = Array.from(fragment.childNodes)
            .map(n => serializeNode(n, this.el))
            .join('');
        e.clipboardData?.setData('text/plain', text);
        return range;
    }

    // Paste handler: parses Aozora notation in the pasted text and inserts rendered inline elements.
    // Multi-line paste creates one <div> per line (matching Enter-key paragraph behavior).
    handlePaste(e: ClipboardEvent): void {
        e.preventDefault();
        const text = e.clipboardData?.getData('text/plain') ?? '';
        if (!text) return;

        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;

        const range = sel.getRangeAt(0);
        range.deleteContents();

        const lines = text.split('\n');
        if (lines.length === 1) {
            this.insertParsedInline(range, lines[0]);
        } else {
            this.insertParsedParagraphs(range, lines);
        }

        // beforeinput does not fire for paste, so set inBurst manually
        this.inlineEditor.onBeforeInput();
        // view.ts calls commitToCm6() after paste
    }

    // Inserts parsed Aozora inline elements at the range position (single-line paste).
    private insertParsedInline(range: Range, line: string): void {
        const sel = window.getSelection()!;
        if (line) {
            const frag = sanitizeHTMLToDom(parseInlineToHtml(line));
            for (const node of Array.from(frag.childNodes)) {
                range.insertNode(node);
                range.setStartAfter(node);
                range.collapse(true);
            }
        }
        sel.removeAllRanges();
        sel.addRange(range);
    }

    // Inserts parsed lines as separate paragraph <div>s (multi-line paste).
    // Splits the current paragraph at the cursor: first line appends to it,
    // each remaining line becomes a new <div>, and after-cursor content moves to the last.
    private insertParsedParagraphs(range: Range, lines: string[]): void {
        const sel = window.getSelection()!;
        const paragraphDiv = this.findParagraphDiv(range.startContainer);

        if (!paragraphDiv || this.inlineEditor.isExpanded()) {
            // Fallback: insert as <br>-separated inline content.
            // Also used when an inline element is expanded (splitting the div would corrupt the tate-editing span).
            for (let i = 0; i < lines.length; i++) {
                if (i > 0) {
                    const br = document.createElement('br');
                    range.insertNode(br);
                    range.setStartAfter(br);
                    range.collapse(true);
                }
                if (lines[i]) {
                    const frag = sanitizeHTMLToDom(parseInlineToHtml(lines[i]));
                    for (const node of Array.from(frag.childNodes)) {
                        range.insertNode(node);
                        range.setStartAfter(node);
                        range.collapse(true);
                    }
                }
            }
            sel.removeAllRanges();
            sel.addRange(range);
            return;
        }

        // Extract content from cursor to end of paragraph
        const afterRange = document.createRange();
        afterRange.selectNodeContents(paragraphDiv);
        afterRange.setStart(range.startContainer, range.startOffset);
        const afterFragment = afterRange.extractContents();

        // Append first line to the current (now truncated) paragraph
        const firstFrag = sanitizeHTMLToDom(parseInlineToHtml(lines[0]));
        paragraphDiv.append(...Array.from(firstFrag.childNodes));

        // Create a new <div> for each remaining line
        let insertAfter: Element = paragraphDiv;
        let lastPastedNode: Node | null = null;

        for (let i = 1; i < lines.length; i++) {
            const div = document.createElement('div');
            const lineFrag = sanitizeHTMLToDom(parseInlineToHtml(lines[i]));
            const lineNodes = Array.from(lineFrag.childNodes);
            div.append(...lineNodes);
            lastPastedNode = lineNodes.length > 0 ? lineNodes[lineNodes.length - 1] : null;

            if (i === lines.length - 1) {
                // Last paragraph: attach the original after-cursor content
                div.append(...Array.from(afterFragment.childNodes));
            }

            insertAfter.after(div);
            insertAfter = div;
        }

        // Position cursor at end of pasted content (before the after-cursor content)
        const newRange = document.createRange();
        if (lastPastedNode) {
            newRange.setStartAfter(lastPastedNode);
        } else {
            newRange.setStart(insertAfter, 0);
        }
        newRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(newRange);
    }

    // Returns the direct <div> child of this.el that contains node, or null.
    private findParagraphDiv(node: Node): HTMLElement | null {
        let current: Node | null = node;
        while (current && current !== this.el) {
            if (current.parentElement === this.el && current instanceof HTMLElement && current.tagName === 'DIV') {
                return current;
            }
            current = current.parentElement;
        }
        return null;
    }

    applySettings(settings: TatePluginSettings): void {
        this.el.style.fontFamily = settings.fontFamily;
        this.el.style.fontSize = `${settings.fontSize}px`;
        this.el.style.lineBreak = settings.lineBreak;
        this.inputTransformer.updateSettings(settings);
        this.inlineEditor.setExpandSettings(
            settings.expandRubyInline,
            settings.expandTcyInline,
            settings.expandBoutenInline,
        );
    }

    adjustWidth(): void { /* no-op: contenteditable div auto-sizes */ }

    focus(): void {
        this.el.focus();
    }

    // Called on beforeinput event (registered from view.ts).
    // For non-IME insertText when cursor is inside a post-collapse bouten span
    // (Chrome normalized it back in), intercepts the event and inserts the character
    // after the span instead. Chrome's Selection API normalization is synchronous and
    // cannot be countered with sel.addRange, so Range-level insertion is used instead.
    onBeforeInput(e: InputEvent): void {
        this.inlineEditor.onBeforeInput();
        if (!e.isComposing && e.inputType === 'insertText' && e.data) {
            const boutenSpan = this.inlineEditor.getCursorBoutenSpan();
            if (boutenSpan) {
                e.preventDefault();
                const char = this.inputTransformer.applySpaceConversion(e.data);
                this.inlineEditor.insertAfterBouten(boutenSpan, char);
                return;
            }
        }
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

    // Called in compositionend (before commitToCm6) to move IME text that landed inside a
    // post-collapse bouten span out to after the span. Returns true if the DOM was changed.
    handleBoutenPostCollapseInput(): boolean {
        return this.inlineEditor.handleBoutenPostCollapseInput();
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

    // Called after input/compositionend to manage U+200B in the cursor anchor span.
    handleCursorAnchorInput(): void {
        this.inlineEditor.handleCursorAnchorInput();
    }

    // Records the direction of the most recent navigation key for anchor skip.
    notifyNavigationKey(key: string): void {
        this.inlineEditor.notifyNavigationKey(key);
    }

    // Intercepts ArrowUp/ArrowDown inside a tcy span and moves the cursor left/right instead.
    // Returns true if the key was consumed (caller should call preventDefault).
    handleTcyNavigation(key: string): boolean {
        return this.inlineEditor.handleTcyNavigation(key);
    }

    // ---- Cursor operations (offset managed in visible character count, excluding <rt> and U+200B) ----

    private getVisibleOffset(): number {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return 0;
        const range = sel.getRangeAt(0);
        let count = 0;
        const walker = document.createTreeWalker(this.el, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode() as Text | null;

        while (node) {
            if (node === range.startContainer) {
                if (!this.isInsideRt(node)) {
                    const text = node.textContent ?? '';
                    const beforeCursor = this.isInsideAnchorSpan(node)
                        ? text.slice(0, range.startOffset).replace(/\u200B/g, '').length
                        : range.startOffset;
                    count += beforeCursor;
                }
                break;
            }
            if (!this.isInsideRt(node)) {
                count += this.isInsideAnchorSpan(node)
                    ? (node.textContent ?? '').replace(/\u200B/g, '').length
                    : node.length;
            }
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
                const visLen = this.isInsideAnchorSpan(node)
                    ? (node.textContent ?? '').replace(/\u200B/g, '').length
                    : node.length;
                if (remaining <= visLen) {
                    const range = document.createRange();
                    let actualOffset: number;
                    if (this.isInsideAnchorSpan(node)) {
                        // Map visible offset to actual offset, skipping U+200B
                        const text = node.textContent ?? '';
                        actualOffset = 0;
                        let visible = 0;
                        for (let i = 0; i < text.length; i++) {
                            if (visible === remaining) { actualOffset = i; break; }
                            if (text[i] !== '\u200B') visible++;
                            actualOffset = i + 1;
                        }
                    } else {
                        actualOffset = remaining;
                    }
                    range.setStart(node, actualOffset);
                    range.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(range);
                    return;
                }
                remaining -= visLen;
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

    private isInsideAnchorSpan(node: Node): boolean {
        let parent = node.parentElement;
        while (parent && parent !== this.el) {
            if (parent.classList.contains('tate-cursor-anchor')) return true;
            parent = parent.parentElement;
        }
        return false;
    }
}
