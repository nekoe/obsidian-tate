import { sanitizeHTMLToDom } from 'obsidian';
import { buildSegmentMap } from './SegmentMap';
import { parseInlineToHtml, serializeNode } from './AozoraParser';
import { computeDivViewLen } from './domHelpers';

// Keep export for test helpers (tests use FROZEN_CLASS to create frozen divs directly).
export const FROZEN_CLASS = 'tate-frozen';
// CSS class applied to both spacer divs so DOM walkers can skip them.
export const SPACER_CLASS = 'tate-spacer';
const FREEZE_DELAY_MS = 50;
// Estimated pixel width for paragraphs that have never entered the viewport.
// Matches the content-visibility:auto intrinsic fallback used in Phase 1 (44px).
// Acceptable inaccuracy: corrects on first viewport entry; adjustable later.
const UNRENDERED_WIDTH_PX = 44;

export interface ParagraphRecord {
    src: string;     // Aozora source line
    viewLen: number; // visible character count (excluding annotation markers and rt text)
    width: number;   // measured pixel width; 0 = not yet measured
}

// Manages DOM virtualization.
//
// Phase 1 (current): off-screen paragraph divs are replaced with lightweight frozen
// placeholders (<div class="tate-frozen">). frozenSrc / frozenViewLen WeakMaps (keyed by
// div identity) are the source of truth for all frozen-div reads. paragraphRecords[]
// mirrors paragraph content indexed by DOM position and is used by the Phase 2 read paths.
//
// Phase 2 (in progress): only a sliding DOM window [domStart, domEnd] is kept in the DOM.
// Off-window paragraphs have no DOM node; getValue() / getVisibleOffset() read from
// paragraphRecords[]. Two spacer divs (rightSpacer, leftSpacer) compensate for the missing
// width so scrollWidth stays constant.
//
// Read path summary:
//   in-window, not frozen → serializeNode / computeDivViewLen (DOM)
//   in-window, frozen     → frozenSrc / frozenViewLen WeakMaps (Phase 1 compat)
//   off-window            → paragraphRecords[i].src / .viewLen (Phase 2+)
export class ParagraphVirtualizer {
    private observer: IntersectionObserver | null = null;
    private freezeTimers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
    // Pixel widths captured in onIntersection (no layout flush needed) and applied as
    // style.width when freezing, so the scroll container does not change width when a
    // div's real content is removed.
    // WeakMap: deleted div elements are GC-eligible even if not explicitly removed here
    // (e.g. after patchParagraphs replaces the DOM without calling unfrostDiv).
    private lastKnownWidths = new WeakMap<HTMLElement, number>();
    // Divs that have entered the viewport at least once (rendered by the browser).
    // Only seen divs are eligible for freezing: a never-seen div has no accurate width
    // measurement (content-visibility:auto returns the 44px fallback for such divs),
    // so freezing it would produce the wrong style.width and cause a layout shift on thaw.
    // WeakSet: same GC rationale as lastKnownWidths.
    private seenDivs = new WeakSet<HTMLElement>();
    private freezeSuppressed = false;
    // Set to false while the tate view is not the active leaf. Prevents freezing of
    // viewport-visible divs that receive isIntersecting:false callbacks when the tab
    // switches away — freezing those divs produces a style.width that may not match
    // the natural content width, causing a scroll-position shift on re-activation.
    private viewActive = true;

    // Per-paragraph data store. Indexed 1:1 with paragraphs (not DOM children).
    // Maintained by initRecords() / spliceRecords() / freezeDiv().
    // Phase 2 read paths use this for off-window paragraphs that have no DOM node.
    readonly paragraphRecords: ParagraphRecord[] = [];

    // DOM window state (Phase 2). domStart and domEnd are inclusive indices into paragraphRecords.
    // In Phase 1 mode (all divs in DOM) domStart = 0, domEnd = paragraphRecords.length - 1.
    // domEnd = -1 signals "no records loaded yet" (initial state before first setValue).
    domStart = 0;
    domEnd   = -1;

    // Set to non-null in Phase 2b when spacers are inserted into editorEl.
    // Used by getWindowDiv() to compute the correct child index (offset by +1 for rightSpacer).
    rightSpacer: HTMLElement | null = null;
    leftSpacer:  HTMLElement | null = null;

