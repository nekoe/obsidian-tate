import { sanitizeHTMLToDom } from 'obsidian';
import { buildSegmentMap } from './SegmentMap';
import { parseInlineToHtml } from './AozoraParser';
import { computeViewOffsetInDiv, computeDomPositionFromViewOff, findLastBaseTextInElement } from './domHelpers';

// CSS class applied to both spacer divs so DOM walkers can skip them.
export const SPACER_CLASS = 'tate-spacer';
// CSS line-height value from .tate-editor. In vertical writing mode the column width
// equals fontSize × lineHeight, so this ratio converts fontSizePx to column width.
const VERTICAL_LINE_HEIGHT = 2;

// Pixel margins for scroll-driven window management.
// The scroll container (tate-scroll-area) is standard LTR; leftSpacer occupies
// x=[0, leftSpacerWidth] and rightSpacer occupies x=[W-rightSpacerWidth, W].
// The viewport shows x=[scrollLeft, scrollLeft+clientWidth].
//   EXPAND_MARGIN: expand when a boundary's right/left edge is within this many px of the viewport.
//   SHRINK_MARGIN: shrink when a boundary is more than this many px past the viewport.
// The 440 px gap between the two thresholds prevents oscillation at the boundary.
const EXPAND_MARGIN = 440;
const SHRINK_MARGIN = 880;

// Tracks the "true" selection across the virtual DOM window. When a non-collapsed
// selection spans paragraphs outside the current DOM window, DOM Range endpoints are
// represented by proxy positions at the window boundary (first/last visible paragraph).
// This allows native ::selection highlighting and Shift+Arrow shrink to work correctly.
export interface VirtualSelection {
    anchorParaIdx: number;
    anchorViewOff: number;
    focusParaIdx:  number;
    focusViewOff:  number;
}

export interface ParagraphRecord {
    src: string;     // Aozora source line
    viewLen: number; // visible character count (excluding annotation markers and rt text)
    width: number;   // measured or estimated pixel width; 0 = unknown (never in window)
}

// Manages DOM virtualization.
//
// A sliding DOM window [domStart, domEnd] is kept in the DOM. Off-window paragraphs have no
// DOM node; getValue() / getVisibleOffset() read from paragraphRecords[]. Two spacer divs
// (rightSpacer, leftSpacer) compensate for the missing width so scrollWidth stays constant.
//
// Read path: in-window → serializeNode / computeDivViewLen (DOM)
//            off-window → paragraphRecords[i].src / .viewLen
//
// Window management: driven by the scroll event. On each scroll, adjustWindowOnScroll()
// computes the visible range from scrollLeft and spacer widths and expands/shrinks the
// window to maintain EXPAND_MARGIN px of preloaded content on each side. No
// IntersectionObserver is used — this avoids the "initial delivery" problem where IO
// reports the current state of a newly-observed div, making it impossible to distinguish
// "boundary is already in zone" from "boundary just entered zone".
export class ParagraphVirtualizer {
    // Per-paragraph data store indexed 1:1 with paragraphs (not DOM children).
    // Maintained by initRecords() / spliceRecords() / syncWindowSrcs().
    readonly paragraphRecords: ParagraphRecord[] = [];

    // DOM window state. domStart and domEnd are inclusive indices into paragraphRecords.
    // domEnd = -1 signals "no records loaded yet" (initial state before first setValue).
    domStart = 0;
    domEnd   = -1;

    // Virtual selection: tracks true selection endpoints when a non-collapsed selection
    // spans paragraphs outside the DOM window. Null when no gap-spanning selection is active.
    private virtualSelection: VirtualSelection | null = null;
    // Counter incremented for each programmatic sel.setBaseAndExtent() call; decremented
    // by a 0ms setTimeout after the selectionchange microtask has fired. When > 0, the
    // selectionchange handler skips VS sync to avoid an infinite re-entry loop.
    private programmaticSelectionUpdates = 0;

    // Spacer divs inserted at the right (first child) and left (last child) of editorEl.
    rightSpacer: HTMLElement | null = null;
    leftSpacer:  HTMLElement | null = null;

    // Accumulated pixel widths of paragraphs evicted to the right and left spacers.
    private rightSpacerWidth = 0;
    private leftSpacerWidth  = 0;

    // Font size in px; used to estimate paragraph widths for off-window records.
    // Updated by setFontSize() when plugin settings change.
    private fontSizePx = 22; // matches DEFAULT_SETTINGS.fontSize

    constructor(
        private readonly editorEl: HTMLElement,
        private readonly scrollArea: HTMLElement,
    ) {}

    // Updates the font size used for width estimation. Call from EditorElement.applySettings().
    setFontSize(px: number): void {
        this.fontSizePx = px;
    }

