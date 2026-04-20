// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { LiveConverter } from './LiveConverter';
import { createRubyEl } from './domHelpers';

// Sets the cursor at the given offset inside a text node and returns the text node.
function setCursor(textNode: Text, offset: number): void {
    const sel = window.getSelection()!;
    const r = document.createRange();
    r.setStart(textNode, offset);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
}

function makeRoot(): HTMLDivElement {
    const root = document.createElement('div');
    document.body.appendChild(root);
    return root;
}

function makePara(root: HTMLDivElement): HTMLDivElement {
    const para = document.createElement('div');
    root.appendChild(para);
    return para;
}

// ================================================================
// handleRubyCompletion — no conversion cases
// ================================================================

describe('handleRubyCompletion — no conversion', () => {
    let root: HTMLDivElement;
    let converter: LiveConverter;

    beforeEach(() => {
        root = makeRoot();
        converter = new LiveConverter(root);
    });

    it('returns converted:false when there is no selection', () => {
        window.getSelection()!.removeAllRanges();
        expect(converter.handleRubyCompletion()).toEqual({ converted: false });
    });

    it('returns converted:false when cursor is not in a text node', () => {
        const para = makePara(root);
        const sel = window.getSelection()!;
        const r = document.createRange();
        r.setStart(para, 0);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
        expect(converter.handleRubyCompletion()).toEqual({ converted: false });
    });

    it('returns converted:false when text does not end with 》', () => {
        const para = makePara(root);
        const text = document.createTextNode('東京《とうきょう');
        para.appendChild(text);
        setCursor(text, text.length);
        expect(converter.handleRubyCompletion()).toEqual({ converted: false });
    });

    it('returns converted:false when pattern does not match (no base text)', () => {
        const para = makePara(root);
        const text = document.createTextNode('《とうきょう》');
        para.appendChild(text);
        setCursor(text, text.length);
        expect(converter.handleRubyCompletion()).toEqual({ converted: false });
    });

    it('returns converted:false when cursor is inside a ruby element', () => {
        const para = makePara(root);
        const ruby = createRubyEl('東京', 'とうきょう', true);
        para.appendChild(ruby);
        // Place cursor in the base text of the ruby
        const baseText = ruby.firstChild as Text;
        setCursor(baseText, baseText.length);
        expect(converter.handleRubyCompletion()).toEqual({ converted: false });
    });
});

// ================================================================
// handleRubyCompletion — explicit form ｜base《rt》
// ================================================================

describe('handleRubyCompletion — explicit form', () => {
    let root: HTMLDivElement;
    let converter: LiveConverter;

    beforeEach(() => {
        root = makeRoot();
        converter = new LiveConverter(root);
    });

    it('converts ｜base《rt》 to a ruby element', () => {
        const para = makePara(root);
        const text = document.createTextNode('｜東京《とうきょう》');
        para.appendChild(text);
        setCursor(text, text.length);

        const result = converter.handleRubyCompletion();

        expect(result).toEqual({ converted: true });
        const ruby = para.querySelector('ruby');
        expect(ruby).not.toBeNull();
        expect(ruby!.getAttribute('data-ruby-explicit')).toBe('true');
        expect(ruby!.querySelector('rt')!.textContent).toBe('とうきょう');
    });

    it('converts half-width pipe |base《rt》 to a ruby element', () => {
        const para = makePara(root);
        const text = document.createTextNode('|東京《とうきょう》');
        para.appendChild(text);
        setCursor(text, text.length);

        const result = converter.handleRubyCompletion();

        expect(result).toEqual({ converted: true });
        const ruby = para.querySelector('ruby');
        expect(ruby!.getAttribute('data-ruby-explicit')).toBe('true');
    });

    it('preserves preceding text before the notation', () => {
        const para = makePara(root);
        const text = document.createTextNode('前置き｜東京《とうきょう》');
        para.appendChild(text);
        setCursor(text, text.length);

        converter.handleRubyCompletion();

        expect(para.firstChild!.textContent).toBe('前置き');
        expect(para.childNodes[1].nodeName).toBe('RUBY');
    });

    it('preserves following text after the notation', () => {
        const para = makePara(root);
        // cursor in the middle: "｜東京《とうきょう》後続"
        const text = document.createTextNode('｜東京《とうきょう》後続');
        para.appendChild(text);
        // cursor just after 》
        setCursor(text, '｜東京《とうきょう》'.length);

        converter.handleRubyCompletion();

        const last = para.lastChild!;
        expect(last.nodeType).toBe(Node.TEXT_NODE);
        expect(last.textContent).toBe('後続');
    });
});