    // Accumulated pixel widths of paragraphs evicted to the right and left spacers.
    // Maintained by expandRight/Left and shrinkRight/Left (Phase 2c+).
    private rightSpacerWidth = 0;
    private leftSpacerWidth  = 0;

    // Dedicated IntersectionObserver that watches only the two boundary divs of the window.
    // Separate from the freeze/thaw observer so boundary detection is not conflated with freeze logic.
    private windowObserver: IntersectionObserver | null = null;

    // True while a drag selection is in progress (mousedown → mouseup).
    // Prevents shrinking the window when the anchor/focus nodes are in the edge div.
    private isDragging = false;

    // Source of truth for frozen div content, keyed by div identity (not DOM position).
    // Set by freezeDiv() / setFrozenContent(); read by getSrcLine() and getViewLen().
    // Identity-keyed so that reads remain correct even after other divs are inserted or
    // removed (DOM positions shift, but a WeakMap entry stays with its div element).
    private frozenSrc = new WeakMap<HTMLElement, string>();
    private frozenViewLen = new WeakMap<HTMLElement, number>();

    constructor(
        private readonly editorEl: HTMLElement,
        private readonly scrollArea: HTMLElement,
    ) {}

    // Starts IntersectionObservers, inserts spacer divs, and begins observing all children.
    attach(): void {
        if (this.observer) return;
        this.observer = new IntersectionObserver(
            (entries) => this.onIntersection(entries),
            {
                root: this.scrollArea,
                // 440px margin on each side covers ~10 paragraphs (44px each) outside the viewport.
                rootMargin: '0px 440px 0px 440px',
                threshold: 0,
            },
        );
        this.windowObserver = new IntersectionObserver(
            (entries) => this.onWindowBoundaryIntersection(entries),
            {
                root: this.scrollArea,
                // Same margin as the freeze/thaw observer: expand the window before divs
                // reach the viewport edge so there is no visible gap during fast scrolling.
                rootMargin: '0px 440px 0px 440px',
                threshold: 0,
            },
        );
        this.initSpacers();
        this.observeAll();
        // Register drag-selection guards to prevent evicting divs that contain an active selection.
        this.editorEl.addEventListener('mousedown', this.onMouseDown);
        document.addEventListener('mouseup', this.onMouseUp);
    }

    // Inserts rightSpacer (first child) and leftSpacer (last child) into editorEl.
    // Both start at width 0 (no off-window paragraphs in Phase 2a/2b; Phase 2c sets real widths).
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

    // Stops observers, removes spacers, and cancels all pending freeze timers.
    detach(): void {
        this.observer?.disconnect();
        this.observer = null;
        this.windowObserver?.disconnect();
        this.windowObserver = null;
        for (const timer of this.freezeTimers.values()) clearTimeout(timer);
        this.freezeTimers.clear();
        // WeakMap/WeakSet have no .clear() — reassign to drop all references.
        this.lastKnownWidths = new WeakMap();
        this.seenDivs = new WeakSet();
        this.frozenSrc = new WeakMap();
        this.frozenViewLen = new WeakMap();
        this.viewActive = true;
        this.paragraphRecords.length = 0;
        this.domStart = 0;
        this.domEnd   = -1;
        this.rightSpacerWidth = 0;
        this.leftSpacerWidth  = 0;
        // Remove spacers from the DOM. A future attach() will recreate them.
        this.rightSpacer?.remove();
        this.leftSpacer?.remove();
        this.rightSpacer = null;
        this.leftSpacer  = null;
        this.isDragging = false;
        this.editorEl.removeEventListener('mousedown', this.onMouseDown);
        document.removeEventListener('mouseup', this.onMouseUp);
    }

    // Registers all current paragraph children with the observer (call after setValue).
    // Skips spacer divs (SPACER_CLASS) because they have no content and measuring them is meaningless.
    // If tate-scroll-restoring is active, real widths are available via getBoundingClientRect.
    // Capturing them here marks every div as seen and stores an accurate width, making all
    // paragraphs immediately eligible for freezing once the class is removed.
    observeAll(): void {
        if (!this.observer) return;
        // Disconnect first so the observer releases all references to the previous set of divs
        // (e.g. after setValue replaceChildren). Without this, the observer holds a strong
        // reference to every previously-observed element, blocking GC after large deletions.
        this.observer.disconnect();
        const captureWidths = this.editorEl.classList.contains('tate-scroll-restoring');
        for (const child of Array.from(this.editorEl.children)) {
            if (child instanceof HTMLElement && child.classList.contains(SPACER_CLASS)) continue;
            this.observer.observe(child);
            if (captureWidths && child instanceof HTMLElement) {
                const w = child.getBoundingClientRect().width;
                if (w > 0) {
                    this.seenDivs.add(child);
                    this.lastKnownWidths.set(child, w);
                }
            }
        }
    }

