import { sanitizeHTMLToDom } from 'obsidian';
import { parseInlineToHtml, serializeNode } from './AozoraParser';
import { rawOffsetForExpand, getExtraCharsFromAnnotation } from './domHelpers';

// Result of collapseEditing. The detached flag is true when the span was not
// in the DOM; in that case, InlineEditor must NOT clear inBurst.
export type CollapseResult = { hasChanged: boolean; detached: boolean };

// Handles the low-level expand/collapse of annotation elements (ruby/tcy/bouten)
// into raw-text tate-editing spans. Does not own any mutable state beyond the el reference.
// Caller (InlineEditor) is responsible for isModifyingDom, expandedEl, and inBurst state.
export class InlineExpander {
    constructor(private readonly el: HTMLDivElement) {}

    // Returns the first ancestor of node that is an expandable annotation element,
    // filtered by the caller-provided expand flags.
    findExpandableAncestor(
        node: Node, ruby: boolean, tcy: boolean, bouten: boolean,
    ): HTMLElement | null {
        let el: HTMLElement | null = node instanceof HTMLElement ? node : node.parentElement;
        while (el && el !== this.el) {
            if (el.tagName === 'RUBY' && ruby) return el;
            if (el.tagName === 'SPAN' && el.getAttribute('data-tcy') === 'explicit' && tcy) return el;
            if (el.tagName === 'SPAN' && el.getAttribute('data-bouten') && bouten) return el;
            el = el.parentElement;
        }
        return null;
    }

    // Replaces target with a tate-editing span and positions the cursor.
    // Returns the created span and its raw text (for InlineEditor to store as expandedEl/originalText).
    // Caller is responsible for setting isModifyingDom and clearing inBurst.
    expandForEditing(target: HTMLElement, range: Range): { el: HTMLSpanElement; originalText: string } {
        const rawText = serializeNode(target, this.el);
        const cursorOffset = rawOffsetForExpand(target, range.startContainer, range.startOffset);

        const span = document.createElement('span');
        span.className = 'tate-editing';
        span.textContent = rawText;

        target.parentNode!.replaceChild(span, target);

        const textNode = span.firstChild as Text | null;
        if (textNode) {
            const sel = window.getSelection();
            if (sel) {
                const r = document.createRange();
                r.setStart(textNode, Math.min(cursorOffset, textNode.length));
                r.collapse(true);
                sel.removeAllRanges();
                sel.addRange(r);
            }
        }
        return { el: span, originalText: rawText };
    }

    // Collapses the editing span, re-parses its content, and inserts the result in place.
    // Cursor placement after collapse is handled by the caller.
    // Returns hasChanged (whether content differs from when expansion started) and detached
    // (true when the span was already removed from the DOM — caller must NOT clear inBurst).
    collapseEditing(expandedEl: HTMLSpanElement, expandedElOriginalText: string | null): CollapseResult {
        if (!expandedEl.isConnected) return { hasChanged: false, detached: true };

        let rawText = expandedEl.textContent ?? '';
        const hasChanged = expandedElOriginalText === null || rawText !== expandedElOriginalText;

        const parent = expandedEl.parentNode!;
        const nextSibling = expandedEl.nextSibling;

        // Leading text absorption correction (only meaningful when hasChanged)
        let precedingTextNode: Text | null = null;
        let precedingChars = '';
        if (hasChanged) {
            const extraChars = getExtraCharsFromAnnotation(rawText);
            if (extraChars.length > 0) {
                const prev = expandedEl.previousSibling;
                if (prev?.nodeType === Node.TEXT_NODE) {
                    const prevText = prev as Text;
                    if ((prevText.textContent ?? '').endsWith(extraChars)) {
                        precedingTextNode = prevText;
                        precedingChars = extraChars;
                        rawText = precedingChars + rawText;
                    }
                }
            }
        }

        // Do not use parseToHtml (it wraps in <div>, which would nest inside the paragraph <div>)
        const html = parseInlineToHtml(rawText);

        // Remove the absorbed leading characters from the preceding text node
        if (precedingTextNode?.isConnected) {
            precedingTextNode.textContent = (precedingTextNode.textContent ?? '')
                .slice(0, -precedingChars.length);
        }

        // Direct DOM manipulation (handles start of line, end of line, and middle uniformly)
        parent.removeChild(expandedEl);
        const fragment = sanitizeHTMLToDom(html);
        while (fragment.firstChild) {
            parent.insertBefore(fragment.firstChild, nextSibling);
        }

        return { hasChanged, detached: false };
    }
}