    // Estimates the rendered pixel width of a paragraph from its visible character count.
    // Uses the editor's current height and font size without touching the DOM.
    // Formula: numColumns × columnWidth, where columnWidth = fontSizePx × lineHeight.
    private estimateWidth(viewLen: number): number {
        const colWidthPx = this.fontSizePx * VERTICAL_LINE_HEIGHT;
        const editorH = this.editorEl.clientHeight;
        if (editorH <= 0 || this.fontSizePx <= 0) return colWidthPx;
        const charsPerCol = Math.max(1, Math.floor(editorH / this.fontSizePx));
        const cols = Math.max(1, Math.ceil(Math.max(1, viewLen) / charsPerCol));
        return cols * colWidthPx;
    }

    private applyRightSpacer(newW: number): void {
        this.rightSpacerWidth = newW;
        if (this.rightSpacer) {
            if (newW > 0) this.rightSpacer.style.setProperty('width', `${newW}px`);
            else this.rightSpacer.style.removeProperty('width');
        }
    }

    private applyLeftSpacer(newW: number): void {
        this.leftSpacerWidth = newW;
        if (this.leftSpacer) {
            if (newW > 0) this.leftSpacer.style.setProperty('width', `${newW}px`);
            else this.leftSpacer.style.removeProperty('width');
        }
    }

    // Starts scroll-based window management and inserts spacer divs.
    attach(): void {
        if (this.rightSpacer) return; // already attached
        this.initSpacers();
        this.scrollArea.addEventListener('scroll', this.onScroll);
    }

    // Inserts rightSpacer and leftSpacer into editorEl.
    private initSpacers(): void {
        if (this.rightSpacer) return; // already initialised
        const right = activeDocument.createElement('div');
        right.classList.add(SPACER_CLASS);
        const left = activeDocument.createElement('div');
        left.classList.add(SPACER_CLASS);
        this.editorEl.prepend(right);
        this.editorEl.append(left);
        this.rightSpacer = right;
        this.leftSpacer  = left;
    }

    // Stops window management, removes spacers.
    detach(): void {
        this.clearVirtualSelection();
        this.paragraphRecords.length = 0;
        this.domStart = 0;
        this.domEnd   = -1;
        this.rightSpacerWidth = 0;
        this.leftSpacerWidth  = 0;
        this.rightSpacer?.remove();
        this.leftSpacer?.remove();
        this.rightSpacer = null;
        this.leftSpacer  = null;
        this.scrollArea.removeEventListener('scroll', this.onScroll);
    }

    // Initializes paragraphRecords from content lines.
    // domStart/domEnd define the initial DOM window; omitting them spans all records (full window).
    // All records receive estimated widths so spacer sizes are immediately accurate without
    // requiring every paragraph to be rendered first.
    // Does NOT touch the editor DOM — call initWindowFromLines() for the initial file-load path
    // where the DOM window also needs to be built. Call from setValue() (DOM already built by caller).
    initRecords(lines: string[], domStart = 0, domEnd = lines.length - 1): void {
        this.paragraphRecords.length = 0;
        for (const line of lines) {
            const viewLen = this.buildParagraphVisibleText(line).length;
            this.paragraphRecords.push({ src: line, viewLen, width: this.estimateWidth(viewLen) });
        }
        this.resetWindow(domStart, domEnd);
    }

    // Reinitializes paragraphRecords from all content lines and builds the [lo, hi] DOM window.
    // Used by EditorElement.loadContent() for the initial file-load path; replaces the old pattern
    // of calling initRecords() + manually building divs in EditorElement.
    initWindowFromLines(lines: string[], lo: number, hi: number): void {
        this.initRecords(lines, lo, hi);
        this.buildDomWindow(lines.slice(lo, hi + 1));
    }

    // Builds paragraph div elements from sources and replaces the editor window's children.
    // Does NOT update spacer widths; callers must have already called resetWindow() (e.g. via
    // initRecords() or resetWindow() directly) so spacer widths are correct.
    private buildDomWindow(sources: string[]): void {
        const windowNodes: Node[] = [];
        for (const src of sources) {
            const div = activeDocument.createElement('div');
            div.replaceChildren(sanitizeHTMLToDom(parseInlineToHtml(src) || '<br>'));
            windowNodes.push(div);
        }
        if (this.rightSpacer && this.leftSpacer) {
            this.editorEl.replaceChildren(this.rightSpacer, ...windowNodes, this.leftSpacer);
        } else {
            this.editorEl.replaceChildren(...windowNodes);
        }
    }

    // Repositions the DOM window to [lo, hi] and updates spacer widths from estimated record
    // widths. Does NOT rebuild paragraph div nodes — the caller is responsible for that.
    // Used by EditorElement.loadContent() (initial load) and jumpWindowTo() (cursor jumps).
    // The next scroll event will call adjustWindowOnScroll() to trim the window to the
    // correct size for the current scroll position.
    resetWindow(lo: number, hi: number): void {
        this.domStart = Math.max(0, lo);
        this.domEnd   = Math.min(hi, this.paragraphRecords.length - 1);
        this.applyRightSpacer(this.paragraphRecords
            .slice(0, this.domStart).reduce((sum, r) => sum + r.width, 0));
        this.applyLeftSpacer(this.paragraphRecords
            .slice(this.domEnd + 1).reduce((sum, r) => sum + r.width, 0));
    }

