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
    private freezeSuppressed = false;

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
    }

    // Registers all current editorEl children with the observer (call after setValue).
    observeAll(): void {
        if (!this.observer) return;
        for (const child of Array.from(this.editorEl.children)) {
            this.observer.observe(child);
        }
    }

    // Registers a single div with the observer (call after patchParagraphs inserts a new div).
    observeOne(div: HTMLElement): void {
        this.observer?.observe(div);
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

    // Thaws all frozen divs. Called by SearchPanel before running a search.
    thawAll(): void {
        for (const child of Array.from(this.editorEl.children) as HTMLElement[]) {
            this.thawDiv(child);
        }
    }

    // Toggles freeze suppression. When suppressed, no divs will be frozen.
    // Used by SearchPanel (suppress while open, resume on close).
    suppressFreeze(value: boolean): void {
        this.freezeSuppressed = value;
    }

    // Returns true if the given div may be frozen.
    shouldFreeze(div: HTMLElement): boolean {
        if (this.freezeSuppressed) return false;
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
    }

    private freezeDiv(div: HTMLElement): void {
        if (div.classList.contains(FROZEN_CLASS)) return;
        if (!this.shouldFreeze(div)) return;
        const src = this.getSrcLine(div);
        const viewLen = this.computeViewLen(src);
        div.replaceChildren();
        div.classList.add(FROZEN_CLASS);
        div.setAttribute('data-src', src);
        div.setAttribute('data-view-len', String(viewLen));
    }

    private computeViewLen(src: string): number {
        const segs = buildSegmentMap(src);
        if (segs.length === 0) return 0;
        const last = segs[segs.length - 1];
        return last.viewStart + last.viewLen;
    }

    private onIntersection(entries: IntersectionObserverEntry[]): void {
        for (const entry of entries) {
            const div = entry.target as HTMLElement;
            if (entry.isIntersecting) {
                this.cancelFreeze(div);
                if (div.classList.contains(FROZEN_CLASS)) this.thawDiv(div);
            } else {
                if (!div.classList.contains(FROZEN_CLASS)) this.scheduleFreeze(div);
            }
        }
    }
}
