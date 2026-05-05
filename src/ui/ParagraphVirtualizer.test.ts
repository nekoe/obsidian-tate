// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ParagraphVirtualizer, FROZEN_CLASS } from './ParagraphVirtualizer';

// ---- Helpers ----

function makeEditorEl(): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'tate-editor';
    document.body.appendChild(el);
    return el;
}

function makeScrollArea(): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'tate-scroll-area';
    document.body.appendChild(el);
    return el;
}

function addRealDiv(editorEl: HTMLElement, text: string): HTMLDivElement {
    const div = document.createElement('div');
    div.textContent = text;
    editorEl.appendChild(div);
    return div;
}

function addFrozenDiv(editorEl: HTMLElement, src: string, viewLen: number): HTMLDivElement {
    const div = document.createElement('div');
    div.classList.add(FROZEN_CLASS);
    div.setAttribute('data-src', src);
    div.setAttribute('data-view-len', String(viewLen));
    editorEl.appendChild(div);
    return div;
}

describe('ParagraphVirtualizer', () => {
    let editorEl: HTMLDivElement;
    let scrollArea: HTMLDivElement;
    let virt: ParagraphVirtualizer;

    beforeEach(() => {
        editorEl = makeEditorEl();
        scrollArea = makeScrollArea();
        virt = new ParagraphVirtualizer(editorEl, scrollArea);
    });

    afterEach(() => {
        virt.detach();
        editorEl.remove();
        scrollArea.remove();
    });

    // ---- getSrcLine ----

    describe('getSrcLine', () => {
        it('returns data-src for frozen div', () => {
            const div = addFrozenDiv(editorEl, '吾輩は猫である', 7);
            expect(virt.getSrcLine(div)).toBe('吾輩は猫である');
        });

        it('returns empty string for frozen div with no data-src', () => {
            const div = addFrozenDiv(editorEl, '', 0);
            expect(virt.getSrcLine(div)).toBe('');
        });

        it('serializes real div children to Aozora', () => {
            const div = document.createElement('div');
            div.textContent = 'test line';
            editorEl.appendChild(div);
            expect(virt.getSrcLine(div)).toBe('test line');
        });

        it('serializes real div with ruby element', () => {
            const div = document.createElement('div');
            div.innerHTML = '<ruby data-ruby-explicit="false">吾輩<rt>わがはい</rt></ruby>';
            editorEl.appendChild(div);
            expect(virt.getSrcLine(div)).toBe('吾輩《わがはい》');
        });
    });

    // ---- getViewLen ----

    describe('getViewLen', () => {
        it('reads data-view-len for frozen div', () => {
            const div = addFrozenDiv(editorEl, '吾輩は猫である', 7);
            expect(virt.getViewLen(div)).toBe(7);
        });

        it('counts visible chars in real div', () => {
            const div = addRealDiv(editorEl, 'abc');
            expect(virt.getViewLen(div)).toBe(3);
        });

        it('excludes rt text in real div', () => {
            const div = document.createElement('div');
            // base text "ab" + rt "xy" → viewLen should be 2 (only base)
            div.innerHTML = '<ruby data-ruby-explicit="false">ab<rt>xy</rt></ruby>';
            editorEl.appendChild(div);
            expect(virt.getViewLen(div)).toBe(2);
        });
    });

    // ---- thawDiv ----

    describe('thawDiv', () => {
        it('thaws a frozen div and restores content from data-src', () => {
            const div = addFrozenDiv(editorEl, '吾輩は猫', 4);
            virt.thawDiv(div);
            expect(div.classList.contains(FROZEN_CLASS)).toBe(false);
            expect(div.getAttribute('data-src')).toBeNull();
            expect(div.getAttribute('data-view-len')).toBeNull();
            expect(div.textContent).toBe('吾輩は猫');
        });

        it('is a no-op on a real div', () => {
            const div = addRealDiv(editorEl, 'original');
            virt.thawDiv(div);
            expect(div.textContent).toBe('original');
        });

        it('thaws empty frozen div to <br>', () => {
            const div = addFrozenDiv(editorEl, '', 0);
            virt.thawDiv(div);
            expect(div.querySelector('br')).not.toBeNull();
        });
    });

    // ---- unfrostDiv ----

    describe('unfrostDiv', () => {
        it('removes frozen markers without touching child content', () => {
            const div = addFrozenDiv(editorEl, '吾輩は猫', 4);
            virt.unfrostDiv(div);
            expect(div.classList.contains(FROZEN_CLASS)).toBe(false);
            expect(div.getAttribute('data-src')).toBeNull();
            expect(div.getAttribute('data-view-len')).toBeNull();
            // Children are NOT reconstructed — the div remains empty
            expect(div.childNodes.length).toBe(0);
        });

        it('is a no-op on a real div', () => {
            const div = addRealDiv(editorEl, 'real');
            virt.unfrostDiv(div);
            expect(div.textContent).toBe('real');
        });
    });

    // ---- ensureThawed ----

    describe('ensureThawed', () => {
        it('thaws the target div and specified neighbors', () => {
            const divs: HTMLDivElement[] = [];
            for (let i = 0; i < 5; i++) {
                divs.push(addFrozenDiv(editorEl, `line${i}`, i));
            }
            // Thaw div[2] with 1 neighbor on each side
            virt.ensureThawed(divs[2], 1);
            expect(divs[1].classList.contains(FROZEN_CLASS)).toBe(false);
            expect(divs[2].classList.contains(FROZEN_CLASS)).toBe(false);
            expect(divs[3].classList.contains(FROZEN_CLASS)).toBe(false);
            // Outer divs remain frozen
            expect(divs[0].classList.contains(FROZEN_CLASS)).toBe(true);
            expect(divs[4].classList.contains(FROZEN_CLASS)).toBe(true);
        });

        it('handles edge (first) div with neighborCount > remaining siblings', () => {
            const divs: HTMLDivElement[] = [];
            for (let i = 0; i < 3; i++) {
                divs.push(addFrozenDiv(editorEl, `line${i}`, i));
            }
            virt.ensureThawed(divs[0], 5); // no previous siblings, 2 following
            expect(divs[0].classList.contains(FROZEN_CLASS)).toBe(false);
            expect(divs[1].classList.contains(FROZEN_CLASS)).toBe(false);
            expect(divs[2].classList.contains(FROZEN_CLASS)).toBe(false);
        });
    });

    // ---- shouldFreeze ----

    describe('shouldFreeze', () => {
        it('returns true for a normal real div', () => {
            const div = addRealDiv(editorEl, 'test');
            expect(virt.shouldFreeze(div)).toBe(true);
        });

        it('returns false when tate-scroll-restoring is active', () => {
            editorEl.classList.add('tate-scroll-restoring');
            const div = addRealDiv(editorEl, 'test');
            expect(virt.shouldFreeze(div)).toBe(false);
            editorEl.classList.remove('tate-scroll-restoring');
        });

        it('returns false when div has tate-layout-refreshing', () => {
            const div = addRealDiv(editorEl, 'test');
            div.classList.add('tate-layout-refreshing');
            expect(virt.shouldFreeze(div)).toBe(false);
        });

        it('returns false when div has a tate-editing span', () => {
            const div = document.createElement('div');
            div.innerHTML = '<span class="tate-editing">編集中</span>';
            editorEl.appendChild(div);
            expect(virt.shouldFreeze(div)).toBe(false);
        });

        it('returns false when div is removed from DOM', () => {
            const div = addRealDiv(editorEl, 'test');
            editorEl.removeChild(div);
            expect(virt.shouldFreeze(div)).toBe(false);
        });

        it('returns false when freeze is suppressed', () => {
            virt.suppressFreeze(true);
            const div = addRealDiv(editorEl, 'test');
            expect(virt.shouldFreeze(div)).toBe(false);
            virt.suppressFreeze(false);
        });
    });

    // ---- buildParagraphVisibleText ----

    describe('buildParagraphVisibleText', () => {
        it('plain text is returned as-is', () => {
            expect(virt.buildParagraphVisibleText('吾輩は猫である')).toBe('吾輩は猫である');
        });

        it('implicit ruby: only base is visible', () => {
            expect(virt.buildParagraphVisibleText('吾輩《わがはい》は猫')).toBe('吾輩は猫');
        });

        it('explicit ruby: only base is visible (｜ marker stripped)', () => {
            expect(virt.buildParagraphVisibleText('｜東京《とうきょう》に')).toBe('東京に');
        });

        it('tcy annotation: only content is visible', () => {
            expect(virt.buildParagraphVisibleText('AB［＃「AB」は縦中横］test')).toBe('ABtest');
        });

        it('bouten annotation: only content is visible', () => {
            expect(virt.buildParagraphVisibleText('重要［＃「重要」に傍点］だ')).toBe('重要だ');
        });

        it('empty string', () => {
            expect(virt.buildParagraphVisibleText('')).toBe('');
        });

        it('view length matches getViewLen for frozen div', () => {
            const src = '｜東京《とうきょう》市';
            const visText = virt.buildParagraphVisibleText(src);
            const div = addFrozenDiv(editorEl, src, visText.length);
            expect(virt.getViewLen(div)).toBe(visText.length);
        });
    });

    // ---- IntersectionObserver lifecycle ----

    describe('IntersectionObserver lifecycle', () => {
        let ioCallback: IntersectionObserverCallback;
        let mockObserve: ReturnType<typeof vi.fn>;
        let mockUnobserve: ReturnType<typeof vi.fn>;
        let mockDisconnect: ReturnType<typeof vi.fn>;
        let virtIO: ParagraphVirtualizer;

        beforeEach(() => {
            mockObserve = vi.fn();
            mockUnobserve = vi.fn();
            mockDisconnect = vi.fn();
            vi.stubGlobal('IntersectionObserver', vi.fn((cb: IntersectionObserverCallback) => {
                ioCallback = cb;
                return { observe: mockObserve, unobserve: mockUnobserve, disconnect: mockDisconnect };
            }));
            virtIO = new ParagraphVirtualizer(editorEl, scrollArea);
            virtIO.attach();
        });

        afterEach(() => {
            virtIO.detach();
            vi.unstubAllGlobals();
            vi.useRealTimers();
        });

        // Fires a synthetic IntersectionObserver callback entry for the given div.
        function fireEntry(div: HTMLElement, isIntersecting: boolean, width = 100): void {
            ioCallback([{
                target: div,
                isIntersecting,
                boundingClientRect: { width } as DOMRectReadOnly,
                intersectionRect: {} as DOMRectReadOnly,
                rootBounds: null,
                intersectionRatio: isIntersecting ? 1 : 0,
                time: 0,
            } as IntersectionObserverEntry], {} as IntersectionObserver);
        }

        it('isIntersecting:true thaws a frozen div and marks it as seen', () => {
            const div = addFrozenDiv(editorEl, '猫', 1);
            fireEntry(div, true, 80);
            expect(div.classList.contains(FROZEN_CLASS)).toBe(false); // thawed
            // seenDivs populated → div is now eligible for freezing
            expect(virtIO.shouldFreeze(div)).toBe(true);
        });

        it('isIntersecting:false captures width, schedules freeze, and freezes after delay', () => {
            vi.useFakeTimers();
            const div = addRealDiv(editorEl, '猫');
            fireEntry(div, true);          // mark as seen
            fireEntry(div, false, 88);     // leave viewport; schedule freeze with width=88
            expect(div.classList.contains(FROZEN_CLASS)).toBe(false); // timer not fired yet
            vi.advanceTimersByTime(51);    // past FREEZE_DELAY_MS (50 ms)
            expect(div.classList.contains(FROZEN_CLASS)).toBe(true);
            expect(div.style.width).toBe('88px');
        });

        it('never-seen div is not frozen even after freeze timer fires', () => {
            vi.useFakeTimers();
            const div = addRealDiv(editorEl, '猫');
            // Fire isIntersecting:false without ever being seen (no prior isIntersecting:true)
            fireEntry(div, false, 88);
            vi.advanceTimersByTime(100);
            expect(div.classList.contains(FROZEN_CLASS)).toBe(false);
        });

        it('re-entering the viewport cancels a pending freeze', () => {
            vi.useFakeTimers();
            const div = addRealDiv(editorEl, '猫');
            fireEntry(div, true);          // mark as seen
            fireEntry(div, false, 88);     // schedule freeze
            fireEntry(div, true);          // cancel freeze before timer fires
            vi.advanceTimersByTime(100);
            expect(div.classList.contains(FROZEN_CLASS)).toBe(false);
        });

        it('observeAll with tate-scroll-restoring captures widths and makes divs freeze-eligible', () => {
            vi.useFakeTimers();
            editorEl.classList.add('tate-scroll-restoring');
            const div = addRealDiv(editorEl, '猫');
            vi.spyOn(div, 'getBoundingClientRect').mockReturnValue({ width: 120 } as DOMRect);
            virtIO.observeAll(); // captures width + adds to seenDivs
            editorEl.classList.remove('tate-scroll-restoring');
            // Simulate IO firing isIntersecting:false (as reobserveAll triggers after scroll-restore)
            fireEntry(div, false, 120);
            vi.advanceTimersByTime(51);
            expect(div.classList.contains(FROZEN_CLASS)).toBe(true);
            expect(div.style.width).toBe('120px');
        });

        it('reobserveOne skips a div that has been removed from the editor', () => {
            const div = addRealDiv(editorEl, '猫');
            editorEl.removeChild(div);
            const observeCallsBefore = mockObserve.mock.calls.length;
            const unobserveCallsBefore = mockUnobserve.mock.calls.length;
            virtIO.reobserveOne(div); // should be a no-op for detached div
            expect(mockObserve.mock.calls.length).toBe(observeCallsBefore);
            expect(mockUnobserve.mock.calls.length).toBe(unobserveCallsBefore);
        });

        it('onViewDeactivated suppresses freeze so visible divs are not frozen on tab switch', () => {
            vi.useFakeTimers();
            const div = addRealDiv(editorEl, '猫');
            fireEntry(div, true);          // mark as seen
            fireEntry(div, false, 88);     // IO fires isIntersecting:false (tab switched away)
            virtIO.onViewDeactivated();    // view becomes inactive — suppress freeze
            vi.advanceTimersByTime(100);   // timer fires but shouldFreeze returns false
            expect(div.classList.contains(FROZEN_CLASS)).toBe(false);
        });

        it('onViewActivated cancels stale timers and re-enables freeze', () => {
            vi.useFakeTimers();
            const div = addRealDiv(editorEl, '猫');
            fireEntry(div, true);
            fireEntry(div, false, 88);     // schedule freeze during inactive period
            virtIO.onViewDeactivated();
            virtIO.onViewActivated();      // re-enable freeze, cancel stale timers
            vi.advanceTimersByTime(100);   // stale timer must not fire
            expect(div.classList.contains(FROZEN_CLASS)).toBe(false);
            // New IO after activation should freeze normally
            fireEntry(div, false, 88);     // fresh isIntersecting:false
            vi.advanceTimersByTime(51);
            expect(div.classList.contains(FROZEN_CLASS)).toBe(true);
        });
    });
});