    // Updates src/viewLen for all records in-place WITHOUT touching domStart, domEnd, or spacer
    // widths. Used by commitToCm6() to keep outline data current after typing, where the DOM
    // window has already settled and a full initRecords() reset would corrupt getWindowDiv().
    syncWindowSrcs(lines: string[]): void {
        const n = lines.length;
        const cur = this.paragraphRecords;
        // Resize in-place, preserving existing widths. New entries get width=0.
        while (cur.length < n) cur.push({ src: '', viewLen: 0, width: 0 });
        while (cur.length > n) cur.pop();
        for (let i = 0; i < n; i++) {
            cur[i].src     = lines[i];
            cur[i].viewLen = this.buildParagraphVisibleText(lines[i]).length;
        }
        // Clamp both window bounds to the new record count.
        this.domEnd   = Math.min(this.domEnd, n - 1);
        this.domStart = Math.min(this.domStart, Math.max(0, n - 1));
        // Sync domEnd with the actual number of paragraph divs in the editor. Enter/Delete
        // can add/remove divs within the window without going through spliceRecords, so
        // we detect the discrepancy here and keep the virtualizer consistent with the DOM.
        // Guard: only when spacers are present (attach() has been called); without spacers
        // the editorEl.children count is unreliable for virtualization purposes.
        if (this.domEnd >= 0 && this.rightSpacer) {
            const actualDivCount = this.editorEl.children.length - 2; // -2 for spacers
            const windowDivCount = this.domEnd - this.domStart + 1;
            if (actualDivCount !== windowDivCount) {
                this.domEnd = Math.min(this.domStart + actualDivCount - 1, n - 1);
                // leftSpacerWidth does NOT need recomputing. Enter/Backspace only add or
                // remove divs inside the DOM window; the off-screen paragraphs represented
                // by the spacer are unchanged, so the stored accumulated width stays correct.
                // The next adjustWindowOnScroll() call (on the following scroll event or via
                // adjustNow) will premeasure the updated in-window divs and call
                // correctSpacerAfterExpand() if the window boundary moved further.
            }
        }
    }

    // Mirrors the DOM splice performed by patchParagraphs, keeping paragraphRecords in sync.
    // lo: first changed index; deleteCount: number of old records to remove;
    // newLines: replacement Aozora source lines (may be a different count than deleteCount).
    spliceRecords(lo: number, deleteCount: number, newLines: string[]): void {
        // Classify the splice before mutating state so we can use the pre-splice window bounds.
        // A splice is "within the window" when every deleted record lies inside [domStart, domEnd]
        // and no off-screen paragraph moves in or out of a spacer area as a result.
        // In that case the spacer widths remain correct as-is; recomputing them from the
        // (now-shifted) records array produces wrong values because syncWindowSrcs preserves
        // widths by index position rather than by paragraph content.
        const spliceWithinWindow =
            lo >= this.domStart &&
            lo <= this.domEnd &&
            lo + deleteCount <= this.domEnd + 1;

        const newRecords = newLines.map(src => {
            const viewLen = this.buildParagraphVisibleText(src).length;
            return { src, viewLen, width: this.estimateWidth(viewLen) };
        });
        this.paragraphRecords.splice(lo, deleteCount, ...newRecords);
        const delta = newLines.length - deleteCount;
        // If the splice is entirely before the window, shift both window bounds.
        if (lo < this.domStart) {
            this.domStart = Math.max(0, this.domStart + delta);
        }
        // Splices that touch or precede domEnd shift the window's end index.
        // Splices entirely after domEnd (lo > domEnd) do not change which paragraphs
        // are in-window; clamp only to keep the index within the new array length.
        if (lo <= this.domEnd) {
            this.domEnd = Math.min(this.domEnd + delta, this.paragraphRecords.length - 1);
        } else {
            this.domEnd = Math.min(this.domEnd, this.paragraphRecords.length - 1);
        }
        this.domEnd = Math.max(this.domEnd, this.domStart);
        if (spliceWithinWindow) {
            // Off-screen paragraphs did not change; stored spacer widths remain correct.
            return;
        }
        // Recompute spacer widths so scrollWidth stays correct.
        this.applyRightSpacer(this.paragraphRecords
            .slice(0, this.domStart).reduce((sum, r) => sum + r.width, 0));
        this.applyLeftSpacer(this.paragraphRecords
            .slice(this.domEnd + 1).reduce((sum, r) => sum + r.width, 0));
    }

    // Returns the Aozora source for the paragraph at index i. O(1).
    getSrcByIndex(i: number): string {
        return this.paragraphRecords[i]?.src ?? '';
    }

