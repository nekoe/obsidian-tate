// ---- Element factories ----

export function createRubyEl(base: string, rt: string, explicit: boolean): HTMLElement {
    const rubyEl = document.createElement('ruby');
    rubyEl.setAttribute('data-ruby-explicit', String(explicit));
    rubyEl.appendChild(document.createTextNode(base));
    const rtEl = document.createElement('rt');
    rtEl.textContent = rt;
    rubyEl.appendChild(rtEl);
    return rubyEl;
}

export function createTcyEl(content: string): HTMLElement {
    const span = document.createElement('span');
    span.setAttribute('data-tcy', 'explicit');
    span.className = 'tcy';
    span.textContent = content;
    return span;
}

export function createBoutenEl(content: string): HTMLElement {
    const span = document.createElement('span');
    span.setAttribute('data-bouten', 'sesame');
    span.className = 'bouten';
    span.textContent = content;
    return span;
}

export function createCursorAnchor(): HTMLSpanElement {
    const anchor = document.createElement('span');
    anchor.className = 'tate-cursor-anchor';
    anchor.appendChild(document.createTextNode('\u200B'));
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
    if (precedingText) parentEl.insertBefore(document.createTextNode(precedingText), next);
    parentEl.insertBefore(element, next);
    if (followingText) parentEl.insertBefore(document.createTextNode(followingText), next);
    return element;
}

export function setCursorAfter(node: Node): void {
    const sel = window.getSelection();
    if (!sel) return;
    const r = document.createRange();
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
    let el: HTMLElement | null = node instanceof HTMLElement ? node : node.parentElement;
    while (el && el !== rootEl) {
        if (pred(el)) return el;
        el = el.parentElement;
    }
    return null;
}

export function findBoutenAncestor(node: Node, rootEl: HTMLElement): HTMLElement | null {
    return findAncestor(node, el => !!el.getAttribute('data-bouten'), rootEl);
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
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let lastText: Text | null = null;
    let node = walker.nextNode() as Text | null;
    while (node) {
        if (!isInsideRtNode(node, rootEl)) lastText = node;
        node = walker.nextNode() as Text | null;
    }
    if (!lastText) return null;
    return { node: lastText, offset: lastText.length };
}

// ---- Pure computation ----

export function rawOffsetForExpand(el: HTMLElement, node: Node, offset: number): number {
    if (el.tagName === 'RUBY') {
        const explicit = el.getAttribute('data-ruby-explicit') !== 'false';
        const prefix = explicit ? 1 : 0;
        const baseLen = Array.from(el.childNodes)
            .filter(n => !(n instanceof HTMLElement && n.tagName === 'RT'))
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

export function getExtraCharsFromAnnotation(rawText: string): string {
    const patterns = [
        /［＃「([^「」\n]+)」は縦中横］/,
        /［＃「([^「」\n]+)」に傍点］/,
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
