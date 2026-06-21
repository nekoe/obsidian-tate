import { sanitizeHTMLToDom } from 'obsidian';
import { buildSegmentMap } from './SegmentMap';
import { parseInlineToHtml } from './AozoraParser';
import { computeViewOffsetInDiv, computeDomPositionFromViewOff, findLastBaseTextInElement, findParentDivInEditor } from './domHelpers';

// CSS class applied to both spacer divs so DOM walkers can skip them.
export const SPACER_CLASS = 'tate-spacer';
// CSS class applied to anchor island divs (real paragraph divs kept outside the main window).
const ANCHOR_CLASS = 'tate-anchor';
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

// A paragraph div kept in the DOM outside the main window as a pinned anchor island.
// type 'cursor': created when the cursor paragraph is evicted from the window edge.
// type 'selection': created explicitly for Cmd-A (para 0 or para N-1).
interface AnchorIsland {
    paraIdx: number;
    div: HTMLElement;
    type: 'cursor' | 'selection';
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
    // Maintained by initRecords() / spliceRecords() / updateWindowRecords().
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

    // Anchor islands: individual paragraph divs kept in the DOM outside the main window.
    // Right anchor sits between rightSpacer and the window; left anchor between window and leftSpacer.
    // Each anchor is accompanied by a mid-spacer that covers the gap to the window edge.
    //
    // DOM order: [rightSpacer] [?rightAnchor.div] [?midRightSpacer] [domStart..domEnd] [?midLeftSpacer] [?leftAnchor.div] [leftSpacer]
    private rightAnchor: AnchorIsland | null = null;
    private leftAnchor:  AnchorIsland | null = null;
    private midRightSpacer: HTMLElement | null = null;
    private midLeftSpacer:  HTMLElement | null = null;
    private midRightSpacerWidth = 0;
    private midLeftSpacerWidth  = 0;

    // Inner anchor islands: when both selection endpoints have moved outside the window on
    // the same side, the "inner" endpoint is promoted to a secondary anchor island so the
    // window can advance past both. Inner anchors are nested between the outer anchor and
    // the window edge.
    //
    // Right side DOM: [rightSpacer][rightAnchor(outer)][midRightOuterSpacer][rightAnchorInner][midRightSpacer][window]
    // Left side DOM:  [window][midLeftSpacer][leftAnchorInner][midLeftOuterSpacer][leftAnchor(outer)][leftSpacer]
    private rightAnchorInner: AnchorIsland | null = null;
    private leftAnchorInner:  AnchorIsland | null = null;
    private midRightOuterSpacer: HTMLElement | null = null;
    private midLeftOuterSpacer:  HTMLElement | null = null;
    private midRightOuterSpacerWidth = 0;
    private midLeftOuterSpacerWidth  = 0;

    // Font size in px; used to estimate paragraph widths for off-window records.
    // Updated by setFontSize() when plugin settings change.
    private fontSizePx = 22; // matches DEFAULT_SETTINGS.fontSize

    // Last observed scrollLeft; used to detect large jumps in adjustWindowOnScroll.
    private prevScrollLeft = -1;

