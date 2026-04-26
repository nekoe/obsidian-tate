// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import {
    createRubyEl, createTcyEl, createBoutenEl, createCursorAnchor,
    insertAnnotationElement, setCursorAfter,
    findAncestor, findBoutenAncestor, findTcyAncestor, isInsideRuby,
    findCursorAnchorAncestor, isInsideRtNode, findLastBaseTextInElement,
    rawOffsetForExpand, getExtraCharsFromAnnotation,
    isEffectivelyEmpty, clearChildren, ensureBrPlaceholder,
} from './domHelpers';

// ================================================================
// Element factories
// ================================================================

describe('createRubyEl', () => {
    it('sets data-ruby-explicit=true when explicit', () => {
        const el = createRubyEl('東京', 'とうきょう', true);
        expect(el.tagName).toBe('RUBY');
        expect(el.getAttribute('data-ruby-explicit')).toBe('true');
    });

    it('sets data-ruby-explicit=false when implicit', () => {
        const el = createRubyEl('東京', 'とうきょう', false);
        expect(el.getAttribute('data-ruby-explicit')).toBe('false');
    });

    it('base text is a direct text node child', () => {
        const el = createRubyEl('東京', 'とうきょう', true);
        const textNode = Array.from(el.childNodes).find(n => n.nodeType === Node.TEXT_NODE);
        expect((textNode as Text).data).toBe('東京');
    });

    it('rt element contains ruby text', () => {
        const el = createRubyEl('東京', 'とうきょう', true);
        const rt = el.querySelector('rt');
        expect(rt?.textContent).toBe('とうきょう');
    });

    it('allows empty rt', () => {
        const el = createRubyEl('東京', '', true);
        expect(el.querySelector('rt')?.textContent).toBe('');
    });
});

describe('createTcyEl', () => {
    it('creates span with correct attributes', () => {
        const el = createTcyEl('AB');
        expect(el.tagName).toBe('SPAN');
        expect(el.getAttribute('data-tcy')).toBe('explicit');
        expect(el.className).toBe('tcy');
        expect(el.textContent).toBe('AB');
    });
});

describe('createBoutenEl', () => {
    it('creates span with correct attributes', () => {
        const el = createBoutenEl('春');
        expect(el.tagName).toBe('SPAN');
        expect(el.getAttribute('data-bouten')).toBe('sesame');
        expect(el.className).toBe('bouten');
        expect(el.textContent).toBe('春');
    });
});

describe('createCursorAnchor', () => {
    it('creates span with tate-cursor-anchor class', () => {
        const el = createCursorAnchor();
        expect(el.tagName).toBe('SPAN');
        expect(el.className).toBe('tate-cursor-anchor');
    });

    it('contains a U+200B text node', () => {
        const el = createCursorAnchor();
        const child = el.firstChild;
        expect(child?.nodeType).toBe(Node.TEXT_NODE);
        expect((child as Text).data).toBe('\u200B');
    });
});

// ================================================================
// insertAnnotationElement
// ================================================================

