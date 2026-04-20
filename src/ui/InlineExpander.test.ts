// @vitest-environment happy-dom
// obsidian is aliased to src/test-mocks/obsidian.ts in vitest.config.ts
import { describe, it, expect, beforeEach } from 'vitest';

import { InlineExpander } from './InlineExpander';
import { createRubyEl, createTcyEl, createBoutenEl } from './domHelpers';

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

function makeEditingSpan(text: string): HTMLSpanElement {
    const span = document.createElement('span');
    span.className = 'tate-editing';
    span.textContent = text;
    return span;
}

// ================================================================
// findExpandableAncestor
// ================================================================

describe('findExpandableAncestor — plain text', () => {
    it('returns null for a plain text node with no annotation ancestor', () => {
        const root = makeRoot();
        const expander = new InlineExpander(root);
        const text = document.createTextNode('hello');
        root.appendChild(text);
        expect(expander.findExpandableAncestor(text, true, true, true)).toBeNull();
    });

    it('returns null when node is the rootEl itself', () => {
        const root = makeRoot();
        const expander = new InlineExpander(root);
        expect(expander.findExpandableAncestor(root, true, true, true)).toBeNull();
    });

    it('does not traverse beyond rootEl', () => {
        const root = makeRoot();
        const expander = new InlineExpander(root);
        const text = document.createTextNode('inside');
        root.appendChild(text);
        // wrap root in a ruby — the ruby is outside root and must not be returned
        const outerRuby = createRubyEl('外', 'そと', true);
        document.body.appendChild(outerRuby);
        outerRuby.appendChild(root);
        expect(expander.findExpandableAncestor(text, true, true, true)).toBeNull();
    });
});

describe('findExpandableAncestor — ruby', () => {
    let root: HTMLDivElement;
    let expander: InlineExpander;

    beforeEach(() => {
        root = makeRoot();
        expander = new InlineExpander(root);
    });

    it('returns ruby when cursor is in the base text node and ruby=true', () => {
        const ruby = createRubyEl('東京', 'とうきょう', true);
        root.appendChild(ruby);
        const baseText = ruby.firstChild as Text;
        expect(expander.findExpandableAncestor(baseText, true, false, false)).toBe(ruby);
    });

    it('returns ruby when cursor is inside <rt> and ruby=true', () => {
        const ruby = createRubyEl('東京', 'とうきょう', false);
        root.appendChild(ruby);
        const rt = ruby.querySelector('rt')!;
        const rtText = rt.firstChild as Text;
        expect(expander.findExpandableAncestor(rtText, true, false, false)).toBe(ruby);
    });

    it('returns null for ruby element when ruby=false', () => {
        const ruby = createRubyEl('東京', 'とうきょう', true);
        root.appendChild(ruby);
        const baseText = ruby.firstChild as Text;
        expect(expander.findExpandableAncestor(baseText, false, true, true)).toBeNull();
    });

    it('returns ruby when the ruby element itself is passed as node', () => {
        const ruby = createRubyEl('東京', 'とうきょう', true);
        root.appendChild(ruby);
        expect(expander.findExpandableAncestor(ruby, true, false, false)).toBe(ruby);
    });
});

describe('findExpandableAncestor — tcy', () => {
    let root: HTMLDivElement;
    let expander: InlineExpander;

    beforeEach(() => {
        root = makeRoot();
        expander = new InlineExpander(root);
    });

    it('returns tcy when cursor is inside tcy and tcy=true', () => {
        const tcy = createTcyEl('AB');
        root.appendChild(tcy);
        const text = tcy.firstChild as Text;
        expect(expander.findExpandableAncestor(text, false, true, false)).toBe(tcy);
    });

    it('returns null for tcy when tcy=false', () => {
        const tcy = createTcyEl('AB');
        root.appendChild(tcy);
        const text = tcy.firstChild as Text;
        expect(expander.findExpandableAncestor(text, true, false, true)).toBeNull();
    });
});

