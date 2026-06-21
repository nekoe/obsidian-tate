// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import {
    createRubyEl, createTcyEl, createBoutenEl, createCursorAnchor,
    insertAnnotationElement, setCursorAfter,
    findAncestor, findBoutenAncestor, findTcyAncestor, isInsideRuby,
    findCursorAnchorAncestor, findLastBaseTextInElement,
    rawOffsetForExpand, getExtraCharsFromAnnotation, countVsViewChars, orderVsEndpoints,
    isEffectivelyEmpty, clearChildren, ensureBrPlaceholder, removeEmptyAnnotationShells,
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

    it('data-rt attribute contains ruby text', () => {
        const el = createRubyEl('東京', 'とうきょう', true);
        expect(el.getAttribute('data-rt')).toBe('とうきょう');
    });

    it('allows empty data-rt', () => {
        const el = createRubyEl('東京', '', true);
        expect(el.getAttribute('data-rt')).toBe('');
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

    it('returns last text node in element containing ruby', () => {
        const root = document.createElement('div');
        const div = document.createElement('div');
        const text = document.createTextNode('前');
        const ruby = createRubyEl('東', 'ひがし', true);
        div.appendChild(text);
        div.appendChild(ruby);
        root.appendChild(div);
        // ruby: [text('東')] — single base text node, no <rt>
        // Last text node is the base text '東' inside ruby
        const result = findLastBaseTextInElement(div, root);
        expect(result?.node.nodeType).toBe(Node.TEXT_NODE);
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

describe('countVsViewChars', () => {
    // Paragraph viewLens: para0=10, para1=20, para2=30, para3=40
    const viewLens = [10, 20, 30, 40];
    const getViewLen = (i: number) => viewLens[i];

    it('single paragraph: difference of offsets', () => {
        expect(countVsViewChars(1, 3, 1, 8, getViewLen)).toBe(5);
    });

    it('single paragraph with reversed offsets is normalized', () => {
        expect(countVsViewChars(1, 8, 1, 3, getViewLen)).toBe(5);
    });

    it('single paragraph empty range returns 0', () => {
        expect(countVsViewChars(2, 7, 2, 7, getViewLen)).toBe(0);
    });

    it('two adjacent paragraphs: tail of first + head of second', () => {
        // para1 tail: 20 - 3 = 17, para2 head: 4 → 21
        expect(countVsViewChars(1, 3, 2, 4, getViewLen)).toBe(21);
    });

    it('counts intermediate paragraphs in full', () => {
        // para0 tail: 10 - 2 = 8, para1: 20, para2: 30, para3 head: 5 → 63
        expect(countVsViewChars(0, 2, 3, 5, getViewLen)).toBe(63);
    });

    it('boundary offsets cover whole first and last paragraphs', () => {
        // startOff 0 and endOff === viewLen → both paragraphs counted in full
        expect(countVsViewChars(0, 0, 1, 20, getViewLen)).toBe(30);
    });

    it('selection covering only the paragraph break counts 0', () => {
        // From end of para0 to start of para1: no visible chars
        expect(countVsViewChars(0, 10, 1, 0, getViewLen)).toBe(0);
    });
});

describe('orderVsEndpoints', () => {
    it('keeps anchor-first order when anchor precedes focus across paragraphs', () => {
        expect(orderVsEndpoints(0, 3, 2, 5)).toEqual([0, 3, 2, 5]);
    });

    it('swaps when focus precedes anchor across paragraphs', () => {
        expect(orderVsEndpoints(2, 5, 0, 3)).toEqual([0, 3, 2, 5]);
    });

    it('orders by offset within the same paragraph (anchor before focus)', () => {
        expect(orderVsEndpoints(1, 2, 1, 7)).toEqual([1, 2, 1, 7]);
    });

    it('swaps within the same paragraph when focus offset precedes anchor offset', () => {
        // Regression: Shift+Cmd+Up selects from the caret back to paragraph start (focusOff=0).
        // Without offset ordering this returned [1, 6, 1, 0], an inverted range that broke
        // copy/cut/delete via sliceAozoraSrcByView.
        expect(orderVsEndpoints(1, 6, 1, 0)).toEqual([1, 0, 1, 6]);
    });

    it('is stable for a collapsed same-position selection', () => {
        expect(orderVsEndpoints(3, 4, 3, 4)).toEqual([3, 4, 3, 4]);
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
// removeEmptyAnnotationShells
// ================================================================

describe('removeEmptyAnnotationShells', () => {
    it('removes an empty ruby shell (no children)', () => {
        const div = document.createElement('div');
        const ruby = document.createElement('ruby');
        ruby.setAttribute('data-rt', 'さいばんかん');
        ruby.setAttribute('data-ruby-explicit', 'false');
        div.appendChild(ruby);
        removeEmptyAnnotationShells(div);
        expect(div.querySelector('ruby')).toBeNull();
    });

    it('removes a ruby shell with only empty text nodes', () => {
        const div = document.createElement('div');
        const ruby = document.createElement('ruby');
        ruby.setAttribute('data-rt', 'よみ');
        ruby.appendChild(document.createTextNode(''));
        div.appendChild(ruby);
        removeEmptyAnnotationShells(div);
        expect(div.querySelector('ruby')).toBeNull();
    });

    it('keeps a ruby element that has base text', () => {
        const div = document.createElement('div');
        const ruby = document.createElement('ruby');
        ruby.setAttribute('data-rt', 'よみ');
        ruby.appendChild(document.createTextNode('漢字'));
        div.appendChild(ruby);
        removeEmptyAnnotationShells(div);
        expect(div.querySelector('ruby')).not.toBeNull();
    });

    it('removes an empty bouten span', () => {
        const div = document.createElement('div');
        const span = document.createElement('span');
        span.setAttribute('data-bouten', 'sesame');
        span.className = 'bouten';
        div.appendChild(span);
        removeEmptyAnnotationShells(div);
        expect(div.querySelector('[data-bouten]')).toBeNull();
    });

    it('keeps a bouten span that has text', () => {
        const div = document.createElement('div');
        const span = document.createElement('span');
        span.setAttribute('data-bouten', 'sesame');
        span.className = 'bouten';
        span.textContent = '春';
        div.appendChild(span);
        removeEmptyAnnotationShells(div);
        expect(div.querySelector('[data-bouten]')).not.toBeNull();
    });

    it('removes an empty tcy span', () => {
        const div = document.createElement('div');
        const span = document.createElement('span');
        span.setAttribute('data-tcy', 'explicit');
        span.className = 'tcy';
        div.appendChild(span);
        removeEmptyAnnotationShells(div);
        expect(div.querySelector('[data-tcy]')).toBeNull();
    });

    it('removes an empty heading span', () => {
        const div = document.createElement('div');
        const span = document.createElement('span');
        span.setAttribute('data-heading', 'large');
        span.className = 'tate-heading tate-heading-large';
        div.appendChild(span);
        removeEmptyAnnotationShells(div);
        expect(div.querySelector('[data-heading]')).toBeNull();
    });

    it('is a no-op when div has no annotation elements', () => {
        const div = document.createElement('div');
        div.appendChild(document.createTextNode('こんにちは'));
        removeEmptyAnnotationShells(div);
        expect(div.textContent).toBe('こんにちは');
    });

    it('only removes empty shells, leaves non-empty ones intact', () => {
        const div = document.createElement('div');
        const ruby1 = document.createElement('ruby');
        ruby1.setAttribute('data-rt', 'あき');
        div.appendChild(ruby1); // empty — should be removed

        const ruby2 = document.createElement('ruby');
        ruby2.setAttribute('data-rt', 'はる');
        ruby2.appendChild(document.createTextNode('春'));
        div.appendChild(ruby2); // non-empty — should stay

        removeEmptyAnnotationShells(div);
        const rubies = div.querySelectorAll('ruby');
        expect(rubies.length).toBe(1);
        expect(rubies[0].getAttribute('data-rt')).toBe('はる');
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