describe('insertAnnotationElement', () => {
    function makeParentWithText(text: string): { parent: HTMLElement; textNode: Text } {
        const parent = document.createElement('div');
        const textNode = document.createTextNode(text);
        parent.appendChild(textNode);
        return { parent, textNode };
    }

    it('inserts element replacing the full text node when no surrounding text', () => {
        const { parent, textNode } = makeParentWithText('春');
        const span = createBoutenEl('春');
        insertAnnotationElement(textNode, 0, 1, span);
        expect(parent.childNodes.length).toBe(1);
        expect(parent.firstChild).toBe(span);
    });

    it('preserves preceding text before the element', () => {
        const { parent, textNode } = makeParentWithText('前春後');
        const span = createBoutenEl('春');
        insertAnnotationElement(textNode, 1, 2, span);
        expect(parent.childNodes.length).toBe(3);
        expect((parent.childNodes[0] as Text).data).toBe('前');
        expect(parent.childNodes[1]).toBe(span);
        expect((parent.childNodes[2] as Text).data).toBe('後');
    });

    it('preserves only following text when element is at start', () => {
        const { parent, textNode } = makeParentWithText('春後');
        const span = createBoutenEl('春');
        insertAnnotationElement(textNode, 0, 1, span);
        expect(parent.childNodes.length).toBe(2);
        expect(parent.childNodes[0]).toBe(span);
        expect((parent.childNodes[1] as Text).data).toBe('後');
    });

    it('preserves only preceding text when element is at end', () => {
        const { parent, textNode } = makeParentWithText('前春');
        const span = createBoutenEl('春');
        insertAnnotationElement(textNode, 1, 2, span);
        expect(parent.childNodes.length).toBe(2);
        expect((parent.childNodes[0] as Text).data).toBe('前');
        expect(parent.childNodes[1]).toBe(span);
    });

    it('returns the inserted element', () => {
        const { textNode } = makeParentWithText('春');
        const span = createBoutenEl('春');
        const result = insertAnnotationElement(textNode, 0, 1, span);
        expect(result).toBe(span);
    });

    it('inserts element at correct position when parent has existing siblings', () => {
        const parent = document.createElement('div');
        const before = document.createTextNode('A');
        const textNode = document.createTextNode('春');
        const after = document.createTextNode('Z');
        parent.appendChild(before);
        parent.appendChild(textNode);
        parent.appendChild(after);
        const span = createBoutenEl('春');
        insertAnnotationElement(textNode, 0, 1, span);
        expect(parent.childNodes[0]).toBe(before);
        expect(parent.childNodes[1]).toBe(span);
        expect(parent.childNodes[2]).toBe(after);
    });
});

// ================================================================
// Ancestor traversal
// ================================================================

describe('findAncestor', () => {
    let root: HTMLElement;

    beforeEach(() => {
        root = document.createElement('div');
    });

    it('returns matching ancestor', () => {
        const inner = document.createElement('span');
        inner.className = 'target';
        const text = document.createTextNode('x');
        inner.appendChild(text);
        root.appendChild(inner);
        const result = findAncestor(text, el => el.className === 'target', root);
        expect(result).toBe(inner);
    });

    it('returns null when no ancestor matches', () => {
        const inner = document.createElement('span');
        const text = document.createTextNode('x');
        inner.appendChild(text);
        root.appendChild(inner);
        const result = findAncestor(text, el => el.tagName === 'RUBY', root);
        expect(result).toBeNull();
    });

    it('does not traverse past rootEl', () => {
        const outer = document.createElement('p');
        outer.className = 'target';
        const inner = document.createElement('span');
        const text = document.createTextNode('x');
        inner.appendChild(text);
        outer.appendChild(inner);
        // root is inner, outer is not searched
        const result = findAncestor(text, el => el.className === 'target', inner);
        expect(result).toBeNull();
    });

    it('returns the element itself if it matches (not a text node)', () => {
        const span = document.createElement('span');
        span.className = 'target';
        root.appendChild(span);
        const result = findAncestor(span, el => el.className === 'target', root);
        expect(result).toBe(span);
    });
});

describe('findBoutenAncestor', () => {
    it('finds a bouten ancestor', () => {
        const root = document.createElement('div');
        const bouten = createBoutenEl('春');
        const text = document.createTextNode('春');
        bouten.replaceChildren(text);
        root.appendChild(bouten);
        expect(findBoutenAncestor(text, root)).toBe(bouten);
    });

    it('returns null when not inside bouten', () => {
        const root = document.createElement('div');
        const text = document.createTextNode('春');
        root.appendChild(text);
        expect(findBoutenAncestor(text, root)).toBeNull();
    });
});

describe('findTcyAncestor', () => {
    it('finds a tcy ancestor', () => {
        const root = document.createElement('div');
        const tcy = createTcyEl('AB');
        const text = document.createTextNode('AB');
        tcy.replaceChildren(text);
        root.appendChild(tcy);
        expect(findTcyAncestor(text, root)).toBe(tcy);
    });

    it('returns null when not inside tcy', () => {
        const root = document.createElement('div');
        const text = document.createTextNode('AB');
        root.appendChild(text);
        expect(findTcyAncestor(text, root)).toBeNull();
    });
});