    // Updates src and viewLen of an off-window record without touching the DOM.
    // Called by SearchPanel.replaceAllMatches() to apply replacements to off-window paragraphs.
    updateRecord(i: number, src: string): void {
        const rec = this.paragraphRecords[i];
        if (!rec) return;
        rec.src = src;
        rec.viewLen = this.buildParagraphVisibleText(src).length;
    }

    // Returns the visible character count for the paragraph at index i. O(1).
    getViewLenByIndex(i: number): number {
        return this.paragraphRecords[i]?.viewLen ?? 0;
    }

    // Returns true if paragraph i is currently in the DOM window.
    isInWindow(i: number): boolean {
        return i >= this.domStart && i <= this.domEnd;
    }

    // Returns the DOM div for paragraph i, or null if i is outside the DOM window.
    // spacerOffset is 1 when rightSpacer occupies children[0]; 0 otherwise.
    getWindowDiv(i: number): HTMLElement | null {
        if (!this.isInWindow(i)) return null;
        const spacerOffset = this.rightSpacer ? 1 : 0;
        return (this.editorEl.children[i - this.domStart + spacerOffset] as HTMLElement) ?? null;
    }

    // Teleports the DOM window to be centered on paragraph `center` (± windowHalf).
    // Rebuilds the DOM from paragraphRecords without traversing intermediate paragraphs.
    // Used by EditorElement.jumpWindowTo() and SearchPanel navigation.
    teleportWindowTo(center: number, windowHalf = 50): void {
        const N = this.paragraphRecords.length;
        if (N === 0) return;
        const lo = Math.max(0, center - windowHalf);
        const hi = Math.min(N - 1, center + windowHalf);
        this.buildDomWindow(this.paragraphRecords.slice(lo, hi + 1).map(r => r.src));
        this.resetWindow(lo, hi);
    }

    // Replaces all paragraph divs with the full document content (one div per record).
    // Used by Cmd-A (select-all) so the selection can span the entire activeDocument.
    // Performs a single replaceChildren call to minimise layout thrashing.
    expandWindowToFull(): void {
        const frag = activeDocument.createDocumentFragment();
        for (const rec of this.paragraphRecords) {
            const div = activeDocument.createElement('div');
            div.replaceChildren(sanitizeHTMLToDom(parseInlineToHtml(rec.src) || '<br>'));
            frag.appendChild(div);
        }
        const nodes = Array.from(frag.childNodes);
        if (this.rightSpacer && this.leftSpacer) {
            this.editorEl.replaceChildren(this.rightSpacer, ...nodes, this.leftSpacer);
        } else {
            this.editorEl.replaceChildren(...nodes);
        }
        this.domStart = 0;
        this.domEnd   = this.paragraphRecords.length - 1;
        this.applyRightSpacer(0);
        this.applyLeftSpacer(0);
    }

    // Called on selectionchange. Window management is scroll-driven, so this is a no-op.
    ensureWindowAroundCursor(): void {}

    // Measures newly expanded divs (those added since domStartBefore/domEndBefore were
    // captured) and corrects the corresponding spacer widths. All DOM mutations must be
    // complete before calling so that a single getBoundingClientRect() call triggers one
    // layout flush and subsequent calls return cached values without extra computation.
    // This eliminates the scrollWidth error introduced when expandLeft/expandRight use
    // estimated rec.width but the rendered div has a different actual width.
    private correctSpacerAfterExpand(domStartBefore: number, domEndBefore: number): void {
        if (this.domStart < domStartBefore) {
            let correction = 0;
            for (let i = this.domStart; i < domStartBefore; i++) {
                const div = this.getWindowDiv(i);
                if (!div) continue;
                const rec = this.paragraphRecords[i];
                const actualW = div.getBoundingClientRect().width;
                if (actualW > 0 && actualW !== rec.width) {
                    correction += actualW - rec.width;
                    rec.width = actualW;
                }
            }
            if (correction !== 0) {
                this.applyRightSpacer(Math.max(0, this.rightSpacerWidth - correction));
            }
        }
        if (this.domEnd > domEndBefore) {
            let correction = 0;
            for (let i = domEndBefore + 1; i <= this.domEnd; i++) {
                const div = this.getWindowDiv(i);
                if (!div) continue;
                const rec = this.paragraphRecords[i];
                const actualW = div.getBoundingClientRect().width;
                if (actualW > 0 && actualW !== rec.width) {
                    correction += actualW - rec.width;
                    rec.width = actualW;
                }
            }
            if (correction !== 0) {
                this.applyLeftSpacer(Math.max(0, this.leftSpacerWidth - correction));
            }
        }
    }

    // ---- Window expand / shrink helpers ----

