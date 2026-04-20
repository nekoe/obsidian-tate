// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { CursorAnchorManager } from './CursorAnchorManager';
import { createBoutenEl } from './domHelpers';

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

function isAnchorSpan(node: Node | null): boolean {
    return node instanceof HTMLElement && node.classList.contains('tate-cursor-anchor');
}

// Places the cursor inside the first text node of the given element.
function setCursorIn(el: HTMLElement, offset: number): void {
    const textNode = el.firstChild as Text;
    const sel = window.getSelection()!;
    const r = document.createRange();
    r.setStart(textNode, offset);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
}

// ================================================================
// ensureCursorAnchorAfter
// ================================================================

describe('ensureCursorAnchorAfter — inserts anchor', () => {
    let root: HTMLDivElement;
    let manager: CursorAnchorManager;

    beforeEach(() => {
        root = makeRoot();
        manager = new CursorAnchorManager(root);
    });

    it('inserts anchor when el is the last child (no next sibling)', () => {
        const para = makePara(root);
        const bouten = createBoutenEl('春');
        para.appendChild(bouten);

        manager.ensureCursorAnchorAfter(bouten);

        expect(para.childNodes.length).toBe(2);
        expect(isAnchorSpan(para.childNodes[1])).toBe(true);
    });

    it('inserted anchor contains U+200B', () => {
        const para = makePara(root);
        const bouten = createBoutenEl('春');
        para.appendChild(bouten);

        manager.ensureCursorAnchorAfter(bouten);

        const anchor = para.childNodes[1] as HTMLElement;
        expect(anchor.textContent).toBe('\u200B');
    });

    it('inserts anchor before a trailing <br> (the br is last child)', () => {
        const para = makePara(root);
        const bouten = createBoutenEl('春');
        const br = document.createElement('br');
        para.appendChild(bouten);
        para.appendChild(br);

        manager.ensureCursorAnchorAfter(bouten);

        // order: bouten → anchor → br
        expect(isAnchorSpan(para.childNodes[1])).toBe(true);
        expect(para.childNodes[2].nodeName).toBe('BR');
    });
});

describe('ensureCursorAnchorAfter — does not insert', () => {
    let root: HTMLDivElement;
    let manager: CursorAnchorManager;

    beforeEach(() => {
        root = makeRoot();
        manager = new CursorAnchorManager(root);
    });

    it('is idempotent when anchor already follows el', () => {
        const para = makePara(root);
        const bouten = createBoutenEl('春');
        para.appendChild(bouten);
        manager.ensureCursorAnchorAfter(bouten); // first call

        manager.ensureCursorAnchorAfter(bouten); // second call

        expect(para.childNodes.length).toBe(2); // no extra anchor
    });

    it('does not insert when a text node follows', () => {
        const para = makePara(root);
        const bouten = createBoutenEl('春');
        para.appendChild(bouten);
        para.appendChild(document.createTextNode('続き'));

        manager.ensureCursorAnchorAfter(bouten);

        expect(para.childNodes.length).toBe(2); // unchanged
        expect(para.childNodes[1].nodeType).toBe(Node.TEXT_NODE);
    });

    it('does not insert when a non-anchor element follows', () => {
        const para = makePara(root);
        const bouten = createBoutenEl('春');
        const nextBouten = createBoutenEl('夏');
        para.appendChild(bouten);
        para.appendChild(nextBouten);

        manager.ensureCursorAnchorAfter(bouten);

        expect(para.childNodes.length).toBe(2);
    });

    it('does not insert when <br> is followed by more content (not last child)', () => {
        const para = makePara(root);
        const bouten = createBoutenEl('春');
        const br = document.createElement('br');
        const afterBr = document.createTextNode('後');
        para.appendChild(bouten);
        para.appendChild(br);
        para.appendChild(afterBr);

        manager.ensureCursorAnchorAfter(bouten);

        expect(para.childNodes.length).toBe(3); // unchanged
    });
});

// ================================================================
// handleCursorAnchorInput
// ================================================================

