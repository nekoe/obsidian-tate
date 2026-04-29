import { App, Scope } from 'obsidian';
import type { EditorElement } from './EditorElement';
import { isInsideRtNode } from './domHelpers';

// ---- Visible text extraction ----

interface TextSegment {
    node: Text;
    start: number; // offset in visible text where this node begins
    length: number; // number of visible chars in this node (excluding U+200B)
}

interface VisibleText {
    text: string;
    segments: TextSegment[];
}

function extractVisibleText(editorEl: HTMLDivElement): VisibleText {
    const segments: TextSegment[] = [];
    let text = '';
    const walker = document.createTreeWalker(editorEl, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode() as Text | null;
    while (node) {
        if (!isInsideRtNode(node, editorEl)) {
            // Strip U+200B (cursor anchor placeholders) from visible text
            const visible = (node.textContent ?? '').replace(/\u200B/g, '');
            if (visible.length > 0) {
                segments.push({ node, start: text.length, length: visible.length });
                text += visible;
            }
        }
        node = walker.nextNode() as Text | null;
    }
    return { text, segments };
}

// ---- Range building ----

function createRangeForMatch(
    segments: TextSegment[],
    matchStart: number,
    matchEnd: number,
): Range | null {
    let startNode: Text | null = null;
    let startOffset = 0;
    let endNode: Text | null = null;
    let endOffset = 0;

    for (const seg of segments) {
        const segEnd = seg.start + seg.length;
        if (startNode === null && matchStart < segEnd) {
            startNode = seg.node;
            startOffset = visibleToRawOffset(seg.node, matchStart - seg.start);
        }
        if (endNode === null && matchEnd <= segEnd) {
            endNode = seg.node;
            endOffset = visibleToRawOffset(seg.node, matchEnd - seg.start);
            break;
        }
    }
    if (!startNode || !endNode) return null;
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
}

// Maps a visible character offset (excluding U+200B) to the raw text node offset.
function visibleToRawOffset(node: Text, visibleOffset: number): number {
    const text = node.textContent ?? '';
    let visible = 0;
    for (let i = 0; i < text.length; i++) {
        if (visible === visibleOffset) return i;
        if (text[i] !== '\u200B') visible++;
    }
    return text.length;
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- SearchPanel ----

export class SearchPanel {
    private panelEl: HTMLElement | null = null;
    private inputEl: HTMLInputElement | null = null;
    private countEl: HTMLElement | null = null;

    private readonly searchScope: Scope;

    private matches: Range[] = [];
    // Visible-text start offset for each match (parallel to matches[]).
    // Used by findFirstIndexAtOrAfter() to seed the initial focus from prSearchOffset.
    private matchStarts: number[] = [];
    private currentIndex = -1;
    // Cursor offset (visible) when the panel was opened; restored if no navigation occurred.
    private prSearchOffset: number | null = null;
    // Offset of the last navigated hit; used as the restore target after close.
    private lastNavigatedOffset: number | null = null;
    // True while the editor has focus due to a user click (not a programmatic setFocus call).
    // When true: tate-search-focus is hidden, and close() skips cursor restore.
    private editorFocused = false;

    constructor(
        private readonly editorElementRef: EditorElement,
        private readonly container: HTMLElement,
        private readonly app: App,
    ) {
        this.searchScope = new Scope(app.scope);

        // When the user clicks the editor, remove the focus highlight and mark that
        // the editor has focus so close() does not restore the cursor over the click position.
        editorElementRef.el.addEventListener('mousedown', () => {
            if (!this.isOpen) return;
            this.editorFocused = true;
            this.clearFocusHighlight();
        });

        this.searchScope.register([], 'Enter', (evt) => {
            if (evt.isComposing) return;
            this.navigate(1);
            return false;
        });
        this.searchScope.register(['Shift'], 'Enter', (evt) => {
            if (evt.isComposing) return;
            this.navigate(-1);
            return false;
        });
        this.searchScope.register([], 'Escape', (evt) => {
            if (evt.isComposing) return;
            this.close();
            return false; // suppress Obsidian's global ESC handler
        });
    }

    get isOpen(): boolean {
        return this.panelEl !== null;
    }

    open(initialOffset: number): void {
        if (this.isOpen) {
            this.inputEl?.focus();
            return;
        }

        this.prSearchOffset = initialOffset;
        this.lastNavigatedOffset = null;
        this.editorFocused = false;
        this.matches = [];
        this.matchStarts = [];
        this.currentIndex = -1;
        this.buildPanel();
        this.app.keymap.pushScope(this.searchScope);
        this.inputEl?.focus();
    }

    close(): number | null {
        if (!this.isOpen) return null;

        this.app.keymap.popScope(this.searchScope);
        this.clearHighlights();

        this.panelEl?.remove();
        this.panelEl = null;
        this.inputEl = null;
        this.countEl = null;
        this.matches = [];
        this.currentIndex = -1;

        const wasEditorFocused = this.editorFocused;
        const restoreOffset = wasEditorFocused ? null : (this.lastNavigatedOffset ?? this.prSearchOffset);
        this.prSearchOffset = null;
        this.lastNavigatedOffset = null;
        this.editorFocused = false;
        this.matchStarts = [];

        // Restore cursor and give focus back to the editor.  This must happen inside
        // close() rather than in the caller because ESC and the × button call close()
        // directly — their return value is never used.
        // If the user clicked the editor before closing, skip cursor restore: the cursor
        // is already at the click position and the editor already has focus.
        if (!wasEditorFocused) {
            if (restoreOffset !== null) {
                this.editorElementRef.setViewCursorOffset(restoreOffset);
            }
            this.editorElementRef.el.focus();
        }

        return restoreOffset; // returned so view.ts can update lastKnownViewOffset
    }

    onContentChanged(): void {
        if (!this.isOpen) return;
        this.runSearch(false); // update highlights only; no scroll while user is editing
    }

    private buildPanel(): void {
        const panel = document.createElement('div');
        panel.className = 'tate-search-panel';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'tate-search-input';
        input.setAttribute('placeholder', '検索');
        input.addEventListener('input', (e) => {
            if ((e as InputEvent).isComposing) return;
            this.runSearch();
        });
        // Run search after IME composition is committed (compositionend fires before the
        // subsequent input event in Chromium, so this is the reliable trigger point).
        input.addEventListener('compositionend', () => this.runSearch());
        // Prevent panel input events from bubbling into the editor's keydown handler
        input.addEventListener('keydown', (e) => {
            // Allow the scope to handle Enter/Escape; block other keys from reaching the editor
            if (e.key !== 'Enter' && e.key !== 'Escape') e.stopPropagation();
        });
        this.inputEl = input;

        const count = document.createElement('span');
        count.className = 'tate-search-count';
        count.textContent = '';
        this.countEl = count;

        const nextBtn = document.createElement('button');
        nextBtn.className = 'tate-search-btn';
        nextBtn.setAttribute('aria-label', '次へ');
        nextBtn.textContent = '↓';
        nextBtn.addEventListener('click', () => this.navigate(1));

        const prevBtn = document.createElement('button');
        prevBtn.className = 'tate-search-btn';
        prevBtn.setAttribute('aria-label', '前へ');
        prevBtn.textContent = '↑';
        prevBtn.addEventListener('click', () => this.navigate(-1));

        const closeBtn = document.createElement('button');
        closeBtn.className = 'tate-search-btn';
        closeBtn.setAttribute('aria-label', '閉じる');
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', () => this.close());

        panel.append(input, count, nextBtn, prevBtn, closeBtn);
        // Append to the tate-container so Obsidian's cleanup manages this DOM.
        // position:absolute with top/right anchors to the container's visible edge,
        // which stays fixed even during horizontal scroll of the editor content.
        this.container.appendChild(panel);
        this.panelEl = panel;
    }

    private runSearch(scroll = true): void {
        const query = this.inputEl?.value ?? '';
        this.clearHighlights();
        const prevIndex = this.currentIndex;
        this.matches = [];
        this.matchStarts = [];
        this.currentIndex = -1;

        if (!query) {
            this.updateCount();
            return;
        }

        const editorEl = this.editorElementRef.el;
        const { text, segments } = extractVisibleText(editorEl);
        const re = new RegExp(escapeRegex(query), 'gi');
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
            const range = createRangeForMatch(segments, m.index, m.index + m[0].length);
            if (range) {
                this.matches.push(range);
                this.matchStarts.push(m.index);
            }
            if (m[0].length === 0) re.lastIndex++;
        }

        if (this.matches.length === 0) {
            this.updateCount();
            return;
        }
        this.applyHitHighlights();

        // Re-search (user keeps typing): stay on the same index if still valid.
        // First search: focus the nearest hit at or after the cursor position.
        if (prevIndex >= 0 && prevIndex < this.matches.length) {
            this.setFocus(prevIndex, scroll);
        } else {
            this.setFocus(this.findFirstIndexAtOrAfter(this.prSearchOffset ?? 0), scroll);
        }
    }

    // Returns the index of the first match whose visible-text start is >= offset.
    // Wraps to 0 if no match is at or after offset (cursor is past all matches).
    private findFirstIndexAtOrAfter(offset: number): number {
        for (let i = 0; i < this.matchStarts.length; i++) {
            if (this.matchStarts[i] >= offset) return i;
        }
        return 0;
    }

    private navigate(delta: 1 | -1): void {
        if (this.matches.length === 0) return;
        const next = (this.currentIndex + delta + this.matches.length) % this.matches.length;
        this.setFocus(next, true);
    }

    // scroll=true: move the DOM cursor to the hit, update lastNavigatedOffset, restore
    //              focus to the input, and scroll the hit into view.
    // scroll=false: update highlight and count only (called from onContentChanged).
    private setFocus(index: number, scroll: boolean): void {
        this.currentIndex = index;
        this.updateCount();
        this.applyFocusHighlight();

        const range = this.matches[index];
        if (!range || !scroll) return;

        // Typing or navigation is restoring control to the search input; clear the flag
        // so the focus highlight is shown again and close() will restore the cursor.
        this.editorFocused = false;

        // Place the editor cursor at the start of the focused match.
        // sel.addRange() on a contenteditable node steals browser focus.
        const sel = window.getSelection();
        if (sel) {
            const cursorRange = document.createRange();
            cursorRange.setStart(range.startContainer, range.startOffset);
            cursorRange.collapse(true);
            sel.removeAllRanges();
            sel.addRange(cursorRange);
        }
        // Update last navigated offset so ESC restores here.
        this.lastNavigatedOffset = this.editorElementRef.getViewCursorOffset();
        // sel.addRange() stole focus from the search input; give it back.
        this.inputEl?.focus();
        this.scrollRangeIntoView(range);
    }

    private scrollRangeIntoView(range: Range): void {
        this.editorElementRef.scrollToRange(range);
        // After a compositor-thread scroll, content-visibility:auto paragraphs that just
        // entered the viewport may be composited before the CSS Custom Highlight registry
        // reaches the main-thread paint record, leaving highlights absent until the next
        // pointer event triggers a main-thread repaint.
        // Changing outline-style (none→solid) is a paint-record mutation that Chrome
        // cannot optimize away, so it forces a main-thread repaint that includes the
        // current CSS Custom Highlights. The outline is transparent and removed in the
        // next rAF, so it is never visible to the user.
        requestAnimationFrame(() => {
            this.editorElementRef.el.classList.add('tate-search-repaint');
            this.applyHitHighlights();
            this.applyFocusHighlight();
            requestAnimationFrame(() => {
                this.editorElementRef.el.classList.remove('tate-search-repaint');
            });
        });
    }

    private applyHitHighlights(): void {
        if (typeof CSS === 'undefined' || !CSS.highlights) return;
        CSS.highlights.set('tate-search-hit', new Highlight(...this.matches));
    }

    private applyFocusHighlight(): void {
        if (typeof CSS === 'undefined' || !CSS.highlights) return;
        if (this.editorFocused) return;
        const focused = this.matches[this.currentIndex];
        if (focused) {
            const h = new Highlight(focused);
            // Must be higher than tate-search-hit (default 0) so the focused style wins
            // when the same range is present in both highlight sets.
            h.priority = 1;
            CSS.highlights.set('tate-search-focus', h);
        } else {
            CSS.highlights.delete('tate-search-focus');
        }
    }

    private clearFocusHighlight(): void {
        if (typeof CSS === 'undefined' || !CSS.highlights) return;
        CSS.highlights.delete('tate-search-focus');
    }

    private clearHighlights(): void {
        if (typeof CSS === 'undefined' || !CSS.highlights) return;
        CSS.highlights.delete('tate-search-hit');
        CSS.highlights.delete('tate-search-focus');
    }

    private updateCount(): void {
        if (!this.countEl) return;
        if (this.matches.length === 0) {
            const hasQuery = !!(this.inputEl?.value);
            this.countEl.textContent = hasQuery ? 'No results' : '';
            this.countEl.classList.toggle('tate-search-no-match', hasQuery);
        } else {
            this.countEl.textContent = `${this.currentIndex + 1}/${this.matches.length}`;
            this.countEl.classList.remove('tate-search-no-match');
        }
    }
}