    // Adds a div for paragraphRecords[domStart-1] at the right end of the window.
    private expandRight(): void {
        if (this.domStart <= 0) return;
        const i = this.domStart - 1;
        const rec = this.paragraphRecords[i];
        const div = activeDocument.createElement('div');
        div.replaceChildren(sanitizeHTMLToDom(parseInlineToHtml(rec.src) || '<br>'));
        // Insert after rightSpacer (children[0]) → before the current first paragraph.
        const firstPara = this.rightSpacer
            ? this.editorEl.children[1] // first paragraph is after rightSpacer
            : this.editorEl.firstChild as HTMLElement | null;
        this.editorEl.insertBefore(div, firstPara ?? null);
        // Shrink rightSpacer by the paragraph's estimated or measured width.
        const w = rec.width > 0 ? rec.width : this.estimateWidth(rec.viewLen);
        this.applyRightSpacer(Math.max(0, this.rightSpacerWidth - w));
        this.domStart--;
    }

    // Adds a div for paragraphRecords[domEnd+1] at the left end of the window.
    private expandLeft(): void {
        if (this.domEnd >= this.paragraphRecords.length - 1) return;
        const i = this.domEnd + 1;
        const rec = this.paragraphRecords[i];
        const div = activeDocument.createElement('div');
        div.replaceChildren(sanitizeHTMLToDom(parseInlineToHtml(rec.src) || '<br>'));
        // Insert before leftSpacer (last child) → after the current last paragraph.
        this.editorEl.insertBefore(div, this.leftSpacer ?? null);
        const w = rec.width > 0 ? rec.width : this.estimateWidth(rec.viewLen);
        this.applyLeftSpacer(Math.max(0, this.leftSpacerWidth - w));
        this.domEnd++;
    }

    // Removes the leftmost div of the window (paragraphs[domEnd]) and grows leftSpacer.
    // When the cursor (collapsed) is inside this div, removal is blocked to protect editing.
    // When a non-collapsed selection endpoint is inside this div, clampSelectionOnShrink()
    // moves the endpoint to a proxy position before removal so VS tracking stays intact.
    private shrinkLeft(): void {
        if (this.domEnd < this.domStart) return; // empty window guard
        const spacerOffset = this.rightSpacer ? 1 : 0;
        const div = this.editorEl.children[this.domEnd - this.domStart + spacerOffset] as HTMLElement;
        if (!div) return;
        const sel = window.getSelection();
        if (sel) {
            const collidingAnchor = div.contains(sel.anchorNode);
            const collidingFocus  = div.contains(sel.focusNode);
            if (sel.isCollapsed && collidingAnchor) return; // cursor in this div — protect
            if (!sel.isCollapsed && (collidingAnchor || collidingFocus)) {
                this.clampSelectionOnShrink(div, this.domEnd);
            }
        }
        const rec = this.paragraphRecords[this.domEnd];
        const w = rec.width > 0 ? rec.width : this.estimateWidth(rec.viewLen);
        rec.width = w;
        div.remove();
        this.applyLeftSpacer(this.leftSpacerWidth + w);
        this.domEnd--;
    }

    // Removes the rightmost div of the window (paragraphs[domStart]) and grows rightSpacer.
    private shrinkRight(): void {
        if (this.domEnd < this.domStart) return;
        const spacerOffset = this.rightSpacer ? 1 : 0;
        const div = this.editorEl.children[spacerOffset] as HTMLElement; // first paragraph
        if (!div || div.classList.contains(SPACER_CLASS)) return;
        const sel = window.getSelection();
        if (sel) {
            const collidingAnchor = div.contains(sel.anchorNode);
            const collidingFocus  = div.contains(sel.focusNode);
            if (sel.isCollapsed && collidingAnchor) return; // cursor in this div — protect
            if (!sel.isCollapsed && (collidingAnchor || collidingFocus)) {
                this.clampSelectionOnShrink(div, this.domStart);
            }
        }
        const rec = this.paragraphRecords[this.domStart];
        const w = rec.width > 0 ? rec.width : this.estimateWidth(rec.viewLen);
        rec.width = w;
        div.remove();
        this.applyRightSpacer(this.rightSpacerWidth + w);
        this.domStart++;
    }

