import { sanitizeHTMLToDom } from 'obsidian';
import { DEFAULT_SETTINGS, TatePluginSettings } from '../settings';
import { buildSegmentMap, srcToView } from './SegmentMap';
import { parseInlineToHtml, parseToHtml, serializeNode } from './AozoraParser';
import { InlineEditor } from './InlineEditor';
import { InputTransformer } from './InputTransformer';
import { isEffectivelyEmpty, clearChildren, ensureBrPlaceholder } from './domHelpers';

export class EditorElement {
    readonly el: HTMLDivElement;
    private readonly inlineEditor: InlineEditor;
    private readonly inputTransformer: InputTransformer;

    constructor(container: HTMLElement) {
        this.el = container.createEl('div');
        this.el.addClass('tate-editor');
        this.el.setAttribute('contenteditable', 'true');
        this.el.setAttribute('spellcheck', 'false');
        this.el.setAttribute('data-placeholder', 'ファイルを開いてください');
        this.inlineEditor = new InlineEditor(this.el);
        this.inputTransformer = new InputTransformer(this.el, DEFAULT_SETTINGS);
    }

    getValue(): string {
        return Array.from(this.el.childNodes)
            .map(n => serializeNode(n, this.el))
            .join('');
    }

    setValue(content: string, preserveCursor: boolean): void {
        // Reset expansion state and selection cache on external update (must run before the early return)
        this.inlineEditor.reset();
        // Also require childNodes.length > 0: parseToHtml('') returns '<div><br></div>', so
        // getValue() and content are both '' for an empty file, but the DOM is still empty
        // on initial load and must be populated with the paragraph div.
        if (this.getValue() === content && this.el.childNodes.length > 0) return;

        if (preserveCursor && document.activeElement === this.el) {
            const pos = this.getVisibleOffset();
            this.el.replaceChildren(sanitizeHTMLToDom(parseToHtml(content)));
            this.setVisibleOffset(pos);
        } else {
            this.el.replaceChildren(sanitizeHTMLToDom(parseToHtml(content)));
        }
    }

    // ---- Inline expand/collapse (call from selectionchange) ----

    handleSelectionChange(): boolean {
        return this.inlineEditor.handleSelectionChange();
    }

    collapseForEnter(): boolean {
        return this.inlineEditor.collapseForEnter();
    }

    // ---- Ruby / tcy live conversion (call from input/compositionend) ----

    handleRubyCompletion(): boolean {
        return this.inlineEditor.handleRubyCompletion();
    }

    handleTcyCompletion(): boolean {
        return this.inlineEditor.handleTcyCompletion();
    }

    handleBoutenCompletion(): boolean {
        return this.inlineEditor.handleBoutenCompletion();
    }

    // ---- Selection wrap methods called from the command palette ----

    wrapSelectionWithRuby(): boolean {
        return this.inlineEditor.wrapSelectionWithRuby();
    }

    wrapSelectionWithTcy(): boolean {
        return this.inlineEditor.wrapSelectionWithTcy();
    }

    wrapSelectionWithBouten(): boolean {
        return this.inlineEditor.wrapSelectionWithBouten();
    }

    // Copy handler: serializes the selected DOM to Aozora notation and writes it to text/plain.
    // This ensures ruby/tcy/bouten are preserved when copying within the editor.
    handleCopy(e: ClipboardEvent): void {
        this.serializeSelectionToClipboard(e);
    }

