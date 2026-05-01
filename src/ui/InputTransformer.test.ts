// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { InputTransformer } from './InputTransformer';

type Settings = {
    convertHalfWidthSpace: boolean;
    autoIndentOnInput: boolean;
    matchPrecedingIndent: boolean;
    removeBracketIndent: boolean;
    fontFamily: string;
    fontSize: number;
    lineBreak: 'normal' | 'strict' | 'loose' | 'anywhere';
    suppressRubyInline: boolean;
    suppressTcyInline: boolean;
    suppressBoutenInline: boolean;
};

const DEFAULT: Settings = {
    convertHalfWidthSpace: true,
    autoIndentOnInput: true,
    matchPrecedingIndent: true,
    removeBracketIndent: true,
    fontFamily: '',
    fontSize: 22,
    lineBreak: 'normal',
    suppressRubyInline: false,
    suppressTcyInline: false,
    suppressBoutenInline: false,
};

function makeRoot(): HTMLDivElement {
    const root = document.createElement('div');
    document.body.appendChild(root);
    return root;
}

function makeEmptyPara(root: HTMLDivElement): HTMLDivElement {
    const para = document.createElement('div');
    para.appendChild(document.createElement('br'));
    root.appendChild(para);
    return para;
}

function makeTextPara(root: HTMLDivElement, text: string): [HTMLDivElement, Text] {
    const para = document.createElement('div');
    const textNode = document.createTextNode(text);
    para.appendChild(textNode);
    root.appendChild(para);
    return [para, textNode];
}

function setCursorInText(textNode: Text, offset: number): void {
    const sel = window.getSelection()!;
    const r = document.createRange();
    r.setStart(textNode, offset);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
}

function setCursorAtEl(el: Element, offset: number): void {
    const sel = window.getSelection()!;
    const r = document.createRange();
    r.setStart(el, offset);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
}

function makeEvent(data: string, isComposing = false): { event: InputEvent; wasPrevented: () => boolean } {
    let prevented = false;
    const event = {
        inputType: 'insertText',
        data,
        isComposing,
        preventDefault: () => { prevented = true; },
    } as unknown as InputEvent;
    return { event, wasPrevented: () => prevented };
}

function makeCompositionEvent(data: string): CompositionEvent {
    return { data } as unknown as CompositionEvent;
}

function settings(overrides: Partial<Settings> = {}): Settings {
    return { ...DEFAULT, ...overrides };
}

// ================================================================
// handleBeforeInput — Case A: cursor at line start
// ================================================================

describe('handleBeforeInput — Case A: cursor at line start', () => {
    let root: HTMLDivElement;
    let transformer: InputTransformer;

    beforeEach(() => {
        root = makeRoot();
    });

    it('does NOT call preventDefault when bracket typed at line start with removeBracketIndent=true (autoIndentOnInput=true)', () => {
        transformer = new InputTransformer(root, settings({ autoIndentOnInput: true, removeBracketIndent: true }));
        const para = makeEmptyPara(root);
        setCursorAtEl(para, 0);

        const { event, wasPrevented } = makeEvent('「');
        transformer.handleBeforeInput(event);

        // removeBracketIndent cancels the autoIndentOnInput space → indentCount=0
        // char === e.data and indentCount === 0, so preventDefault is NOT called
        expect(wasPrevented()).toBe(false);
    });

    it('calls preventDefault and inserts 　あ when non-bracket typed at line start (autoIndentOnInput=true)', () => {
        transformer = new InputTransformer(root, settings({ autoIndentOnInput: true, removeBracketIndent: true }));
        const para = makeEmptyPara(root);
        setCursorAtEl(para, 0);

        const { event, wasPrevented } = makeEvent('あ');
        transformer.handleBeforeInput(event);

        expect(wasPrevented()).toBe(true);
        expect(para.textContent).toBe('　あ');
    });

    it('calls preventDefault and inserts 　「 when bracket typed with removeBracketIndent=false (autoIndentOnInput=true)', () => {
        transformer = new InputTransformer(root, settings({ autoIndentOnInput: true, removeBracketIndent: false }));
        const para = makeEmptyPara(root);
        setCursorAtEl(para, 0);

        const { event, wasPrevented } = makeEvent('「');
        transformer.handleBeforeInput(event);

        expect(wasPrevented()).toBe(true);
        expect(para.textContent).toBe('　「');
    });

    it('does NOT call preventDefault when bracket typed at line start (autoIndentOnInput=false)', () => {
        transformer = new InputTransformer(root, settings({ autoIndentOnInput: false, removeBracketIndent: true }));
        const para = makeEmptyPara(root);
        setCursorAtEl(para, 0);

        const { event, wasPrevented } = makeEvent('「');
        transformer.handleBeforeInput(event);

        expect(wasPrevented()).toBe(false);
    });
});