    // Adjusts the DOM window based on the current scroll position.
    //
    // Coordinate system (tate-scroll-area is a standard LTR scroll container):
    //   leftSpacer  →  x = [0,                      leftSpacerWidth]       (end of document)
    //   window divs →  x = [leftSpacerWidth,         leftSpacerWidth + W_win]
    //   rightSpacer →  x = [W - rightSpacerWidth,    W]                    (start of document)
    //   viewport    →  x = [scrollLeft,              scrollLeft + clientWidth]
    //
    // Left boundary (domEnd = leftmost paragraph):
    //   Its right edge is at leftSpacerWidth + domEnd.width.
    //   Expand when right edge > scrollLeft - EXPAND_MARGIN (boundary approaching viewport).
    //   Shrink when right edge < scrollLeft - SHRINK_MARGIN (boundary too far behind viewport).
    //
    // Right boundary (domStart = rightmost paragraph):
    //   Its left edge is at W - rightSpacerWidth - domStart.width.
    //   Expand when left edge < scrollLeft + clientWidth + EXPAND_MARGIN.
    //   Shrink when left edge > scrollLeft + clientWidth + SHRINK_MARGIN.
    //
    // EXPAND_MARGIN < SHRINK_MARGIN provides hysteresis that prevents oscillation.
    private adjustWindowOnScroll(): void {
        if (this.paragraphRecords.length === 0) return;
        // Premeasure: update rec.width with actual rendered widths before any mutations.
        // Ensures shrink operations use accurate widths so the net scrollWidth change
        // per shrink is zero, and also updates widths for divs added since the last
        // measurement (e.g. after Enter/Delete). Must run before reading scrollWidth
        // so that the layout query below returns a value consistent with the measurements.
        this.premeasureWindowWidths();
        const domStartBefore = this.domStart;
        const domEndBefore   = this.domEnd;
        // Read layout properties once before any mutations to avoid thrashing.
        const scrollLeft = this.scrollArea.scrollLeft;
        const viewW      = this.scrollArea.clientWidth;
        const W          = this.scrollArea.scrollWidth;

        // ---- Left boundary (domEnd) ----
        // Expand: domEnd's right edge within EXPAND_MARGIN of viewport's left edge.
        while (this.domEnd < this.paragraphRecords.length - 1) {
            const rec = this.paragraphRecords[this.domEnd];
            const w   = rec.width > 0 ? rec.width : this.estimateWidth(rec.viewLen);
            if (this.leftSpacerWidth + w > scrollLeft - EXPAND_MARGIN) {
                this.expandLeft();
            } else break;
        }
        // Shrink: domEnd's right edge more than SHRINK_MARGIN behind viewport's left edge.
        while (this.domEnd > this.domStart + 2) {
            const rec = this.paragraphRecords[this.domEnd];
            const w   = rec.width > 0 ? rec.width : this.estimateWidth(rec.viewLen);
            if (this.leftSpacerWidth + w < scrollLeft - SHRINK_MARGIN) {
                const endBefore = this.domEnd;
                this.shrinkLeft();
                if (this.domEnd === endBefore) break; // blocked (e.g. selection overlap), stop
            } else break;
        }

        // ---- Right boundary (domStart) ----
        // Expand: domStart's left edge within EXPAND_MARGIN of viewport's right edge.
        while (this.domStart > 0) {
            const rec = this.paragraphRecords[this.domStart];
            const w   = rec.width > 0 ? rec.width : this.estimateWidth(rec.viewLen);
            if (W - this.rightSpacerWidth - w < scrollLeft + viewW + EXPAND_MARGIN) {
                this.expandRight();
            } else break;
        }
        // Shrink: domStart's left edge more than SHRINK_MARGIN past viewport's right edge.
        while (this.domEnd > this.domStart + 2) {
            const rec = this.paragraphRecords[this.domStart];
            const w   = rec.width > 0 ? rec.width : this.estimateWidth(rec.viewLen);
            if (W - this.rightSpacerWidth - w > scrollLeft + viewW + SHRINK_MARGIN) {
                const startBefore = this.domStart;
                this.shrinkRight();
                if (this.domStart === startBefore) break; // blocked (e.g. selection overlap), stop
            } else break;
        }

        // Post-expand: correct spacer widths for any divs added since domStartBefore/domEndBefore.
        // All DOM mutations are complete; getBoundingClientRect() triggers one layout flush and
        // subsequent calls on the unmodified DOM return cached values.
        this.correctSpacerAfterExpand(domStartBefore, domEndBefore);

        // Re-sync the DOM Range to the VS proxy positions after the window has settled.
        // Without this, the selection appears stuck at the old proxy boundary div.
        if (this.virtualSelection) this.syncDomRangeToVirtual();
    }

    // Reads the actual rendered widths of all in-window paragraph divs and updates
    // paragraphRecords[i].width. A single layout flush — no DOM mutations between reads.
    // Called at the start of adjustWindowOnScroll() so that shrink operations use actual
    // widths. When the stored width equals the actual width, the net scrollWidth change
    // per shrink is zero, keeping the cursor in place (overflow-anchor: none).
    private premeasureWindowWidths(): void {
        if (!this.rightSpacer || this.domEnd < 0) return;
        const spacerOffset = 1; // rightSpacer is always children[0]
        const children = this.editorEl.children;
        for (let i = this.domStart; i <= this.domEnd; i++) {
            const k = i - this.domStart;
            const div = children[k + spacerOffset] as HTMLElement;
            if (!div || div.classList.contains(SPACER_CLASS)) continue;
            const w = div.getBoundingClientRect().width;
            if (w > 0) this.paragraphRecords[i].width = w;
        }
    }