    // Cut handler: same as copy, then deletes the selected content.
    handleCut(e: ClipboardEvent): void {
        const range = this.serializeSelectionToClipboard(e);
        if (!range) return;
        // Pre-identify empty paragraph divs (only <br>) that may have their placeholder
        // removed by deleteContents(). After the cut, any such div with no remaining
        // children must be removed: <div></div> serializes identically to <div><br></div>
        // ('\n'), so getValue() sees no change and commitToCm6() skips the CM6 update.
        // This covers both same-div selections and cross-div selections where the empty
        // line falls within the range.
        const emptyLineDivs = Array.from(this.el.children).filter(
            (n): n is HTMLElement =>
                n instanceof HTMLElement &&
                n.tagName === 'DIV' &&
                n.childNodes.length === 1 &&
                n.firstChild?.nodeName === 'BR'
        );
        range.deleteContents();
        // Empty-line divs that had their <br> removed by deleteContents() represent
        // a whole empty paragraph being cut — remove the shell entirely.
        for (const div of emptyLineDivs) {
            if (div.isConnected && isEffectivelyEmpty(div)) div.remove();
        }
        // Any remaining <div> whose text was fully cut must have its <br> placeholder
        // restored. deleteContents() on a full text selection leaves the text node in
        // place with data === '' rather than removing it; ensureBrPlaceholder handles both
        // the childNodes.length === 0 and the empty-Text-node cases.
        for (const child of Array.from(this.el.children)) {
            if (child instanceof HTMLElement && child.tagName === 'DIV')
                ensureBrPlaceholder(child);
        }
        // view.ts calls commitToCm6() after cut
    }

    // Serializes the current selection to Aozora notation and writes it to text/plain.
    // Returns the range on success (for cut to delete), or null if nothing to serialize.
    private serializeSelectionToClipboard(e: ClipboardEvent): Range | null {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return null;
        const range = sel.getRangeAt(0);
        if (range.collapsed || !this.el.contains(range.commonAncestorContainer)) return null;
        e.preventDefault();
        const fragment = range.cloneContents();
        const text = Array.from(fragment.childNodes)
            .map(n => serializeNode(n, this.el))
            .join('');
        // A single empty paragraph div (<div><br></div>) is the first child of the fragment
        // and has previousSibling === null, so serializeNode returns '' for it. Map '' to
        // '\n' so pasting an empty line inserts an empty paragraph rather than doing nothing.
        const clipboardText = !text && fragment.childNodes.length > 0 ? '\n' : text;
        e.clipboardData?.setData('text/plain', clipboardText);
        return range;
    }

    // Paste handler: parses Aozora notation in the pasted text and inserts rendered inline elements.
    // Multi-line paste creates one <div> per line (matching Enter-key paragraph behavior).
    // Returns newly created off-screen divs that need a proactive layout cache refresh.
    // Single-line paste into a visible cursor div returns [] (cache updates naturally on-screen).
    handlePaste(e: ClipboardEvent): HTMLDivElement[] {
        e.preventDefault();
        const text = e.clipboardData?.getData('text/plain') ?? '';
        if (!text) return [];

        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return [];

        const range = sel.getRangeAt(0);
        range.deleteContents();

        // In vertical writing mode the selection boundaries often land at the editor root
        // level (this.el) rather than inside a paragraph div. When that happens,
        // deleteContents() may delete only the <br> placeholder of an empty paragraph div,
        // leaving a <div></div> shell adjacent to the collapsed cursor. Move the cursor
        // into that shell so that subsequent paste logic inserts content at the correct
        // location instead of creating a bare text node directly inside this.el.
        if (range.startContainer === this.el) {
            const at     = this.el.childNodes[range.startOffset] as Node | undefined;
            const before = this.el.childNodes[range.startOffset - 1] as Node | undefined;
            // A paragraph div is a target for cursor adoption if it has no children, or if
            // all children are empty Text nodes left by splitText(0) during deleteContents().
            const isParagraphEmpty = (n: Node | undefined): n is HTMLElement =>
                n instanceof HTMLElement && n.tagName === 'DIV' && isEffectivelyEmpty(n);
            // Move cursor into the empty shell and strip any empty text node artifacts.
            const adoptDiv = (div: HTMLElement) => {
                clearChildren(div);
                range.setStart(div, 0);
                range.collapse(true);
            };
            if (isParagraphEmpty(at)) {
                adoptDiv(at);
            } else if (isParagraphEmpty(before)) {
                adoptDiv(before);
            }
        }

        const lines = text.split('\n');
        // When the cursor is still at the editor root level (no adjacent empty div to adopt),
        // route single-line paste through insertParsedParagraphs, which has a dedicated
        // handler for the this.el case and creates a proper <div> instead of a bare text node.
        let newDivs: HTMLDivElement[];
        if (lines.length === 1 && range.startContainer !== this.el) {
            this.insertParsedInline(range, lines[0]);
            newDivs = []; // cursor div is always visible; cache updates naturally
        } else {
            newDivs = this.insertParsedParagraphs(range, lines);
        }

        // beforeinput does not fire for paste, so set inBurst manually
        this.inlineEditor.onBeforeInput();
        // view.ts calls commitToCm6() after paste
        return newDivs;
    }

