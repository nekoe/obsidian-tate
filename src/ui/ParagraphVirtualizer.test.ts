// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ParagraphVirtualizer, SPACER_CLASS } from './ParagraphVirtualizer';

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

function addDiv(editorEl: HTMLElement, text: string): HTMLDivElement {
    const div = document.createElement('div');
    div.textContent = text;
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

        it('sets estimated width for all entries', () => {
            virt.initRecords(['abc', 'def']);
            // In happy-dom clientHeight=0, so estimateWidth falls back to fontSizePx(22)×lineHeight(2)=44.
            expect(virt.paragraphRecords[0].width).toBe(44);
            expect(virt.paragraphRecords[1].width).toBe(44);
        });

        it('replaces existing records on repeated calls', () => {
            virt.initRecords(['old1', 'old2']);
            virt.initRecords(['new']);
            expect(virt.paragraphRecords).toHaveLength(1);
            expect(virt.paragraphRecords[0].src).toBe('new');
        });

        it('sets domStart=0 and domEnd=N-1', () => {
            virt.initRecords(['a', 'b', 'c']);
            expect(virt.domStart).toBe(0);
            expect(virt.domEnd).toBe(2);
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

        it('insertion before window shifts domStart and domEnd forward', () => {
            virt.domStart = 2;
            virt.domEnd   = 3;
            virt.spliceRecords(0, 0, ['inserted']);
            expect(virt.paragraphRecords).toHaveLength(5);
            expect(virt.domStart).toBe(3);
            expect(virt.domEnd).toBe(4);
        });

        it('deletion before window shifts domStart and domEnd back', () => {
            virt.domStart = 2;
            virt.domEnd   = 3;
            virt.spliceRecords(0, 1, []);
            expect(virt.paragraphRecords).toHaveLength(3);
            expect(virt.domStart).toBe(1);
            expect(virt.domEnd).toBe(2);
        });

        it('splice spanning window start clamps domStart to 0 when all prefix removed', () => {
            virt.domStart = 2;
            virt.domEnd   = 3;
            virt.spliceRecords(0, 3, ['only']);
            // paragraphs: ['only', 'line3'] (4 replaced by ['only', 'line3'])
            expect(virt.paragraphRecords).toHaveLength(2);
            // delta = 1 - 3 = -2; domStart = max(0, 2 + (-2)) = 0; domEnd = min(3 + (-2), 1) = 1
            expect(virt.domStart).toBe(0);
            expect(virt.domEnd).toBe(1);
        });

        it('splice after window does not affect domStart or domEnd', () => {
            virt.domStart = 0;
            virt.domEnd   = 1;
            virt.spliceRecords(2, 2, ['x', 'y', 'z']);
            expect(virt.paragraphRecords).toHaveLength(5);
            expect(virt.domStart).toBe(0);
            expect(virt.domEnd).toBe(1);
        });
    });

    // ---- syncWindowSrcs ----

    describe('syncWindowSrcs', () => {
        it('updates src and viewLen without resetting domStart/domEnd', () => {
            virt.initRecords(['old0', 'old1', 'old2']);
            // Simulate a shrunk window [1,2]
            virt.domStart = 1;
            virt.domEnd   = 2;
            virt.syncWindowSrcs(['new0', 'new1', 'new2']);
            expect(virt.paragraphRecords[0].src).toBe('new0');
            expect(virt.paragraphRecords[1].src).toBe('new1');
            expect(virt.paragraphRecords[2].src).toBe('new2');
            // Window state must not be disturbed
            expect(virt.domStart).toBe(1);
            expect(virt.domEnd).toBe(2);
        });

        it('grows the record array when lines > records', () => {
            virt.initRecords(['a', 'b']);
            virt.syncWindowSrcs(['a', 'b', 'c']);
            expect(virt.paragraphRecords).toHaveLength(3);
            expect(virt.getSrcByIndex(2)).toBe('c');
        });

        it('shrinks the record array when lines < records and clamps domEnd', () => {
            virt.initRecords(['a', 'b', 'c', 'd']);
            virt.domEnd = 3;
            virt.syncWindowSrcs(['a', 'b']);
            expect(virt.paragraphRecords).toHaveLength(2);
            expect(virt.domEnd).toBe(1);
        });

        it('preserves existing widths', () => {
            virt.initRecords(['a', 'b']);
            virt.paragraphRecords[0].width = 120;
            virt.syncWindowSrcs(['x', 'y']);
            expect(virt.paragraphRecords[0].width).toBe(120);
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
    });

    // ---- attach / spacers ----

    describe('attach and spacers', () => {
        it('inserts rightSpacer and leftSpacer as first and last child', () => {
            addDiv(editorEl, 'content');
            virt.attach();
            expect(virt.rightSpacer).not.toBeNull();
            expect(virt.leftSpacer).not.toBeNull();
            expect(editorEl.firstChild).toBe(virt.rightSpacer);
            expect(editorEl.lastChild).toBe(virt.leftSpacer);
            expect(virt.rightSpacer!.classList.contains(SPACER_CLASS)).toBe(true);
            expect(virt.leftSpacer!.classList.contains(SPACER_CLASS)).toBe(true);
        });

        it('detach removes spacers and resets state', () => {
            virt.attach();
            virt.initRecords(['a', 'b']);
            virt.detach();
            expect(virt.rightSpacer).toBeNull();
            expect(virt.leftSpacer).toBeNull();
            expect(virt.paragraphRecords).toHaveLength(0);
            expect(virt.domEnd).toBe(-1);
        });
    });

    // ---- isInWindow / getWindowDiv ----

    describe('isInWindow and getWindowDiv', () => {
        it('all indices are in-window after initRecords (domStart=0, domEnd=N-1)', () => {
            addDiv(editorEl, 'a');
            addDiv(editorEl, 'b');
            virt.attach();
            virt.initRecords(['a', 'b']);
            expect(virt.isInWindow(0)).toBe(true);
            expect(virt.isInWindow(1)).toBe(true);
            expect(virt.isInWindow(2)).toBe(false);
        });

        it('getWindowDiv returns correct div accounting for spacerOffset', () => {
            // Add paragraph divs BEFORE attach so initSpacers wraps them: [rightSpacer, d0, d1, leftSpacer]
            const d0 = addDiv(editorEl, 'p0');
            const d1 = addDiv(editorEl, 'p1');
            virt.attach();
            virt.initRecords(['p0', 'p1']);
            expect(virt.getWindowDiv(0)).toBe(d0);
            expect(virt.getWindowDiv(1)).toBe(d1);
        });

        it('getWindowDiv returns null for out-of-window index', () => {
            virt.attach();
            virt.initRecords(['a', 'b']);
            virt.domStart = 1;
            expect(virt.getWindowDiv(0)).toBeNull();
        });
    });

    // ---- expandWindowToFull ----

    describe('expandWindowToFull', () => {
        let mockObserve: ReturnType<typeof vi.fn>;
        let mockDisconnect: ReturnType<typeof vi.fn>;

        beforeEach(() => {
            mockObserve = vi.fn();
            mockDisconnect = vi.fn();
            vi.stubGlobal('IntersectionObserver', vi.fn(() => ({
                observe: mockObserve,
                unobserve: vi.fn(),
                disconnect: mockDisconnect,
            })));
        });

        afterEach(() => {
            vi.unstubAllGlobals();
        });

        it('rebuilds all divs and resets domStart=0, domEnd=N-1', () => {
            const virtIO = new ParagraphVirtualizer(editorEl, scrollArea);
            virtIO.attach();
            virtIO.initRecords(['a', 'b', 'c']);
            virtIO.domStart = 1;
            virtIO.domEnd   = 2;
            virtIO.expandWindowToFull();
            expect(virtIO.domStart).toBe(0);
            expect(virtIO.domEnd).toBe(2);
            // spacers + 3 paragraph divs
            expect(editorEl.children.length).toBe(5);
            virtIO.detach();
        });
    });
});
