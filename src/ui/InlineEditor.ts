import { sanitizeHTMLToDom } from 'obsidian';
import { KANJI_RE_STR, parseInlineToHtml, serializeNode } from './AozoraParser';

export class InlineEditor {
    // The editing span currently expanded inline. null if not expanded.
    private expandedEl: HTMLSpanElement | null = null;
    // Guard to prevent re-entry during DOM manipulation inside the selectionchange handler
    private isModifyingDom = false;
    // Serialized text captured at expandForEditing time (used to detect changes in collapseEditing)
    private expandedElOriginalText: string | null = null;
    // Cached selection range for command execution (retained even after focus leaves due to command palette)
    private savedRange: {
        startContainer: Node; startOffset: number;
        endContainer: Node; endOffset: number;
    } | null = null;
    // Flag indicating there are uncommitted changes pending for CM6.
    // Set by onBeforeInput, cleared by resetBurst() when commitToCm6() completes.
    private inBurst = false;

    constructor(private readonly el: HTMLDivElement) {}

    // Resets expansion state, selection cache, and burst flag (called from setValue / applyFromCm6)
    reset(): void {
        this.expandedEl = null;
        this.expandedElOriginalText = null;
        this.savedRange = null;
        this.inBurst = false;
    }

    isExpanded(): boolean {
        return this.expandedEl !== null;
    }

    // ---- Inline expand/collapse (call from selectionchange) ----

    // Called on every cursor movement to expand or collapse ruby/tcy elements.
    // Returns true if collapse changed the content (signal for view.ts to call commitToCm6).
    handleSelectionChange(): boolean {
        // Update the cache only when not in DOM manipulation and there is a non-collapsed selection inside the editor
        // (retaining it when focus leaves allows access after the command palette is opened)
        if (!this.isModifyingDom) {
            // Synchronize expandedEl with the actual tate-editing span in the DOM
            if (!this.expandedEl || !this.expandedEl.isConnected) {
                const actualSpan = this.el.querySelector<HTMLSpanElement>('span.tate-editing');
                if (actualSpan !== this.expandedEl) {
                    this.expandedEl = actualSpan;
                    // Original text is unknown, so set to null to force hasChanged = true
                    this.expandedElOriginalText = null;
                }
            }

            const sc = window.getSelection();
            if (sc && sc.rangeCount > 0) {
                const rc = sc.getRangeAt(0);
                if (!rc.collapsed
                    && this.el.contains(rc.startContainer)
                    && this.el.contains(rc.endContainer)) {
                    this.savedRange = {
                        startContainer: rc.startContainer,
                        startOffset: rc.startOffset,
                        endContainer: rc.endContainer,
                        endOffset: rc.endOffset,
                    };
                }
            }
        }
        if (this.isModifyingDom) return false;
        // Early return for selectionchange outside the editor unless expanded (guards against multiple views)
        const sel0 = window.getSelection();
        if (!this.expandedEl && (!sel0 || sel0.rangeCount === 0 ||
            !this.el.contains(sel0.getRangeAt(0).startContainer))) return false;
        let contentChanged = false;
        this.isModifyingDom = true;
        try {
            const sel = window.getSelection();
            if (!sel || sel.rangeCount === 0) return false;
            const range = sel.getRangeAt(0);

            // Cursor is still inside the expanded span — do nothing
            if (this.expandedEl && this.expandedEl.contains(range.startContainer)) {
                return false;
            }

            // Cursor moved outside the expanded span — collapse, then restore the intended position
            if (this.expandedEl) {
                const savedNode = range.startContainer;
                const savedOffset = range.startOffset;

                contentChanged = this.collapseEditing();
                this.savedRange = null; // Discard stale node reference after collapse

                // Restore the cursor to the position the user moved to (savedNode)
                if (savedNode.isConnected && this.el.contains(savedNode)) {
                    try {
                        const maxOffset = savedNode.nodeType === Node.TEXT_NODE
                            ? (savedNode as Text).length
                            : savedNode.childNodes.length;
                        const r = document.createRange();
                        r.setStart(savedNode, Math.min(savedOffset, maxOffset));
                        r.collapse(true);
                        sel.removeAllRanges();
                        sel.addRange(r);
                    } catch { /* ignore if node was detached */ }
                }
            }

            // Check if cursor is still inside the editor
            if (sel.rangeCount === 0) return contentChanged;
            const currentRange = sel.getRangeAt(0);
            if (!this.el.contains(currentRange.startContainer)) return contentChanged;

            // Expand if the cursor is inside an expandable element (ruby/tcy)
            const target = this.findExpandableAncestor(currentRange.startContainer);
            if (target) {
                this.expandForEditing(target, currentRange);
            }
        } finally {
            this.isModifyingDom = false;
        }
        return contentChanged;
    }

