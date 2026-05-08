import { sanitizeHTMLToDom } from 'obsidian';
import { buildSegmentMap } from './SegmentMap';
import { parseInlineToHtml } from './AozoraParser';

// CSS class applied to both spacer divs so DOM walkers can skip them.
export const SPACER_CLASS = 'tate-spacer';
// Fallback width for paragraphs that have never entered the viewport and whose
// estimated width cannot be computed (e.g. editorEl.clientHeight is 0).
// Equals one column width at the default font size (22px × lineHeight 2 = 44px).
const UNRENDERED_WIDTH_PX = 44;
// CSS line-height value from .tate-editor. In vertical writing mode the column width
// equals fontSize × lineHeight, so this ratio converts fontSizePx to column width.
const VERTICAL_LINE_HEIGHT = 2;

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
export class ParagraphVirtualizer {
    // Per-paragraph data store indexed 1:1 with paragraphs (not DOM children).
    // Maintained by initRecords() / spliceRecords() / syncWindowSrcs().
    readonly paragraphRecords: ParagraphRecord[] = [];

    // DOM window state. domStart and domEnd are inclusive indices into paragraphRecords.
    // domEnd = -1 signals "no records loaded yet" (initial state before first setValue).
    domStart = 0;
    domEnd   = -1;

    // Spacer divs inserted at the right (first child) and left (last child) of editorEl.
    rightSpacer: HTMLElement | null = null;
    leftSpacer:  HTMLElement | null = null;

    // Accumulated pixel widths of paragraphs evicted to the right and left spacers.
    private rightSpacerWidth = 0;
    private leftSpacerWidth  = 0;

    // Watches the two boundary divs of the window; expands/shrinks the window on intersection.
    private windowObserver: IntersectionObserver | null = null;

    // True while a drag selection is in progress (mousedown → mouseup).
    private isDragging = false;