    // Inserts parsed Aozora inline elements at the range position (single-line paste).
    private insertParsedInline(range: Range, line: string): void {
        const sel = window.getSelection()!;
        if (line) {
            const frag = sanitizeHTMLToDom(parseInlineToHtml(line));
            for (const node of Array.from(frag.childNodes)) {
                range.insertNode(node);
                range.setStartAfter(node);
                range.collapse(true);
            }
        }
        sel.removeAllRanges();
        sel.addRange(range);
    }

    // Inserts parsed lines as separate paragraph <div>s (multi-line paste).
    // Splits the current paragraph at the cursor: first line appends to it,
    // each remaining line becomes a new <div>, and after-cursor content moves to the last.
    // Returns newly created <div>s that may be off-screen and need a layout cache refresh.
    private insertParsedParagraphs(range: Range, lines: string[]): HTMLDivElement[] {
        const sel = window.getSelection()!;
        const paragraphDiv = this.findParagraphDiv(range.startContainer);

        // Cursor is directly on the editor element (between paragraph divs, not inside one).
        // This happens after deleteContents() removes whole-paragraph divs and collapses
        // the range to an inter-div offset on the editor root. Insert new <div>s at that
        // position instead of falling through to the <br> fallback, which would create
        // bare text nodes and <br>s directly inside the editor and corrupt patchParagraphs.
        if (!this.inlineEditor.isExpanded() && range.startContainer === this.el) {
            const refNode = this.el.childNodes[range.startOffset] ?? null;
            const newDivs: HTMLDivElement[] = [];
            let lastDiv: HTMLDivElement | null = null;
            for (const line of lines) {
                const div = document.createElement('div');
                div.replaceChildren(sanitizeHTMLToDom(parseInlineToHtml(line) || '<br>'));
                this.el.insertBefore(div, refNode);
                newDivs.push(div);
                lastDiv = div;
            }
            if (lastDiv) {
                const r = document.createRange();
                r.selectNodeContents(lastDiv);
                r.collapse(false);
                sel.removeAllRanges();
                sel.addRange(r);
            }
            return newDivs;
        }

        if (!paragraphDiv || this.inlineEditor.isExpanded()) {
            // Fallback: insert as <br>-separated inline content.
            // Used when an inline element is expanded (splitting the div would corrupt the tate-editing span).
            for (let i = 0; i < lines.length; i++) {
                if (i > 0) {
                    const br = document.createElement('br');
                    range.insertNode(br);
                    range.setStartAfter(br);
                    range.collapse(true);
                }
                if (lines[i]) {
                    const frag = sanitizeHTMLToDom(parseInlineToHtml(lines[i]));
                    for (const node of Array.from(frag.childNodes)) {
                        range.insertNode(node);
                        range.setStartAfter(node);
                        range.collapse(true);
                    }
                }
            }
            sel.removeAllRanges();
            sel.addRange(range);
            return []; // same div, always visible; no cache refresh needed
        }

        // Extract content from cursor to end of paragraph
        const afterRange = document.createRange();
        afterRange.selectNodeContents(paragraphDiv);
        afterRange.setStart(range.startContainer, range.startOffset);
        const afterFragment = afterRange.extractContents();
        // extractContents() splits a text node at the cursor offset, leaving '' empty text
        // nodes in both directions:
        //   cursor at START of text node → '' stays in paragraphDiv, real text → fragment
        //   cursor at END of text node   → real text stays in paragraphDiv, '' → fragment
        // Either empty text node causes childNodes.length > 0, bypassing the <br> placeholder
        // check and producing an invisible <div></div>. Strip empty text nodes from both.
        for (const n of Array.from(paragraphDiv.childNodes)) {
            if (n instanceof Text && n.data === '') n.remove();
        }
        for (const n of Array.from(afterFragment.childNodes)) {
            if (n instanceof Text && n.data === '') n.remove();
        }

        // Append first line to the current (now truncated) paragraph
        const firstFrag = sanitizeHTMLToDom(parseInlineToHtml(lines[0]));
        paragraphDiv.append(...Array.from(firstFrag.childNodes));
        ensureBrPlaceholder(paragraphDiv);
        // paragraphDiv (lines[0]) is the cursor's current paragraph — always visible; not collected.

        // Create a new <div> for each remaining line
        let insertAfter: Element = paragraphDiv;
        let lastPastedNode: Node | null = null;
        const newDivs: HTMLDivElement[] = [];

        for (let i = 1; i < lines.length; i++) {
            const div = document.createElement('div');
            const lineFrag = sanitizeHTMLToDom(parseInlineToHtml(lines[i]));
            const lineNodes = Array.from(lineFrag.childNodes);
            div.append(...lineNodes);
            lastPastedNode = lineNodes.length > 0 ? lineNodes[lineNodes.length - 1] : null;

            if (i === lines.length - 1) {
                // Last paragraph: attach the original after-cursor content
                div.append(...Array.from(afterFragment.childNodes));
            }

            ensureBrPlaceholder(div);

            insertAfter.after(div);
            insertAfter = div;
            newDivs.push(div); // these N-1 divs may be off-screen
        }

        // Position cursor at end of pasted content (before the after-cursor content)
        const newRange = document.createRange();
        if (lastPastedNode) {
            newRange.setStartAfter(lastPastedNode);
        } else {
            newRange.setStart(insertAfter, 0);
        }
        newRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(newRange);
        return newDivs;
    }