    // ---- Ruby / tcy live conversion (call from input/compositionend) ----

    // Converts a ruby notation just before the cursor to a <ruby> element when 》 is typed.
    // Returns true if a conversion occurred (signal for view.ts to call commitToCm6).
    handleRubyCompletion(): boolean {
        // Skip if a span is already expanded or if a DOM modification is in progress
        if (this.expandedEl) return false;
        if (this.isModifyingDom) return false;

        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return false;
        const range = sel.getRangeAt(0);
        if (range.startContainer.nodeType !== Node.TEXT_NODE) return false;
        if (this.isInsideRuby(range.startContainer)) return false;

        const textNode = range.startContainer as Text;
        const textBefore = textNode.textContent?.slice(0, range.startOffset) ?? '';
        if (!textBefore.endsWith('》')) return false;

        // Explicit form takes priority: ｜base《rt》 or |base《rt》
        let match = textBefore.match(/[|｜]([^|｜《》\n]+)《([^《》\n]*)》$/);
        let explicit = true;
        if (!match) {
            // Implicit form: preceding run of kanji followed by 《rt》
            match = textBefore.match(new RegExp(`(${KANJI_RE_STR})《([^《》\\n]*)》$`, 'u'));
            explicit = false;
        }
        if (!match) return false;

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

            this.isModifyingDom = true;
            try {
                this.insertAnnotationElement(textNode, matchStart, range.startOffset, span);
                this.expandedEl = span;
                this.expandedElOriginalText = rawText;

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
            } finally {
                this.isModifyingDom = false;
            }
            return true;
        }