describe('isInsideRuby', () => {
    it('returns true when inside ruby element', () => {
        const root = document.createElement('div');
        const ruby = createRubyEl('東', 'ひがし', true);
        root.appendChild(ruby);
        const textNode = ruby.firstChild!;
        expect(isInsideRuby(textNode, root)).toBe(true);
    });

    it('returns false when not inside ruby', () => {
        const root = document.createElement('div');
        const text = document.createTextNode('東');
        root.appendChild(text);
        expect(isInsideRuby(text, root)).toBe(false);
    });

    it('returns true when inside rt (which is inside ruby)', () => {
        const root = document.createElement('div');
        const ruby = createRubyEl('東', 'ひがし', true);
        root.appendChild(ruby);
        const rt = ruby.querySelector('rt')!;
        expect(isInsideRuby(rt, root)).toBe(true);
    });
});

describe('findCursorAnchorAncestor', () => {
    it('finds a cursor anchor ancestor', () => {
        const root = document.createElement('div');
        const anchor = createCursorAnchor();
        root.appendChild(anchor);
        const text = anchor.firstChild!;
        expect(findCursorAnchorAncestor(text, root)).toBe(anchor);
    });

    it('returns null when not inside cursor anchor', () => {
        const root = document.createElement('div');
        const text = document.createTextNode('x');
        root.appendChild(text);
        expect(findCursorAnchorAncestor(text, root)).toBeNull();
    });
});

describe('isInsideRtNode', () => {
    it('returns true when inside rt', () => {
        const root = document.createElement('div');
        const ruby = createRubyEl('東', 'ひがし', true);
        root.appendChild(ruby);
        const rt = ruby.querySelector('rt')!;
        const rtText = rt.firstChild!;
        expect(isInsideRtNode(rtText, root)).toBe(true);
    });

    it('returns false when inside ruby base text (not rt)', () => {
        const root = document.createElement('div');
        const ruby = createRubyEl('東', 'ひがし', true);
        root.appendChild(ruby);
        // First text node of ruby (the base)
        const baseText = ruby.firstChild!;
        expect(isInsideRtNode(baseText, root)).toBe(false);
    });

    it('returns false for plain text outside ruby', () => {
        const root = document.createElement('div');
        const text = document.createTextNode('東');
        root.appendChild(text);
        expect(isInsideRtNode(text, root)).toBe(false);
    });
});

describe('findLastBaseTextInElement', () => {
    it('returns last text node in a plain div', () => {
        const root = document.createElement('div');
        const div = document.createElement('div');
        const t1 = document.createTextNode('A');
        const t2 = document.createTextNode('B');
        div.appendChild(t1);
        div.appendChild(t2);
        root.appendChild(div);
        const result = findLastBaseTextInElement(div, root);
        expect(result?.node).toBe(t2);
        expect(result?.offset).toBe(1);
    });

    it('skips text inside rt nodes', () => {
        const root = document.createElement('div');
        const div = document.createElement('div');
        const text = document.createTextNode('前');
        const ruby = createRubyEl('東', 'ひがし', true);
        div.appendChild(text);
        div.appendChild(ruby);
        root.appendChild(div);
        // 'ruby' base text comes after 'text', but rt text inside ruby should be skipped
        // Last non-rt text inside div should be the ruby base text node
        const result = findLastBaseTextInElement(div, root);
        expect(result?.node.nodeType).toBe(Node.TEXT_NODE);
        // The base text of ruby is 'ひがし' — but wait, ruby contains base + rt.
        // Actually ruby: [text('東'), rt('ひがし')]
        // The base node is the first child of ruby ('東')
        // rt text ('ひがし') is skipped
        // So last non-rt text is '東'
        expect(result?.node.textContent).toBe('東');
    });

    it('returns null for an element with no text nodes', () => {
        const root = document.createElement('div');
        const div = document.createElement('div');
        div.innerHTML = '<br>';
        root.appendChild(div);
        expect(findLastBaseTextInElement(div, root)).toBeNull();
    });
});