// ================================================================
// handleRubyCompletion — implicit form kanji《rt》
// ================================================================

describe('handleRubyCompletion — implicit form', () => {
    let root: HTMLDivElement;
    let converter: LiveConverter;

    beforeEach(() => {
        root = makeRoot();
        converter = new LiveConverter(root);
    });

    it('converts kanji《rt》 to an implicit ruby element', () => {
        const para = makePara(root);
        const text = document.createTextNode('東京《とうきょう》');
        para.appendChild(text);
        setCursor(text, text.length);

        const result = converter.handleRubyCompletion();

        expect(result).toEqual({ converted: true });
        const ruby = para.querySelector('ruby');
        expect(ruby!.getAttribute('data-ruby-explicit')).toBe('false');
        expect(ruby!.querySelector('rt')!.textContent).toBe('とうきょう');
    });

    it('does not convert non-kanji base text without explicit pipe', () => {
        const para = makePara(root);
        const text = document.createTextNode('hello《world》');
        para.appendChild(text);
        setCursor(text, text.length);

        expect(converter.handleRubyCompletion()).toEqual({ converted: false });
    });
});

// ================================================================
// handleRubyCompletion — empty rt (tate-editing span)
// ================================================================

describe('handleRubyCompletion — empty rt creates tate-editing span', () => {
    let root: HTMLDivElement;
    let converter: LiveConverter;

    beforeEach(() => {
        root = makeRoot();
        converter = new LiveConverter(root);
    });

    it('returns newExpanded when rt is empty (explicit form)', () => {
        const para = makePara(root);
        const text = document.createTextNode('｜東京《》');
        para.appendChild(text);
        setCursor(text, text.length);

        const result = converter.handleRubyCompletion();

        expect(result.converted).toBe(true);
        if (!result.converted) return;
        expect(result.newExpanded).toBeDefined();
        expect(result.newExpanded!.el.className).toBe('tate-editing');
        expect(result.newExpanded!.originalText).toBe('｜東京《》');
    });

    it('returns newExpanded when rt is empty (implicit kanji form)', () => {
        const para = makePara(root);
        const text = document.createTextNode('東京《》');
        para.appendChild(text);
        setCursor(text, text.length);

        const result = converter.handleRubyCompletion();

        expect(result.converted).toBe(true);
        if (!result.converted) return;
        expect(result.newExpanded).toBeDefined();
        expect(result.newExpanded!.originalText).toBe('東京《》');
    });

    it('inserts tate-editing span into DOM instead of ruby element', () => {
        const para = makePara(root);
        const text = document.createTextNode('｜東京《》');
        para.appendChild(text);
        setCursor(text, text.length);

        converter.handleRubyCompletion();

        expect(para.querySelector('ruby')).toBeNull();
        expect(para.querySelector('span.tate-editing')).not.toBeNull();
    });

    it('places cursor between 《 and 》 (just before 》)', () => {
        const para = makePara(root);
        const rawText = '｜東京《》';
        const text = document.createTextNode(rawText);
        para.appendChild(text);
        setCursor(text, text.length);

        converter.handleRubyCompletion();

        const sel = window.getSelection()!;
        const range = sel.getRangeAt(0);
        const span = para.querySelector('span.tate-editing')!;
        expect(range.startContainer).toBe(span.firstChild);
        // cursor at rawText.length - 1 = just before 》
        expect(range.startOffset).toBe(rawText.length - 1);
    });
});

// ================================================================
// handleTcyCompletion
// ================================================================

describe('handleTcyCompletion — no conversion', () => {
    let root: HTMLDivElement;
    let converter: LiveConverter;

    beforeEach(() => {
        root = makeRoot();
        converter = new LiveConverter(root);
    });

    it('returns false when there is no selection', () => {
        window.getSelection()!.removeAllRanges();
        expect(converter.handleTcyCompletion()).toBe(false);
    });

    it('returns false when text does not end with ］', () => {
        const para = makePara(root);
        const text = document.createTextNode('AB［＃「AB」は縦中横');
        para.appendChild(text);
        setCursor(text, text.length);
        expect(converter.handleTcyCompletion()).toBe(false);
    });

    it('returns false when pattern does not match', () => {
        const para = makePara(root);
        const text = document.createTextNode('AB］');
        para.appendChild(text);
        setCursor(text, text.length);
        expect(converter.handleTcyCompletion()).toBe(false);
    });

    it('returns false when leading text does not end with annotation content', () => {
        // content is "AB" but leading text is "XY" — no match
        const para = makePara(root);
        const text = document.createTextNode('XY［＃「AB」は縦中横］');
        para.appendChild(text);
        setCursor(text, text.length);
        expect(converter.handleTcyCompletion()).toBe(false);
    });
});