    // Unobserves then re-observes all paragraph children (skips spacers), forcing the
    // IntersectionObserver to fire fresh callbacks. Call after tate-scroll-restoring is removed
    // so divs that are now off-screen (but seenDivs-eligible) get their freeze timers scheduled.
    reobserveAll(): void {
        if (!this.observer) return;
        for (const child of Array.from(this.editorEl.children)) {
            if (child instanceof HTMLElement && child.classList.contains(SPACER_CLASS)) continue;
            this.observer.unobserve(child);
            this.observer.observe(child);
        }
    }

    // Registers a single div with the observer (call after patchParagraphs inserts a new div).
    observeOne(div: HTMLElement): void {
        this.observer?.observe(div);
    }

    // Unobserves then re-observes a single div, forcing the IntersectionObserver to fire a
    // fresh callback for it. Call after tate-layout-refreshing is removed for a div that was
    // off-screen throughout the mutation, so off-screen divs get their freeze rescheduled with
    // an accurate width (from the contain-intrinsic-block-size cache updated by Frame N).
    // Skips divs that are no longer in the editor (removed between schedule and fire).
    reobserveOne(div: HTMLElement): void {
        if (!this.observer) return;
        if (!this.editorEl.contains(div)) return;
        this.observer.unobserve(div);
        this.observer.observe(div);
    }

    // Initializes paragraphRecords from content lines and resets the window to span all records.
    // Call from EditorElement.setValue() and the patchParagraphs fallback after replaceChildren.
    // width is 0 for all entries (updated to the measured value when the div is first frozen).
    initRecords(lines: string[]): void {
        this.paragraphRecords.length = 0;
        for (const line of lines) {
            this.paragraphRecords.push({
                src: line,
                viewLen: this.buildParagraphVisibleText(line).length,
                width: 0,
            });
        }
        this.domStart = 0;
        this.domEnd   = this.paragraphRecords.length - 1;
        // Reset spacer widths (window spans all records; spacers are 0-width).
        this.rightSpacerWidth = 0;
        this.leftSpacerWidth  = 0;
        if (this.rightSpacer) this.rightSpacer.style.removeProperty('width');
        if (this.leftSpacer)  this.leftSpacer.style.removeProperty('width');
        this.reobserveBoundaries();
    }

    // Mirrors the DOM splice performed by patchParagraphs, keeping paragraphRecords in sync.
    // lo: first changed index; deleteCount: number of old records to remove;
    // newLines: replacement Aozora source lines (may be a different count than deleteCount).
    spliceRecords(lo: number, deleteCount: number, newLines: string[]): void {
        const newRecords = newLines.map(src => ({
            src,
            viewLen: this.buildParagraphVisibleText(src).length,
            width: 0,
        }));
        this.paragraphRecords.splice(lo, deleteCount, ...newRecords);
        // Clamp domEnd to the new total count (may have shrunk if lines were deleted).
        this.domEnd = Math.min(this.domEnd + (newLines.length - deleteCount), this.paragraphRecords.length - 1);
        this.domEnd = Math.max(this.domEnd, this.domStart);
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
        this.observeAll();
        this.reobserveBoundaries();
    }

    // Ensures cursor paragraph and its neighbors are in the DOM window (replaces ensureThawedAtCursor).
    ensureWindowAroundCursor(): void {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        let node: Node | null = sel.getRangeAt(0).startContainer;
        while (node && node !== this.editorEl) {
            if (node instanceof HTMLElement && node.parentElement === this.editorEl) {
                // The div is already in the DOM (it's a direct child of editorEl), so no
                // window expansion is needed. The frozen infrastructure below handles thawing.
                this.ensureThawed(node, 10);
                return;
            }
            node = node.parentElement;
        }
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
        // Register new div with the freeze/thaw observer.
        this.observer?.observe(div);
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
        this.observer?.observe(div);
    }

