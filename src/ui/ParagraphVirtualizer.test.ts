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

// Creates a frozen div and registers its content in both frozenSrc/frozenViewLen (for getSrcLine/getViewLen)
// and paragraphRecords (for getSrcByIndex/getViewLenByIndex). Mirrors what freezeDiv() does in production.
function addFrozenDiv(virt: ParagraphVirtualizer, editorEl: HTMLElement, src: string, viewLen: number): HTMLDivElement {
    const div = document.createElement('div');
    div.classList.add(FROZEN_CLASS);
    editorEl.appendChild(div);
    virt.setFrozenContent(div, src, viewLen);
    virt.paragraphRecords.push({ src, viewLen, width: 0 });
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

    // ---- initRecords ----

    describe('initRecords', () => {
        it('populates paragraphRecords from lines', () => {
            virt.initRecords(['吾輩', '猫', '']);
            expect(virt.paragraphRecords).toHaveLength(3);
            expect(virt.paragraphRecords[0].src).toBe('吾輩');
            expect(virt.paragraphRecords[1].src).toBe('猫');
            expect(virt.paragraphRecords[2].src).toBe('');
        });

        it('computes viewLen for each line', () => {
            virt.initRecords(['東京《とうきょう》市']);
            expect(virt.paragraphRecords[0].viewLen).toBe(3); // 東京市 (rt excluded)
        });

        it('sets width to 0 for all entries', () => {
            virt.initRecords(['abc', 'def']);
            expect(virt.paragraphRecords[0].width).toBe(0);
            expect(virt.paragraphRecords[1].width).toBe(0);
        });

        it('replaces existing records on repeated calls', () => {
            virt.initRecords(['old1', 'old2']);
            virt.initRecords(['new']);
            expect(virt.paragraphRecords).toHaveLength(1);
            expect(virt.paragraphRecords[0].src).toBe('new');
        });
    });

    // ---- spliceRecords ----

    describe('spliceRecords', () => {
        beforeEach(() => {
            virt.initRecords(['line0', 'line1', 'line2', 'line3']);
        });

        it('replaces middle records with same count', () => {
            virt.spliceRecords(1, 2, ['new1', 'new2']);
            expect(virt.paragraphRecords).toHaveLength(4);
            expect(virt.getSrcByIndex(0)).toBe('line0');
            expect(virt.getSrcByIndex(1)).toBe('new1');
            expect(virt.getSrcByIndex(2)).toBe('new2');
            expect(virt.getSrcByIndex(3)).toBe('line3');
        });

        it('inserts more than deleted (count grows)', () => {
            virt.spliceRecords(1, 1, ['a', 'b', 'c']);
            expect(virt.paragraphRecords).toHaveLength(6);
            expect(virt.getSrcByIndex(1)).toBe('a');
            expect(virt.getSrcByIndex(2)).toBe('b');
            expect(virt.getSrcByIndex(3)).toBe('c');
            expect(virt.getSrcByIndex(4)).toBe('line2');
        });

        it('deletes more than inserted (count shrinks)', () => {
            virt.spliceRecords(1, 3, ['only']);
            expect(virt.paragraphRecords).toHaveLength(2);
            expect(virt.getSrcByIndex(0)).toBe('line0');
            expect(virt.getSrcByIndex(1)).toBe('only');
        });

        it('computes viewLen for new records', () => {
            virt.spliceRecords(0, 1, ['吾輩《わがはい》']);
            expect(virt.paragraphRecords[0].viewLen).toBe(2); // 吾輩 (rt excluded)
        });
    });

    // ---- getSrcByIndex ----

    describe('getSrcByIndex', () => {
        it('returns src at index', () => {
            virt.initRecords(['alpha', 'beta']);
            expect(virt.getSrcByIndex(0)).toBe('alpha');
            expect(virt.getSrcByIndex(1)).toBe('beta');
        });

        it('returns empty string for out-of-bounds index', () => {
            virt.initRecords(['a']);
            expect(virt.getSrcByIndex(99)).toBe('');
        });
    });

    // ---- getViewLenByIndex ----

    describe('getViewLenByIndex', () => {
        it('returns viewLen at index', () => {
            virt.initRecords(['abc', '吾輩《わがはい》']);
            expect(virt.getViewLenByIndex(0)).toBe(3);
            expect(virt.getViewLenByIndex(1)).toBe(2); // 吾輩 (rt excluded)
        });

        it('returns 0 for out-of-bounds index', () => {
            virt.initRecords(['a']);
            expect(virt.getViewLenByIndex(99)).toBe(0);
        });
    });

    // ---- getSrcLine ----

    describe('getSrcLine', () => {
        it('returns src from frozenSrc WeakMap for frozen div', () => {
            const div = addFrozenDiv(virt, editorEl, '吾輩は猫である', 7);
            expect(virt.getSrcLine(div)).toBe('吾輩は猫である');
        });

        it('returns empty string for frozen div with empty frozenSrc entry', () => {
            const div = addFrozenDiv(virt, editorEl, '', 0);
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
        it('reads viewLen from frozenViewLen WeakMap for frozen div', () => {
            const div = addFrozenDiv(virt, editorEl, '吾輩は猫である', 7);
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
        it('thaws a frozen div and restores content from paragraphRecords', () => {
            const div = addFrozenDiv(virt, editorEl, '吾輩は猫', 4);
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
            const div = addFrozenDiv(virt, editorEl, '', 0);
            virt.thawDiv(div);
            expect(div.querySelector('br')).not.toBeNull();
        });
    });

    // ---- unfrostDiv ----

    describe('unfrostDiv', () => {
        it('removes frozen markers without touching child content', () => {
            const div = addFrozenDiv(virt, editorEl, '吾輩は猫', 4);
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
                divs.push(addFrozenDiv(virt, editorEl, `line${i}`, i));
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
                divs.push(addFrozenDiv(virt, editorEl, `line${i}`, i));
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
            const div = addFrozenDiv(virt, editorEl, src, visText.length);
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

        it('isIntersecting:true thaws a frozen div and restores content from paragraphRecords', () => {
            const div = addFrozenDiv(virtIO, editorEl, '猫', 1);
            fireEntry(div, true, 80);
            expect(div.classList.contains(FROZEN_CLASS)).toBe(false); // thawed
            expect(div.textContent).toBe('猫'); // content restored from records
            // seenDivs populated → div is now eligible for freezing
            expect(virtIO.shouldFreeze(div)).toBe(true);
        });

        it('isIntersecting:false captures width, schedules freeze, and freezes after delay', () => {
            vi.useFakeTimers();
            const div = addRealDiv(editorEl, '猫');
            virtIO.initRecords(['猫']); // records must exist before freeze
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
            virtIO.initRecords(['猫']); // records must exist before freeze
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
            virtIO.initRecords(['猫']); // records must exist before freeze
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