describe('handleTcyCompletion — conversion', () => {
    let root: HTMLDivElement;
    let converter: LiveConverter;

    beforeEach(() => {
        root = makeRoot();
        converter = new LiveConverter(root);
    });

    it('converts AB［＃「AB」は縦中横］ to a tcy element', () => {
        const para = makePara(root);
        const text = document.createTextNode('AB［＃「AB」は縦中横］');
        para.appendChild(text);
        setCursor(text, text.length);

        expect(converter.handleTcyCompletion()).toBe(true);
        const tcy = para.querySelector('[data-tcy]') as HTMLElement;
        expect(tcy).not.toBeNull();
        expect(tcy.textContent).toBe('AB');
    });

    it('preserves preceding text', () => {
        const para = makePara(root);
        const text = document.createTextNode('前AB［＃「AB」は縦中横］');
        para.appendChild(text);
        setCursor(text, text.length);

        converter.handleTcyCompletion();

        expect(para.firstChild!.textContent).toBe('前');
        expect((para.childNodes[1] as HTMLElement).getAttribute('data-tcy')).toBe('explicit');
    });

    it('returns false when cursor is inside a ruby element', () => {
        const para = makePara(root);
        const ruby = createRubyEl('東', 'ひがし', false);
        para.appendChild(ruby);
        const baseText = ruby.firstChild as Text;
        setCursor(baseText, baseText.length);
        expect(converter.handleTcyCompletion()).toBe(false);
    });
});

// ================================================================
// handleBoutenCompletion
// ================================================================

describe('handleBoutenCompletion — no conversion', () => {
    let root: HTMLDivElement;
    let converter: LiveConverter;

    beforeEach(() => {
        root = makeRoot();
        converter = new LiveConverter(root);
    });

    it('returns false when there is no selection', () => {
        window.getSelection()!.removeAllRanges();
        expect(converter.handleBoutenCompletion()).toBe(false);
    });

    it('returns false when pattern does not match', () => {
        const para = makePara(root);
        const text = document.createTextNode('春夏］');
        para.appendChild(text);
        setCursor(text, text.length);
        expect(converter.handleBoutenCompletion()).toBe(false);
    });

    it('returns false when leading text does not end with annotation content', () => {
        const para = makePara(root);
        const text = document.createTextNode('秋冬［＃「春夏」に傍点］');
        para.appendChild(text);
        setCursor(text, text.length);
        expect(converter.handleBoutenCompletion()).toBe(false);
    });
});

describe('handleBoutenCompletion — conversion', () => {
    let root: HTMLDivElement;
    let converter: LiveConverter;

    beforeEach(() => {
        root = makeRoot();
        converter = new LiveConverter(root);
    });

    it('converts 春夏［＃「春夏」に傍点］ to a bouten element', () => {
        const para = makePara(root);
        const text = document.createTextNode('春夏［＃「春夏」に傍点］');
        para.appendChild(text);
        setCursor(text, text.length);

        expect(converter.handleBoutenCompletion()).toBe(true);
        const bouten = para.querySelector('[data-bouten]') as HTMLElement;
        expect(bouten).not.toBeNull();
        expect(bouten.textContent).toBe('春夏');
    });

    it('preserves preceding text', () => {
        const para = makePara(root);
        const text = document.createTextNode('前置き春夏［＃「春夏」に傍点］');
        para.appendChild(text);
        setCursor(text, text.length);

        converter.handleBoutenCompletion();

        expect(para.firstChild!.textContent).toBe('前置き');
        expect((para.childNodes[1] as HTMLElement).getAttribute('data-bouten')).toBeTruthy();
    });

    it('returns false when cursor is inside a ruby element', () => {
        const para = makePara(root);
        const ruby = createRubyEl('東', 'ひがし', false);
        para.appendChild(ruby);
        const baseText = ruby.firstChild as Text;
        setCursor(baseText, baseText.length);
        expect(converter.handleBoutenCompletion()).toBe(false);
    });
});