    // Returns the direct <div> child of this.el that contains node, or null.
    private findParagraphDiv(node: Node): HTMLElement | null {
        let current: Node | null = node;
        while (current && current !== this.el) {
            if (current.parentElement === this.el && current instanceof HTMLElement && current.tagName === 'DIV') {
                return current;
            }
            current = current.parentElement;
        }
        return null;
    }

    // Restores a minimal <div><br></div> if Chrome deleted all paragraph divs (e.g., Backspace on last char).
    normalizeEmptyDom(): void {
        if (this.el.childNodes.length > 0) return;
        const div = document.createElement('div');
        div.appendChild(document.createElement('br'));
        this.el.appendChild(div);
        const range = document.createRange();
        range.setStart(div, 0);
        range.collapse(true);
        const sel = window.getSelection();
        if (sel) { sel.removeAllRanges(); sel.addRange(range); }
    }

    // Removes any <div></div> children left by Chrome's native cut-line behavior.
    // Called from the input handler when inputType === 'deleteByCut'.
    cleanupEmptyParagraphDivs(): void {
        for (const child of Array.from(this.el.childNodes)) {
            if (child instanceof HTMLElement && child.tagName === 'DIV' && isEffectivelyEmpty(child))
                child.remove();
        }
    }

    // Clears all content and shows the placeholder (used when no file is active).
    clearContent(): void {
        this.inlineEditor.reset();
        this.el.replaceChildren();
    }

    applySettings(settings: TatePluginSettings): void {
        this.el.style.fontFamily = settings.fontFamily;
        this.el.style.fontSize = `${settings.fontSize}px`;
        this.el.style.lineBreak = settings.lineBreak;
        this.inputTransformer.updateSettings(settings);
        this.inlineEditor.setExpandSettings(
            !settings.suppressRubyInline,
            !settings.suppressTcyInline,
            !settings.suppressBoutenInline,
        );
    }

    adjustWidth(): void { /* no-op: contenteditable div auto-sizes */ }

    focus(): void {
        this.el.focus();
    }

