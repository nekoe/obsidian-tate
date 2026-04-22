import { TatePluginSettings } from '../settings';

// Full-width opening brackets used in Japanese typography.
// When typed at line start (possibly after auto-indent spaces), one leading indent space is removed.
const OPEN_BRACKETS = new Set([
    '\u300C', // 「
    '\u300E', // 『
    '\u3010', // 【
    '\u3014', // 〔
    '\uFF08', // （
    '\uFF5B', // ｛
    '\u3008', // 〈
    '\u300A', // 《
    '\u3016', // 〖
    '\u3018', // 〘
    '\u301A', // 〚
]);

export class InputTransformer {
    private settings: TatePluginSettings;

    constructor(
        private readonly el: HTMLDivElement,
        settings: TatePluginSettings,
    ) {
        this.settings = { ...settings };
    }

    updateSettings(settings: TatePluginSettings): void {
        this.settings = { ...settings };
    }

    applySpaceConversion(char: string): string {
        return this.settings.convertHalfWidthSpace && char === ' ' ? '\u3000' : char;
    }

    // Called on compositionstart. Inserts one indent space at line start before IME composition begins
    // so that Japanese characters are typed after the indent, not before it.
    handleCompositionStart(): void {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);

        const textBefore = this.getTextBeforeCursorInParagraph(range);
        if (textBefore !== '') return;

