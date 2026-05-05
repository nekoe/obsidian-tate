import { KANJI_RE_STR } from './AozoraParser';
import {
    createRubyEl, createTcyEl, createBoutenEl, createHeadingEl,
    insertAnnotationElement, setCursorAfter, isInsideRuby,
} from './domHelpers';

// Result returned by handleRubyCompletion.
// When a tate-editing span is created (empty rt), newExpanded carries it so
// InlineEditor can update its expandedEl/expandedElOriginalText state.
export type RubyCompletionResult =
    | { converted: false }
    | { converted: true; newExpanded?: { el: HTMLSpanElement; originalText: string } };

// Handles live conversion of Aozora notation text into DOM elements as the user types.
// Caller (InlineEditor) is responsible for isModifyingDom guard and state updates.
export class LiveConverter {
    constructor(private readonly el: HTMLDivElement) {}

    // Converts a ruby notation just before the cursor to a <ruby> element when 》 is typed.
    // If rt is empty, creates a tate-editing span and returns it via result.newExpanded.
    // Caller must check expandedEl and isModifyingDom before calling, and apply result.newExpanded.
    handleRubyCompletion(): RubyCompletionResult {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return { converted: false };
        const range = sel.getRangeAt(0);
        if (range.startContainer.nodeType !== Node.TEXT_NODE) return { converted: false };
        if (isInsideRuby(range.startContainer, this.el)) return { converted: false };

        const textNode = range.startContainer as Text;
        const textBefore = textNode.textContent?.slice(0, range.startOffset) ?? '';
        if (!textBefore.endsWith('》')) return { converted: false };

        // Explicit form takes priority: ｜base《rt》 or |base《rt》
        let match = textBefore.match(/[|｜]([^|｜《》\n]+)《([^《》\n]*)》$/);
        let explicit = true;
        if (!match) {
            // Implicit form: preceding run of kanji followed by 《rt》
            match = textBefore.match(new RegExp(`(${KANJI_RE_STR})《([^《》\\n]*)》$`, 'u'));
            explicit = false;
        }
        if (!match) return { converted: false };

        const base = match[1];
        const rt = match[2];
        const matchStart = range.startOffset - match[0].length;

        // If rt is empty (user typed 《》): expand to a tate-editing span and place cursor between 《 and 》.
        // When the user types the ruby text and moves the cursor away, collapseEditing() collapses it to a <ruby>.
        if (rt === '') {
            const rawText = explicit ? `｜${base}《》` : `${base}《》`;
            const span = document.createElement('span');
            span.className = 'tate-editing';
            span.textContent = rawText;

            insertAnnotationElement(textNode, matchStart, range.startOffset, span);

            // Place cursor between 《 and 》 (rawText.length - 1 = just before 》)
            const spanText = span.firstChild as Text | null;
            if (spanText) {
                const r = document.createRange();
                r.setStart(spanText, rawText.length - 1);
                r.collapse(true);
                const s = window.getSelection()!;
                s.removeAllRanges();
                s.addRange(r);
            }
            return { converted: true, newExpanded: { el: span, originalText: rawText } };
        }

        const rubyEl = createRubyEl(base, rt, explicit);
        const inserted = insertAnnotationElement(textNode, matchStart, range.startOffset, rubyEl);

        // Place cursor just after the element
        // If the cursor is inside the ruby, selectionchange fires expandForEditing() immediately
        setCursorAfter(inserted);
        return { converted: true };
    }

    // Converts a tate-chu-yoko notation just before the cursor to a <span class="tcy"> when ］ is typed.
    // Returns true if a conversion occurred.
    handleTcyCompletion(): boolean {
        return this.handleAnnotationCompletion('］', /［＃「([^「」\n]+)」は縦中横］$/, createTcyEl);
    }

    // Converts a bouten notation just before the cursor to a <span class="bouten"> when ］ is typed.
    // Returns true if a conversion occurred.
    handleBoutenCompletion(): boolean {
        return this.handleAnnotationCompletion('］', /［＃「([^「」\n]+)」に傍点］$/, createBoutenEl);
    }

    // Converts a heading notation just before the cursor to a heading span when ］ is typed.
    // Tries large → mid → small in order; returns true if any conversion occurred.
    handleHeadingCompletion(): boolean {
        return (
            this.handleAnnotationCompletion('］', /［＃「([^「」\n]+)」は大見出し］$/, c => createHeadingEl(c, 'large')) ||
            this.handleAnnotationCompletion('］', /［＃「([^「」\n]+)」は中見出し］$/, c => createHeadingEl(c, 'mid'))   ||
            this.handleAnnotationCompletion('］', /［＃「([^「」\n]+)」は小見出し］$/, c => createHeadingEl(c, 'small'))
        );
    }

    // Shared implementation for live conversions that complete on a terminal character (tcy, bouten).
    private handleAnnotationCompletion(
        endChar: string,
        re: RegExp,
        createElement: (content: string) => HTMLElement,
    ): boolean {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return false;
        const range = sel.getRangeAt(0);
        if (range.startContainer.nodeType !== Node.TEXT_NODE) return false;
        if (isInsideRuby(range.startContainer, this.el)) return false;

        const textNode = range.startContainer as Text;
        const textBefore = textNode.textContent?.slice(0, range.startOffset) ?? '';
        if (!textBefore.endsWith(endChar)) return false;

        const annotationMatch = textBefore.match(re);
        if (!annotationMatch) return false;

        const content = annotationMatch[1];
        const annotationStart = range.startOffset - annotationMatch[0].length;
        if (!textBefore.slice(0, annotationStart).endsWith(content)) return false;

        const newEl = createElement(content);
        const inserted = insertAnnotationElement(
            textNode, annotationStart - content.length, range.startOffset, newEl,
        );

        // Place cursor just after the element
        // If the cursor is inside the element, selectionchange fires expandForEditing() immediately
        setCursorAfter(inserted);
        return true;
    }
}
