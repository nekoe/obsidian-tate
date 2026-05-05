import {
    createCursorAnchor, findCursorAnchorAncestor,
    isInsideRtNode, findLastBaseTextInElement,
} from './domHelpers';
import type { ParagraphVirtualizer } from './ParagraphVirtualizer';

// Manages cursor anchor spans (U+200B placeholder spans inserted at end-of-line after annotation
// elements) and the pending-skip direction used to make the invisible placeholder transparent.
export class CursorAnchorManager {
    private pendingAnchorSkip: 'forward' | 'backward' | null = null;
    private virtualizer: ParagraphVirtualizer | null = null;

    constructor(private readonly el: HTMLDivElement) {}

    setVirtualizer(v: ParagraphVirtualizer): void {
        this.virtualizer = v;
    }

    // Sets the skip direction based on the navigation key that was just pressed.
    setSkipDirection(key: string): void {
        if (key === 'ArrowDown') this.pendingAnchorSkip = 'forward';
        else if (key === 'ArrowUp') this.pendingAnchorSkip = 'backward';
        else this.pendingAnchorSkip = null;
    }

    // If the placed anchor is at end-of-line, clears the pending skip so the cursor rests there.
    // If content follows, the skip is kept and fires on the next selectionchange.
    clearSkipIfEndOfLine(placedAnchor: HTMLElement): void {
        const nextAfterAnchor = placedAnchor.nextSibling;
        const atEndOfLine = !nextAfterAnchor
            || (nextAfterAnchor instanceof HTMLElement
                && nextAfterAnchor.tagName === 'BR'
                && nextAfterAnchor === nextAfterAnchor.parentElement?.lastChild);
        if (atEndOfLine) this.pendingAnchorSkip = null;
    }

    // Handles the anchor-skip logic inside handleSelectionChange.
    // Consumes the pending skip direction and moves the cursor past the anchor if applicable.
    // Returns true if the cursor is inside an anchor span (caller must not proceed to expansion).
    handleAnchorPosition(currentRange: Range, sel: Selection): boolean {
        const anchorSpan = findCursorAnchorAncestor(currentRange.startContainer, this.el);
        const savedSkip = this.pendingAnchorSkip;
        this.pendingAnchorSkip = null;
        if (!anchorSpan) return false;

        const text = anchorSpan.textContent ?? '';
        if ((text === '\u200B' || text === '') && savedSkip !== null) {
            try {
                const r = document.createRange();
                if (savedSkip === 'forward') {
                    const pos = this.findPositionAfterAnchor(anchorSpan);
                    if (pos) r.setStart(pos.node, pos.offset);
                    else r.setStartAfter(anchorSpan);
                } else {
                    const pos = this.findPositionBeforeAnchor(anchorSpan);
                    if (pos) r.setStart(pos.node, pos.offset);
                    else r.setStartAfter(anchorSpan);
                }
                r.collapse(true);
                sel.removeAllRanges();
                sel.addRange(r);
            } catch { /* ignore if detached */ }
        }
        return true;
    }

    // Places the cursor just after a collapsed annotation element.
    // Inserts a cursor-anchor span at end-of-line if needed and adjusts pendingAnchorSkip.
    // Caller is responsible for the boutenGuard.set() call that follows.
    placeCursorAfterCollapse(nextSib: Node | null, parentEl: HTMLElement, sel: Selection): void {
        try {
            const r = document.createRange();
            let placedAnchor: HTMLElement | null = null;
            if (nextSib && nextSib.isConnected) {
                if (nextSib instanceof HTMLElement
                        && nextSib.classList.contains('tate-cursor-anchor')
                        && nextSib.firstChild?.nodeType === Node.TEXT_NODE) {
                    // Use a text-level position inside the anchor to avoid Chrome creating an
                    // element-level position that fires an intermediate selectionchange and
                    // clears pendingAnchorSkip before the skip runs.
                    r.setStart(nextSib.firstChild, 0);
                    placedAnchor = nextSib;
                } else {
                    r.setStartBefore(nextSib);
                }
            } else {
                // End-of-line: insert cursor anchor span with U+200B so Chrome has a real
                // text position and does not normalize into <rt> or the annotation span.
                const anchor = createCursorAnchor();
                parentEl.appendChild(anchor);
                r.setStart(anchor.firstChild!, 0);
                placedAnchor = anchor;
            }
            r.collapse(true);
            sel.removeAllRanges();
            sel.addRange(r);
            // If the anchor is at end-of-line, clear pendingAnchorSkip so the cursor rests
            // there; if content follows, keep the flag so the skip fires on landing.
            if (placedAnchor) this.clearSkipIfEndOfLine(placedAnchor);
        } catch { /* ignore if node detached */ }
    }

