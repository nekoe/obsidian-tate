// ---- Constants ----

// CJK Unified Ideographs (U+4E00–U+9FFF) + Extension A (U+3400–U+4DBF) + iteration marks
export const KANJI_RE_STR = '[\u4E00-\u9FFF\u3400-\u4DBF\u{20000}-\u{2A6DF}々〆〤]+';

// ---- Element factories ----

export function createRubyEl(base: string, rt: string, explicit: boolean): HTMLElement {
    const rubyEl = activeDocument.createElement('ruby');
    rubyEl.setAttribute('data-ruby-explicit', String(explicit));
    rubyEl.appendChild(activeDocument.createTextNode(base));
    const rtEl = activeDocument.createElement('rt');
    rtEl.textContent = rt;
    rubyEl.appendChild(rtEl);
    return rubyEl;
}

export function createTcyEl(content: string): HTMLElement {
    const span = activeDocument.createElement('span');
    span.setAttribute('data-tcy', 'explicit');
    span.className = 'tcy';
    span.textContent = content;
    return span;
}

export function createBoutenEl(content: string): HTMLElement {
    const span = activeDocument.createElement('span');
    span.setAttribute('data-bouten', 'sesame');
    span.className = 'bouten';
    span.textContent = content;
    return span;
}

export function createHeadingEl(content: string, level: 'large' | 'mid' | 'small'): HTMLElement {
    const span = activeDocument.createElement('span');
    span.setAttribute('data-heading', level);
    span.className = `tate-heading tate-heading-${level}`;
    span.textContent = content;
    return span;
}

export function createCursorAnchor(): HTMLSpanElement {
    const anchor = activeDocument.createElement('span');
    anchor.className = 'tate-cursor-anchor';
    anchor.appendChild(activeDocument.createTextNode('\u200B'));
    return anchor;
}

// ---- DOM manipulation ----

export function insertAnnotationElement(
    textNode: Text,
    matchStart: number,
    matchEnd: number,
    element: HTMLElement,
): HTMLElement {
    const parentEl = textNode.parentNode as HTMLElement;
    const precedingText = textNode.data.slice(0, matchStart);
    const followingText = textNode.data.slice(matchEnd);
    const next = textNode.nextSibling;
    parentEl.removeChild(textNode);
    if (precedingText) parentEl.insertBefore(activeDocument.createTextNode(precedingText), next);
    parentEl.insertBefore(element, next);
    if (followingText) parentEl.insertBefore(activeDocument.createTextNode(followingText), next);
    return element;
}

export function setCursorAfter(node: Node): void {
    const sel = window.getSelection();
    if (!sel) return;
    const r = activeDocument.createRange();
    r.setStartAfter(node);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
}

// ---- Ancestor traversal ----

export function findAncestor(
    node: Node,
    pred: (el: HTMLElement) => boolean,
    rootEl: HTMLElement,
): HTMLElement | null {
    let el: HTMLElement | null = node.instanceOf(HTMLElement) ? node : node.parentElement;
    while (el && el !== rootEl) {
        if (pred(el)) return el;
        el = el.parentElement;
    }
    return null;
}

export function findBoutenAncestor(node: Node, rootEl: HTMLElement): HTMLElement | null {
    return findAncestor(node, el => !!el.getAttribute('data-bouten'), rootEl);
}

export function findHeadingAncestor(node: Node, rootEl: HTMLElement): HTMLElement | null {
    return findAncestor(node, el => !!el.getAttribute('data-heading'), rootEl);
}

export function findTcyAncestor(node: Node, rootEl: HTMLElement): HTMLElement | null {
    return findAncestor(node, el => el.classList.contains('tcy'), rootEl);
}

export function isInsideRuby(node: Node, rootEl: HTMLElement): boolean {
    return findAncestor(node, el => el.tagName === 'RUBY', rootEl) !== null;
}

export function findCursorAnchorAncestor(node: Node, rootEl: HTMLElement): HTMLElement | null {
    return findAncestor(node, el => el.classList.contains('tate-cursor-anchor'), rootEl);
}

export function isInsideRtNode(node: Node, rootEl: HTMLElement): boolean {
    return findAncestor(node.parentElement ?? node, el => el.tagName === 'RT', rootEl) !== null;
}

export function findLastBaseTextInElement(
    el: HTMLElement,
    rootEl: HTMLElement,
): { node: Text; offset: number } | null {
    const walker = activeDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let lastText: Text | null = null;
    let node = walker.nextNode() as Text | null;
    while (node) {
        if (!isInsideRtNode(node, rootEl)) lastText = node;
        node = walker.nextNode() as Text | null;
    }
    if (!lastText) return null;
    return { node: lastText, offset: lastText.length };
}

// ---- Paragraph div utilities ----

// Returns true if el has no children, or all children are empty Text nodes.
// deleteContents() often leaves empty Text nodes (data === '') instead of removing
// them outright, so a childNodes.length === 0 check alone is insufficient.
export function isEffectivelyEmpty(el: HTMLElement): boolean {
    return Array.from(el.childNodes).every(c => c.instanceOf(Text) && c.data === '');
}

// Removes all child nodes from el.
export function clearChildren(el: HTMLElement): void {
    for (const c of Array.from(el.childNodes)) c.remove();
}