        if (this.settings.autoIndentOnInput) {
            this.insertText(range, '\u3000');
        }
    }

    // Called on compositionend. Removes one leading full-width space when the confirmed character
    // is a full-width opening bracket preceded only by full-width spaces in the paragraph.
    handleCompositionEnd(): void {
        if (!this.settings.removeBracketIndent) return;

        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        if (!range.collapsed) return;

        const { startContainer, startOffset } = range;
        if (startContainer.nodeType !== Node.TEXT_NODE) return;
        const textNode = startContainer as Text;
        if (startOffset === 0) return;

        const charBefore = textNode.data[startOffset - 1];
        if (!OPEN_BRACKETS.has(charBefore)) return;

        // Build a collapsed range just before the bracket to get text preceding it in the paragraph.
        const bracketRange = document.createRange();
        bracketRange.setStart(textNode, startOffset - 1);
        bracketRange.collapse(true);
        const textBeforeBracket = this.getTextBeforeCursorInParagraph(bracketRange);

        if (textBeforeBracket.length === 0) return;
        if (!/^\u3000+$/.test(textBeforeBracket)) return;

        this.removeOneLeadingFullWidthSpace(range);
    }

    // Called from EditorElement.onBeforeInput. Intercepts insertText events and applies
    // space conversion, auto-indent, and bracket de-indent according to current settings.
    handleBeforeInput(e: InputEvent): void {
        if (e.inputType !== 'insertText' || !e.data || e.isComposing) return;

        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);

        let char = e.data;

        if (this.settings.convertHalfWidthSpace && char === ' ') {
            char = '\u3000';
        }

        const textBefore = this.getTextBeforeCursorInParagraph(range);
        const isAtLineStart = textBefore === '';
        // Non-zero only when every character before the cursor in this paragraph is a full-width space.
        const leadingSpacesBeforeCursor = /^\u3000*$/.test(textBefore) ? textBefore.length : 0;

        if (isAtLineStart && char !== '\u3000') {
            let indentCount = this.settings.autoIndentOnInput ? 1 : 0;

            // Bracket typed after leading spaces: reduce indent by 1.
            if (this.settings.removeBracketIndent && OPEN_BRACKETS.has(char)) {
                indentCount = Math.max(0, indentCount - 1);
            }

            if (char !== e.data || indentCount > 0) {
                e.preventDefault();
                this.insertText(range, '\u3000'.repeat(indentCount) + char);
            }
            // indentCount === 0 and no conversion needed: let browser insert normally.
            return;
        }

        // Bracket typed after only full-width spaces on this line: remove one leading space.
        if (leadingSpacesBeforeCursor >= 1 && this.settings.removeBracketIndent && OPEN_BRACKETS.has(char)) {
            e.preventDefault();
            this.removeOneLeadingFullWidthSpace(range);
            const newSel = window.getSelection();
            if (newSel && newSel.rangeCount > 0) {
                this.insertText(newSel.getRangeAt(0), char);
            }
            return;
        }

        // Space conversion only (not at line start, not a bracket removal case).
        if (char !== e.data) {
            e.preventDefault();
            this.insertText(range, char);
        }
    }

    // ---- Private helpers ----

    private getTextBeforeCursorInParagraph(range: Range): string {
        const div = this.getContainingParagraphDiv(range.startContainer);
        if (!div) return '';
        try {
            const lineRange = document.createRange();
            lineRange.setStart(div, 0);
            lineRange.setEnd(range.startContainer, range.startOffset);
            return lineRange.toString();
        } catch {
            return '';
        }
    }

    private getContainingParagraphDiv(node: Node): HTMLElement | null {
        let current: Node | null = node;
        while (current && current !== this.el) {
            if (
                current.nodeType === Node.ELEMENT_NODE &&
                (current as HTMLElement).tagName === 'DIV' &&
                current.parentNode === this.el
            ) {
                return current as HTMLElement;
            }
            current = current.parentNode;
        }
        return null;
    }

    // Called after Enter (insertParagraph). Inserts N full-width spaces matching the preceding paragraph's
    // leading indent. Only active when matchPrecedingIndent is enabled.
    handleParagraphInsert(): void {
        if (!this.settings.matchPrecedingIndent) return;

        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);

        const indentCount = this.getPrecedingParagraphLeadingSpaces(range);
        if (indentCount > 0) {
            this.insertText(range, '\u3000'.repeat(indentCount));
        }
    }

    private getPrecedingParagraphLeadingSpaces(range: Range): number {
        const currentDiv = this.getContainingParagraphDiv(range.startContainer);
        // No current div means the editor has no paragraph divs yet; use last child as "preceding".
        const prevDiv = currentDiv
            ? currentDiv.previousElementSibling
            : this.el.lastElementChild;

        if (!prevDiv || prevDiv.tagName !== 'DIV') return 0;

        const walker = document.createTreeWalker(prevDiv, NodeFilter.SHOW_TEXT);
        // Skip empty text nodes (can arise from Range.insertNode splitting at offset 0)
        let firstText = walker.nextNode() as Text | null;
        while (firstText && firstText.data.length === 0) firstText = walker.nextNode() as Text | null;
        const text = firstText?.data ?? '';
        let count = 0;
        while (count < text.length && text[count] === '\u3000') count++;
        return count;
    }

    private removeOneLeadingFullWidthSpace(cursorRange: Range): void {
        const div = this.getContainingParagraphDiv(cursorRange.startContainer) ?? this.el;
        const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
        // Skip empty text nodes (can arise from Range.insertNode splitting at offset 0)
        let firstText = walker.nextNode() as Text | null;
        while (firstText && firstText.data.length === 0) firstText = walker.nextNode() as Text | null;
        if (!firstText || firstText.data[0] !== '\u3000') return;

        firstText.deleteData(0, 1);

        // Adjust cursor if it was inside the same text node (offset shifts left by 1).
        if (cursorRange.startContainer === firstText) {
            const newOffset = Math.max(0, cursorRange.startOffset - 1);
            const r = document.createRange();
            r.setStart(firstText, newOffset);
            r.collapse(true);
            const sel = window.getSelection();
            if (sel) {
                sel.removeAllRanges();
                sel.addRange(r);
            }
        }
    }

    private insertText(range: Range, text: string): void {
        range.deleteContents();
        if (range.startContainer.nodeType === Node.TEXT_NODE) {
            // insertData modifies the text node in-place, avoiding the Range.insertNode split
            // that creates an empty leading text node and breaks subsequent TreeWalker searches.
            const node = range.startContainer as Text;
            const insertOffset = range.startOffset;
            node.insertData(insertOffset, text);
            const r = document.createRange();
            r.setStart(node, insertOffset + text.length);
            r.collapse(true);
            const sel = window.getSelection();
            if (sel) { sel.removeAllRanges(); sel.addRange(r); }
        } else {
            const textNode = document.createTextNode(text);
            range.insertNode(textNode);
            // Place cursor inside the text node rather than at the element-level position
            // {<div>, 1} that setStartAfter would produce.  An element-level cursor adjacent
            // to a trailing <br> (left behind after inserting into an empty paragraph div)
            // can prevent Chrome from correctly advancing the selection into the new paragraph
            // after Enter, causing handleParagraphInsert to see a stale cursor still inside
            // the preceding paragraph and return 0 indent instead of copying its indent count.
            range.setStart(textNode, textNode.length);
            range.collapse(true);
            const sel = window.getSelection();
            if (sel) { sel.removeAllRanges(); sel.addRange(range); }
        }
    }
}