describe('handleCursorAnchorInput — cursor not in anchor', () => {
    it('does nothing when cursor is in a plain text node', () => {
        const root = makeRoot();
        const manager = new CursorAnchorManager(root);
        const para = makePara(root);
        const text = document.createTextNode('hello');
        para.appendChild(text);

        const sel = window.getSelection()!;
        const r = document.createRange();
        r.setStart(text, 3);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);

        manager.handleCursorAnchorInput();

        expect(text.textContent).toBe('hello'); // unchanged
    });

    it('does nothing when there is no selection', () => {
        const root = makeRoot();
        const manager = new CursorAnchorManager(root);
        window.getSelection()!.removeAllRanges();
        // should not throw
        manager.handleCursorAnchorInput();
    });
});

describe('handleCursorAnchorInput — anchor is empty', () => {
    it('restores U+200B when anchor text is empty', () => {
        const root = makeRoot();
        const manager = new CursorAnchorManager(root);
        const para = makePara(root);
        const anchor = document.createElement('span');
        anchor.className = 'tate-cursor-anchor';
        const textNode = document.createTextNode('');
        anchor.appendChild(textNode);
        para.appendChild(anchor);

        setCursorIn(anchor, 0);
        manager.handleCursorAnchorInput();

        expect(anchor.textContent).toBe('\u200B');
    });

    it('places cursor at offset 0 of the restored U+200B node', () => {
        const root = makeRoot();
        const manager = new CursorAnchorManager(root);
        const para = makePara(root);
        const anchor = document.createElement('span');
        anchor.className = 'tate-cursor-anchor';
        anchor.appendChild(document.createTextNode(''));
        para.appendChild(anchor);

        setCursorIn(anchor, 0);
        manager.handleCursorAnchorInput();

        const sel = window.getSelection()!;
        const range = sel.getRangeAt(0);
        expect(range.startContainer).toBe(anchor.firstChild);
        expect(range.startOffset).toBe(0);
    });
});

describe('handleCursorAnchorInput — anchor has only U+200B', () => {
    it('does nothing when anchor contains only U+200B', () => {
        const root = makeRoot();
        const manager = new CursorAnchorManager(root);
        const para = makePara(root);
        const anchor = document.createElement('span');
        anchor.className = 'tate-cursor-anchor';
        anchor.appendChild(document.createTextNode('\u200B'));
        para.appendChild(anchor);

        setCursorIn(anchor, 0);
        manager.handleCursorAnchorInput();

        expect(anchor.textContent).toBe('\u200B'); // unchanged
    });
});

describe('handleCursorAnchorInput — U+200B mixed with real chars', () => {
    it('strips U+200B when real chars are present', () => {
        const root = makeRoot();
        const manager = new CursorAnchorManager(root);
        const para = makePara(root);
        const anchor = document.createElement('span');
        anchor.className = 'tate-cursor-anchor';
        // U+200B followed by a real char (simulates typing 'あ' after landing in anchor)
        anchor.appendChild(document.createTextNode('\u200Bあ'));
        para.appendChild(anchor);

        setCursorIn(anchor, 2); // after 'あ'
        manager.handleCursorAnchorInput();

        expect(anchor.textContent).toBe('あ');
    });

    it('adjusts cursor offset correctly after stripping U+200B before cursor', () => {
        const root = makeRoot();
        const manager = new CursorAnchorManager(root);
        const para = makePara(root);
        const anchor = document.createElement('span');
        anchor.className = 'tate-cursor-anchor';
        // '\u200Bあ' — cursor at offset 2 (after 'あ')
        anchor.appendChild(document.createTextNode('\u200Bあ'));
        para.appendChild(anchor);

        setCursorIn(anchor, 2);
        manager.handleCursorAnchorInput();

        const sel = window.getSelection()!;
        const range = sel.getRangeAt(0);
        // U+200B removed → visible offset 1 ('あ' is at index 0, cursor after it = 1)
        expect(range.startOffset).toBe(1);
    });

    it('adjusts cursor offset correctly when cursor is before U+200B', () => {
        const root = makeRoot();
        const manager = new CursorAnchorManager(root);
        const para = makePara(root);
        const anchor = document.createElement('span');
        anchor.className = 'tate-cursor-anchor';
        // 'あ\u200B' — cursor at offset 1 (between 'あ' and U+200B)
        anchor.appendChild(document.createTextNode('あ\u200B'));
        para.appendChild(anchor);

        setCursorIn(anchor, 1);
        manager.handleCursorAnchorInput();

        expect(anchor.textContent).toBe('あ');
        const sel = window.getSelection()!;
        expect(sel.getRangeAt(0).startOffset).toBe(1);
    });
});
