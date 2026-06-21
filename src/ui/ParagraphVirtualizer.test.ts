// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

    // ---- updateWindowRecords ----

    describe('updateWindowRecords', () => {
        it('updates src/viewLen for window records without touching off-window records', () => {
            virt.initRecords(['off0', 'win1', 'win2', 'off3']);
            virt.domStart = 1;
            virt.domEnd   = 2;
            virt.updateWindowRecords(['new1', 'new2']);
            expect(virt.paragraphRecords[0].src).toBe('off0');   // off-window: unchanged
            expect(virt.paragraphRecords[1].src).toBe('new1');   // window: updated
            expect(virt.paragraphRecords[2].src).toBe('new2');   // window: updated
            expect(virt.paragraphRecords[3].src).toBe('off3');   // off-window: unchanged
            expect(virt.domStart).toBe(1); // window bounds unchanged
            expect(virt.domEnd).toBe(2);
        });

        it('inserts new records at domEnd+1 when srcs has more entries (Enter)', () => {
            virt.initRecords(['a', 'b', 'c', 'off4']);
            virt.domStart = 1;
            virt.domEnd   = 2; // window covers b,c
            // Enter splits 'b' into 'b-first' + '' + keeps 'c'
            virt.updateWindowRecords(['b-first', '', 'c']);
            expect(virt.paragraphRecords).toHaveLength(5);
            expect(virt.domEnd).toBe(3);
            expect(virt.paragraphRecords[1].src).toBe('b-first');
            expect(virt.paragraphRecords[2].src).toBe('');
            expect(virt.paragraphRecords[3].src).toBe('c');
            expect(virt.paragraphRecords[4].src).toBe('off4'); // shifted right
        });

        it('removes records when srcs has fewer entries (Backspace merges)', () => {
            virt.initRecords(['a', 'b', 'c', 'off4']);
            virt.domStart = 1;
            virt.domEnd   = 2; // window covers b,c
            // Backspace merges 'b'+'c' → 'bc'
            virt.updateWindowRecords(['bc']);
            expect(virt.paragraphRecords).toHaveLength(3);
            expect(virt.domEnd).toBe(1);
            expect(virt.paragraphRecords[1].src).toBe('bc');
            expect(virt.paragraphRecords[2].src).toBe('off4'); // shifted left
        });

        it('preserves existing widths', () => {
            virt.initRecords(['a', 'b']);
            virt.paragraphRecords[0].width = 120;
            virt.paragraphRecords[1].width = 200;
            virt.updateWindowRecords(['x', 'y']);
            expect(virt.paragraphRecords[0].width).toBe(120);
            expect(virt.paragraphRecords[1].width).toBe(200);
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

    // ---- getVirtualSelectionFocusOffset ----

    describe('getVirtualSelectionFocusOffset', () => {
        // Builds a fully-in-window doc and sets up a select-all VS (focus = document end).
        function setupSelectAll(lines: string[]): void {
            for (const line of lines) addDiv(editorEl, line);
            virt.attach(); // wraps the divs with spacers
            virt.initRecords(lines);
            virt.setVirtualSelectAll();
        }

        it('returns null when no VirtualSelection is active', () => {
            virt.attach();
            virt.initRecords(['吾輩', '猫である']);
            expect(virt.getVirtualSelectionFocusOffset()).toBeNull();
        });

        it('returns the total view length for a select-all VS (focus at document end)', () => {
            setupSelectAll(['吾輩', '猫である']); // viewLens 2 + 4
            expect(virt.getVirtualSelectionFocusOffset()).toBe(6);
        });

        it('sums viewLens of all paragraphs preceding the focus paragraph', () => {
            setupSelectAll(['ab', 'cde', 'fg']); // viewLens 2 + 3 + 2, focus = (2, 2)
            expect(virt.getVirtualSelectionFocusOffset()).toBe(7);
        });

        it('returns 0 when the focus collapses to the document start', () => {
            const d0 = addDiv(editorEl, 'ab');
            addDiv(editorEl, 'cde');
            virt.attach();
            virt.initRecords(['ab', 'cde']);
            // extendSelectionToDocumentBoundary reads the anchor from the DOM selection.
            const sel = window.getSelection()!;
            sel.collapse(d0.firstChild, 1);
            virt.extendSelectionToDocumentBoundary(true); // focus = (0, 0)
            expect(virt.getVirtualSelectionFocusOffset()).toBe(0);
        });
    });

    // ---- getCaretParagraphIndex ----

    describe('getCaretParagraphIndex', () => {
        it('returns the paragraph index of the DOM selection focus', () => {
            addDiv(editorEl, 'ab');
            const d1 = addDiv(editorEl, 'cde');
            virt.attach();
            virt.initRecords(['ab', 'cde']);
            window.getSelection()!.collapse(d1.firstChild, 1);
            expect(virt.getCaretParagraphIndex()).toBe(1);
        });

        it('returns the VS focus paragraph when a VirtualSelection is active', () => {
            for (const l of ['ab', 'cde', 'fg']) addDiv(editorEl, l);
            virt.attach();
            virt.initRecords(['ab', 'cde', 'fg']);
            virt.setVirtualSelectAll(); // focus = last paragraph
            expect(virt.getCaretParagraphIndex()).toBe(2);
        });

        it('returns -1 when there is no selection focus', () => {
            virt.attach();
            virt.initRecords(['ab']);
            window.getSelection()!.removeAllRanges();
            expect(virt.getCaretParagraphIndex()).toBe(-1);
        });
    });

    // ---- extendSelectionToParagraphBoundary ----

    describe('extendSelectionToParagraphBoundary', () => {
        // Sets up a two-paragraph doc with the caret inside para 1 ('cde') at the given offset.
        function setupCaretInPara1(offset: number): void {
            addDiv(editorEl, 'ab');
            const d1 = addDiv(editorEl, 'cde');
            virt.attach();
            virt.initRecords(['ab', 'cde']); // viewLens 2 + 3
            window.getSelection()!.collapse(d1.firstChild, offset);
        }

        it('extends the focus to the start of the focus paragraph', () => {
            setupCaretInPara1(2);
            virt.extendSelectionToParagraphBoundary(true);
            const vs = virt.getVirtualSelection()!;
            expect(vs.focusParaIdx).toBe(1);
            expect(vs.focusViewOff).toBe(0);
            expect(virt.getVirtualSelectionFocusOffset()).toBe(2); // preceding para0 viewLen
        });

        it('extends the focus to the end of the focus paragraph', () => {
            setupCaretInPara1(1);
            virt.extendSelectionToParagraphBoundary(false);
            const vs = virt.getVirtualSelection()!;
            expect(vs.focusParaIdx).toBe(1);
            expect(vs.focusViewOff).toBe(3); // viewLen of 'cde'
            expect(virt.getVirtualSelectionFocusOffset()).toBe(5); // 2 + 3
        });

        it('preserves the existing anchor when extending', () => {
            setupCaretInPara1(1);
            virt.extendSelectionToParagraphBoundary(true);
            const vs = virt.getVirtualSelection()!;
            expect(vs.anchorParaIdx).toBe(1);
            expect(vs.anchorViewOff).toBe(1);
        });
    });

});