// ================================================================
// handleBeforeInput — Case B: cursor after leading full-width spaces
// ================================================================

describe('handleBeforeInput — Case B: cursor after leading spaces', () => {
    let root: HTMLDivElement;
    let transformer: InputTransformer;

    beforeEach(() => {
        root = makeRoot();
        transformer = new InputTransformer(root, settings({ autoIndentOnInput: true, removeBracketIndent: true }));
    });

    it('removes leading space and inserts bracket when cursor is after 1 space', () => {
        const [para, textNode] = makeTextPara(root, '　');
        setCursorInText(textNode, 1);

        const { event, wasPrevented } = makeEvent('「');
        transformer.handleBeforeInput(event);

        expect(wasPrevented()).toBe(true);
        expect(para.textContent).toBe('「');
    });

    it('removes one leading space and inserts bracket when cursor is after 2 spaces', () => {
        const [para, textNode] = makeTextPara(root, '　　');
        setCursorInText(textNode, 2);

        const { event, wasPrevented } = makeEvent('「');
        transformer.handleBeforeInput(event);

        expect(wasPrevented()).toBe(true);
        expect(para.textContent).toBe('　「');
    });

    it('does NOT remove space when cursor is after spaces+text (non-all-space)', () => {
        const [, textNode] = makeTextPara(root, '　あ');
        setCursorInText(textNode, 2);

        const { event, wasPrevented } = makeEvent('「');
        transformer.handleBeforeInput(event);

        // Not a bracket-de-indent scenario: cursor not after ONLY full-width spaces
        expect(wasPrevented()).toBe(false);
    });

    it('works for （ (full-width parenthesis)', () => {
        const [para, textNode] = makeTextPara(root, '　');
        setCursorInText(textNode, 1);

        const { event, wasPrevented } = makeEvent('（');
        transformer.handleBeforeInput(event);

        expect(wasPrevented()).toBe(true);
        expect(para.textContent).toBe('（');
    });

    it('works for 【 (lenticular bracket)', () => {
        const [para, textNode] = makeTextPara(root, '　');
        setCursorInText(textNode, 1);

        const { event, wasPrevented } = makeEvent('【');
        transformer.handleBeforeInput(event);

        expect(wasPrevented()).toBe(true);
        expect(para.textContent).toBe('【');
    });

    it('does NOT fire when removeBracketIndent=false', () => {
        transformer = new InputTransformer(root, settings({ autoIndentOnInput: true, removeBracketIndent: false }));
        const [para, textNode] = makeTextPara(root, '　');
        setCursorInText(textNode, 1);

        const { event, wasPrevented } = makeEvent('「');
        transformer.handleBeforeInput(event);

        // autoIndentOnInput not at line start (textBefore='　'), space conversion only (no conversion needed)
        expect(wasPrevented()).toBe(false);
        // DOM not changed by handleBeforeInput
        expect(para.textContent).toBe('　');
    });

    it('skips IME events (isComposing=true)', () => {
        const [para, textNode] = makeTextPara(root, '　');
        setCursorInText(textNode, 1);

        const { event, wasPrevented } = makeEvent('「', true);
        transformer.handleBeforeInput(event);

        expect(wasPrevented()).toBe(false);
        expect(para.textContent).toBe('　');
    });
});

// ================================================================
// handleCompositionStart
// ================================================================