    // Removes the rightmost div of the window (paragraphs[domEnd]) and grows leftSpacer.
    // Guards against removing a div that contains the current selection anchor or focus.
    private shrinkLeft(): void {
        if (this.domEnd < this.domStart) return; // empty window guard
        const spacerOffset = this.rightSpacer ? 1 : 0;
        const div = this.editorEl.children[this.domEnd - this.domStart + spacerOffset] as HTMLElement;
        if (!div) return;
        if (this.isDragging && this.selectionOverlaps(div)) return;
        const w = div.getBoundingClientRect().width || UNRENDERED_WIDTH_PX;
        this.paragraphRecords[this.domEnd].width = w;
        this.observer?.unobserve(div);
        div.remove();
        this.leftSpacerWidth += w;
        if (this.leftSpacer) this.leftSpacer.style.setProperty('width', `${this.leftSpacerWidth}px`);
        this.domEnd--;
    }

    // Removes the leftmost div of the window (paragraphs[domStart]) and grows rightSpacer.
    private shrinkRight(): void {
        if (this.domEnd < this.domStart) return;
        const spacerOffset = this.rightSpacer ? 1 : 0;
        const div = this.editorEl.children[spacerOffset] as HTMLElement; // first paragraph
        if (!div || div.classList.contains(SPACER_CLASS)) return;
        if (this.isDragging && this.selectionOverlaps(div)) return;
        const w = div.getBoundingClientRect().width || UNRENDERED_WIDTH_PX;
        this.paragraphRecords[this.domStart].width = w;
        this.observer?.unobserve(div);
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
    // Boundary div exits extended viewport → shrink window from the opposite end.
    private onWindowBoundaryIntersection(entries: IntersectionObserverEntry[]): void {
        if (this.paragraphRecords.length === 0) return;
        let changed = false;
        for (const entry of entries) {
            const div = entry.target as HTMLElement;
            const spacerOffset = this.rightSpacer ? 1 : 0;
            const divIndex = Array.from(this.editorEl.children).indexOf(div) - spacerOffset + this.domStart;
            if (entry.isIntersecting) {
                if (divIndex === this.domStart && this.domStart > 0) {
                    this.expandRight();
                    changed = true;
                }
                if (divIndex === this.domEnd && this.domEnd < this.paragraphRecords.length - 1) {
                    this.expandLeft();
                    changed = true;
                }
            } else {
                // Only shrink from the far end when there are off-screen paragraphs to evict.
                // Apply a conservative guard: only shrink when the window is wide enough that
                // at least one paragraph is clearly off-screen on each side.
                if (divIndex === this.domStart && this.domEnd > this.domStart + 2) {
                    this.shrinkLeft();
                    changed = true;
                }
                if (divIndex === this.domEnd && this.domEnd > this.domStart + 2) {
                    this.shrinkRight();
                    changed = true;
                }
            }
        }
        if (changed) this.reobserveBoundaries();
    }

    // Arrow function so `this` is bound for addEventListener/removeEventListener.
    private readonly onMouseDown = () => { this.isDragging = true; };
    private readonly onMouseUp   = () => { this.isDragging = false; };

    // Returns true if div is currently frozen (has the tate-frozen class).
    isFrozen(div: HTMLElement): boolean {
        return div.classList.contains(FROZEN_CLASS);
    }

    // Sets the frozen content for a div in frozenSrc / frozenViewLen.
    // Called by freezeDiv() internally. Also exposed for test helpers that create frozen
    // divs directly (outside the normal freeze/thaw lifecycle).
    setFrozenContent(div: HTMLElement, src: string, viewLen: number): void {
        this.frozenSrc.set(div, src);
        this.frozenViewLen.set(div, viewLen);
    }

    // Returns the Aozora source line for a div.
    // Frozen div: reads from frozenSrc (keyed by div identity, O(1), correct after DOM shifts).
    // Real div: serializes child nodes.
    getSrcLine(div: HTMLElement): string {
        if (div.classList.contains(FROZEN_CLASS)) {
            return this.frozenSrc.get(div) ?? '';
        }
        return Array.from(div.childNodes)
            .map(n => serializeNode(n, this.editorEl))
            .join('');
    }

    // Returns the visible character count for a div.
    // Frozen div: reads from frozenViewLen (keyed by div identity, O(1), correct after DOM shifts).
    // Real div: walks text nodes.
    getViewLen(div: HTMLElement): number {
        if (div.classList.contains(FROZEN_CLASS)) {
            return this.frozenViewLen.get(div) ?? 0;
        }
        return computeDivViewLen(div, this.editorEl);
    }

    // Thaws a frozen div: restores real DOM content from paragraphRecords and re-registers with observer.
    thawDiv(div: HTMLElement): void {
        if (!div.classList.contains(FROZEN_CLASS)) return;
        this.cancelFreeze(div);
        // Read src from records before removing the frozen class (getSrcLine uses the class to branch).
        const src = this.getSrcLine(div);
        div.classList.remove(FROZEN_CLASS);
        // Remove the frozen width pin and any stale contain-intrinsic-block-size from a
        // previous freeze cycle. Both operations and replaceChildren are batched into a
        // single browser layout pass, so there is no intermediate size flash.
        div.style.removeProperty('width');
        div.style.removeProperty('contain-intrinsic-block-size');
        div.replaceChildren(sanitizeHTMLToDom(parseInlineToHtml(src) || '<br>'));
        this.observeOne(div); // re-register so future viewport exits trigger a new freeze
    }

    // Removes frozen state markers without reconstructing DOM (for patchParagraphs, which will
    // immediately replace children itself — avoids a double replaceChildren).
    unfrostDiv(div: HTMLElement): void {
        if (!div.classList.contains(FROZEN_CLASS)) return;
        this.cancelFreeze(div);
        div.classList.remove(FROZEN_CLASS);
        div.style.removeProperty('width');
        div.style.removeProperty('contain-intrinsic-block-size');
    }

    // Thaws the given div and up to neighborCount divs on each side.
    ensureThawed(div: HTMLElement, neighborCount = 10): void {
        this.thawDiv(div);
        let prev: Element | null = div.previousElementSibling;
        for (let i = 0; i < neighborCount && prev; i++, prev = prev.previousElementSibling) {
            if (prev instanceof HTMLElement) this.thawDiv(prev);
        }
        let next: Element | null = div.nextElementSibling;
        for (let i = 0; i < neighborCount && next; i++, next = next.nextElementSibling) {
            if (next instanceof HTMLElement) this.thawDiv(next);
        }
    }

    // Thaws the paragraph containing the cursor and its neighbors. Called on selectionchange.
    ensureThawedAtCursor(): void {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        let node: Node | null = sel.getRangeAt(0).startContainer;
        while (node && node !== this.editorEl) {
            if (node instanceof HTMLElement && node.parentElement === this.editorEl) {
                this.ensureThawed(node, 10);
                return;
            }
            node = node.parentElement;
        }
    }

    // Toggles freeze suppression. When suppressed, no divs will be frozen.
    // Used by SearchPanel (suppress while open, resume on close).
    suppressFreeze(value: boolean): void {
        this.freezeSuppressed = value;
    }

    // Called when the tate view loses focus (another leaf becomes active).
    // Suppresses freeze and cancels pending timers so that viewport-visible divs
    // that receive isIntersecting:false during the tab switch are not frozen with
    // potentially inaccurate widths (inactive-tab layout may differ).
    onViewDeactivated(): void {
        this.viewActive = false;
        this.cancelAllPendingFreezeTimers();
    }

    // Called when the tate view becomes the active leaf again.
    // Re-enables freeze and cancels any stale timers that were scheduled during
    // the inactive period so they do not fire and freeze now-visible divs.
    onViewActivated(): void {
        this.viewActive = true;
        this.cancelAllPendingFreezeTimers();
    }

    // Returns true if the given div may be frozen.
    shouldFreeze(div: HTMLElement): boolean {
        if (this.freezeSuppressed) return false;
        if (!this.viewActive) return false;
        if (this.editorEl.classList.contains('tate-scroll-restoring')) return false;
        if (div.classList.contains('tate-layout-refreshing')) return false;
        if (!this.editorEl.contains(div)) return false; // div was removed from the DOM
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0 && div.contains(sel.getRangeAt(0).startContainer)) return false;
        if (div.querySelector('.tate-editing')) return false;
        return true;
    }

