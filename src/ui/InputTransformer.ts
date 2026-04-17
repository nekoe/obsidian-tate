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
            // matchPrecedingIndent and autoIndentOnInput are independent: matchPrecedingIndent takes
            // priority; autoIndentOnInput applies only when matchPrecedingIndent is off.
            let indentCount: number;
            if (this.settings.matchPrecedingIndent) {
                indentCount = this.getPrecedingParagraphLeadingSpaces(range);
            } else if (this.settings.autoIndentOnInput) {
                indentCount = 1;
            } else {
                indentCount = 0;
            }

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

    private getPrecedingParagraphLeadingSpaces(range: Range): number {
        const currentDiv = this.getContainingParagraphDiv(range.startContainer);
        // No current div means the editor has no paragraph divs yet; use last child as "preceding".
        const prevDiv = currentDiv
            ? currentDiv.previousElementSibling
            : this.el.lastElementChild;

        if (!prevDiv || prevDiv.tagName !== 'DIV') return 1;

        const walker = document.createTreeWalker(prevDiv, NodeFilter.SHOW_TEXT);
        const firstText = walker.nextNode() as Text | null;
        const text = firstText?.data ?? '';
        let count = 0;
        while (count < text.length && text[count] === '\u3000') count++;
        return count;
    }

    private removeOneLeadingFullWidthSpace(cursorRange: Range): void {
        const div = this.getContainingParagraphDiv(cursorRange.startContainer) ?? this.el;
        const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
        const firstText = walker.nextNode() as Text | null;
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
        const textNode = document.createTextNode(text);
        range.insertNode(textNode);
        range.setStartAfter(textNode);
        range.collapse(true);
        const sel = window.getSelection();
        if (sel) {
            sel.removeAllRanges();
            sel.addRange(range);
        }
    }
}