    // Set by teleportWindowTo(); cleared on the next adjustWindowOnScroll() call.
    // Used to detect stale scroll events that fired before the teleport settled.
    private justTeleported = false;

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
        this.rightSpacer?.setCssProps({ '--tate-spacer-width': newW > 0 ? `${newW}px` : '' });
    }

    private applyLeftSpacer(newW: number): void {
        this.leftSpacerWidth = newW;
        this.leftSpacer?.setCssProps({ '--tate-spacer-width': newW > 0 ? `${newW}px` : '' });
    }

    private applyMidRightSpacer(newW: number): void {
        this.midRightSpacerWidth = newW;
        this.midRightSpacer?.setCssProps({ '--tate-spacer-width': newW > 0 ? `${newW}px` : '' });
    }

    private applyMidLeftSpacer(newW: number): void {
        this.midLeftSpacerWidth = newW;
        this.midLeftSpacer?.setCssProps({ '--tate-spacer-width': newW > 0 ? `${newW}px` : '' });
    }

    // Number of DOM children before the first window div.
    // = 1 (rightSpacer) + 2 per active anchor island (anchor div + spacer).
    private get windowChildOffset(): number {
        let off = this.rightSpacer ? 1 : 0;
        if (this.rightAnchor) off += 2;
        if (this.rightAnchorInner) off += 2;
        return off;
    }

    // Number of extra DOM children on the right side (anchor divs + mid-spacers).
    // Used by EditorElement.getValue() and paragraphChildIndex() to skip non-window children.
    get rightAnchorChildCount(): number {
        return (this.rightAnchor ? 2 : 0) + (this.rightAnchorInner ? 2 : 0);
    }

    // Number of extra DOM children on the left side (mid-spacers + anchor divs).
    get leftAnchorChildCount(): number {
        return (this.leftAnchorInner ? 2 : 0) + (this.leftAnchor ? 2 : 0);
    }

    // x-offset of the leftmost window div's left edge in the scroll container.
    // When anchor islands are active, includes all anchor widths and spacer widths.
    private get leftWindowOffset(): number {
        if (!this.leftAnchor) return this.leftSpacerWidth;
        const outerW = this.paragraphRecords[this.leftAnchor.paraIdx]?.width ?? 0;
        if (!this.leftAnchorInner) return this.leftSpacerWidth + outerW + this.midLeftSpacerWidth;
        const innerW = this.paragraphRecords[this.leftAnchorInner.paraIdx]?.width ?? 0;
        return this.leftSpacerWidth + outerW + this.midLeftOuterSpacerWidth + innerW + this.midLeftSpacerWidth;
    }

    // Combined right-side offset used in expand/shrink boundary calculations.
    // When anchor islands are active, includes all anchor widths and spacer widths.
    private get rightWindowOffset(): number {
        if (!this.rightAnchor) return this.rightSpacerWidth;
        const outerW = this.paragraphRecords[this.rightAnchor.paraIdx]?.width ?? 0;
        if (!this.rightAnchorInner) return this.rightSpacerWidth + outerW + this.midRightSpacerWidth;
        const innerW = this.paragraphRecords[this.rightAnchorInner.paraIdx]?.width ?? 0;
        return this.rightSpacerWidth + outerW + this.midRightOuterSpacerWidth + innerW + this.midRightSpacerWidth;
    }

    // Immediately removes all anchor islands and mid-spacers from the DOM without adjusting
    // spacer widths. Used before buildDomWindow / teleportWindowTo where resetWindow()
    // will recompute spacer widths from scratch.
    private forceRemoveAllAnchors(): void {
        if (this.rightAnchorInner) {
            this.rightAnchorInner.div.remove();
            this.midRightSpacer?.remove();       // inner→window spacer
            this.midRightOuterSpacer?.remove();  // outer→inner spacer
            this.rightAnchorInner = null;
            this.midRightSpacer = null;
            this.midRightSpacerWidth = 0;
            this.midRightOuterSpacer = null;
            this.midRightOuterSpacerWidth = 0;
            if (this.rightAnchor) {
                this.rightAnchor.div.remove();
                this.rightAnchor = null;
            }
        } else if (this.rightAnchor) {
            this.rightAnchor.div.remove();
            this.midRightSpacer?.remove();
            this.rightAnchor = null;
            this.midRightSpacer = null;
            this.midRightSpacerWidth = 0;
        }
        if (this.leftAnchorInner) {
            this.leftAnchorInner.div.remove();
            this.midLeftSpacer?.remove();        // window→inner spacer
            this.midLeftOuterSpacer?.remove();   // inner→outer spacer
            this.leftAnchorInner = null;
            this.midLeftSpacer = null;
            this.midLeftSpacerWidth = 0;
            this.midLeftOuterSpacer = null;
            this.midLeftOuterSpacerWidth = 0;
            if (this.leftAnchor) {
                this.leftAnchor.div.remove();
                this.leftAnchor = null;
            }
        } else if (this.leftAnchor) {
            this.leftAnchor.div.remove();
            this.midLeftSpacer?.remove();
            this.leftAnchor = null;
            this.midLeftSpacer = null;
            this.midLeftSpacerWidth = 0;
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
        this.forceRemoveAllAnchors();
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
    buildDomWindow(sources: string[]): void {
        this.forceRemoveAllAnchors();
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

    // Updates paragraphRecords for the window range from pre-serialized div sources.
    // Inserts or removes records at the domEnd boundary to match srcs.length, then writes
    // src/viewLen for each window paragraph. Called by EditorElement.syncRecordsFromDom()
    // before getValue() to materialise the current DOM state into records so that getValue()
    // can read from records alone without touching the DOM.
    updateWindowRecords(srcs: string[]): void {
        if (this.domEnd < 0) return;
        const oldWindowDivCount = this.domEnd - this.domStart + 1;
        const delta = srcs.length - oldWindowDivCount;
        if (delta > 0) {
            // More divs than domEnd expected (Enter or paste added divs). Insert new placeholder
            // records at domEnd+1 so that off-window records shift to the correct indices.
            const newRecs: ParagraphRecord[] = Array.from({ length: delta },
                () => ({ src: '', viewLen: 0, width: 0 }));
            this.paragraphRecords.splice(this.domEnd + 1, 0, ...newRecs);
            this.domEnd += delta;
        } else if (delta < 0) {
            // Fewer divs than domEnd expected (Backspace removed divs). Remove records from
            // the end of the window range so that off-window records shift back.
            this.paragraphRecords.splice(this.domEnd + delta + 1, -delta);
            this.domEnd += delta;
        }
        for (let k = 0; k < srcs.length; k++) {
            const rec = this.paragraphRecords[this.domStart + k];
            if (!rec) continue;
            rec.src     = srcs[k];
            rec.viewLen = this.buildParagraphVisibleText(srcs[k]).length;
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
        // Update anchor paraIdx based on the splice range.
        // When the splice deletes the anchor's own paragraph, remove the anchor from the DOM so
        // that subsequent spacer-recomputation (below) can rebuild widths from scratch.
        // Process inner anchors before outer anchors so mid-spacer state stays consistent.
        if (this.rightAnchorInner) {
            const idx = this.rightAnchorInner.paraIdx;
            if (lo <= idx && idx < lo + deleteCount) {
                this.rightAnchorInner.div.remove();
                this.midRightSpacer?.remove();      // inner→window spacer
                this.rightAnchorInner = null;
                // Restore midRightOuterSpacer as outer→window spacer.
                this.midRightSpacer = this.midRightOuterSpacer;
                this.midRightSpacerWidth = this.midRightOuterSpacerWidth;
                this.midRightOuterSpacer = null;
                this.midRightOuterSpacerWidth = 0;
            } else if (idx >= lo + deleteCount) {
                this.rightAnchorInner = { ...this.rightAnchorInner, paraIdx: idx + delta };
            }
        }
        if (this.rightAnchor) {
            const idx = this.rightAnchor.paraIdx;
            if (lo <= idx && idx < lo + deleteCount) {
                // Outer anchor's paragraph deleted — clean up any remaining inner anchor first.
                if (this.rightAnchorInner) {
                    this.rightAnchorInner.div.remove();
                    this.midRightSpacer?.remove();
                    this.midRightOuterSpacer?.remove();
                    this.rightAnchorInner = null;
                    this.midRightSpacer = null;
                    this.midRightSpacerWidth = 0;
                    this.midRightOuterSpacer = null;
                    this.midRightOuterSpacerWidth = 0;
                }
                this.rightAnchor.div.remove();
                this.midRightSpacer?.remove();
                this.rightAnchor = null;
                this.midRightSpacer = null;
                this.midRightSpacerWidth = 0;
            } else if (idx >= lo + deleteCount) {
                this.rightAnchor = { ...this.rightAnchor, paraIdx: idx + delta };
            }
        }
        if (this.leftAnchorInner) {
            const idx = this.leftAnchorInner.paraIdx;
            if (lo <= idx && idx < lo + deleteCount) {
                this.leftAnchorInner.div.remove();
                this.midLeftSpacer?.remove();       // window→inner spacer
                this.leftAnchorInner = null;
                // Restore midLeftOuterSpacer as window→outer spacer.
                this.midLeftSpacer = this.midLeftOuterSpacer;
                this.midLeftSpacerWidth = this.midLeftOuterSpacerWidth;
                this.midLeftOuterSpacer = null;
                this.midLeftOuterSpacerWidth = 0;
            } else if (idx >= lo + deleteCount) {
                this.leftAnchorInner = { ...this.leftAnchorInner, paraIdx: idx + delta };
            }
        }
        if (this.leftAnchor) {
            const idx = this.leftAnchor.paraIdx;
            if (lo <= idx && idx < lo + deleteCount) {
                if (this.leftAnchorInner) {
                    this.leftAnchorInner.div.remove();
                    this.midLeftSpacer?.remove();
                    this.midLeftOuterSpacer?.remove();
                    this.leftAnchorInner = null;
                    this.midLeftSpacer = null;
                    this.midLeftSpacerWidth = 0;
                    this.midLeftOuterSpacer = null;
                    this.midLeftOuterSpacerWidth = 0;
                }
                this.leftAnchor.div.remove();
                this.midLeftSpacer?.remove();
                this.leftAnchor = null;
                this.midLeftSpacer = null;
                this.midLeftSpacerWidth = 0;
            } else if (idx >= lo + deleteCount) {
                this.leftAnchor = { ...this.leftAnchor, paraIdx: idx + delta };
            }
        }
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
    getWindowDiv(i: number): HTMLElement | null {
        if (!this.isInWindow(i)) return null;
        return (this.editorEl.children[i - this.domStart + this.windowChildOffset] as HTMLElement) ?? null;
    }

    // Returns the paragraphRecords index for div if it is an anchor island div, or -1 otherwise.
    // Used by EditorElement.handlePaste() to detect when the cursor is in an anchor island so
    // the window can be teleported before paste, preventing DOM structure corruption.
    getAnchorParaIdxForDiv(div: HTMLElement): number {
        if (this.rightAnchor?.div === div)      return this.rightAnchor.paraIdx;
        if (this.rightAnchorInner?.div === div) return this.rightAnchorInner.paraIdx;
        if (this.leftAnchorInner?.div === div)  return this.leftAnchorInner.paraIdx;
        if (this.leftAnchor?.div === div)       return this.leftAnchor.paraIdx;
        return -1;
    }

    // Teleports the DOM window to be centered on paragraph `center` (± windowHalf).
    // Rebuilds the DOM from paragraphRecords without traversing intermediate paragraphs.
    // Clears any anchor islands first so spacer widths are recomputed cleanly by resetWindow().
    // Used by EditorElement.jumpWindowTo() and SearchPanel navigation.
    // windowHalf=20 (41 divs max) rather than the INITIAL_WINDOW_HALF of 50: adjustWindowOnScroll
    // corrects the window size on the next scroll event, so a large pre-built buffer is wasteful.
    // 20 exceeds the ~10-paragraph expand margin and avoids an immediate expansion in all cases.
    teleportWindowTo(center: number, windowHalf = 20): void {
        const N = this.paragraphRecords.length;
        if (N === 0) return;
        const lo = Math.max(0, center - windowHalf);
        const hi = Math.min(N - 1, center + windowHalf);
        this.buildDomWindow(this.paragraphRecords.slice(lo, hi + 1).map(r => r.src));
        this.resetWindow(lo, hi);
        this.justTeleported = true;
    }

    // Called on selectionchange. Absorbs cursor-type anchor islands when neither selection
    // endpoint is inside them, so the anchor does not persist indefinitely after the user
    // clicks elsewhere. Selection-type anchors (created by Cmd-A) are left untouched; they
    // are released by clearVirtualSelection() when the VS is cleared.
    ensureWindowAroundCursor(): void {
        const sel = window.getSelection();
        if (!sel) return;
        const anchorNode = sel.anchorNode;
        if (!anchorNode) return;
        const focusNode = sel.focusNode;
        if (this.rightAnchor?.type === 'cursor' &&
            !this.rightAnchor.div.contains(anchorNode) &&
            !(focusNode && this.rightAnchor.div.contains(focusNode))) {
            // Absorb inner first (nested between outer anchor and window).
            if (this.rightAnchorInner) this.absorbRightAnchorInner();
            this.absorbRightAnchor();
        }
        if (this.leftAnchor?.type === 'cursor' &&
            !this.leftAnchor.div.contains(anchorNode) &&
            !(focusNode && this.leftAnchor.div.contains(focusNode))) {
            if (this.leftAnchorInner) this.absorbLeftAnchorInner();
            this.absorbLeftAnchor();
        }
    }

    // ---- Anchor island management ----

    // Pins paragraph paraIdx as a right anchor island between rightSpacer and the main window.
    // Case A (domStart == paraIdx): promotes the current rightmost window div to anchor by
    //   inserting a midRightSpacer after it and incrementing domStart.
    // Case B (domStart > paraIdx): creates a new div for paraIdx from records and inserts it
    //   with a midRightSpacer between rightSpacer and the window.
    private setRightAnchor(paraIdx: number, type: 'cursor' | 'selection'): void {
        if (this.rightAnchor?.paraIdx === paraIdx) {
            this.rightAnchor.type = type;
            return;
        }
        // Absorb any existing right anchor before setting a new one.
        if (this.rightAnchor) this.absorbRightAnchor();

        const rec = this.paragraphRecords[paraIdx];
        if (!rec) return;
        const anchorW = rec.width > 0 ? rec.width : this.estimateWidth(rec.viewLen);
        rec.width = anchorW;

        let anchorDiv: HTMLElement;
        const midSpacer = activeDocument.createElement('div');
        midSpacer.classList.add(SPACER_CLASS);

        let midW: number;

        if (this.domStart === paraIdx) {
            // Case A: promote current window's rightmost div.
            anchorDiv = this.getWindowDiv(paraIdx)!;
            if (!anchorDiv) return;
            anchorDiv.classList.add(ANCHOR_CLASS);
            // Insert midSpacer immediately after anchorDiv (before the new domStart div).
            anchorDiv.insertAdjacentElement('afterend', midSpacer);
            midW = 0; // anchor and window are adjacent
            this.domStart++;
            // rightSpacerWidth is unchanged (still covers 0..paraIdx-1).
        } else {
            // Case B: paraIdx is in the rightSpacer region — create a new div.
            anchorDiv = activeDocument.createElement('div');
            anchorDiv.classList.add(ANCHOR_CLASS);
            anchorDiv.replaceChildren(sanitizeHTMLToDom(parseInlineToHtml(rec.src) || '<br>'));
            // Insert: [rightSpacer] → [anchorDiv] → [midSpacer] → [window]
            const insertPoint = this.rightSpacer
                ? this.editorEl.children[1] as ChildNode
                : this.editorEl.firstChild;
            this.editorEl.insertBefore(anchorDiv, insertPoint ?? null);
            anchorDiv.insertAdjacentElement('afterend', midSpacer);
            // midW = sum of para[paraIdx+1..domStart-1] widths.
            midW = 0;
            for (let k = paraIdx + 1; k < this.domStart; k++) {
                const r = this.paragraphRecords[k];
                midW += r.width > 0 ? r.width : this.estimateWidth(r.viewLen);
            }
            // rightSpacerWidth now covers only 0..paraIdx-1.
            this.applyRightSpacer(Math.max(0, this.rightSpacerWidth - anchorW - midW));
        }

        this.rightAnchor = { paraIdx, div: anchorDiv, type };
        this.midRightSpacer = midSpacer;
        this.applyMidRightSpacer(midW);
    }

    // Symmetric counterpart of setRightAnchor for the left side.
    private setLeftAnchor(paraIdx: number, type: 'cursor' | 'selection'): void {
        if (this.leftAnchor?.paraIdx === paraIdx) {
            this.leftAnchor.type = type;
            return;
        }
        if (this.leftAnchor) this.absorbLeftAnchor();

        const rec = this.paragraphRecords[paraIdx];
        if (!rec) return;
        const anchorW = rec.width > 0 ? rec.width : this.estimateWidth(rec.viewLen);
        rec.width = anchorW;

        let anchorDiv: HTMLElement;
        const midSpacer = activeDocument.createElement('div');
        midSpacer.classList.add(SPACER_CLASS);

        let midW: number;

        if (this.domEnd === paraIdx) {
            // Case A: promote current window's leftmost div.
            anchorDiv = this.getWindowDiv(paraIdx)!;
            if (!anchorDiv) return;
            anchorDiv.classList.add(ANCHOR_CLASS);
            // Insert midSpacer immediately before anchorDiv (after the new domEnd div).
            anchorDiv.insertAdjacentElement('beforebegin', midSpacer);
            midW = 0;
            this.domEnd--;
            // leftSpacerWidth is unchanged.
        } else {
            // Case B: paraIdx is in the leftSpacer region — create a new div.
            anchorDiv = activeDocument.createElement('div');
            anchorDiv.classList.add(ANCHOR_CLASS);
            anchorDiv.replaceChildren(sanitizeHTMLToDom(parseInlineToHtml(rec.src) || '<br>'));
            // Insert: [window] → [midSpacer] → [anchorDiv] → [leftSpacer]
            this.editorEl.insertBefore(anchorDiv, this.leftSpacer ?? null);
            anchorDiv.insertAdjacentElement('beforebegin', midSpacer);
            midW = 0;
            for (let k = this.domEnd + 1; k < paraIdx; k++) {
                const r = this.paragraphRecords[k];
                midW += r.width > 0 ? r.width : this.estimateWidth(r.viewLen);
            }
            this.applyLeftSpacer(Math.max(0, this.leftSpacerWidth - anchorW - midW));
        }

        this.leftAnchor = { paraIdx, div: anchorDiv, type };
        this.midLeftSpacer = midSpacer;
        this.applyMidLeftSpacer(midW);
    }

    // Absorbs the right anchor back into the window or right spacer.
    // When midRightSpacerWidth == 0 (anchor is adjacent to window): removes the mid-spacer
    //   and decrements domStart so the anchor div becomes the new window right edge.
    // When midRightSpacerWidth > 0 (anchor is separated): removes both the anchor div and
    //   mid-spacer from the DOM and returns their widths to rightSpacer.
    private absorbRightAnchor(): void {
        if (!this.rightAnchor || !this.midRightSpacer) return;
        // Inner anchor must be absorbed first to restore midRightSpacer to outer→window role.
        if (this.rightAnchorInner) this.absorbRightAnchorInner();
        if (this.midRightSpacerWidth === 0) {
            // Adjacent — incorporate anchor into window.
            this.midRightSpacer.remove();
            this.rightAnchor.div.classList.remove(ANCHOR_CLASS);
            this.domStart = this.rightAnchor.paraIdx;
        } else {
            // Gap present — return widths to rightSpacer.
            const anchorW = this.paragraphRecords[this.rightAnchor.paraIdx]?.width ??
                this.estimateWidth(this.paragraphRecords[this.rightAnchor.paraIdx]?.viewLen ?? 0);
            this.rightAnchor.div.remove();
            this.midRightSpacer.remove();
            this.applyRightSpacer(this.rightSpacerWidth + anchorW + this.midRightSpacerWidth);
        }
        this.midRightSpacer = null;
        this.midRightSpacerWidth = 0;
        this.rightAnchor = null;
    }

    // Symmetric counterpart of absorbRightAnchor for the left side.
    private absorbLeftAnchor(): void {
        if (!this.leftAnchor || !this.midLeftSpacer) return;
        if (this.leftAnchorInner) this.absorbLeftAnchorInner();
        if (this.midLeftSpacerWidth === 0) {
            this.midLeftSpacer.remove();
            this.leftAnchor.div.classList.remove(ANCHOR_CLASS);
            this.domEnd = this.leftAnchor.paraIdx;
        } else {
            const anchorW = this.paragraphRecords[this.leftAnchor.paraIdx]?.width ??
                this.estimateWidth(this.paragraphRecords[this.leftAnchor.paraIdx]?.viewLen ?? 0);
            this.leftAnchor.div.remove();
            this.midLeftSpacer.remove();
            this.applyLeftSpacer(this.leftSpacerWidth + anchorW + this.midLeftSpacerWidth);
        }
        this.midLeftSpacer = null;
        this.midLeftSpacerWidth = 0;
        this.leftAnchor = null;
    }

    // Pins paragraphRecords[paraIdx] as a secondary (inner) right anchor island between the
    // outer rightAnchor and the main window. Called when shrinkRight finds rightAnchor already
    // set and the inner endpoint blocks eviction again. Only Case A (domStart === paraIdx)
    // is supported: promotes the current rightmost window div; domStart is incremented.
    private setRightAnchorInner(paraIdx: number, type: 'cursor' | 'selection'): void {
        if (this.rightAnchorInner?.paraIdx === paraIdx) { this.rightAnchorInner.type = type; return; }
        if (this.rightAnchorInner) this.absorbRightAnchorInner();
        if (!this.rightAnchor) return;
        const anchorDiv = this.getWindowDiv(paraIdx);
        if (!anchorDiv) return;
        anchorDiv.classList.add(ANCHOR_CLASS);
        // Existing midRightSpacer (outer→window) becomes midRightOuterSpacer (outer→inner).
        this.midRightOuterSpacer = this.midRightSpacer;
        this.midRightOuterSpacerWidth = this.midRightSpacerWidth;
        // New midRightSpacer (inner→window) starts at width 0 (adjacent).
        const newMid = activeDocument.createElement('div');
        newMid.classList.add(SPACER_CLASS);
        anchorDiv.insertAdjacentElement('afterend', newMid);
        this.midRightSpacer = newMid;
        this.midRightSpacerWidth = 0;
        this.rightAnchorInner = { paraIdx, div: anchorDiv, type };
        this.domStart++;
    }

    // Absorbs the inner right anchor back into the window (midRightSpacer == 0) or folds
    // its width into midRightOuterSpacer (gap present). Restores midRightSpacer to the
    // outer→window spacer role held by midRightOuterSpacer.
    private absorbRightAnchorInner(): void {
        if (!this.rightAnchorInner || !this.midRightSpacer || !this.midRightOuterSpacer) return;
        const inner = this.rightAnchorInner;
        if (this.midRightSpacerWidth === 0) {
            this.midRightSpacer.remove();
            inner.div.classList.remove(ANCHOR_CLASS);
            this.midRightSpacer = this.midRightOuterSpacer;
            this.midRightSpacerWidth = this.midRightOuterSpacerWidth;
            this.domStart = inner.paraIdx;
        } else {
            const innerW = this.paragraphRecords[inner.paraIdx]?.width ??
                this.estimateWidth(this.paragraphRecords[inner.paraIdx]?.viewLen ?? 0);
            const oldInnerSpacerW = this.midRightSpacerWidth;
            inner.div.remove();
            this.midRightSpacer.remove();
            this.midRightSpacer = this.midRightOuterSpacer;
            this.applyMidRightSpacer(this.midRightOuterSpacerWidth + innerW + oldInnerSpacerW);
        }
        this.midRightOuterSpacer = null;
        this.midRightOuterSpacerWidth = 0;
        this.rightAnchorInner = null;
    }

    // Symmetric counterpart of setRightAnchorInner for the left side.
    // Only Case A (domEnd === paraIdx) is supported; domEnd is decremented.
    private setLeftAnchorInner(paraIdx: number, type: 'cursor' | 'selection'): void {
        if (this.leftAnchorInner?.paraIdx === paraIdx) { this.leftAnchorInner.type = type; return; }
        if (this.leftAnchorInner) this.absorbLeftAnchorInner();
        if (!this.leftAnchor) return;
        const anchorDiv = this.getWindowDiv(paraIdx);
        if (!anchorDiv) return;
        anchorDiv.classList.add(ANCHOR_CLASS);
        // Existing midLeftSpacer (window→outer) becomes midLeftOuterSpacer (inner→outer).
        this.midLeftOuterSpacer = this.midLeftSpacer;
        this.midLeftOuterSpacerWidth = this.midLeftSpacerWidth;
        // New midLeftSpacer (window→inner) starts at width 0 (adjacent).
        const newMid = activeDocument.createElement('div');
        newMid.classList.add(SPACER_CLASS);
        anchorDiv.insertAdjacentElement('beforebegin', newMid);
        this.midLeftSpacer = newMid;
        this.midLeftSpacerWidth = 0;
        this.leftAnchorInner = { paraIdx, div: anchorDiv, type };
        this.domEnd--;
    }

    // Symmetric counterpart of absorbRightAnchorInner for the left side.
    private absorbLeftAnchorInner(): void {
        if (!this.leftAnchorInner || !this.midLeftSpacer || !this.midLeftOuterSpacer) return;
        const inner = this.leftAnchorInner;
        if (this.midLeftSpacerWidth === 0) {
            this.midLeftSpacer.remove();
            inner.div.classList.remove(ANCHOR_CLASS);
            this.midLeftSpacer = this.midLeftOuterSpacer;
            this.midLeftSpacerWidth = this.midLeftOuterSpacerWidth;
            this.domEnd = inner.paraIdx;
        } else {
            const innerW = this.paragraphRecords[inner.paraIdx]?.width ??
                this.estimateWidth(this.paragraphRecords[inner.paraIdx]?.viewLen ?? 0);
            const oldInnerSpacerW = this.midLeftSpacerWidth;
            inner.div.remove();
            this.midLeftSpacer.remove();
            this.midLeftSpacer = this.midLeftOuterSpacer;
            this.applyMidLeftSpacer(this.midLeftOuterSpacerWidth + innerW + oldInnerSpacerW);
        }
        this.midLeftOuterSpacer = null;
        this.midLeftOuterSpacerWidth = 0;
        this.leftAnchorInner = null;
    }

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
                if (this.rightAnchor) {
                    this.applyMidRightSpacer(Math.max(0, this.midRightSpacerWidth - correction));
                } else {
                    this.applyRightSpacer(Math.max(0, this.rightSpacerWidth - correction));
                }
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
                if (this.leftAnchor) {
                    this.applyMidLeftSpacer(Math.max(0, this.midLeftSpacerWidth - correction));
                } else {
                    this.applyLeftSpacer(Math.max(0, this.leftSpacerWidth - correction));
                }
            }
        }
    }

    // ---- Window expand / shrink helpers ----

    // Adds a div for paragraphRecords[domStart-1] at the right end of the window.
    // When anchor islands are active and domStart-1 matches an anchor, absorbs it instead.
    // Inner anchor is checked first (it is closer to the window than the outer anchor).
    private expandRight(): void {
        if (this.domStart <= 0) return;
        const i = this.domStart - 1;
        if (this.rightAnchorInner && i === this.rightAnchorInner.paraIdx) {
            this.absorbRightAnchorInner();
            return;
        }
        if (this.rightAnchor && i === this.rightAnchor.paraIdx) {
            this.absorbRightAnchor();
            return;
        }
        const rec = this.paragraphRecords[i];
        const div = activeDocument.createElement('div');
        div.replaceChildren(sanitizeHTMLToDom(parseInlineToHtml(rec.src) || '<br>'));
        // Insert before the first window div (accounts for anchor + midSpacer offset).
        const firstWindowDiv = this.editorEl.children[this.windowChildOffset] as HTMLElement | null;
        this.editorEl.insertBefore(div, firstWindowDiv ?? null);
        const w = rec.width > 0 ? rec.width : this.estimateWidth(rec.viewLen);
        if (this.rightAnchor) {
            // New div came from midRight region; shrink mid-spacer.
            this.applyMidRightSpacer(Math.max(0, this.midRightSpacerWidth - w));
        } else {
            this.applyRightSpacer(Math.max(0, this.rightSpacerWidth - w));
        }
        this.domStart--;
    }

    // Adds a div for paragraphRecords[domEnd+1] at the left end of the window.
    // When anchor islands are active and domEnd+1 matches an anchor, absorbs it instead.
    // Inner anchor is checked first (it is closer to the window than the outer anchor).
    private expandLeft(): void {
        if (this.domEnd >= this.paragraphRecords.length - 1) return;
        const i = this.domEnd + 1;
        if (this.leftAnchorInner && i === this.leftAnchorInner.paraIdx) {
            this.absorbLeftAnchorInner();
            return;
        }
        if (this.leftAnchor && i === this.leftAnchor.paraIdx) {
            this.absorbLeftAnchor();
            return;
        }
        const rec = this.paragraphRecords[i];
        const div = activeDocument.createElement('div');
        div.replaceChildren(sanitizeHTMLToDom(parseInlineToHtml(rec.src) || '<br>'));
        // Insert before midLeftSpacer (if anchor present) or leftSpacer.
        const insertBefore = this.leftAnchor ? this.midLeftSpacer : this.leftSpacer;
        this.editorEl.insertBefore(div, insertBefore ?? null);
        const w = rec.width > 0 ? rec.width : this.estimateWidth(rec.viewLen);
        if (this.leftAnchor) {
            this.applyMidLeftSpacer(Math.max(0, this.midLeftSpacerWidth - w));
        } else {
            this.applyLeftSpacer(Math.max(0, this.leftSpacerWidth - w));
        }
        this.domEnd++;
    }

    // Removes the leftmost div of the window (paragraphs[domEnd]) and grows leftSpacer (or
    // midLeftSpacer when a left anchor is active).
    // When any selection endpoint (collapsed or not) is inside this div, promotes the div to a
    // left anchor island instead of removing it, so the selection endpoint stays in the DOM.
    private shrinkLeft(): void {
        if (this.domEnd < this.domStart) return; // empty window guard
        const div = this.editorEl.children[this.domEnd - this.domStart + this.windowChildOffset] as HTMLElement;
        if (!div || div.classList.contains(SPACER_CLASS) || div.classList.contains(ANCHOR_CLASS)) return;
        const sel = window.getSelection();
        if (sel) {
            const collidingAnchor = div.contains(sel.anchorNode);
            const collidingFocus  = div.contains(sel.focusNode);
            if (sel.isCollapsed && collidingAnchor) {
                // Promote to anchor island instead of blocking removal.
                if (!this.leftAnchor) this.setLeftAnchor(this.domEnd, 'cursor');
                return;
            }
            if (!sel.isCollapsed && (collidingAnchor || collidingFocus)) {
                if (!this.leftAnchor) {
                    this.initVsFromDomIfNeeded(sel);
                    this.setLeftAnchor(this.domEnd, 'cursor');
                } else if (!this.leftAnchorInner && this.virtualSelection) {
                    this.setLeftAnchorInner(this.domEnd, 'cursor');
                }
                return;
            }
        }
        const rec = this.paragraphRecords[this.domEnd];
        const w = rec.width > 0 ? rec.width : this.estimateWidth(rec.viewLen);
        rec.width = w;
        div.remove();
        if (this.leftAnchor) {
            this.applyMidLeftSpacer(this.midLeftSpacerWidth + w);
        } else {
            this.applyLeftSpacer(this.leftSpacerWidth + w);
        }
        this.domEnd--;
    }

    // Removes the rightmost div of the window (paragraphs[domStart]) and grows rightSpacer (or
    // midRightSpacer when a right anchor is active).
    // When any selection endpoint (collapsed or not) is inside this div, promotes the div to a
    // right anchor island instead of removing it, so the selection endpoint stays in the DOM.
    private shrinkRight(): void {
        if (this.domEnd < this.domStart) return;
        const div = this.editorEl.children[this.windowChildOffset] as HTMLElement; // first window paragraph
        if (!div || div.classList.contains(SPACER_CLASS) || div.classList.contains(ANCHOR_CLASS)) return;
        const sel = window.getSelection();
        if (sel) {
            const collidingAnchor = div.contains(sel.anchorNode);
            const collidingFocus  = div.contains(sel.focusNode);
            if (sel.isCollapsed && collidingAnchor) {
                // Promote to anchor island instead of blocking removal.
                if (!this.rightAnchor) this.setRightAnchor(this.domStart, 'cursor');
                return;
            }
            if (!sel.isCollapsed && (collidingAnchor || collidingFocus)) {
                if (!this.rightAnchor) {
                    this.initVsFromDomIfNeeded(sel);
                    this.setRightAnchor(this.domStart, 'cursor');
                } else if (!this.rightAnchorInner && this.virtualSelection) {
                    this.setRightAnchorInner(this.domStart, 'cursor');
                }
                return;
            }
        }
        const rec = this.paragraphRecords[this.domStart];
        const w = rec.width > 0 ? rec.width : this.estimateWidth(rec.viewLen);
        rec.width = w;
        div.remove();
        if (this.rightAnchor) {
            this.applyMidRightSpacer(this.midRightSpacerWidth + w);
        } else {
            this.applyRightSpacer(this.rightSpacerWidth + w);
        }
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
        // Reconcile domEnd with the actual number of window divs before any measurements.
        // The DOM may have gained or lost divs since the last commit (e.g. a scroll event
        // arriving during the debounce window after Backspace/Enter). Reconciling here ensures
        // premeasureWindowWidths reads the correct div positions and shrink/expand decisions
        // are based on accurate data.
        if (this.domEnd >= 0 && this.rightSpacer) {
            const anchorChildren = this.rightAnchorChildCount + this.leftAnchorChildCount;
            const actualDivCount = this.editorEl.children.length - 2 - anchorChildren;
            const expected = this.domEnd - this.domStart + 1;
            if (actualDivCount !== expected) {
                const newDomEnd = Math.min(
                    this.domStart + actualDivCount - 1,
                    this.paragraphRecords.length - 1,
                );
                if (newDomEnd < this.domEnd) {
                    // Divs were removed (e.g. Backspace merging paragraphs): splice out the
                    // stale records so getValue() returns the correct paragraph count.
                    // Without this, syncRecordsFromDom() sees delta=0 (because domEnd was
                    // already reconciled) and leaves the orphaned record in place.
                    this.paragraphRecords.splice(newDomEnd + 1, this.domEnd - newDomEnd);
                }
                // newDomEnd > domEnd (divs gained): no paragraphRecords manipulation needed.
                // All paths that increase div count (insertParagraph, paste, undo/redo) call
                // syncRecordsFromDom() synchronously before adjustNow(), so records are already
                // consistent when this reconcile block runs. The Math.min cap above also guards
                // against domEnd ever exceeding paragraphRecords.length - 1.
                this.domEnd = newDomEnd;
            }
        }
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
        let W            = this.scrollArea.scrollWidth; // 'let': may be updated after teleport

        // Discard stale scroll events that were queued before the most recent teleportWindowTo.
        // After a teleport the window is centred on a new paragraph; a scroll event carrying the
        // old scrollLeft position would otherwise drive O(N) expand/shrink back to the old spot.
        // Threshold: SHRINK_MARGIN ensures the guard fires only when scrollLeft is actually
        // outside the teleported window (not merely near its edge).
        if (this.justTeleported) {
            this.justTeleported = false;
            const windowRight = W - this.rightWindowOffset;
            const windowLeft  = this.leftWindowOffset;
            if (scrollLeft > windowRight + SHRINK_MARGIN ||
                    scrollLeft + viewW < windowLeft - SHRINK_MARGIN) {
                return;
            }
        }

        // When a virtual selection is active and the viewport jumps by more than 10 screen
        // widths, the browser has auto-scrolled to reveal a selection endpoint (e.g. after
        // Cmd-A → Shift+Arrow). Incremental expand/shrink would be O(N) DOM mutations;
        // teleport the window directly to the VS focus paragraph instead.
        const prevScrollLeft = this.prevScrollLeft;
        this.prevScrollLeft  = scrollLeft;
        if (this.virtualSelection && prevScrollLeft >= 0 &&
                Math.abs(scrollLeft - prevScrollLeft) > viewW * 10) {
            this.teleportWindowTo(this.virtualSelection.focusParaIdx);
            W = this.scrollArea.scrollWidth; // re-read after teleport mutations
        }

        // ---- Left boundary (domEnd) ----
        // Expand: window's left edge (leftWindowOffset) within EXPAND_MARGIN of viewport's
        // left edge. leftWindowOffset accounts for leftAnchor + midLeftSpacer when active.
        // Using leftWindowOffset alone (without + domEnd.width) ensures the value decreases
        // with each expandLeft call, preventing the condition from being a constant that
        // would otherwise cause O(N) expansion when scrollLeft is at the document boundary.
        while (this.domEnd < this.paragraphRecords.length - 1) {
            if (this.leftWindowOffset > scrollLeft - EXPAND_MARGIN) {
                this.expandLeft();
            } else break;
        }
        // Shrink: domEnd's right edge more than SHRINK_MARGIN behind viewport's left edge.
        while (this.domEnd > this.domStart + 2) {
            const rec = this.paragraphRecords[this.domEnd];
            const w   = rec.width > 0 ? rec.width : this.estimateWidth(rec.viewLen);
            if (this.leftWindowOffset + w < scrollLeft - SHRINK_MARGIN) {
                const endBefore = this.domEnd;
                this.shrinkLeft();
                if (this.domEnd === endBefore) break; // blocked (e.g. selection overlap), stop
            } else break;
        }

        // ---- Right boundary (domStart) ----
        // Expand: domStart's left edge within EXPAND_MARGIN of viewport's right edge.
        // rightWindowOffset accounts for rightAnchor + midRightSpacer when active.
        while (this.domStart > 0) {
            const rec = this.paragraphRecords[this.domStart];
            const w   = rec.width > 0 ? rec.width : this.estimateWidth(rec.viewLen);
            if (W - this.rightWindowOffset - w < scrollLeft + viewW + EXPAND_MARGIN) {
                this.expandRight();
            } else break;
        }
        // Shrink: domStart's left edge more than SHRINK_MARGIN past viewport's right edge.
        while (this.domEnd > this.domStart + 2) {
            const rec = this.paragraphRecords[this.domStart];
            const w   = rec.width > 0 ? rec.width : this.estimateWidth(rec.viewLen);
            if (W - this.rightWindowOffset - w > scrollLeft + viewW + SHRINK_MARGIN) {
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
        // Before resetting, capture any focus movement (e.g., Shift+Arrow into a mid-spacer)
        // that occurred between the browser's selection update and this scroll event firing.
        if (this.virtualSelection) {
            const sel = window.getSelection();
            if (sel && !sel.isCollapsed) {
                const focusUpdated = this.tryUpdateFocusFromDom(sel);
                if (focusUpdated) this.scrollFocusIntoView();
            }
            this.syncDomRangeToVirtual();
        }

    }

    // Reads the actual rendered widths of all in-window paragraph divs and updates
    // paragraphRecords[i].width. A single layout flush — no DOM mutations between reads.
    // Called at the start of adjustWindowOnScroll() so that shrink operations use actual
    // widths. When the stored width equals the actual width, the net scrollWidth change
    // per shrink is zero, keeping the cursor in place (overflow-anchor: none).
    private premeasureWindowWidths(): void {
        if (!this.rightSpacer || this.domEnd < 0) return;
        const off = this.windowChildOffset;
        const children = this.editorEl.children;
        for (let i = this.domStart; i <= this.domEnd; i++) {
            const k = i - this.domStart;
            const div = children[k + off] as HTMLElement;
            if (!div || div.classList.contains(SPACER_CLASS)) continue;
            const w = div.getBoundingClientRect().width;
            if (w > 0) this.paragraphRecords[i].width = w;
        }
        // Also measure anchor divs so their widths are accurate for spacer accounting.
        if (this.rightAnchor) {
            const w = this.rightAnchor.div.getBoundingClientRect().width;
            if (w > 0) this.paragraphRecords[this.rightAnchor.paraIdx].width = w;
        }
        if (this.rightAnchorInner) {
            const w = this.rightAnchorInner.div.getBoundingClientRect().width;
            if (w > 0) this.paragraphRecords[this.rightAnchorInner.paraIdx].width = w;
        }
        if (this.leftAnchorInner) {
            const w = this.leftAnchorInner.div.getBoundingClientRect().width;
            if (w > 0) this.paragraphRecords[this.leftAnchorInner.paraIdx].width = w;
        }
        if (this.leftAnchor) {
            const w = this.leftAnchor.div.getBoundingClientRect().width;
            if (w > 0) this.paragraphRecords[this.leftAnchor.paraIdx].width = w;
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

    /** Absolute view offset of the active VirtualSelection's focus endpoint, or null when
     *  no VS is active. Equals the sum of preceding paragraph viewLens plus focusViewOff. */
    getVirtualSelectionFocusOffset(): number | null {
        const vs = this.virtualSelection;
        if (!vs) return null;
        let offset = vs.focusViewOff;
        for (let i = 0; i < vs.focusParaIdx; i++) offset += this.paragraphRecords[i].viewLen;
        return offset;
    }

    /** Returns the paragraphRecords index of the current caret / selection focus, or -1 when it
     *  cannot be determined. Uses the VS focus paragraph when a VirtualSelection is active,
     *  otherwise reads the DOM selection focus node. Used by the paragraph-boundary jump. */
    getCaretParagraphIndex(): number {
        if (this.virtualSelection) return this.virtualSelection.focusParaIdx;
        const sel = window.getSelection();
        if (!sel || !sel.focusNode) return -1;
        const div = this.findParaDiv(sel.focusNode);
        if (!div) return -1;
        return this.getParagraphIndex(div);
    }

    clearVirtualSelection(): void {
        if (this.virtualSelection) {
            // Release selection-type anchor islands created for Cmd-A.
            if (this.rightAnchor?.type === 'selection') this.absorbRightAnchor();
            if (this.leftAnchor?.type === 'selection') this.absorbLeftAnchor();
        }
        this.virtualSelection = null;
    }

    // Initializes VS to span the entire document and syncs the DOM Range to proxy positions.
    // For N > 1: sets up anchor islands for para 0 (right anchor) and para N-1 (left anchor)
    // so that the DOM selection uses real nodes rather than window-boundary proxies.
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
        if (N > 1) {
            // Ensure para 0 is in DOM as right anchor (unless it is already in the window).
            if (this.domStart > 0) this.setRightAnchor(0, 'selection');
            // Ensure para N-1 is in DOM as left anchor (unless it is already in the window).
            if (this.domEnd < N - 1) this.setLeftAnchor(N - 1, 'selection');
        }
        this.syncDomRangeToVirtual();
    }

    // Extends the selection from the current anchor to the document start (toStart=true)
    // or end (toStart=false), and scrolls the scroll area to make the target boundary visible.
    // If VS is already active the existing anchor is preserved; otherwise the anchor is read
    // from the DOM selection so the user's cursor position becomes the selection anchor.
    //
    // Uses teleportWindowTo (same as jumpWindowTo for cursor jumps) to place the DOM window
    // directly at the target boundary, then re-syncs the VS. This avoids the incremental
    // adjustWindowOnScroll path, which cannot efficiently shrink across a large scroll gap:
    // the while(domEnd > domStart+2) guard stops the left-shrink when domEnd reaches
    // domStart+3, and the right-expand then widens the window from the other side without
    // triggering a second left-shrink pass, leaving far too many paragraph divs in the DOM.
    extendSelectionToDocumentBoundary(toStart: boolean): void {
        const N = this.paragraphRecords.length;
        if (N === 0) return;

        let anchorParaIdx: number;
        let anchorViewOff: number;

        if (this.virtualSelection) {
            anchorParaIdx = this.virtualSelection.anchorParaIdx;
            anchorViewOff = this.virtualSelection.anchorViewOff;
        } else {
            const sel = window.getSelection();
            if (!sel || !sel.anchorNode) return;
            const anchorDiv = this.findParaDiv(sel.anchorNode);
            if (!anchorDiv) return;
            anchorParaIdx = this.getParagraphIndex(anchorDiv);
            if (anchorParaIdx < 0) return;
            anchorViewOff = computeViewOffsetInDiv(anchorDiv, this.editorEl, sel.anchorNode, sel.anchorOffset);
        }

        const focusParaIdx = toStart ? 0 : N - 1;
        const focusViewOff = toStart ? 0 : this.paragraphRecords[N - 1].viewLen;
        this.virtualSelection = { anchorParaIdx, anchorViewOff, focusParaIdx, focusViewOff };

        this.teleportWindowTo(focusParaIdx);
        this.syncDomRangeToVirtual();

        this.scrollArea.scrollLeft = toStart
            ? this.scrollArea.scrollWidth - this.scrollArea.clientWidth
            : 0;
        this.adjustWindowOnScroll();
    }

    // Extends the selection from the current anchor to the start (toStart=true) or end
    // (toStart=false) of the paragraph containing the current focus, then scrolls that
    // boundary into view. Mirrors extendSelectionToDocumentBoundary but targets the focus
    // paragraph rather than the document boundary, so the selection crosses soft-wrapped
    // columns to the logical paragraph boundary. If VS is already active the anchor and focus
    // paragraph are read from it; otherwise both are read from the DOM selection (anchor =
    // selection anchor, focus paragraph = paragraph under the caret).
    extendSelectionToParagraphBoundary(toStart: boolean): void {
        const N = this.paragraphRecords.length;
        if (N === 0) return;

        let anchorParaIdx: number;
        let anchorViewOff: number;
        let focusParaIdx: number;

        if (this.virtualSelection) {
            anchorParaIdx = this.virtualSelection.anchorParaIdx;
            anchorViewOff = this.virtualSelection.anchorViewOff;
            focusParaIdx  = this.virtualSelection.focusParaIdx;
        } else {
            const sel = window.getSelection();
            if (!sel || !sel.anchorNode || !sel.focusNode) return;
            const anchorDiv = this.findParaDiv(sel.anchorNode);
            const focusDiv  = this.findParaDiv(sel.focusNode);
            if (!anchorDiv || !focusDiv) return;
            anchorParaIdx = this.getParagraphIndex(anchorDiv);
            focusParaIdx  = this.getParagraphIndex(focusDiv);
            if (anchorParaIdx < 0 || focusParaIdx < 0) return;
            anchorViewOff = computeViewOffsetInDiv(anchorDiv, this.editorEl, sel.anchorNode, sel.anchorOffset);
        }

        const focusViewOff = toStart ? 0 : this.paragraphRecords[focusParaIdx].viewLen;
        this.virtualSelection = { anchorParaIdx, anchorViewOff, focusParaIdx, focusViewOff };

        this.teleportWindowTo(focusParaIdx);
        this.syncDomRangeToVirtual();
        this.scrollFocusIntoView();
    }

    // Called from selectionchange when VS is null and the DOM selection is non-collapsed.
    // If one or both endpoints are in anchor island divs, initializes VS from the real
    // paragraph indices and returns true. The caller should then call syncDomRangeToVirtual()
    // to normalize the DOM selection to proxy positions.
    // Without this, copy/cut would fall back to cloneContents() which includes spacer divs
    // and out-of-window paragraphs in the wrong order, producing corrupted clipboard content.
    tryInitVsFromDomSelection(sel: Selection): boolean {
        if (this.virtualSelection || sel.isCollapsed) return false;
        const anchorDiv = this.findParaDiv(sel.anchorNode!);
        const focusDiv  = this.findParaDiv(sel.focusNode!);
        let anchorIdx = anchorDiv ? this.getParagraphIndex(anchorDiv) : -1;
        let focusIdx  = focusDiv  ? this.getParagraphIndex(focusDiv)  : -1;
        if (anchorIdx < 0 || focusIdx < 0) return false;
        const anchorIsIsland = this.rightAnchor?.div === anchorDiv || this.rightAnchorInner?.div === anchorDiv ||
            this.leftAnchorInner?.div === anchorDiv || this.leftAnchor?.div === anchorDiv;
        const focusIsIsland  = this.rightAnchor?.div === focusDiv  || this.rightAnchorInner?.div === focusDiv ||
            this.leftAnchorInner?.div === focusDiv  || this.leftAnchor?.div === focusDiv;
        if (!anchorIsIsland && !focusIsIsland) return false;
        let anchorViewOff: number;
        let focusViewOff: number;
        ({ paraIdx: anchorIdx, viewOff: anchorViewOff } = this.normalizeDomEndpoint(anchorDiv!, sel.anchorNode!, sel.anchorOffset, anchorIdx));
        ({ paraIdx: focusIdx,  viewOff: focusViewOff  } = this.normalizeDomEndpoint(focusDiv!,  sel.focusNode!,  sel.focusOffset,  focusIdx));
        this.virtualSelection = { anchorParaIdx: anchorIdx, anchorViewOff, focusParaIdx: focusIdx, focusViewOff };
        return true;
    }

    // Called from selectionchange when VS is active and the event is not programmatic.
    // Reads the new focus position from the DOM and updates VS.focusParaIdx/focusViewOff.
    // Returns true if the DOM range should be re-synced (caller should then call
    // syncDomRangeToVirtual() and scrollFocusIntoView()).
    // Returns true WITHOUT updating VS when the focus escaped into an outer or mid spacer —
    // the escape triggers re-sync and scroll-into-view, which drives a large auto-scroll that
    // in turn triggers the teleport-on-jump path in adjustWindowOnScroll.
    tryUpdateFocusFromDom(sel: Selection): boolean {
        const vs = this.virtualSelection;
        if (!vs) return false;
        const focusNode = sel.focusNode;
        if (!focusNode) return false;

        // Focus escaped into an outer spacer (document-start or document-end boundary).
        // Re-sync without updating VS so syncDomRangeToVirtual re-clamps to the valid position.
        if ((this.rightSpacer?.contains(focusNode)) || (this.leftSpacer?.contains(focusNode))) {
            return true;
        }

        // Focus escaped into a mid-spacer (gap between anchor island and window edge).
        // This happens when Shift+Arrow moves focus from an anchor island div into the
        // adjacent mid-spacer. Treat like outer spacer: VS is unchanged but return true so
        // scrollFocusIntoView fires, driving a large scroll that triggers the
        // teleport-on-jump path (same mechanism as the outer-spacer escape).
        if ((this.midLeftSpacer?.contains(focusNode)) || (this.midRightSpacer?.contains(focusNode)) ||
            (this.midLeftOuterSpacer?.contains(focusNode)) || (this.midRightOuterSpacer?.contains(focusNode))) {
            return true;
        }

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
        let focusParaIdx = this.getParagraphIndex(focusDiv);
        if (focusParaIdx < 0) return false;
        let newFocusViewOff: number;
        ({ paraIdx: focusParaIdx, viewOff: newFocusViewOff } = this.normalizeDomEndpoint(focusDiv, focusNode, sel.focusOffset, focusParaIdx));
        if (focusParaIdx === vs.focusParaIdx && newFocusViewOff === vs.focusViewOff) return false;
        this.virtualSelection = { ...vs, focusParaIdx, focusViewOff: newFocusViewOff };
        return true;
    }

    // Scrolls the paragraph containing the VS focus into view. Called after
    // syncDomRangeToVirtual() since programmatic setBaseAndExtent does not trigger browser
    // auto-scroll. Also called when focus escapes into a spacer, to prevent the browser from
    // auto-scrolling to the document boundary (which would trigger O(N) DOM expansion).
    scrollFocusIntoView(): void {
        const vs = this.virtualSelection;
        if (!vs) return;
        let focusEl: HTMLElement | null = null;
        if (this.rightAnchor?.paraIdx === vs.focusParaIdx) focusEl = this.rightAnchor.div;
        else if (this.rightAnchorInner?.paraIdx === vs.focusParaIdx) focusEl = this.rightAnchorInner.div;
        else if (this.leftAnchorInner?.paraIdx === vs.focusParaIdx) focusEl = this.leftAnchorInner.div;
        else if (this.leftAnchor?.paraIdx === vs.focusParaIdx) focusEl = this.leftAnchor.div;
        else focusEl = this.getWindowDiv(vs.focusParaIdx);
        focusEl?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
    // When an anchor island exists for paraIdx, uses the actual anchor div so the DOM
    // selection endpoint is a real node (not a window-boundary proxy).
    // For other off-window paragraphs, falls back to the nearest window boundary proxy.
    private proxyForEndpoint(paraIdx: number, viewOff: number): { node: Node; offset: number } {
        if (this.rightAnchor && paraIdx === this.rightAnchor.paraIdx)
            return computeDomPositionFromViewOff(this.rightAnchor.div, this.editorEl, viewOff);
        if (this.rightAnchorInner && paraIdx === this.rightAnchorInner.paraIdx)
            return computeDomPositionFromViewOff(this.rightAnchorInner.div, this.editorEl, viewOff);
        if (this.leftAnchorInner && paraIdx === this.leftAnchorInner.paraIdx)
            return computeDomPositionFromViewOff(this.leftAnchorInner.div, this.editorEl, viewOff);
        if (this.leftAnchor && paraIdx === this.leftAnchor.paraIdx)
            return computeDomPositionFromViewOff(this.leftAnchor.div, this.editorEl, viewOff);
        if (paraIdx < this.domStart) {
            // Off-right (between rightAnchor and window, or beyond rightAnchor):
            // proxy = start of domStart div (rightmost visible paragraph).
            const div = this.getWindowDiv(this.domStart);
            if (div) return { node: div, offset: 0 };
        } else if (paraIdx > this.domEnd) {
            // Off-left (between window and leftAnchor, or beyond leftAnchor):
            // proxy = end of domEnd div (leftmost visible paragraph).
            const div = this.getWindowDiv(this.domEnd);
            if (div) {
                const last = findLastBaseTextInElement(div, this.editorEl);
                if (last) return { node: last.node, offset: last.offset };
                return { node: div, offset: div.childNodes.length };
            }
        } else {
            // In-window: actual DOM position.
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

    // Initializes virtualSelection from the current DOM selection if VS is not yet active.
    // Called before promoting a selection endpoint's paragraph to an anchor island, so VS
    // captures the real paragraph indices before the div leaves the window.
    private initVsFromDomIfNeeded(sel: Selection): void {
        if (this.virtualSelection || sel.isCollapsed) return;
        const anchorDiv = this.findParaDiv(sel.anchorNode!);
        const focusDiv  = this.findParaDiv(sel.focusNode!);
        let anchorIdx = anchorDiv ? this.getParagraphIndex(anchorDiv) : -1;
        let focusIdx  = focusDiv  ? this.getParagraphIndex(focusDiv)  : -1;
        if (anchorIdx < 0 || focusIdx < 0) return;
        let anchorViewOff: number;
        let focusViewOff: number;
        ({ paraIdx: anchorIdx, viewOff: anchorViewOff } = this.normalizeDomEndpoint(anchorDiv!, sel.anchorNode!, sel.anchorOffset, anchorIdx));
        ({ paraIdx: focusIdx,  viewOff: focusViewOff  } = this.normalizeDomEndpoint(focusDiv!,  sel.focusNode!,  sel.focusOffset,  focusIdx));
        this.virtualSelection = { anchorParaIdx: anchorIdx, anchorViewOff, focusParaIdx: focusIdx, focusViewOff };
    }

    // Computes the normalized (paraIdx, viewOff) for a DOM selection endpoint.
    // Normalizes paragraph-boundary positions: (paraIdx, 0) for paraIdx > 0 is semantically
    // identical to (paraIdx-1, viewLen(paraIdx-1)). Prefer the earlier paragraph so that
    // eviction of the later paragraph div during scroll does not falsely trigger a collision.
    // Only normalizes for element nodes (div at offset=0 = trailing newline position). A text
    // node at offset=0 means the cursor is genuinely at the start of the paragraph (e.g.
    // triple-click anchor) and must NOT be remapped to end-of-previous-paragraph.
    private normalizeDomEndpoint(
        div: HTMLElement, node: Node, nodeOffset: number, paraIdx: number,
    ): { paraIdx: number; viewOff: number } {
        let viewOff = computeViewOffsetInDiv(div, this.editorEl, node, nodeOffset);
        if (viewOff === 0 && paraIdx > 0 && node.nodeType !== Node.TEXT_NODE) {
            paraIdx--;
            viewOff = this.getViewLenByIndex(paraIdx);
        }
        return { paraIdx, viewOff };
    }

    // Returns the direct paragraph div (non-spacer DIV child of editorEl) that contains node.
    // Anchor island divs are valid paragraph divs even though they carry ANCHOR_CLASS.
    private findParaDiv(node: Node): HTMLElement | null {
        const div = findParentDivInEditor(node, this.editorEl);
        if (!div) return null;
        if (div.classList.contains(SPACER_CLASS)) return null;
        return div; // includes ANCHOR_CLASS divs
    }

    // Returns the paragraphRecords index for the given div, or -1 if not found.
    // Handles in-window divs, right anchor div, and left anchor div.
    private getParagraphIndex(div: HTMLElement): number {
        if (this.rightAnchor      && div === this.rightAnchor.div)      return this.rightAnchor.paraIdx;
        if (this.rightAnchorInner && div === this.rightAnchorInner.div) return this.rightAnchorInner.paraIdx;
        if (this.leftAnchorInner  && div === this.leftAnchorInner.div)  return this.leftAnchorInner.paraIdx;
        if (this.leftAnchor       && div === this.leftAnchor.div)       return this.leftAnchor.paraIdx;
        const off = this.windowChildOffset;
        const children = this.editorEl.children;
        for (let k = off; k < children.length; k++) {
            const child = children[k];
            if (child.classList.contains(SPACER_CLASS)) break; // past window end
            if (child === div) return this.domStart + (k - off);
        }
        return -1;
    }

}