    // Inserts a cursor anchor after el if el is at end-of-line and has no anchor yet.
    // Must be called before expandForEditing so that the anchor survives as nextSibling
    // of the tate-editing span and is available when the user exits past the closing bracket.
    ensureCursorAnchorAfter(el: HTMLElement): void {
        const next = el.nextSibling;
        if (next instanceof HTMLElement && next.classList.contains('tate-cursor-anchor')) return;
        const isEndOfLine = !next
            || (next instanceof HTMLElement && next.tagName === 'BR'
                && next === next.parentElement?.lastChild);
        if (!isEndOfLine) return;
        const anchor = createCursorAnchor();
        el.parentNode!.insertBefore(anchor, next);
    }

    // Called after input/compositionend when cursor may be inside a tate-cursor-anchor span.
    // Removes U+200B once real characters have been typed, or re-inserts it when the span is empty.
    // Caller is responsible for setting/clearing the isModifyingDom guard around this call.
    handleCursorAnchorInput(): void {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        const anchor = findCursorAnchorAncestor(range.startContainer, this.el);
        if (!anchor) return;

        const text = anchor.textContent ?? '';
        if (text === '') {
            // Span emptied by deletion: restore U+200B placeholder
            const zws = document.createTextNode('\u200B');
            anchor.replaceChildren(zws);
            const r = document.createRange();
            r.setStart(zws, 0);
            r.collapse(true);
            sel.removeAllRanges();
            sel.addRange(r);
        } else if (text !== '\u200B' && text.includes('\u200B')) {
            // Real chars mixed with U+200B: strip placeholder
            const cleaned = text.replace(/\u200B/g, '');
            const textNode = anchor.firstChild;
            if (textNode?.nodeType === Node.TEXT_NODE) {
                const prevOffset = range.startContainer === textNode ? range.startOffset : cleaned.length;
                textNode.textContent = cleaned;
                const adjustedOffset = text.slice(0, prevOffset).replace(/\u200B/g, '').length;
                const r = document.createRange();
                r.setStart(textNode, Math.min(adjustedOffset, cleaned.length));
                r.collapse(true);
                sel.removeAllRanges();
                sel.addRange(r);
            }
        }
    }

    // Returns the first non-<rt> text position after the anchor.
    // Checks siblings within the same paragraph first; falls back to the next paragraph.
    private findPositionAfterAnchor(anchor: HTMLElement): { node: Text; offset: number } | null {
        let sibling: Node | null = anchor.nextSibling;
        while (sibling) {
            if (sibling.nodeType === Node.TEXT_NODE) {
                const t = sibling as Text;
                if (!isInsideRtNode(t, this.el)) return { node: t, offset: 0 };
            } else if (sibling.nodeType === Node.ELEMENT_NODE) {
                const walker = document.createTreeWalker(sibling, NodeFilter.SHOW_TEXT);
                let node = walker.nextNode() as Text | null;
                while (node) {
                    if (!isInsideRtNode(node, this.el)) return { node, offset: 0 };
                    node = walker.nextNode() as Text | null;
                }
            }
            sibling = sibling.nextSibling;
        }
        // Fallback: first text in the next paragraph
        const parentDiv = anchor.parentElement;
        if (!parentDiv) return null;
        let next = parentDiv.nextSibling;
        while (next) {
            if (next instanceof HTMLElement) this.virtualizer?.thawDiv(next);
            const walker = document.createTreeWalker(next, NodeFilter.SHOW_TEXT);
            let node = walker.nextNode() as Text | null;
            while (node) {
                if (!isInsideRtNode(node, this.el)) return { node, offset: 0 };
                node = walker.nextNode() as Text | null;
            }
            next = next.nextSibling;
        }
        return null;
    }

    // Returns the last non-<rt> text position before the anchor on the same line.
    // Descends into element siblings (e.g. <ruby>) to find their last base text node,
    // which causes selectionchange to trigger expandForEditing on the ruby.
    // Falls back to the last text of the previous paragraph if nothing is found on the same line.
    private findPositionBeforeAnchor(anchor: HTMLElement): { node: Text; offset: number } | null {
        let prev: Node | null = anchor.previousSibling;
        while (prev) {
            if (prev.nodeType === Node.TEXT_NODE) {
                return { node: prev as Text, offset: (prev as Text).length };
            }
            if (prev.nodeType === Node.ELEMENT_NODE) {
                const pos = findLastBaseTextInElement(prev as HTMLElement, this.el);
                if (pos) return pos;
            }
            prev = prev.previousSibling;
        }
        // Nothing usable on the same line: fall back to end of previous paragraph
        const parentDiv = anchor.parentElement;
        if (!parentDiv) return null;
        let prevDiv = parentDiv.previousSibling;
        while (prevDiv) {
            if (prevDiv instanceof HTMLElement) this.virtualizer?.thawDiv(prevDiv);
            const walker = document.createTreeWalker(prevDiv, NodeFilter.SHOW_TEXT);
            let lastText: Text | null = null;
            let node = walker.nextNode() as Text | null;
            while (node) {
                if (!isInsideRtNode(node, this.el)) lastText = node;
                node = walker.nextNode() as Text | null;
            }
            if (lastText) return { node: lastText, offset: lastText.length };
            prevDiv = prevDiv.previousSibling;
        }
        return null;
    }
}