// ================================================================
// Pure computation
// ================================================================

describe('rawOffsetForExpand', () => {
    it('offset inside base text of explicit ruby adds prefix 1', () => {
        const ruby = createRubyEl('東京', 'とうきょう', true);
        const baseText = ruby.firstChild as Text;
        // Explicit ruby: prefix = 1 (｜), so offset 1 into base → 1 + 1 = 2
        expect(rawOffsetForExpand(ruby, baseText, 1)).toBe(2);
    });

    it('offset inside base text of implicit ruby has no prefix', () => {
        const ruby = createRubyEl('東京', 'とうきょう', false);
        const baseText = ruby.firstChild as Text;
        // Implicit ruby: prefix = 0, so offset 1 → 0 + 1 = 1
        expect(rawOffsetForExpand(ruby, baseText, 1)).toBe(1);
    });

    it('offset inside rt of explicit ruby', () => {
        const ruby = createRubyEl('東', 'ひがし', true);
        // Explicit: prefix=1, baseLen=1 (text '東'), then '《', then rt offset
        // rawText: ｜東《ひがし》 → rt starts after prefix(1) + base(1) + '《'(1) = 3
        const rt = ruby.querySelector('rt')!;
        const rtText = rt.firstChild as Text;
        expect(rawOffsetForExpand(ruby, rtText, 0)).toBe(1 + 1 + 1 + 0); // = 3
        expect(rawOffsetForExpand(ruby, rtText, 2)).toBe(1 + 1 + 1 + 2); // = 5
    });

    it('offset inside rt of implicit ruby', () => {
        const ruby = createRubyEl('東', 'ひがし', false);
        // Implicit: prefix=0, baseLen=1, then '《'(1), then rt offset
        const rt = ruby.querySelector('rt')!;
        const rtText = rt.firstChild as Text;
        expect(rawOffsetForExpand(ruby, rtText, 0)).toBe(0 + 1 + 1 + 0); // = 2
    });

    it('offset inside tcy span returns offset as-is', () => {
        const tcy = createTcyEl('AB');
        const text = tcy.firstChild as Text;
        expect(rawOffsetForExpand(tcy, text, 1)).toBe(1);
    });

    it('offset inside bouten span returns offset as-is', () => {
        const bouten = createBoutenEl('春');
        const text = bouten.firstChild as Text;
        expect(rawOffsetForExpand(bouten, text, 0)).toBe(0);
    });
});

describe('getExtraCharsFromAnnotation', () => {
    it('returns empty string for plain text', () => {
        expect(getExtraCharsFromAnnotation('hello')).toBe('');
    });

    it('returns empty string when tcy content matches leading text exactly', () => {
        // "AB" before "AB[＃...]": no extra chars
        expect(getExtraCharsFromAnnotation('AB［＃「AB」は縦中横］')).toBe('');
    });

    it('returns extra chars when tcy content is longer than preceding text', () => {
        // "B" before "AB[＃...]": 'A' is extra
        expect(getExtraCharsFromAnnotation('B［＃「AB」は縦中横］')).toBe('A');
    });

    it('returns empty string when tcy content is shorter than or equal to preceding text', () => {
        // "XAB" before "AB[＃...]": leading text ends with content, no extra
        expect(getExtraCharsFromAnnotation('XAB［＃「AB」は縦中横］')).toBe('');
    });

    it('returns extra chars for bouten annotation', () => {
        // "夏" before "春夏[＃...]": '春' is extra
        expect(getExtraCharsFromAnnotation('夏［＃「春夏」に傍点］')).toBe('春');
    });

    it('returns empty string when bouten content matches exactly', () => {
        expect(getExtraCharsFromAnnotation('春夏［＃「春夏」に傍点］')).toBe('');
    });
});

// ================================================================
// Paragraph div utilities
// ================================================================