describe('handleCompositionStart', () => {
    let root: HTMLDivElement;

    beforeEach(() => {
        root = makeRoot();
    });

    it('inserts 　 at line start when autoIndentOnInput=true', () => {
        const transformer = new InputTransformer(root, settings({ autoIndentOnInput: true }));
        const para = makeEmptyPara(root);
        setCursorAtEl(para, 0);

        transformer.handleCompositionStart();

        expect(para.textContent).toBe('　');
    });

    it('does NOT insert 　 when autoIndentOnInput=false', () => {
        const transformer = new InputTransformer(root, settings({ autoIndentOnInput: false }));
        const para = makeEmptyPara(root);
        setCursorAtEl(para, 0);

        transformer.handleCompositionStart();

        expect(para.textContent).toBe('');
    });

    it('does NOT insert 　 when cursor is not at line start', () => {
        const transformer = new InputTransformer(root, settings({ autoIndentOnInput: true }));
        const [, textNode] = makeTextPara(root, '　');
        setCursorInText(textNode, 1);

        transformer.handleCompositionStart();

        // Should not insert another space — cursor is not at line start
        expect(textNode.data).toBe('　');
    });
});

// ================================================================
// handleCompositionEnd
// ================================================================

describe('handleCompositionEnd', () => {
    let root: HTMLDivElement;

    beforeEach(() => {
        root = makeRoot();
    });

    it('removes leading space when IME-confirmed single bracket follows 　', () => {
        const transformer = new InputTransformer(root, settings({ removeBracketIndent: true }));
        const [para, textNode] = makeTextPara(root, '　「');
        setCursorInText(textNode, 2);

        transformer.handleCompositionEnd(makeCompositionEvent('「'));

        expect(para.textContent).toBe('「');
    });

    it('removes leading space when IME-confirmed string starts with bracket (multi-char: 「あいうえお)', () => {
        // '　「あいうえお' = 7 chars; cursor at offset 7 (after last char)
        const transformer = new InputTransformer(root, settings({ removeBracketIndent: true }));
        const [para, textNode] = makeTextPara(root, '　「あいうえお');
        setCursorInText(textNode, 7);

        transformer.handleCompositionEnd(makeCompositionEvent('「あいうえお'));

        expect(para.textContent).toBe('「あいうえお');
    });

    it('does NOT remove space when removeBracketIndent=false', () => {
        const transformer = new InputTransformer(root, settings({ removeBracketIndent: false }));
        const [para, textNode] = makeTextPara(root, '　「');
        setCursorInText(textNode, 2);

        transformer.handleCompositionEnd(makeCompositionEvent('「'));

        expect(para.textContent).toBe('　「');
    });

    it('does NOT remove space when confirmed string does not start with bracket', () => {
        const transformer = new InputTransformer(root, settings({ removeBracketIndent: true }));
        const [para, textNode] = makeTextPara(root, '　あいうえお');
        setCursorInText(textNode, 6);

        transformer.handleCompositionEnd(makeCompositionEvent('あいうえお'));

        expect(para.textContent).toBe('　あいうえお');
    });

    it('does NOT remove space when text before bracket contains non-space characters', () => {
        const transformer = new InputTransformer(root, settings({ removeBracketIndent: true }));
        const [para, textNode] = makeTextPara(root, 'あ「');
        setCursorInText(textNode, 2);

        transformer.handleCompositionEnd(makeCompositionEvent('「'));

        expect(para.textContent).toBe('あ「');
    });

    it('does NOT fire when bracket is at beginning of paragraph (no leading space)', () => {
        const transformer = new InputTransformer(root, settings({ removeBracketIndent: true }));
        const [para, textNode] = makeTextPara(root, '「');
        setCursorInText(textNode, 1);

        transformer.handleCompositionEnd(makeCompositionEvent('「'));

        expect(para.textContent).toBe('「');
    });

    it('works with two text nodes: space in first node, bracket in second', () => {
        const transformer = new InputTransformer(root, settings({ removeBracketIndent: true }));
        const para = document.createElement('div');
        root.appendChild(para);
        const spaceNode = document.createTextNode('　');
        const bracketNode = document.createTextNode('「');
        para.appendChild(spaceNode);
        para.appendChild(bracketNode);
        setCursorInText(bracketNode, 1);

        transformer.handleCompositionEnd(makeCompositionEvent('「'));

        expect(para.textContent).toBe('「');
    });
});
