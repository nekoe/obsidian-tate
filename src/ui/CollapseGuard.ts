// Manages the post-collapse guard state for annotation elements (bouten, ruby, heading).
// After an element collapses, Chrome normalizes the cursor back into the element synchronously,
// which would re-trigger expansion. This class detects and redirects such moves, and intercepts
// input events to route characters to the correct position outside the element.
export class CollapseGuard {
    private justCollapsed: { el: HTMLElement; originalText: string } | null = null;

    clear(): void {
        this.justCollapsed = null;
    }

    set(el: HTMLElement, originalText: string): void {
        this.justCollapsed = { el, originalText };
    }

    get(): { el: HTMLElement; originalText: string } | null {
        return this.justCollapsed;
    }

    // Returns the guarded element if the cursor is in the post-collapse zone, or null.
    // expandFlag: whether this element type should expand on cursor entry.
    // Covers three cursor positions that occur after collapse:
    //   1. cursor normalized into the element itself (Chrome moves it back synchronously)
    //   2. cursor redirected into the adjacent anchor span (end-of-line)
    //   3. cursor redirected to the start of the next text node (mid-line)
    // Non-collapsed selections are excluded to avoid false positives.
    getCursorCollapseEl(expandFlag: boolean, expandedEl: HTMLSpanElement | null): HTMLElement | null {
        if (!this.justCollapsed || !expandFlag || expandedEl) return null;
        const el = this.justCollapsed.el;
        if (!el.isConnected) {
            this.justCollapsed = null;
            return null;
        }
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || !sel.getRangeAt(0).collapsed) return null;

        const range = sel.getRangeAt(0);
        const container = range.startContainer;

        // Case 1: Chrome normalized cursor back into the element itself
        if (el.contains(container)) return el;

        // Case 2 / 3: cursor is at the immediate next sibling of el
        // (anchor span for end-of-line, or text node for mid-line),
        // including descendants of that sibling and element-level cursor positions.
        const nextSib = el.nextSibling;
        if (nextSib) {
            if (nextSib === container
                    || (nextSib?.instanceOf(HTMLElement) && nextSib.contains(container))) {
                return el;
            }
            // Element-level cursor: {parentDiv, indexOf(nextSib)}
            if (container.nodeType === Node.ELEMENT_NODE
                    && (container as Element).childNodes[range.startOffset] === nextSib) {
                return el;
            }
        }

        return null;
    }

    // Inserts chars into the DOM immediately after el without going through the Selection API.
    // End-of-line (anchor span follows): creates a new text node between el and anchor.
    // Mid-line (text node follows): prepends to that text node.
    // Moves the cursor to just after the inserted text.
    insertAfter(el: HTMLElement, chars: string): void {
        const next = el.nextSibling;
        let targetNode: Text;
        let targetOffset: number;

        if (next?.instanceOf(HTMLElement) && next.classList.contains('tate-cursor-anchor')
                && next.firstChild?.nodeType === Node.TEXT_NODE) {
            // End-of-line: new text node between el and anchor preserves anchor for future navigation
            const textNode = activeDocument.createTextNode(chars);
            el.parentNode!.insertBefore(textNode, next);
            targetNode = textNode;
            targetOffset = chars.length;
        } else if (next?.nodeType === Node.TEXT_NODE) {
            // Mid-line: prepend to existing text node (avoids creating a node split)
            const textNode = next as Text;
            textNode.insertData(0, chars);
            targetNode = textNode;
            targetOffset = chars.length;
        } else {
            const textNode = activeDocument.createTextNode(chars);
            el.parentNode!.insertBefore(textNode, next ?? null);
            targetNode = textNode;
            targetOffset = chars.length;
        }

        const sel = window.getSelection();
        if (sel) {
            const r = activeDocument.createRange();
            r.setStart(targetNode, targetOffset);
            r.collapse(true);
            sel.removeAllRanges();
            sel.addRange(r);
        }

        // Insertion succeeded: cursor is now outside el. Clear guard.
        this.justCollapsed = null;
    }

    // Called in compositionend (before commitToCm6) to move IME text that landed inside a
    // post-collapse element out to after the element. Returns true if the DOM was changed.
    handlePostCollapseInput(): boolean {
        if (!this.justCollapsed) return false;
        const { el, originalText } = this.justCollapsed;
        if (!el.isConnected) {
            this.justCollapsed = null;
            return false;
        }

        const currentText = el.textContent ?? '';

        if (currentText === originalText) return false;

        if (!currentText.startsWith(originalText)) {
            // IME changed content unexpectedly: clear guard, let expansion handle naturally
            this.justCollapsed = null;
            return false;
        }

        const extraChars = currentText.slice(originalText.length);
        el.textContent = originalText;
        this.insertAfter(el, extraChars);
        // insertAfter clears justCollapsed
        return true;
    }

    // Redirects cursor to a stable position just after el to prevent re-expansion.
    // End-of-line: redirects to end of anchor text (after U+200B), which the anchor span handler
    // intercepts on the next selectionchange so expansion does not fire.
    // Mid-line: redirects to the start of the following text node, a true text-level stable position.
    redirectCursorOutOfCollapsed(el: HTMLElement, sel: Selection): void {
        const next = el.nextSibling;
        const r = activeDocument.createRange();
        if (next?.instanceOf(HTMLElement) && next.classList.contains('tate-cursor-anchor')
                && next.firstChild?.nodeType === Node.TEXT_NODE) {
            // Place cursor at the END of the anchor text (after U+200B) rather than the start,
            // so Chrome does not re-normalize this position back into the preceding element.
            const anchorText = next.firstChild as Text;
            r.setStart(anchorText, anchorText.length);
        } else if (next?.nodeType === Node.TEXT_NODE) {
            r.setStart(next as Text, 0);
        } else if (next) {
            r.setStartBefore(next);
        } else {
            // Defensive fallback: el is at end-of-line with no anchor.
            r.setStartAfter(el);
        }
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
    }
}