describe('findExpandableAncestor — bouten', () => {
    let root: HTMLDivElement;
    let expander: InlineExpander;

    beforeEach(() => {
        root = makeRoot();
        expander = new InlineExpander(root);
    });

    it('returns bouten when cursor is inside bouten and bouten=true', () => {
        const bouten = createBoutenEl('春');
        root.appendChild(bouten);
        const text = bouten.firstChild as Text;
        expect(expander.findExpandableAncestor(text, false, false, true)).toBe(bouten);
    });

    it('returns null for bouten when bouten=false', () => {
        const bouten = createBoutenEl('春');
        root.appendChild(bouten);
        const text = bouten.firstChild as Text;
        expect(expander.findExpandableAncestor(text, true, true, false)).toBeNull();
    });
});

// ================================================================
// collapseEditing
// ================================================================

describe('collapseEditing — detached / hasChanged', () => {
    let root: HTMLDivElement;
    let expander: InlineExpander;

    beforeEach(() => {
        root = makeRoot();
        expander = new InlineExpander(root);
    });

    it('returns {hasChanged: false, detached: true} when span is not connected', () => {
        const span = makeEditingSpan('春夏［＃「春夏」に傍点］');
        // intentionally not appended to DOM
        const result = expander.collapseEditing(span, '春夏［＃「春夏」に傍点］');
        expect(result).toEqual({ hasChanged: false, detached: true });
    });

    it('returns hasChanged: false when text matches originalText', () => {
        const para = makePara(root);
        const span = makeEditingSpan('春夏［＃「春夏」に傍点］');
        para.appendChild(span);
        const result = expander.collapseEditing(span, '春夏［＃「春夏」に傍点］');
        expect(result.hasChanged).toBe(false);
        expect(result.detached).toBe(false);
    });

    it('returns hasChanged: true when text differs from originalText', () => {
        const para = makePara(root);
        const span = makeEditingSpan('春夏秋冬［＃「春夏秋冬」に傍点］');
        para.appendChild(span);
        const result = expander.collapseEditing(span, '春夏［＃「春夏」に傍点］');
        expect(result.hasChanged).toBe(true);
    });

    it('returns hasChanged: true when originalText is null', () => {
        const para = makePara(root);
        const span = makeEditingSpan('春夏［＃「春夏」に傍点］');
        para.appendChild(span);
        const result = expander.collapseEditing(span, null);
        expect(result.hasChanged).toBe(true);
    });
});

describe('collapseEditing — DOM transformation', () => {
    let root: HTMLDivElement;
    let expander: InlineExpander;

    beforeEach(() => {
        root = makeRoot();
        expander = new InlineExpander(root);
    });

    it('removes the tate-editing span from the DOM', () => {
        const para = makePara(root);
        const span = makeEditingSpan('春夏［＃「春夏」に傍点］');
        para.appendChild(span);
        expander.collapseEditing(span, '春夏［＃「春夏」に傍点］');
        expect(para.querySelector('span.tate-editing')).toBeNull();
    });

    it('inserts a bouten element in place of the span', () => {
        const para = makePara(root);
        const span = makeEditingSpan('春夏［＃「春夏」に傍点］');
        para.appendChild(span);
        expander.collapseEditing(span, '春夏［＃「春夏」に傍点］');
        const bouten = para.querySelector('[data-bouten]') as HTMLElement;
        expect(bouten).not.toBeNull();
        expect(bouten.textContent).toBe('春夏');
    });

    it('inserts a tcy element in place of the span', () => {
        const para = makePara(root);
        const span = makeEditingSpan('AB［＃「AB」は縦中横］');
        para.appendChild(span);
        expander.collapseEditing(span, 'AB［＃「AB」は縦中横］');
        const tcy = para.querySelector('[data-tcy]') as HTMLElement;
        expect(tcy).not.toBeNull();
        expect(tcy.textContent).toBe('AB');
    });

    it('inserts a ruby element in place of the span', () => {
        const para = makePara(root);
        const span = makeEditingSpan('東京《とうきょう》');
        para.appendChild(span);
        expander.collapseEditing(span, '東京《とうきょう》');
        const ruby = para.querySelector('ruby') as HTMLElement;
        expect(ruby).not.toBeNull();
        expect(ruby.querySelector('rt')?.textContent).toBe('とうきょう');
    });

    it('preserves preceding and following text nodes', () => {
        const para = makePara(root);
        para.appendChild(document.createTextNode('前'));
        const span = makeEditingSpan('春夏［＃「春夏」に傍点］');
        para.appendChild(span);
        para.appendChild(document.createTextNode('後'));
        expander.collapseEditing(span, '春夏［＃「春夏」に傍点］');
        expect(para.childNodes[0].textContent).toBe('前');
        expect((para.childNodes[1] as HTMLElement).getAttribute('data-bouten')).toBeTruthy();
        expect(para.childNodes[2].textContent).toBe('後');
    });

    it('works when the span is the only child (no preceding or following nodes)', () => {
        const para = makePara(root);
        const span = makeEditingSpan('AB［＃「AB」は縦中横］');
        para.appendChild(span);
        expander.collapseEditing(span, 'AB［＃「AB」は縦中横］');
        expect(para.childNodes.length).toBe(1);
        expect((para.childNodes[0] as HTMLElement).getAttribute('data-tcy')).toBe('explicit');
    });

    it('collapses plain text (no annotation) to a text node', () => {
        const para = makePara(root);
        const span = makeEditingSpan('hello');
        para.appendChild(span);
        expander.collapseEditing(span, 'hello');
        expect(para.childNodes[0].nodeType).toBe(Node.TEXT_NODE);
        expect(para.childNodes[0].textContent).toBe('hello');
    });
});

