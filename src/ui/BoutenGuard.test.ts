// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { BoutenGuard } from './BoutenGuard';
import { createBoutenEl, createCursorAnchor } from './domHelpers';

// Build a minimal DOM: <div>(root) > <div>(para) > children...
function makeRoot(): HTMLDivElement {
    const root = document.createElement('div');
    document.body.appendChild(root);
    return root;
}

// ================================================================
// set / get / clear
// ================================================================

describe('BoutenGuard state (set/get/clear)', () => {
    it('get returns null initially', () => {
        const el = document.createElement('div');
        const guard = new BoutenGuard(el);
        expect(guard.get()).toBeNull();
    });

    it('get returns value after set', () => {
        const el = document.createElement('div');
        const guard = new BoutenGuard(el);
        const bouten = createBoutenEl('春');
        guard.set(bouten, '春');
        const result = guard.get();
        expect(result?.el).toBe(bouten);
        expect(result?.originalText).toBe('春');
    });

    it('get returns null after clear', () => {
        const el = document.createElement('div');
        const guard = new BoutenGuard(el);
        const bouten = createBoutenEl('春');
        guard.set(bouten, '春');
        guard.clear();
        expect(guard.get()).toBeNull();
    });
});

// ================================================================
// insertAfterBouten — DOM structure tests
// ================================================================

describe('insertAfterBouten', () => {
    let root: HTMLDivElement;
    let guard: BoutenGuard;
    let para: HTMLDivElement;

    beforeEach(() => {
        root = makeRoot();
        guard = new BoutenGuard(root);
        para = document.createElement('div');
        root.appendChild(para);
    });

    it('creates new text node between bouten and cursor anchor (end-of-line case)', () => {
        const bouten = createBoutenEl('春');
        const anchor = createCursorAnchor();
        para.appendChild(bouten);
        para.appendChild(anchor);

        guard.insertAfterBouten(bouten, 'あ');

        // Structure should be: bouten | 'あ' | anchor
        expect(para.childNodes.length).toBe(3);
        expect(para.childNodes[0]).toBe(bouten);
        expect((para.childNodes[1] as Text).data).toBe('あ');
        expect(para.childNodes[2]).toBe(anchor);
    });

    it('prepends to existing text node (mid-line case)', () => {
        const bouten = createBoutenEl('春');
        const text = document.createTextNode('続き');
        para.appendChild(bouten);
        para.appendChild(text);

        guard.insertAfterBouten(bouten, 'あ');

        // Text node now has 'あ' prepended
        expect(para.childNodes.length).toBe(2);
        expect((para.childNodes[1] as Text).data).toBe('あ続き');
    });

    it('creates new text node at end when no next sibling', () => {
        const bouten = createBoutenEl('春');
        para.appendChild(bouten);

        guard.insertAfterBouten(bouten, 'あ');

        expect(para.childNodes.length).toBe(2);
        expect(para.childNodes[0]).toBe(bouten);
        expect((para.childNodes[1] as Text).data).toBe('あ');
    });

    it('clears boutenJustCollapsed after insertion', () => {
        const bouten = createBoutenEl('春');
        para.appendChild(bouten);
        guard.set(bouten, '春');

        guard.insertAfterBouten(bouten, 'あ');

        expect(guard.get()).toBeNull();
    });
});

// ================================================================
// handleBoutenPostCollapseInput
// ================================================================

describe('handleBoutenPostCollapseInput', () => {
    let root: HTMLDivElement;
    let guard: BoutenGuard;
    let para: HTMLDivElement;

    beforeEach(() => {
        root = makeRoot();
        guard = new BoutenGuard(root);
        para = document.createElement('div');
        root.appendChild(para);
    });

    it('returns false immediately when guard is not set', () => {
        expect(guard.handleBoutenPostCollapseInput()).toBe(false);
    });

    it('returns false and clears guard when bouten is detached', () => {
        const bouten = createBoutenEl('春');
        // Do NOT attach bouten to DOM
        guard.set(bouten, '春');
        expect(guard.handleBoutenPostCollapseInput()).toBe(false);
        expect(guard.get()).toBeNull();
    });

    it('returns false when text has not changed', () => {
        const bouten = createBoutenEl('春');
        para.appendChild(bouten);
        guard.set(bouten, '春');
        expect(guard.handleBoutenPostCollapseInput()).toBe(false);
        // Guard remains set
        expect(guard.get()).not.toBeNull();
    });

    it('moves extra chars after bouten and returns true (end-of-line)', () => {
        const bouten = createBoutenEl('春');
        const anchor = createCursorAnchor();
        para.appendChild(bouten);
        para.appendChild(anchor);
        guard.set(bouten, '春');

        // Simulate IME appending text inside the bouten span
        bouten.textContent = '春あ';

        const result = guard.handleBoutenPostCollapseInput();

        expect(result).toBe(true);
        expect(bouten.textContent).toBe('春');
        // Extra char 'あ' is now a text node between bouten and anchor
        expect((para.childNodes[1] as Text).data).toBe('あ');
        expect(para.childNodes[2]).toBe(anchor);
    });

    it('moves extra chars after bouten and returns true (mid-line)', () => {
        const bouten = createBoutenEl('春');
        const text = document.createTextNode('続き');
        para.appendChild(bouten);
        para.appendChild(text);
        guard.set(bouten, '春');

        bouten.textContent = '春い';

        const result = guard.handleBoutenPostCollapseInput();

        expect(result).toBe(true);
        expect(bouten.textContent).toBe('春');
        // 'い' is prepended to the text node
        expect((para.childNodes[1] as Text).data).toBe('い続き');
    });

    it('returns false and clears guard when content does not start with originalText', () => {
        const bouten = createBoutenEl('春');
        para.appendChild(bouten);
        guard.set(bouten, '春');

        // Unexpected: content replaced entirely
        bouten.textContent = '夏';

        const result = guard.handleBoutenPostCollapseInput();

        expect(result).toBe(false);
        expect(guard.get()).toBeNull();
    });
});

// ================================================================
// getCursorBoutenSpan — guard flag tests (cursor-independent)
// ================================================================

describe('getCursorBoutenSpan guard flags', () => {
    it('returns null when guard is not set', () => {
        const el = document.createElement('div');
        const guard = new BoutenGuard(el);
        expect(guard.getCursorBoutenSpan(true, null)).toBeNull();
    });

    it('returns null when expandBouten is false', () => {
        const el = document.createElement('div');
        const guard = new BoutenGuard(el);
        const bouten = createBoutenEl('春');
        el.appendChild(bouten);
        guard.set(bouten, '春');
        expect(guard.getCursorBoutenSpan(false, null)).toBeNull();
    });

    it('returns null when expandedEl is set (another element already expanded)', () => {
        const el = document.createElement('div');
        const guard = new BoutenGuard(el);
        const bouten = createBoutenEl('春');
        el.appendChild(bouten);
        guard.set(bouten, '春');
        const fakeExpanded = document.createElement('span') as HTMLSpanElement;
        expect(guard.getCursorBoutenSpan(true, fakeExpanded)).toBeNull();
    });

    it('returns null and clears guard when bouten is detached', () => {
        const el = document.createElement('div');
        const guard = new BoutenGuard(el);
        const bouten = createBoutenEl('春');
        // Do NOT attach to DOM
        guard.set(bouten, '春');
        const result = guard.getCursorBoutenSpan(true, null);
        expect(result).toBeNull();
        expect(guard.get()).toBeNull();
    });
});