    // Called on beforeinput event (registered from view.ts).
    // For non-IME insertText when cursor is inside a post-collapse bouten span
    // (Chrome normalized it back in), intercepts the event and inserts the character
    // after the span instead. Chrome's Selection API normalization is synchronous and
    // cannot be countered with sel.addRange, so Range-level insertion is used instead.
    onBeforeInput(e: InputEvent): void {
        this.inlineEditor.onBeforeInput();
        if (!e.isComposing && e.inputType === 'insertText' && e.data) {
            const boutenSpan = this.inlineEditor.getCursorBoutenSpan();
            if (boutenSpan) {
                e.preventDefault();
                const char = this.inputTransformer.applySpaceConversion(e.data);
                this.inlineEditor.insertAfterBouten(boutenSpan, char);
                return;
            }
        }
        this.inputTransformer.handleBeforeInput(e);
    }

    // Called after Enter (insertParagraph input event) from view.ts.
    handleParagraphInsert(): void {
        this.inputTransformer.handleParagraphInsert();
    }

    // Called on compositionstart (registered from view.ts).
    onCompositionStart(): void {
        this.inputTransformer.handleCompositionStart();
    }

    // Called in compositionend (before commitToCm6) to move IME text that landed inside a
    // post-collapse bouten span out to after the span. Returns true if the DOM was changed.
    handleBoutenPostCollapseInput(): boolean {
        return this.inlineEditor.handleBoutenPostCollapseInput();
    }

    // Called on compositionend (registered from view.ts), before commitToCm6.
    onCompositionEnd(): void {
        this.inputTransformer.handleCompositionEnd();
    }

    // Resets the burst flag after a commit. Does NOT clear boutenGuard.
    afterCommit(): void {
        this.inlineEditor.afterCommit();
    }

    // Resets the burst flag and clears boutenGuard on mouse click or navigation key.
    afterNavigation(): void {
        this.inlineEditor.afterNavigation();
    }

    // Called after CM6 Undo/Redo. Applies content to the vertical writing view and
    // restores the cursor by converting srcOffset (CM6 cursor position) via srcToView.
    // prevContent must equal the current DOM content (caller guarantees prevContent !== content).
    // Returns the changed/added divs for proactive layout cache refresh, or null if patchParagraphs
    // fell back to a full replaceChildren (hasCleanDivStructure failed).
    applyFromCm6(prevContent: string, content: string, srcOffset: number): HTMLDivElement[] | null {
        // Clear any expanded span (CM6 state is the source of truth, so force reset)
        this.inlineEditor.reset();
        // Patch only the paragraph divs whose source line changed, preserving the
        // content-visibility: auto size cache for unchanged paragraphs. This avoids the
        // O(N) replaceChildren cost and prevents the scroll-width collapse that causes
        // scroll position to jump after Undo/Redo on large files.
        const changedDivs = this.patchParagraphs(prevContent, content);
        // Convert CM6 source offset to visible offset and restore cursor
        const segs = buildSegmentMap(content);
        const viewOffset = srcToView(segs, srcOffset);
        this.setVisibleOffset(viewOffset);
        return changedDivs;
    }