    // Immediately adjusts the DOM window for the current scroll position.
    // Call after any programmatic scrollLeft change so the window is correct before the next
    // paint, without waiting for the async scroll event.
    adjustNow(): void {
        this.adjustWindowOnScroll();
    }

    // Arrow function so `this` is bound for addEventListener/removeEventListener.
    private readonly onScroll = () => { this.adjustWindowOnScroll(); };

    // Computes visible text for an Aozora source line.
    // For every segment: take viewLen visible characters starting at srcStart.
    // ruby-explicit is the only exception: it has a leading ｜ marker (+1 offset before the base text).
    buildParagraphVisibleText(src: string): string {
        const segs = buildSegmentMap(src);
        const result: string[] = [];
        for (const seg of segs) {
            if (seg.viewLen === 0) continue; // newline segment
            const start = seg.kind === 'ruby-explicit' ? seg.srcStart + 1 : seg.srcStart;
            result.push(src.slice(start, start + seg.viewLen));
        }
        return result.join('');
    }

    // ---- Virtual Selection API ----

    // True while a programmatic setBaseAndExtent() call is in flight (counter > 0).
    // selectionchange handlers should skip VS update logic when this is true.
    get isSyncingSelection(): boolean { return this.programmaticSelectionUpdates > 0; }

    getVirtualSelection(): VirtualSelection | null { return this.virtualSelection; }

    clearVirtualSelection(): void { this.virtualSelection = null; }

    // Initializes VS to span the entire document and syncs the DOM Range to proxy positions.
    // Called from the Cmd-A handler instead of expandWindowToFull().
    setVirtualSelectAll(): void {
        const N = this.paragraphRecords.length;
        if (N === 0) return;
        this.virtualSelection = {
            anchorParaIdx: 0,
            anchorViewOff: 0,
            focusParaIdx:  N - 1,
            focusViewOff:  this.paragraphRecords[N - 1].viewLen,
        };
        this.syncDomRangeToVirtual();
    }

    // Called from selectionchange when VS is active and the event is not programmatic.
    // Reads the new focus position from the DOM and updates VS.focusParaIdx/focusViewOff.
    // Returns true if VS was changed (caller should then call syncDomRangeToVirtual()).
    tryUpdateFocusFromDom(sel: Selection): boolean {
        const vs = this.virtualSelection;
        if (!vs) return false;
        const focusNode = sel.focusNode;
        if (!focusNode) return false;

        // If the DOM focus is at the proxy position that syncDomRangeToVirtual would set,
        // this selectionchange was triggered by our own setBaseAndExtent (not by the user).
        // Updating VS from a proxy position would corrupt focusParaIdx to a boundary index.
        // This check is timing-independent: Chrome fires setTimeout(0) before selectionchange,
        // so the counter-based isSyncingSelection guard is unreliable for syncDomRangeToVirtual.
        const expectedFocusProxy = this.proxyForEndpoint(vs.focusParaIdx, vs.focusViewOff);
        if (sel.focusNode === expectedFocusProxy.node && sel.focusOffset === expectedFocusProxy.offset) {
            return false;
        }

        const focusDiv = this.findParaDiv(focusNode);
        if (!focusDiv) return false;
        const focusParaIdx = this.getParagraphIndex(focusDiv);
        if (focusParaIdx < 0) return false;
        const newFocusViewOff = computeViewOffsetInDiv(focusDiv, this.editorEl, focusNode, sel.focusOffset);
        if (focusParaIdx === vs.focusParaIdx && newFocusViewOff === vs.focusViewOff) return false;
        this.virtualSelection = { ...vs, focusParaIdx, focusViewOff: newFocusViewOff };
        return true;
    }

    // Sets the DOM Range to proxy positions derived from the current VS, so that native
    // ::selection highlights all in-window paragraphs covered by the virtual selection.
    syncDomRangeToVirtual(): void {
        const vs = this.virtualSelection;
        if (!vs || this.domEnd < 0) return;
        const sel = window.getSelection();
        if (!sel) return;
        const anchor = this.proxyForEndpoint(vs.anchorParaIdx, vs.anchorViewOff);
        const focus  = this.proxyForEndpoint(vs.focusParaIdx,  vs.focusViewOff);
        this.markProgrammaticSelection();
        sel.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
    }

    // Returns the DOM node/offset for the given (paraIdx, viewOff) endpoint.
    // For off-window paragraphs, returns a proxy at the nearest window boundary div.
    private proxyForEndpoint(paraIdx: number, viewOff: number): { node: Node; offset: number } {
        if (paraIdx < this.domStart) {
            // Off-right: proxy = start of domStart div (rightmost visible paragraph)
            const div = this.getWindowDiv(this.domStart);
            if (div) return { node: div, offset: 0 };
        } else if (paraIdx > this.domEnd) {
            // Off-left: proxy = end of domEnd div (leftmost visible paragraph)
            const div = this.getWindowDiv(this.domEnd);
            if (div) {
                const last = findLastBaseTextInElement(div, this.editorEl);
                if (last) return { node: last.node, offset: last.offset };
                return { node: div, offset: div.childNodes.length };
            }
        } else {
            // In-window: actual DOM position
            const div = this.getWindowDiv(paraIdx);
            if (div) return computeDomPositionFromViewOff(div, this.editorEl, viewOff);
        }
        return { node: this.editorEl, offset: 0 };
    }