        this.isModifyingDom = true;
        try {
            const rubyEl = this.createRubyEl(base, rt, explicit);
            const inserted = this.insertAnnotationElement(
                textNode, matchStart, range.startOffset, rubyEl,
            );

            // Place cursor just after the element
            // If the cursor is inside the ruby, selectionchange fires expandForEditing() immediately
            this.setCursorAfter(inserted);
            return true;
        } finally {
            this.isModifyingDom = false;
        }
    }

    // Converts a tate-chu-yoko notation just before the cursor to a <span class="tcy"> when ］ is typed.
    // Returns true if a conversion occurred.
    handleTcyCompletion(): boolean {
        return this.handleAnnotationCompletion('］', /［＃「([^「」\n]+)」は縦中横］$/, c => this.createTcyEl(c));
    }

    // Converts a bouten notation just before the cursor to a <span class="bouten"> when ］ is typed.
    // Returns true if a conversion occurred.
    handleBoutenCompletion(): boolean {
        return this.handleAnnotationCompletion('］', /［＃「([^「」\n]+)」に傍点］$/, c => this.createBoutenEl(c));
    }

    // ---- Selection wrap methods called from the command palette ----

    // Wraps the selected text in a tate-editing span and places the cursor between 《 and 》
    // When the cursor leaves the span, collapseEditing() collapses it to a <ruby> element
    wrapSelectionWithRuby(): boolean {
        if (this.expandedEl) return false;
        const resolved = this.resolveSelectionRange();
        if (!resolved) return false;
        const { textNode, startOffset, endOffset } = resolved;
        const selectedText = textNode.data.slice(startOffset, endOffset);
        if (!selectedText) return false;

        const rawText = `｜${selectedText}《》`;
        const span = document.createElement('span');
        span.className = 'tate-editing';
        span.textContent = rawText;

        const parentEl = textNode.parentNode as HTMLElement;

        this.isModifyingDom = true;
        try {
            // Direct DOM manipulation: insert span (handles start, end, and middle of line uniformly)
            const precedingText = textNode.data.slice(0, startOffset);
            const followingText = textNode.data.slice(endOffset);
            const next = textNode.nextSibling;
            parentEl.removeChild(textNode);
            if (precedingText) parentEl.insertBefore(document.createTextNode(precedingText), next);
            parentEl.insertBefore(span, next);
            if (followingText) parentEl.insertBefore(document.createTextNode(followingText), next);

            this.expandedEl = span;
            this.expandedElOriginalText = rawText;

            // Place cursor between 《 and 》 (rawText.length - 1 = just before 》)
            const spanText = span.firstChild as Text | null;
            if (spanText) {
                const sel = window.getSelection()!;
                const r = document.createRange();
                r.setStart(spanText, rawText.length - 1);
                r.collapse(true);
                sel.removeAllRanges();
                sel.addRange(r);
            }
        } finally {
            this.isModifyingDom = false;
        }

        this.savedRange = null;
        return true;
    }

    // Wraps the selected text in a tate-chu-yoko element
    wrapSelectionWithTcy(): boolean {
        return this.wrapSelectionWith(c => this.createTcyEl(c));
    }

    // Wraps the selected text in a bouten element
    wrapSelectionWithBouten(): boolean {
        return this.wrapSelectionWith(c => this.createBoutenEl(c));
    }

    // Called on the beforeinput event (registered from view.ts).
    // Sets the inBurst flag to indicate there are uncommitted changes pending for CM6.
    onBeforeInput(): void {
        this.inBurst = true;
    }

    // Resets the burst flag (call after commitToCm6() completes or on navigation in view.ts).
    resetBurst(): void {
        this.inBurst = false;
    }

    // ---- Shared logic for selection wrap and annotation completion ----

    // Shared implementation for element-replacement wraps (tcy, bouten, etc.)
    private wrapSelectionWith(createElement: (content: string) => HTMLElement): boolean {
        if (this.expandedEl) return false;
        const resolved = this.resolveSelectionRange();
        if (!resolved) return false;
        const { textNode, startOffset, endOffset } = resolved;
        const selectedText = textNode.data.slice(startOffset, endOffset);
        if (!selectedText) return false;

        const newEl = createElement(selectedText);

        this.isModifyingDom = true;
        try {
            const inserted = this.insertAnnotationElement(
                textNode, startOffset, endOffset, newEl,
            );

            // Place cursor just after the inserted element
            // If the cursor is inside the element, selectionchange would trigger expandForEditing()
            this.setCursorAfter(inserted);
        } finally {
            this.isModifyingDom = false;
        }
        this.savedRange = null;
        return true;
    }

    // Shared implementation for live conversions that complete on a terminal character (tcy, bouten, etc.).
    // Returns true if a conversion occurred.
    private handleAnnotationCompletion(
        endChar: string,
        re: RegExp,
        createElement: (content: string) => HTMLElement,
    ): boolean {
        // Skip if a span is already expanded or if a DOM modification is in progress
        if (this.expandedEl) return false;
        if (this.isModifyingDom) return false;
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return false;
        const range = sel.getRangeAt(0);
        if (range.startContainer.nodeType !== Node.TEXT_NODE) return false;
        if (this.isInsideRuby(range.startContainer)) return false;

        const textNode = range.startContainer as Text;
        const textBefore = textNode.textContent?.slice(0, range.startOffset) ?? '';
        if (!textBefore.endsWith(endChar)) return false;

        const annotationMatch = textBefore.match(re);
        if (!annotationMatch) return false;

        const content = annotationMatch[1];
        const annotationStart = range.startOffset - annotationMatch[0].length;
        if (!textBefore.slice(0, annotationStart).endsWith(content)) return false;

        this.isModifyingDom = true;
        try {
            const newEl = createElement(content);
            const inserted = this.insertAnnotationElement(
                textNode, annotationStart - content.length, range.startOffset, newEl,
            );

            // Place cursor just after the element
            // If the cursor is inside the element, selectionchange fires expandForEditing() immediately
            this.setCursorAfter(inserted);
            return true;
        } finally {
            this.isModifyingDom = false;
        }
    }

    // ---- Private helpers for inline expand/collapse ----

    // Walks up ancestors from node and returns the first expandable element (ruby or explicit tcy)
    private findExpandableAncestor(node: Node): HTMLElement | null {
        let el: HTMLElement | null = node instanceof HTMLElement ? node : node.parentElement;
        while (el && el !== this.el) {
            if (el.tagName === 'RUBY') return el;
            if (el.tagName === 'SPAN' && el.getAttribute('data-tcy') === 'explicit') return el;
            if (el.tagName === 'SPAN' && el.getAttribute('data-bouten')) return el;
            el = el.parentElement;
        }
        return null;
    }

    // Expands target into a raw-text editing span and sets the cursor to the corresponding position
    private expandForEditing(target: HTMLElement, range: Range): void {
        const rawText = serializeNode(target, this.el);
        const cursorOffset = this.rawOffsetForExpand(
            target, range.startContainer, range.startOffset
        );

        const span = document.createElement('span');
        span.className = 'tate-editing';
        span.textContent = rawText;

        target.parentNode!.replaceChild(span, target);
        this.expandedEl = span;
        this.expandedElOriginalText = rawText; // Saved for change detection in collapseEditing
        this.inBurst = false; // Expansion is a navigation action; treat subsequent input as a new burst.

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
    }

    // Collapses the editing span, re-parses its content, and inserts the result at the original position (caller handles cursor).
    // Returns true if content changed (signal for view.ts to call commitToCm6).
    private collapseEditing(): boolean {
        if (!this.expandedEl) return false;
        // A detached node must be cleared and returned immediately
        // (calling parentNode / selectNode on a detached node throws an exception)
        if (!this.expandedEl.isConnected) {
            this.expandedEl = null;
            this.expandedElOriginalText = null;
            return false;
        }

        let rawText = this.expandedEl.textContent ?? '';
        const hasChanged = this.expandedElOriginalText === null
            || rawText !== this.expandedElOriginalText;

        const parent = this.expandedEl.parentNode!;
        const nextSibling = this.expandedEl.nextSibling;

        // Leading text absorption correction (only meaningful when hasChanged)
        let precedingTextNode: Text | null = null;
        let precedingChars = '';
        if (hasChanged) {
            const extraChars = this.getExtraCharsFromAnnotation(rawText);
            if (extraChars.length > 0) {
                const prev = this.expandedEl.previousSibling;
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
        parent.removeChild(this.expandedEl);
        this.expandedEl = null;
        this.expandedElOriginalText = null;
        const fragment = sanitizeHTMLToDom(html);
        while (fragment.firstChild) {
            parent.insertBefore(fragment.firstChild, nextSibling);
        }

        // After collapse, treat the next input as a new burst
        this.inBurst = false;
        return hasChanged;
    }

    // Converts the cursor position inside an element to a character offset in raw text
    private rawOffsetForExpand(el: HTMLElement, node: Node, offset: number): number {
        if (el.tagName === 'RUBY') {
            const explicit = el.getAttribute('data-ruby-explicit') !== 'false';
            const prefix = explicit ? 1 : 0; // '|'
            const baseLen = Array.from(el.childNodes)
                .filter(n => !(n instanceof HTMLElement && n.tagName === 'RT'))
                .reduce((sum, n) => sum + (n.textContent?.length ?? 0), 0);
            const rt = el.querySelector('rt');

            if (rt && rt.contains(node)) {
                // Cursor is inside <rt>: prefix + base + '《' + offset
                return prefix + baseLen + 1 + offset;
            } else {
                // Cursor is inside the base text: prefix + offset
                return prefix + offset;
            }
        } else {
            // <span data-tcy="explicit"> / <span data-bouten>: raw = 'X［＃「X」は縦中横/に傍点］'
            // The content part (X) is at the beginning
            return offset;
        }
    }

    // Normalizes savedRange and returns { textNode, startOffset, endOffset }.
    private resolveSelectionRange(): { textNode: Text; startOffset: number; endOffset: number } | null {
        const r = this.savedRange;
        if (!r || r.startContainer.nodeType !== Node.TEXT_NODE) return null;
        const textNode = r.startContainer as Text;

        // Ideal case: selection within the same text node
        if (r.endContainer === r.startContainer) {
            if (r.startOffset === r.endOffset) return null; // Empty selection
            return { textNode, startOffset: r.startOffset, endOffset: r.endOffset };
        }

        // Chrome block-end selection: endContainer is the parent element (<div>)
        const parent = textNode.parentNode;
        if (!parent) return null;
        if (r.endContainer === parent) {
            const textNodeIdx = Array.from(parent.childNodes).indexOf(textNode);
            if (textNodeIdx !== -1 && r.endOffset > textNodeIdx) {
                return { textNode, startOffset: r.startOffset, endOffset: textNode.length };
            }
        }
        // Chrome block-end selection: endContainer is a sibling <br> under the same parent
        if (r.endContainer.nodeType === Node.ELEMENT_NODE &&
            (r.endContainer as Element).tagName === 'BR' &&
            r.endContainer.parentNode === parent) {
            return { textNode, startOffset: r.startOffset, endOffset: textNode.length };
        }

        return null;
    }

    // Direct DOM operation: replaces the range [matchStart, matchEnd) of the text node with element.
    private insertAnnotationElement(
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

    // Moves the cursor to just after node.
    private setCursorAfter(node: Node): void {
        const sel = window.getSelection();
        if (!sel) return;
        const r = document.createRange();
        r.setStartAfter(node);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
    }

    // After inline editing, on collapse: returns the characters to absorb from the preceding text node
    // when the annotation 「」content is longer than the leading text inside the span.
    private getExtraCharsFromAnnotation(rawText: string): string {
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

    private isInsideRuby(node: Node): boolean {
        let parent = node.parentElement;
        while (parent && parent !== this.el) {
            if (parent.tagName === 'RUBY') return true;
            parent = parent.parentElement;
        }
        return false;
    }

    private createRubyEl(base: string, rt: string, explicit: boolean): HTMLElement {
        const rubyEl = document.createElement('ruby');
        rubyEl.setAttribute('data-ruby-explicit', String(explicit));
        rubyEl.appendChild(document.createTextNode(base));
        const rtEl = document.createElement('rt');
        rtEl.textContent = rt;
        rubyEl.appendChild(rtEl);
        return rubyEl;
    }

    private createTcyEl(content: string): HTMLElement {
        const span = document.createElement('span');
        span.setAttribute('data-tcy', 'explicit');
        span.className = 'tcy';
        span.textContent = content;
        return span;
    }

    private createBoutenEl(content: string): HTMLElement {
        const span = document.createElement('span');
        span.setAttribute('data-bouten', 'sesame');
        span.className = 'bouten';
        span.textContent = content;
        return span;
    }
}