    // Computes visible text for an Aozora source line (for SearchPanel text extraction on frozen divs).
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

    // Returns the index of div in editorEl.children, or -1 if not found.
    // Used by freezeDiv() to sync paragraphRecords[idx] when a div is frozen (O(N) scan;
    // acceptable because freezeDiv fires at most once per div after a 50ms timer delay).
    private indexOfDiv(div: HTMLElement): number {
        for (let i = 0; i < this.editorEl.children.length; i++) {
            if (this.editorEl.children[i] === div) return i;
        }
        return -1;
    }

    // Cancels all pending freeze timers without touching lastKnownWidths, preserving
    // accurate widths for the next freeze cycle. Used by onViewDeactivated/onViewActivated.
    private cancelAllPendingFreezeTimers(): void {
        for (const timer of this.freezeTimers.values()) clearTimeout(timer);
        this.freezeTimers.clear();
    }

    private scheduleFreeze(div: HTMLElement): void {
        if (div.classList.contains(FROZEN_CLASS)) return;
        if (this.freezeTimers.has(div)) return;
        const timer = setTimeout(() => {
            this.freezeTimers.delete(div);
            this.freezeDiv(div);
        }, FREEZE_DELAY_MS);
        this.freezeTimers.set(div, timer);
    }

    private cancelFreeze(div: HTMLElement): void {
        const timer = this.freezeTimers.get(div);
        if (timer !== undefined) {
            clearTimeout(timer);
            this.freezeTimers.delete(div);
        }
        this.lastKnownWidths.delete(div);
    }