describe('collapseEditing — leading text absorption', () => {
    let root: HTMLDivElement;
    let expander: InlineExpander;

    beforeEach(() => {
        root = makeRoot();
        expander = new InlineExpander(root);
    });

    it('absorbs extra chars from preceding text for tcy when content is longer than leading text', () => {
        // Original: text("A") + tcy("AB") → expanded to span("AB[＃「AB」は縦中横]")
        // User deletes leading A: span now has "B[＃「AB」は縦中横]"
        // Absorption: "A" pulled from preceding text("A") → rawText = "AB[＃「AB」は縦中横]"
        const para = makePara(root);
        const prevText = document.createTextNode('A');
        para.appendChild(prevText);
        const span = makeEditingSpan('B［＃「AB」は縦中横］');
        para.appendChild(span);
        expander.collapseEditing(span, 'AB［＃「AB」は縦中横］');
        expect(prevText.textContent).toBe('');
        const tcy = para.querySelector('[data-tcy]') as HTMLElement;
        expect(tcy).not.toBeNull();
        expect(tcy.textContent).toBe('AB');
    });

    it('absorbs extra chars from preceding text for bouten', () => {
        // Original: text("春") + bouten("春夏") → expanded to span("春夏[＃「春夏」に傍点]")
        // User deletes leading 春: span now has "夏[＃「春夏」に傍点]"
        const para = makePara(root);
        const prevText = document.createTextNode('春');
        para.appendChild(prevText);
        const span = makeEditingSpan('夏［＃「春夏」に傍点］');
        para.appendChild(span);
        expander.collapseEditing(span, '春夏［＃「春夏」に傍点］');
        expect(prevText.textContent).toBe('');
        const bouten = para.querySelector('[data-bouten]') as HTMLElement;
        expect(bouten).not.toBeNull();
        expect(bouten.textContent).toBe('春夏');
    });

    it('does not absorb when preceding sibling is not a text node', () => {
        const para = makePara(root);
        const prevBouten = createBoutenEl('前');
        para.appendChild(prevBouten);
        const span = makeEditingSpan('B［＃「AB」は縦中横］');
        para.appendChild(span);
        expander.collapseEditing(span, 'AB［＃「AB」は縦中横］');
        // prevBouten must be untouched
        expect(prevBouten.textContent).toBe('前');
    });

    it('does not absorb when preceding text does not end with the extra chars', () => {
        const para = makePara(root);
        const prevText = document.createTextNode('X');
        para.appendChild(prevText);
        const span = makeEditingSpan('B［＃「AB」は縦中横］');
        para.appendChild(span);
        expander.collapseEditing(span, 'AB［＃「AB」は縦中横］');
        // "X" does not end with "A", so no absorption
        expect(prevText.textContent).toBe('X');
    });

    it('does not absorb when hasChanged is false', () => {
        const para = makePara(root);
        const prevText = document.createTextNode('A');
        para.appendChild(prevText);
        const originalText = 'AB［＃「AB」は縦中横］';
        const span = makeEditingSpan(originalText);
        para.appendChild(span);
        // originalText matches current text → hasChanged = false → no absorption
        expander.collapseEditing(span, originalText);
        expect(prevText.textContent).toBe('A');
    });
});
