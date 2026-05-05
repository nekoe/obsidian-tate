import { sanitizeHTMLToDom } from 'obsidian';
import { buildSegmentMap } from './SegmentMap';
import { parseInlineToHtml, serializeNode } from './AozoraParser';
import { computeDivViewLen } from './domHelpers';

// Keep export for test helpers (tests use FROZEN_CLASS to create frozen divs directly).
export const FROZEN_CLASS = 'tate-frozen';
const FREEZE_DELAY_MS = 50;

// Manages DOM virtualization: off-screen paragraph divs are replaced with lightweight
// frozen placeholders (<div class="tate-frozen" data-src="..." data-view-len="...">) to
// reduce the number of live DOM nodes. IntersectionObserver drives freeze/thaw automatically.
export class ParagraphVirtualizer {
    private observer: IntersectionObserver | null = null;
    private freezeTimers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
    // Pixel widths captured in onIntersection (no layout flush needed) and applied as
    // style.width when freezing, so the scroll container does not change width when a
    // div's real content is removed.
    private lastKnownWidths = new Map<HTMLElement, number>();
    // Divs that have entered the viewport at least once (rendered by the browser).
    // Only seen divs are eligible for freezing: a never-seen div has no accurate width
    // measurement (content-visibility:auto returns the 44px fallback for such divs),
    // so freezing it would produce the wrong style.width and cause a layout shift on thaw.
    private seenDivs = new Set<HTMLElement>();
    private freezeSuppressed = false;
    // Set to false while the tate view is not the active leaf. Prevents freezing of
    // viewport-visible divs that receive isIntersecting:false callbacks when the tab
    // switches away — freezing those divs produces a style.width that may not match
    // the natural content width, causing a scroll-position shift on re-activation.
    private viewActive = true;

    constructor(
        private readonly editorEl: HTMLElement,
        private readonly scrollArea: HTMLElement,
    ) {}

    // Starts the IntersectionObserver and begins observing all current children.
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
        this.observeAll();
    }

    // Stops the observer and cancels all pending freeze timers.
    detach(): void {
        this.observer?.disconnect();
        this.observer = null;
        for (const timer of this.freezeTimers.values()) clearTimeout(timer);
        this.freezeTimers.clear();
        this.lastKnownWidths.clear();
        this.seenDivs.clear();
        this.viewActive = true;
    }

    // Registers all current editorEl children with the observer (call after setValue).
    // If tate-scroll-restoring is active, content-visibility:visible is in effect for all
    // divs, so their real widths are available via getBoundingClientRect. Capturing them here
    // marks every div as seen and stores an accurate width, making all paragraphs immediately
    // eligible for freezing once the class is removed.
    observeAll(): void {
        if (!this.observer) return;
        const captureWidths = this.editorEl.classList.contains('tate-scroll-restoring');
        for (const child of Array.from(this.editorEl.children)) {
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

    // Unobserves then re-observes all children, forcing the IntersectionObserver to fire
    // fresh callbacks for every div. Call after tate-scroll-restoring is removed so divs
    // that are now off-screen (but seenDivs-eligible) get their freeze timers scheduled.
    reobserveAll(): void {
        if (!this.observer) return;
        for (const child of Array.from(this.editorEl.children)) {
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

    // Returns true if div is currently frozen (has the tate-frozen class).
    isFrozen(div: HTMLElement): boolean {
        return div.classList.contains(FROZEN_CLASS);
    }

    // Returns the Aozora source line for a div.
    // Frozen div: reads data-src attribute. Real div: serializes child nodes.
    getSrcLine(div: HTMLElement): string {
        if (div.classList.contains(FROZEN_CLASS)) {
            return div.getAttribute('data-src') ?? '';
        }
        return Array.from(div.childNodes)
            .map(n => serializeNode(n, this.editorEl))
            .join('');
    }

    // Returns the visible character count for a div.
    // Frozen div: reads data-view-len attribute. Real div: walks text nodes.
    getViewLen(div: HTMLElement): number {
        if (div.classList.contains(FROZEN_CLASS)) {
            return parseInt(div.getAttribute('data-view-len') ?? '0', 10);
        }
        return computeDivViewLen(div, this.editorEl);
    }

    // Thaws a frozen div: restores real DOM content from data-src and re-registers with observer.
    thawDiv(div: HTMLElement): void {
        if (!div.classList.contains(FROZEN_CLASS)) return;
        this.cancelFreeze(div);
        const src = div.getAttribute('data-src') ?? '';
        div.classList.remove(FROZEN_CLASS);
        div.removeAttribute('data-src');
        div.removeAttribute('data-view-len');
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
        div.removeAttribute('data-src');
        div.removeAttribute('data-view-len');
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
        // Set style.width before emptying content so both changes are batched into a single
        // layout pass — the div stays at pixelWidth throughout the transition with no size
        // flash regardless of whether it is inside or outside Chrome's content-visibility
        // rendering buffer (~3600px). contain-intrinsic-block-size only applies when
        // content-visibility:auto skips layout (>~3600px away), which is too narrow a
        // condition to rely on for scroll-container stability.
        if (pixelWidth > 0) div.style.setProperty('width', `${pixelWidth}px`);
        div.replaceChildren();
        div.classList.add(FROZEN_CLASS);
        div.setAttribute('data-src', src);
        div.setAttribute('data-view-len', String(viewLen));
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