    // Updates paragraph divs to match nextContent, replacing only divs whose line changed.
    // Returns the changed/added divs, or null if hasCleanDivStructure failed (full rebuild).
    private patchParagraphs(prevContent: string, nextContent: string): HTMLDivElement[] | null {
        const prevLines = prevContent.split('\n');
        const nextLines = nextContent ? nextContent.split('\n') : [''];
        const el = this.el;

        // The invariant for differential patching: every direct child of el is a <div>
        // element and el.childNodes.length equals prevLines.length. This breaks when the
        // paste fallback path (cursor on the editor element itself rather than inside a
        // child div) inserts bare text nodes and <br>s directly into the editor. Using
        // el.children would count <br> as an element child and produce a false positive,
        // so we walk el.childNodes and verify that every node is a <div>.
        if (!this.hasCleanDivStructure(prevLines.length)) {
            el.replaceChildren(sanitizeHTMLToDom(parseToHtml(nextContent)));
            return null;
        }

        // Adjust paragraph count without touching unchanged trailing divs
        while (el.children.length < nextLines.length) {
            el.appendChild(document.createElement('div'));
        }
        while (el.children.length > nextLines.length) {
            el.removeChild(el.lastChild!);
        }

        const changedDivs: HTMLDivElement[] = [];
        for (let i = 0; i < nextLines.length; i++) {
            if (prevLines[i] === nextLines[i]) {
                // Defensive: a prior paste may have left a <div></div> (empty div without <br>)
                // for an empty line. The content is identical so the diff skips it, but the
                // missing <br> makes the column invisible. Restore it here.
                if (nextLines[i] === '') ensureBrPlaceholder(el.children[i] as HTMLElement);
                continue;
            }
            const div = el.children[i] as HTMLDivElement;
            const html = parseInlineToHtml(nextLines[i]) || '<br>';
            div.replaceChildren(sanitizeHTMLToDom(html));
            changedDivs.push(div);
        }
        return changedDivs;
    }

    // Returns true iff el.childNodes consists of exactly expectedCount <div> elements.
    // Used by patchParagraphs to detect DOM structure corruption (e.g. bare text nodes
    // or <br>s inserted directly into the editor by the paste fallback path).
    private hasCleanDivStructure(expectedCount: number): boolean {
        if (this.el.childNodes.length !== expectedCount) return false;
        for (const node of Array.from(this.el.childNodes)) {
            if (!(node instanceof HTMLElement) || node.tagName !== 'DIV') return false;
        }
        return true;
    }

    /** Returns whether a tate-editing span is currently expanded (used by view.ts to decide cursor sync). */
    isInlineExpanded(): boolean {
        return this.inlineEditor.isExpanded();
    }

    /** Returns the current cursor position in the vertical writing view as a visible offset (used by view.ts for cursor sync). */
    getViewCursorOffset(): number {
        return this.getVisibleOffset();
    }

    /** Sets the cursor position in the vertical writing view from a visible offset (used for cursor restore after file load). */
    setViewCursorOffset(offset: number): void {
        this.setVisibleOffset(offset);
    }

    /** Scrolls the current cursor position into view. Defaults to centering; pass 'nearest' for minimal scroll. */
    scrollCursorIntoView(block: ScrollLogicalPosition = 'center', _inline: ScrollLogicalPosition = 'center'): void {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        this.scrollRangeIntoView(sel.getRangeAt(0), block);
    }

    /** Scrolls an arbitrary Range into view using block:'center'. Used by SearchPanel to scroll
     *  to search hits without scrolling to the paragraph boundary for long multi-column paragraphs. */
    scrollToRange(range: Range): void {
        this.scrollRangeIntoView(range, 'center');
    }

    /** Scrolls a Range into view by computing the horizontal scroll offset from the range's
     *  bounding rect rather than calling element.scrollIntoView(). For long paragraphs that span
     *  multiple columns, element.scrollIntoView() scrolls to the element boundary (paragraph center
     *  or edge) instead of the column containing the range. The rect-based approach is exact.
     *  Also forces a layout flush via getBoundingClientRect(), which — when tate-scroll-restoring
     *  or tate-layout-refreshing is active — runs with content-visibility:visible on the relevant
     *  divs, so the returned rect reflects actual (not cached) sizes. */
    private scrollRangeIntoView(range: Range, block: ScrollLogicalPosition): void {
        const container = this.el.parentElement; // .tate-scroll-area (overflow-x: auto)
        if (!container) return;

        const rect = range.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
            // Range not yet laid out — fall back to element-based scroll.
            const node = range.startContainer;
            (node instanceof Element ? node : node.parentElement)?.scrollIntoView({ block, inline: 'nearest' });
            return;
        }

        const containerRect = container.getBoundingClientRect();
        const viewWidth = container.clientWidth;
        // Convert range viewport x-coordinates to the container's scroll coordinate space:
        //   absolute_x = viewport_x - container_left + scrollLeft
        const absLeft  = rect.left  - containerRect.left + container.scrollLeft;
        const absRight = rect.right - containerRect.left + container.scrollLeft;