    // Hysteresis flags: prevent the oscillation that occurs when reobserveBoundaries()
    // delivers an initial IO state for the newly-registered boundary div that is just
    // outside the rootMargin (causing shrink immediately after expand, or vice versa).
    // Each flag is set when an expand/shrink happens and cleared when the initial
    // IO delivery for the new boundary div is handled (blocking the spurious action).
    private justExpandedLeft  = false;
    private justExpandedRight = false;
    private justShrankLeft    = false;
    private justShrankRight   = false;

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
        const editorH = (this.editorEl as HTMLElement).clientHeight;
        if (editorH <= 0 || this.fontSizePx <= 0) return colWidthPx;
        const charsPerCol = Math.max(1, Math.floor(editorH / this.fontSizePx));
        const cols = Math.max(1, Math.ceil(Math.max(1, viewLen) / charsPerCol));
        return cols * colWidthPx;
    }

    // Starts the window boundary observer and inserts spacer divs.
    attach(): void {
        if (this.windowObserver) return;
        this.windowObserver = new IntersectionObserver(
            (entries) => this.onWindowBoundaryIntersection(entries),
            {
                root: this.scrollArea,
                // 440px margin on each side covers ~10 paragraphs (44px each) outside the viewport.
                rootMargin: '0px 440px 0px 440px',
                threshold: 0,
            },
        );
        this.initSpacers();
        this.editorEl.addEventListener('mousedown', this.onMouseDown);
        document.addEventListener('mouseup', this.onMouseUp);
    }

    // Inserts rightSpacer and leftSpacer into editorEl.
    private initSpacers(): void {
        if (this.rightSpacer) return; // already initialised
        const right = document.createElement('div');
        right.classList.add(SPACER_CLASS);
        right.style.setProperty('pointer-events', 'none');
        right.style.setProperty('user-select', 'none');
        const left = document.createElement('div');
        left.classList.add(SPACER_CLASS);
        left.style.setProperty('pointer-events', 'none');
        left.style.setProperty('user-select', 'none');
        this.editorEl.prepend(right);
        this.editorEl.append(left);
        this.rightSpacer = right;
        this.leftSpacer  = left;
    }

    // Stops observer, removes spacers.
    detach(): void {
        this.windowObserver?.disconnect();
        this.windowObserver = null;
        this.paragraphRecords.length = 0;
        this.domStart = 0;
        this.domEnd   = -1;
        this.rightSpacerWidth = 0;
        this.leftSpacerWidth  = 0;
        this.rightSpacer?.remove();
        this.leftSpacer?.remove();
        this.rightSpacer = null;
        this.leftSpacer  = null;
        this.isDragging = false;
        this.justExpandedLeft  = false;
        this.justExpandedRight = false;
        this.justShrankLeft    = false;
        this.justShrankRight   = false;
        this.editorEl.removeEventListener('mousedown', this.onMouseDown);
        document.removeEventListener('mouseup', this.onMouseUp);
    }

    // Initializes paragraphRecords from content lines.
    // domStart/domEnd define the initial DOM window; omitting them spans all records (full window).
    // All records receive estimated widths so spacer sizes are immediately accurate without
    // requiring every paragraph to be rendered first.
    // Call from EditorElement.loadContent() (initial file load) and the patchParagraphs fallback.
    initRecords(lines: string[], domStart = 0, domEnd = lines.length - 1): void {
        this.paragraphRecords.length = 0;
        for (const line of lines) {
            const viewLen = this.buildParagraphVisibleText(line).length;
            this.paragraphRecords.push({ src: line, viewLen, width: this.estimateWidth(viewLen) });
        }
        this.resetWindow(domStart, domEnd);
    }

    // Repositions the DOM window to [lo, hi] and updates spacer widths from estimated record
    // widths. Does NOT rebuild paragraph div nodes — the caller is responsible for that.
    // Used by EditorElement.loadContent() (initial load) and jumpWindowTo() (cursor jumps).
    resetWindow(lo: number, hi: number): void {
        this.domStart = Math.max(0, lo);
        this.domEnd   = Math.min(hi, this.paragraphRecords.length - 1);
        this.rightSpacerWidth = this.paragraphRecords
            .slice(0, this.domStart).reduce((sum, r) => sum + r.width, 0);
        this.leftSpacerWidth = this.paragraphRecords
            .slice(this.domEnd + 1).reduce((sum, r) => sum + r.width, 0);
        if (this.rightSpacer) {
            if (this.rightSpacerWidth > 0) this.rightSpacer.style.setProperty('width', `${this.rightSpacerWidth}px`);
            else this.rightSpacer.style.removeProperty('width');
        }
        if (this.leftSpacer) {
            if (this.leftSpacerWidth > 0) this.leftSpacer.style.setProperty('width', `${this.leftSpacerWidth}px`);
            else this.leftSpacer.style.removeProperty('width');
        }
        this.reobserveBoundaries();
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
            const actualDivCount = (this.editorEl as HTMLElement).children.length - 2; // -2 for spacers
            const windowDivCount = this.domEnd - this.domStart + 1;
            if (actualDivCount !== windowDivCount) {
                this.domEnd = Math.min(this.domStart + actualDivCount - 1, n - 1);
                // leftSpacerWidth does NOT need recomputing. Enter/Backspace only affect
                // paragraphs inside the DOM window; the spacer region continues to represent
                // the same physical off-screen paragraphs, so the stored accumulated width
                // remains correct.
                //
                // Re-register the observer on the new boundary divs. Without this, the IO
                // keeps watching the old domEnd element (split by Enter or merged by
                // Backspace) and the new domEnd div is never observed, so expandLeft stops
                // firing permanently.
                //
                // Block all four actions for the initial IO delivery that reobserveBoundaries
                // triggers. The new boundary divs are close to the viewport (cursor is there),
                // so their initial states would fire expandLeft/expandRight immediately,
                // changing leftSpacerWidth and causing visible cursor slide. After these
                // one-shot flags are consumed, the IO resumes normal operation on scroll.
                this.justShrankLeft   = true; // blocks expandLeft  from initial delivery
                this.justShrankRight  = true; // blocks expandRight from initial delivery
                this.justExpandedLeft  = true; // blocks shrinkLeft  from initial delivery
                this.justExpandedRight = true; // blocks shrinkRight from initial delivery
                this.reobserveBoundaries();
            }
        }
    }

    // Mirrors the DOM splice performed by patchParagraphs, keeping paragraphRecords in sync.
    // lo: first changed index; deleteCount: number of old records to remove;
    // newLines: replacement Aozora source lines (may be a different count than deleteCount).
    spliceRecords(lo: number, deleteCount: number, newLines: string[]): void {
        const newRecords = newLines.map(src => {
            const viewLen = this.buildParagraphVisibleText(src).length;
            return { src, viewLen, width: this.estimateWidth(viewLen) };
        });
        this.paragraphRecords.splice(lo, deleteCount, ...newRecords);
        const delta = newLines.length - deleteCount;
        // If the splice is entirely before the window, shift the window indices.
        if (lo < this.domStart) {
            this.domStart = Math.max(0, this.domStart + delta);
        }
        // Adjust domEnd by the count delta and clamp to the new total.
        this.domEnd = Math.min(this.domEnd + delta, this.paragraphRecords.length - 1);
        this.domEnd = Math.max(this.domEnd, this.domStart);
        // Recompute spacer widths so scrollWidth stays correct.
        this.rightSpacerWidth = this.paragraphRecords
            .slice(0, this.domStart).reduce((sum, r) => sum + r.width, 0);
        this.leftSpacerWidth = this.paragraphRecords
            .slice(this.domEnd + 1).reduce((sum, r) => sum + r.width, 0);
        if (this.rightSpacer) {
            if (this.rightSpacerWidth > 0) this.rightSpacer.style.setProperty('width', `${this.rightSpacerWidth}px`);
            else this.rightSpacer.style.removeProperty('width');
        }
        if (this.leftSpacer) {
            if (this.leftSpacerWidth > 0) this.leftSpacer.style.setProperty('width', `${this.leftSpacerWidth}px`);
            else this.leftSpacer.style.removeProperty('width');
        }
        this.reobserveBoundaries();
    }

    // Returns the Aozora source for the paragraph at index i. O(1).
    getSrcByIndex(i: number): string {
        return this.paragraphRecords[i]?.src ?? '';
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

    // Ensures paragraph i is in the DOM window.
    // Expands the window in the required direction until i is included.
    // Called by setVisibleOffset (cursor restore) and jump-to-heading.
    ensureInWindow(i: number): void {
        if (this.isInWindow(i)) return;
        if (i < this.domStart) {
            while (this.domStart > i) this.expandRight();
        } else {
            while (this.domEnd < i) this.expandLeft();
        }
        this.reobserveBoundaries();
    }

    // Replaces all paragraph divs with the full document content (one div per record).
    // Used by Cmd-A (select-all) so the selection can span the entire document.
    // Performs a single replaceChildren call to minimise layout thrashing.
    expandWindowToFull(): void {
        const frag = document.createDocumentFragment();
        for (const rec of this.paragraphRecords) {
            const div = document.createElement('div');
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
        this.rightSpacerWidth = 0;
        this.leftSpacerWidth  = 0;
        if (this.rightSpacer) this.rightSpacer.style.removeProperty('width');
        if (this.leftSpacer)  this.leftSpacer.style.removeProperty('width');
        this.reobserveBoundaries();
    }

    // Called on selectionchange. The window mechanism (IntersectionObserver) keeps the cursor
    // paragraph in the window proactively, so this is normally a no-op safety hook.
    ensureWindowAroundCursor(): void {
        // No-op: cursor paragraph is always in the window (IO expands before viewport edges).
    }

    // ---- Window expand / shrink helpers ----

    // Adds a div for paragraphRecords[domStart-1] at the right end of the window.
    private expandRight(): void {
        if (this.domStart <= 0) return;
        const i = this.domStart - 1;
        const rec = this.paragraphRecords[i];
        const div = document.createElement('div');
        div.replaceChildren(sanitizeHTMLToDom(parseInlineToHtml(rec.src) || '<br>'));
        // Insert after rightSpacer (children[0]) → before the current first paragraph.
        const firstPara = this.rightSpacer
            ? this.editorEl.children[1] // first paragraph is after rightSpacer
            : this.editorEl.firstChild as HTMLElement | null;
        this.editorEl.insertBefore(div, firstPara ?? null);
        // Shrink rightSpacer by the paragraph's estimated or measured width.
        const w = rec.width > 0 ? rec.width : UNRENDERED_WIDTH_PX;
        this.rightSpacerWidth = Math.max(0, this.rightSpacerWidth - w);
        if (this.rightSpacer) this.rightSpacer.style.setProperty('width', `${this.rightSpacerWidth}px`);
        this.domStart--;
    }

    // Adds a div for paragraphRecords[domEnd+1] at the left end of the window.
    private expandLeft(): void {
        if (this.domEnd >= this.paragraphRecords.length - 1) return;
        const i = this.domEnd + 1;
        const rec = this.paragraphRecords[i];
        const div = document.createElement('div');
        div.replaceChildren(sanitizeHTMLToDom(parseInlineToHtml(rec.src) || '<br>'));
        // Insert before leftSpacer (last child) → after the current last paragraph.
        this.editorEl.insertBefore(div, this.leftSpacer ?? null);
        const w = rec.width > 0 ? rec.width : UNRENDERED_WIDTH_PX;
        this.leftSpacerWidth = Math.max(0, this.leftSpacerWidth - w);
        if (this.leftSpacer) this.leftSpacer.style.setProperty('width', `${this.leftSpacerWidth}px`);
        this.domEnd++;
    }

    // Removes the leftmost div of the window (paragraphs[domEnd]) and grows leftSpacer.
    // Guards against removing a div that contains the current selection anchor or focus.
    private shrinkLeft(): void {
        if (this.domEnd < this.domStart) return; // empty window guard
        const spacerOffset = this.rightSpacer ? 1 : 0;
        const div = this.editorEl.children[this.domEnd - this.domStart + spacerOffset] as HTMLElement;
        if (!div) return;
        if (this.isDragging && this.selectionOverlaps(div)) return;
        const w = div.getBoundingClientRect().width || UNRENDERED_WIDTH_PX;
        this.paragraphRecords[this.domEnd].width = w;
        div.remove();
        this.leftSpacerWidth += w;
        if (this.leftSpacer) this.leftSpacer.style.setProperty('width', `${this.leftSpacerWidth}px`);
        this.domEnd--;
    }

    // Removes the rightmost div of the window (paragraphs[domStart]) and grows rightSpacer.
    private shrinkRight(): void {
        if (this.domEnd < this.domStart) return;
        const spacerOffset = this.rightSpacer ? 1 : 0;
        const div = this.editorEl.children[spacerOffset] as HTMLElement; // first paragraph
        if (!div || div.classList.contains(SPACER_CLASS)) return;
        if (this.isDragging && this.selectionOverlaps(div)) return;
        const w = div.getBoundingClientRect().width || UNRENDERED_WIDTH_PX;
        this.paragraphRecords[this.domStart].width = w;
        div.remove();
        this.rightSpacerWidth += w;
        if (this.rightSpacer) this.rightSpacer.style.setProperty('width', `${this.rightSpacerWidth}px`);
        this.domStart++;
    }

    // Returns true if the current selection anchor or focus node is inside div.
    private selectionOverlaps(div: HTMLElement): boolean {
        const sel = window.getSelection();
        if (!sel) return false;
        return div.contains(sel.anchorNode) || div.contains(sel.focusNode);
    }

    // Re-registers the current boundary divs (domStart and domEnd) with the window observer.
    // Must be called after any expand/shrink operation so the observer watches the new boundaries.
    private reobserveBoundaries(): void {
        if (!this.windowObserver) return;
        this.windowObserver.disconnect();
        const startDiv = this.getWindowDiv(this.domStart);
        const endDiv   = this.getWindowDiv(this.domEnd);
        if (startDiv) this.windowObserver.observe(startDiv);
        if (endDiv && endDiv !== startDiv) this.windowObserver.observe(endDiv);
    }

    // Called by the window boundary IntersectionObserver.
    // Boundary div enters extended viewport → expand window in that direction.
    // Boundary div exits extended viewport → shrink window from that same end.
    private onWindowBoundaryIntersection(entries: IntersectionObserverEntry[]): void {
        if (this.paragraphRecords.length === 0) return;
        let changed = false;
        for (const entry of entries) {
            const div = entry.target as HTMLElement;
            const spacerOffset = this.rightSpacer ? 1 : 0;
            const divIndex = Array.from(this.editorEl.children).indexOf(div) - spacerOffset + this.domStart;
            if (entry.isIntersecting) {
                if (divIndex === this.domStart && this.domStart > 0) {
                    // After shrinkRight, reobserveBoundaries delivers the new domStart's
                    // initial state as "intersecting" (it was already inside the rootMargin).
                    // Suppress this one delivery to prevent shrink→expand oscillation.
                    if (this.justShrankRight) {
                        this.justShrankRight = false;
                    } else {
                        this.expandRight();
                        this.justExpandedRight = true;
                        changed = true;
                    }
                }
                if (divIndex === this.domEnd && this.domEnd < this.paragraphRecords.length - 1) {
                    if (this.justShrankLeft) {
                        this.justShrankLeft = false;
                    } else {
                        this.expandLeft();
                        this.justExpandedLeft = true;
                        changed = true;
                    }
                }
            } else {
                // Only shrink when the window is wide enough that the exiting boundary is
                // clearly off-screen. Guard of +2 ensures at least one paragraph buffer remains.
                if (divIndex === this.domStart && this.domEnd > this.domStart + 2) {
                    // After expandRight, reobserveBoundaries delivers the new domStart's
                    // initial state as "not intersecting" (just outside the rootMargin).
                    // Suppress this one delivery to prevent expand→shrink oscillation.
                    if (this.justExpandedRight) {
                        this.justExpandedRight = false;
                    } else {
                        this.shrinkRight();
                        this.justShrankRight = true;
                        changed = true;
                    }
                }
                if (divIndex === this.domEnd && this.domEnd > this.domStart + 2) {
                    if (this.justExpandedLeft) {
                        this.justExpandedLeft = false;
                    } else {
                        this.shrinkLeft();
                        this.justShrankLeft = true;
                        changed = true;
                    }
                }
            }
        }
        if (changed) this.reobserveBoundaries();
    }

    // Arrow function so `this` is bound for addEventListener/removeEventListener.
    private readonly onMouseDown = () => { this.isDragging = true; };
    private readonly onMouseUp   = () => { this.isDragging = false; };

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

}