// Ensures el contains exactly a <br> placeholder.
// If el is effectively empty (no children, or only empty Text nodes), strips any
// leftover empty Text nodes and appends a fresh <br>. Does nothing otherwise.
export function ensureBrPlaceholder(el: HTMLElement): void {
    if (!isEffectivelyEmpty(el)) return;
    clearChildren(el);
    el.appendChild(activeDocument.createElement('br'));
}

// ---- Pure computation ----

export function rawOffsetForExpand(el: HTMLElement, node: Node, offset: number): number {
    if (el.tagName === 'RUBY') {
        const explicit = el.getAttribute('data-ruby-explicit') !== 'false';
        const prefix = explicit ? 1 : 0;
        const baseLen = Array.from(el.childNodes)
            .filter(n => !(n.instanceOf(HTMLElement) && n.tagName === 'RT'))
            .reduce((sum, n) => sum + (n.textContent?.length ?? 0), 0);
        const rt = el.querySelector('rt');
        if (rt && rt.contains(node)) {
            return prefix + baseLen + 1 + offset;
        } else {
            return prefix + offset;
        }
    } else {
        // <span data-tcy="explicit"> / <span data-bouten>: the content part is at the beginning
        return offset;
    }
}

// Counts visible characters in a paragraph div, excluding <rt> content and U+200B placeholders.
// Used by EditorElement and ParagraphVirtualizer to compute per-div viewLen consistently.
export function computeDivViewLen(div: HTMLElement, rootEl: HTMLElement): number {
    let count = 0;
    const walker = activeDocument.createTreeWalker(div, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode() as Text | null;
    while (node) {
        if (!isInsideRtNode(node, rootEl)) {
            count += findCursorAnchorAncestor(node, rootEl)
                ? (node.textContent ?? '').replace(/\u200B/g, '').length
                : node.length;
        }
        node = walker.nextNode() as Text | null;
    }
    return count;
}

// Computes view offset (visible char count) from the start of div to (targetNode, targetOffset).
// Applies the same rules as computeDivViewLen: excludes RT text and U+200B cursor anchors.
export function computeViewOffsetInDiv(
    div: HTMLElement, editorEl: HTMLElement,
    targetNode: Node, targetOffset: number,
): number {
    let count = 0;
    const walker = activeDocument.createTreeWalker(div, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode() as Text | null;
    while (node) {
        if (!isInsideRtNode(node, editorEl)) {
            const isAnchor = !!findCursorAnchorAncestor(node, editorEl);
            if (node === targetNode) {
                count += isAnchor
                    ? (node.textContent ?? '').slice(0, targetOffset).replace(/\u200B/g, '').length
                    : targetOffset;
                return count;
            }
            count += isAnchor
                ? (node.textContent ?? '').replace(/\u200B/g, '').length
                : node.length;
        }
        node = walker.nextNode() as Text | null;
    }
    return count;
}

// Computes the DOM position (node, offset) corresponding to viewOff within div.
// Falls back to { node: div, offset: div.childNodes.length } when viewOff exceeds the div.
export function computeDomPositionFromViewOff(
    div: HTMLElement, editorEl: HTMLElement, viewOff: number,
): { node: Node; offset: number } {
    let remaining = viewOff;
    const walker = activeDocument.createTreeWalker(div, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode() as Text | null;
    while (node) {
        if (!isInsideRtNode(node, editorEl)) {
            const isAnchor = !!findCursorAnchorAncestor(node, editorEl);
            const text = node.textContent ?? '';
            if (isAnchor) {
                const visLen = text.replace(/\u200B/g, '').length;
                if (remaining <= visLen) {
                    let visible = 0;
                    let actualOffset = text.length;
                    for (let ci = 0; ci < text.length; ci++) {
                        if (visible === remaining) { actualOffset = ci; break; }
                        if (text[ci] !== '\u200B') visible++;
                    }
                    return { node, offset: actualOffset };
                }
                remaining -= visLen;
            } else {
                if (remaining <= node.length) return { node, offset: remaining };
                remaining -= node.length;
            }
        }
        node = walker.nextNode() as Text | null;
    }
    return { node: div, offset: div.childNodes.length };
}

export function getExtraCharsFromAnnotation(rawText: string): string {
    const patterns = [
        /［＃「([^「」\n]+)」は縦中横］/,
        /［＃「([^「」\n]+)」に傍点］/,
        /［＃「([^「」\n]+)」は(大|中|小)見出し］/,
    ];
    for (const re of patterns) {
        const m = rawText.match(re);
        if (!m || m.index === undefined) continue;
        const content = m[1];
        const leadingText = rawText.slice(0, m.index);
        if (!leadingText.endsWith(content) && content.length > leadingText.length) {
            const extraCount = content.length - leadingText.length;
            return content.slice(0, extraCount);
        }
    }
    return '';
}

// Returns the direct DIV child of editorEl that contains node, or null if none found.
// Traverses up from node, stopping at editorEl. Only direct children with tagName 'DIV'
// are returned; callers that need to exclude spacers should check the result themselves.
export function findParentDivInEditor(node: Node, editorEl: HTMLElement): HTMLElement | null {
    let current: Node | null = node;
    while (current && current !== editorEl) {
        if (current.instanceOf(HTMLElement)
                && current.parentElement === editorEl
                && current.tagName === 'DIV') {
            return current;
        }
        current = current.parentElement;
    }
    return null;
}