        let newScrollLeft: number;
        if (block === 'nearest') {
            const visLeft  = container.scrollLeft;
            const visRight = container.scrollLeft + viewWidth;
            if (absLeft >= visLeft && absRight <= visRight) return; // already fully visible
            newScrollLeft = absLeft < visLeft ? absLeft : absRight - viewWidth;
        } else {
            // 'center': place the range at the horizontal midpoint of the viewport.
            newScrollLeft = absLeft - (viewWidth - (absRight - absLeft)) / 2;
        }

        container.scrollLeft = Math.max(0, Math.min(container.scrollWidth - viewWidth, newScrollLeft));
    }

    // Called after input/compositionend to manage U+200B in the cursor anchor span.
    handleCursorAnchorInput(): void {
        this.inlineEditor.handleCursorAnchorInput();
    }

    // Records the direction of the most recent navigation key for anchor skip.
    notifyNavigationKey(key: string): void {
        this.inlineEditor.notifyNavigationKey(key);
    }

    // Intercepts ArrowUp/ArrowDown inside a tcy span and moves the cursor left/right instead.
    // Returns true if the key was consumed (caller should call preventDefault).
    handleTcyNavigation(key: string): boolean {
        return this.inlineEditor.handleTcyNavigation(key);
    }

    // ---- Cursor operations (offset managed in visible character count, excluding <rt> and U+200B) ----

    private getVisibleOffset(): number {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return 0;
        const range = sel.getRangeAt(0);
        let count = 0;
        const walker = document.createTreeWalker(this.el, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode() as Text | null;

        while (node) {
            if (node === range.startContainer) {
                if (!this.isInsideRt(node)) {
                    const text = node.textContent ?? '';
                    const beforeCursor = this.isInsideAnchorSpan(node)
                        ? text.slice(0, range.startOffset).replace(/\u200B/g, '').length
                        : range.startOffset;
                    count += beforeCursor;
                }
                break;
            }
            if (!this.isInsideRt(node)) {
                count += this.isInsideAnchorSpan(node)
                    ? (node.textContent ?? '').replace(/\u200B/g, '').length
                    : node.length;
            }
            node = walker.nextNode() as Text | null;
        }
        return count;
    }

    private setVisibleOffset(offset: number): void {
        const sel = window.getSelection();
        if (!sel) return;
        let remaining = offset;
        const walker = document.createTreeWalker(this.el, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode() as Text | null;

        while (node) {
            if (!this.isInsideRt(node)) {
                const visLen = this.isInsideAnchorSpan(node)
                    ? (node.textContent ?? '').replace(/\u200B/g, '').length
                    : node.length;
                if (remaining <= visLen) {
                    const range = document.createRange();
                    let actualOffset: number;
                    if (this.isInsideAnchorSpan(node)) {
                        // Map visible offset to actual offset, skipping U+200B
                        const text = node.textContent ?? '';
                        actualOffset = 0;
                        let visible = 0;
                        for (let i = 0; i < text.length; i++) {
                            if (visible === remaining) { actualOffset = i; break; }
                            if (text[i] !== '\u200B') visible++;
                            actualOffset = i + 1;
                        }
                    } else {
                        actualOffset = remaining;
                    }
                    range.setStart(node, actualOffset);
                    range.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(range);
                    return;
                }
                remaining -= visLen;
            }
            node = walker.nextNode() as Text | null;
        }

        const range = document.createRange();
        range.selectNodeContents(this.el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
    }

    private isInsideRt(node: Node): boolean {
        let parent = node.parentElement;
        while (parent && parent !== this.el) {
            if (parent.tagName === 'RT') return true;
            parent = parent.parentElement;
        }
        return false;
    }

    private isInsideAnchorSpan(node: Node): boolean {
        let parent = node.parentElement;
        while (parent && parent !== this.el) {
            if (parent.classList.contains('tate-cursor-anchor')) return true;
            parent = parent.parentElement;
        }
        return false;
    }
}