    private freezeDiv(div: HTMLElement): void {
        if (div.classList.contains(FROZEN_CLASS)) return;
        if (!this.shouldFreeze(div)) return;
        // Never freeze a div that has not been rendered at least once. Its width is unknown
        // (content-visibility:auto reports the 44px fallback for never-rendered elements).
        if (!this.seenDivs.has(div)) return;
        const src = this.getSrcLine(div);
        const viewLen = this.buildParagraphVisibleText(src).length;
        const pixelWidth = this.lastKnownWidths.get(div) ?? 0;

        // Store content keyed by div identity (WeakMap) so getSrcLine/getViewLen remain
        // correct even if other divs are inserted or removed after this freeze (DOM positions
        // shift, but each WeakMap entry travels with its own div element).
        this.setFrozenContent(div, src, viewLen);

        // Also sync paragraphRecords for Phase 2 (DOM windowing). Records are indexed by
        // current DOM position; they become stale after DOM insertions/deletions outside
        // patchParagraphs, but frozenSrc/frozenViewLen are always authoritative for reads.
        const idx = this.indexOfDiv(div);
        if (idx >= 0 && this.paragraphRecords[idx] !== undefined) {
            this.paragraphRecords[idx].src = src;
            this.paragraphRecords[idx].viewLen = viewLen;
            this.paragraphRecords[idx].width = pixelWidth;
        }

        // Set style.width before emptying content so both changes are batched into a single
        // layout pass — the div stays at pixelWidth throughout the transition with no size
        // flash regardless of whether it is inside or outside Chrome's content-visibility
        // rendering buffer (~3600px). contain-intrinsic-block-size only applies when
        // content-visibility:auto skips layout (>~3600px away), which is too narrow a
        // condition to rely on for scroll-container stability.
        if (pixelWidth > 0) div.style.setProperty('width', `${pixelWidth}px`);
        div.replaceChildren();
        div.classList.add(FROZEN_CLASS);
    }

    private onIntersection(entries: IntersectionObserverEntry[]): void {
        for (const entry of entries) {
            const div = entry.target as HTMLElement;
            if (entry.isIntersecting) {
                this.seenDivs.add(div); // mark as rendered; now eligible for future freezing
                this.cancelFreeze(div);
                if (div.classList.contains(FROZEN_CLASS)) this.thawDiv(div);
            } else {
                if (!div.classList.contains(FROZEN_CLASS)) {
                    // Cache the real pixel width now (no layout flush: boundingClientRect is
                    // provided by the observer callback) so freezeDiv can pin style.width.
                    const w = entry.boundingClientRect.width;
                    if (w > 0) this.lastKnownWidths.set(div, w);
                    this.scheduleFreeze(div);
                }
            }
        }
    }
}
