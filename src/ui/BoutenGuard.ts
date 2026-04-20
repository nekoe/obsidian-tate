import { findBoutenAncestor } from './domHelpers';

// Manages the post-collapse guard state for bouten (emphasis mark) spans.
// After a bouten span collapses, Chrome normalizes the cursor back into the span,
// which would re-trigger expansion. This class detects and redirects such moves.
export class BoutenGuard {
    private boutenJustCollapsed: { el: HTMLElement; originalText: string } | null = null;

    constructor(private readonly el: HTMLDivElement) {}

    clear(): void {
        this.boutenJustCollapsed = null;
    }

    set(bouten: HTMLElement, originalText: string): void {
        this.boutenJustCollapsed = { el: bouten, originalText };
    }

    get(): { el: HTMLElement; originalText: string } | null {
        return this.boutenJustCollapsed;
    }

    // Returns the bouten span that should intercept the next insertText event due to Chrome's
    // post-collapse cursor behavior, or null if not applicable.
    // Covers three cursor positions that occur after collapse:
    //   1. cursor normalized into bouten itself (Chrome moves it back synchronously)
    //   2. cursor redirected into the adjacent anchor span (end-of-line)
    //   3. cursor redirected to the start of the next text node (mid-line)
    // Non-collapsed selections (e.g. Ctrl+A) are excluded to avoid false positives.
    getCursorBoutenSpan(expandBouten: boolean, expandedEl: HTMLSpanElement | null): HTMLElement | null {
        if (!this.boutenJustCollapsed || !expandBouten || expandedEl) return null;
        const bouten = this.boutenJustCollapsed.el;
        if (!bouten.isConnected) {
            this.boutenJustCollapsed = null;
            return null;
        }
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || !sel.getRangeAt(0).collapsed) return null;

        const range = sel.getRangeAt(0);
        const container = range.startContainer;

        // Case 1: Chrome normalized cursor back into bouten span itself
        if (findBoutenAncestor(container, this.el) === bouten) return bouten;

        // Case 2 / 3: cursor is at the immediate next sibling of bouten
        // (anchor span for end-of-line, or text node for mid-line),
        // including descendants of that sibling and element-level cursor positions.
        const nextSib = bouten.nextSibling;
        if (nextSib) {
            if (nextSib === container
                    || (nextSib instanceof HTMLElement && nextSib.contains(container))) {
                return bouten;
            }
            // Element-level cursor: {parentDiv, indexOf(nextSib)}
            if (container.nodeType === Node.ELEMENT_NODE
                    && (container as Element).childNodes[range.startOffset] === nextSib) {
                return bouten;
            }
        }

        return null;
    }

    // Inserts chars into the DOM immediately after bouten without going through the Selection API.
    // End-of-line (anchor span follows): creates a new text node between bouten and anchor.
    // Mid-line (text node follows): prepends to that text node.
    // Moves the cursor to just after the inserted text.
    insertAfterBouten(bouten: HTMLElement, chars: string): void {
        const next = bouten.nextSibling;
        let targetNode: Text;
        let targetOffset: number;

        if (next instanceof HTMLElement && next.classList.contains('tate-cursor-anchor')
                && next.firstChild?.nodeType === Node.TEXT_NODE) {
            // End-of-line: new text node between bouten and anchor preserves anchor for future navigation
            const textNode = document.createTextNode(chars);
            bouten.parentNode!.insertBefore(textNode, next);
            targetNode = textNode;
            targetOffset = chars.length;
        } else if (next?.nodeType === Node.TEXT_NODE) {
            // Mid-line: prepend to existing text node (avoids creating a node split)
            const textNode = next as Text;
            textNode.insertData(0, chars);
            targetNode = textNode;
            targetOffset = chars.length;
        } else {
            const textNode = document.createTextNode(chars);
            bouten.parentNode!.insertBefore(textNode, next ?? null);
            targetNode = textNode;
            targetOffset = chars.length;
        }

        const sel = window.getSelection();
        if (sel) {
            const r = document.createRange();
            r.setStart(targetNode, targetOffset);
            r.collapse(true);
            sel.removeAllRanges();
            sel.addRange(r);
        }

        // Insertion succeeded: cursor is now outside bouten. Clear the guard so that
        // subsequent keystrokes are handled by normal input logic at the correct position.
        this.boutenJustCollapsed = null;
    }

    // Called in compositionend (before commitToCm6) to move IME text that landed inside a
    // post-collapse bouten span out to after the span. Returns true if the DOM was changed.
    handleBoutenPostCollapseInput(): boolean {
        if (!this.boutenJustCollapsed) return false;
        const { el: bouten, originalText } = this.boutenJustCollapsed;
        if (!bouten.isConnected) {
            this.boutenJustCollapsed = null;
            return false;
        }

        const currentText = bouten.textContent ?? '';

        if (currentText === originalText) return false;

        if (!currentText.startsWith(originalText)) {
            // IME changed content unexpectedly: clear guard, let expansion handle naturally
            this.boutenJustCollapsed = null;
            return false;
        }

        const extraChars = currentText.slice(originalText.length);
        bouten.textContent = originalText;
        this.insertAfterBouten(bouten, extraChars);
        // insertAfterBouten clears boutenJustCollapsed
        return true;
    }

    // Redirects cursor to a stable position after the bouten span to prevent re-expansion.
    // Called when Chrome normalizes the cursor from the adjacent anchor back into bouten.
    // End-of-line: redirects to end of anchor text (after U+200B), which the anchor span handler
    // intercepts on the next selectionchange so expansion does not fire.
    // Mid-line: redirects to the start of the following text node, a true text-level stable position.
    redirectCursorOutOfCollapsedBouten(bouten: HTMLElement, sel: Selection): void {
        const next = bouten.nextSibling;
        const r = document.createRange();
        if (next instanceof HTMLElement && next.classList.contains('tate-cursor-anchor')
                && next.firstChild?.nodeType === Node.TEXT_NODE) {
            // Place cursor at the END of the anchor text (after U+200B) rather than the start,
            // so Chrome does not re-normalize this position back into the preceding bouten span.
            const anchorText = next.firstChild as Text;
            r.setStart(anchorText, anchorText.length);
        } else if (next?.nodeType === Node.TEXT_NODE) {
            r.setStart(next as Text, 0);
        } else if (next) {
            r.setStartBefore(next);
        } else {
            // Defensive fallback: bouten is at end-of-line with no anchor.
            // In normal operation this branch is unreachable because ensureCursorAnchorAfter
            // always inserts an anchor before expandForEditing, so collapseEditing leaves
            // the anchor as nextSibling. Reached only if the anchor was removed externally.
            r.setStartAfter(bouten);
        }
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
    }
}