    // Increments the programmatic-update counter and schedules a decrement after the
    // selectionchange event (macrotask) has had a chance to fire and be suppressed.
    private markProgrammaticSelection(): void {
        this.programmaticSelectionUpdates++;
        window.setTimeout(() => { this.programmaticSelectionUpdates--; }, 0);
    }

    // Saves the current selection into VS and moves DOM endpoints out of the div that is
    // about to be removed. Called from shrinkLeft/shrinkRight when a non-collapsed selection
    // endpoint is inside the div being evicted from the DOM window.
    private clampSelectionOnShrink(div: HTMLElement, paraIdx: number): void {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return;
        const anchorInDiv = div.contains(sel.anchorNode);
        const focusInDiv  = div.contains(sel.focusNode);
        if (!anchorInDiv && !focusInDiv) return;

        // Initialize VS from DOM if not yet active
        if (!this.virtualSelection) {
            const anchorDiv = this.findParaDiv(sel.anchorNode!);
            const focusDiv  = this.findParaDiv(sel.focusNode!);
            const anchorIdx = anchorDiv ? this.getParagraphIndex(anchorDiv) : -1;
            const focusIdx  = focusDiv  ? this.getParagraphIndex(focusDiv)  : -1;
            if (anchorIdx < 0 || focusIdx < 0) return;
            this.virtualSelection = {
                anchorParaIdx: anchorIdx,
                anchorViewOff: anchorDiv
                    ? computeViewOffsetInDiv(anchorDiv, this.editorEl, sel.anchorNode!, sel.anchorOffset)
                    : 0,
                focusParaIdx:  focusIdx,
                focusViewOff:  focusDiv
                    ? computeViewOffsetInDiv(focusDiv, this.editorEl, sel.focusNode!, sel.focusOffset)
                    : 0,
            };
        }

        // Compute proxy for the endpoint(s) in the div being removed
        let proxyNode: Node;
        let proxyOffset: number;
        if (paraIdx === this.domEnd) {
            // shrinkLeft removes domEnd: proxy = end of domEnd-1
            const safeDiv = this.getWindowDiv(this.domEnd - 1);
            if (!safeDiv) return;
            const last = findLastBaseTextInElement(safeDiv, this.editorEl);
            if (last) { proxyNode = last.node; proxyOffset = last.offset; }
            else { proxyNode = safeDiv; proxyOffset = safeDiv.childNodes.length; }
        } else if (paraIdx === this.domStart) {
            // shrinkRight removes domStart: proxy = start of domStart+1
            const safeDiv = this.getWindowDiv(this.domStart + 1);
            if (!safeDiv) return;
            proxyNode = safeDiv; proxyOffset = 0;
        } else {
            return;
        }

        let newAnchorNode: Node, newAnchorOffset: number;
        let newFocusNode:  Node, newFocusOffset:  number;
        if (anchorInDiv && focusInDiv) {
            newAnchorNode = proxyNode; newAnchorOffset = proxyOffset;
            newFocusNode  = proxyNode; newFocusOffset  = proxyOffset;
        } else if (anchorInDiv) {
            newAnchorNode = proxyNode;        newAnchorOffset = proxyOffset;
            newFocusNode  = sel.focusNode!;   newFocusOffset  = sel.focusOffset;
        } else {
            newAnchorNode = sel.anchorNode!;  newAnchorOffset = sel.anchorOffset;
            newFocusNode  = proxyNode;        newFocusOffset  = proxyOffset;
        }
        this.markProgrammaticSelection();
        sel.setBaseAndExtent(newAnchorNode, newAnchorOffset, newFocusNode, newFocusOffset);
    }

    // Returns the direct paragraph div (non-spacer DIV child of editorEl) that contains node.
    private findParaDiv(node: Node): HTMLElement | null {
        let el: Node | null = node;
        while (el && el !== this.editorEl) {
            if (el.instanceOf(HTMLElement)
                    && el.parentElement === this.editorEl
                    && el.tagName === 'DIV'
                    && !el.classList.contains(SPACER_CLASS)) {
                return el;
            }
            el = el.parentElement;
        }
        return null;
    }

    // Returns the paragraphRecords index for the given in-window div, or -1 if not found.
    private getParagraphIndex(div: HTMLElement): number {
        const spacerOffset = this.rightSpacer ? 1 : 0;
        const children = this.editorEl.children;
        for (let k = spacerOffset; k < children.length; k++) {
            if (children[k] === div) return this.domStart + (k - spacerOffset);
        }
        return -1;
    }

}