describe('isEffectivelyEmpty', () => {
    it('returns true for a div with no children', () => {
        const div = document.createElement('div');
        expect(isEffectivelyEmpty(div)).toBe(true);
    });

    it('returns true for a div containing only an empty Text node', () => {
        const div = document.createElement('div');
        div.appendChild(document.createTextNode(''));
        expect(isEffectivelyEmpty(div)).toBe(true);
    });

    it('returns true for a div containing multiple empty Text nodes', () => {
        const div = document.createElement('div');
        div.appendChild(document.createTextNode(''));
        div.appendChild(document.createTextNode(''));
        expect(isEffectivelyEmpty(div)).toBe(true);
    });

    it('returns false for a div with a non-empty Text node', () => {
        const div = document.createElement('div');
        div.appendChild(document.createTextNode('x'));
        expect(isEffectivelyEmpty(div)).toBe(false);
    });

    it('returns false for a div containing a <br>', () => {
        const div = document.createElement('div');
        div.appendChild(document.createElement('br'));
        expect(isEffectivelyEmpty(div)).toBe(false);
    });

    it('returns false for a div containing an element child', () => {
        const div = document.createElement('div');
        div.appendChild(document.createElement('span'));
        expect(isEffectivelyEmpty(div)).toBe(false);
    });

    it('returns false when empty Text node and non-empty Text node coexist', () => {
        const div = document.createElement('div');
        div.appendChild(document.createTextNode(''));
        div.appendChild(document.createTextNode('y'));
        expect(isEffectivelyEmpty(div)).toBe(false);
    });
});

describe('clearChildren', () => {
    it('removes all children from an element', () => {
        const div = document.createElement('div');
        div.appendChild(document.createTextNode('abc'));
        div.appendChild(document.createElement('br'));
        clearChildren(div);
        expect(div.childNodes.length).toBe(0);
    });

    it('is a no-op on an already-empty element', () => {
        const div = document.createElement('div');
        expect(() => clearChildren(div)).not.toThrow();
        expect(div.childNodes.length).toBe(0);
    });
});

describe('ensureBrPlaceholder', () => {
    it('appends <br> to an empty div', () => {
        const div = document.createElement('div');
        ensureBrPlaceholder(div);
        expect(div.childNodes.length).toBe(1);
        expect(div.firstChild?.nodeName).toBe('BR');
    });

    it('replaces empty Text nodes with <br>', () => {
        const div = document.createElement('div');
        div.appendChild(document.createTextNode(''));
        div.appendChild(document.createTextNode(''));
        ensureBrPlaceholder(div);
        expect(div.childNodes.length).toBe(1);
        expect(div.firstChild?.nodeName).toBe('BR');
    });

    it('does not modify a div that already has a <br>', () => {
        const div = document.createElement('div');
        const br = document.createElement('br');
        div.appendChild(br);
        ensureBrPlaceholder(div);
        expect(div.childNodes.length).toBe(1);
        expect(div.firstChild).toBe(br);
    });

    it('does not modify a div with text content', () => {
        const div = document.createElement('div');
        const text = document.createTextNode('hello');
        div.appendChild(text);
        ensureBrPlaceholder(div);
        expect(div.childNodes.length).toBe(1);
        expect(div.firstChild).toBe(text);
    });

    it('does not modify a div with mixed content', () => {
        const div = document.createElement('div');
        div.appendChild(document.createTextNode('a'));
        div.appendChild(document.createElement('span'));
        ensureBrPlaceholder(div);
        expect(div.childNodes.length).toBe(2);
    });
});

// ================================================================
// setCursorAfter (Selection API — basic smoke test)
// ================================================================

describe('setCursorAfter', () => {
    it('sets a collapsed selection after the given node', () => {
        const root = document.createElement('div');
        const text = document.createTextNode('hello');
        const span = document.createElement('span');
        span.textContent = 'X';
        root.appendChild(text);
        root.appendChild(span);
        document.body.appendChild(root);

        setCursorAfter(span);

        const sel = window.getSelection();
        expect(sel?.rangeCount).toBeGreaterThan(0);
        const range = sel?.getRangeAt(0);
        expect(range?.collapsed).toBe(true);

        document.body.removeChild(root);
    });
});
