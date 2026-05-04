import { App, Scope } from 'obsidian';
import type { EditorElement } from './EditorElement';
import type { ParagraphVirtualizer } from './ParagraphVirtualizer';
import { isInsideRtNode } from './domHelpers';

// ---- Match entry types ----

interface ThawedMatchEntry {
    kind: 'thawed';
    range: Range;
    viewStart: number; // visible-text offset of match start in combined text
}

interface FrozenMatchEntry {
    kind: 'frozen';
    div: HTMLElement;
    localStart: number; // visible offset within this paragraph
    localEnd: number;
    viewStart: number; // visible-text offset in combined text
}

type MatchEntry = ThawedMatchEntry | FrozenMatchEntry;

// ---- Text extraction helpers ----

interface LocalSegment {
    node: Text;
    start: number; // local visible offset within this paragraph
    length: number;
}

interface ParagraphTextData {
    div: HTMLElement;
    frozen: boolean;
    globalStart: number; // where this paragraph's visible text starts in the combined string
    text: string;        // visible text for this paragraph
    segments: LocalSegment[]; // populated for thawed divs; empty for frozen
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

// Extracts text segments from a single thawed paragraph div.
function extractSegmentsFromDiv(div: HTMLElement, editorEl: HTMLElement): LocalSegment[] {
    const segments: LocalSegment[] = [];
    let localOffset = 0;
    const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode() as Text | null;
    while (node) {
        if (!isInsideRtNode(node, editorEl)) {
            const visible = (node.textContent ?? '').replace(/\u200B/g, '');
            if (visible.length > 0) {
                segments.push({ node, start: localOffset, length: visible.length });
                localOffset += visible.length;
            }
        }
        node = walker.nextNode() as Text | null;
    }
    return segments;
}

// Builds per-paragraph text data without thawing frozen divs.
// Frozen divs are represented by their data-src visible text via virtualizer.
function extractHybridText(
    editorEl: HTMLDivElement,
    virtualizer?: ParagraphVirtualizer,
): { text: string; paragraphs: ParagraphTextData[] } {
    const paragraphs: ParagraphTextData[] = [];
    let globalOffset = 0;

    for (const child of Array.from(editorEl.children)) {
        if (!(child instanceof HTMLElement)) continue;
        if (virtualizer?.isFrozen(child)) {
            const src = child.getAttribute('data-src') ?? '';
            const text = virtualizer.buildParagraphVisibleText(src);
            paragraphs.push({ div: child, frozen: true, globalStart: globalOffset, text, segments: [] });
            globalOffset += text.length;
        } else {
            const segments = extractSegmentsFromDiv(child, editorEl);
            const text = segments.map(s => (s.node.textContent ?? '').replace(/\u200B/g, '')).join('');
            paragraphs.push({ div: child, frozen: false, globalStart: globalOffset, text, segments });
            globalOffset += text.length;
        }
    }

    return { text: paragraphs.map(p => p.text).join(''), paragraphs };
}

// Creates a DOM Range for a match within a single thawed paragraph.
function createRangeInParagraph(
    segments: LocalSegment[],
    localStart: number,
    localEnd: number,
): Range | null {
    let startNode: Text | null = null;
    let startOffset = 0;
    let endNode: Text | null = null;
    let endOffset = 0;

    for (const seg of segments) {
        const segEnd = seg.start + seg.length;
        if (startNode === null && localStart < segEnd) {
            startNode = seg.node;
            startOffset = visibleToRawOffset(seg.node, localStart - seg.start);
        }
        if (endNode === null && localEnd <= segEnd) {
            endNode = seg.node;
            endOffset = visibleToRawOffset(seg.node, localEnd - seg.start);
            break;
        }
    }
    if (!startNode || !endNode) return null;
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
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

    private matchEntries: MatchEntry[] = [];
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
        private readonly virtualizer?: ParagraphVirtualizer,
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
            if (this.editorFocused) return; // pass through to editor
            this.navigate(1);
            return false;
        });
        this.searchScope.register(['Shift'], 'Enter', (evt) => {
            if (evt.isComposing) return;
            if (this.editorFocused) return; // pass through to editor
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
        this.matchEntries = [];
        this.currentIndex = -1;
        // Suppress freeze while the panel is open so DOM ranges remain valid.
        // No thawAll() needed: frozen divs are searched via data-src without thawing.
        this.virtualizer?.suppressFreeze(true);
        this.buildPanel();
        this.app.keymap.pushScope(this.searchScope);
        this.inputEl?.focus();
    }

    close(): number | null {
        if (!this.isOpen) return null;

        this.app.keymap.popScope(this.searchScope);
        this.clearHighlights();
        // Re-enable freezing after closing (IntersectionObserver will gradually freeze off-screen divs).
        this.virtualizer?.suppressFreeze(false);

        this.panelEl?.remove();
        this.panelEl = null;
        this.inputEl = null;
        this.countEl = null;
        this.matchEntries = [];
        this.currentIndex = -1;

        const wasEditorFocused = this.editorFocused;
        const restoreOffset = wasEditorFocused ? null : (this.lastNavigatedOffset ?? this.prSearchOffset);
        this.prSearchOffset = null;
        this.lastNavigatedOffset = null;
        this.editorFocused = false;

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
        input.addEventListener('focus', () => {
            if (this.editorFocused) {
                // User clicked the editor then returned to the input.
                // Capture the click position so ESC restores to it, not to the last search hit.
                // window.getSelection() retains the editor selection even after focus moves to
                // a text <input>, so getViewCursorOffset() is valid here.
                this.lastNavigatedOffset = this.editorElementRef.getViewCursorOffset();
            }
            this.editorFocused = false;
        });
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
        this.matchEntries = [];
        this.currentIndex = -1;

        if (!query) {
            this.updateCount();
            return;
        }

        // Build combined visible text without thawing frozen divs.
        // Frozen divs contribute their visible text via buildParagraphVisibleText(data-src).
        const editorEl = this.editorElementRef.el;
        const { text, paragraphs } = extractHybridText(editorEl, this.virtualizer);
        const re = new RegExp(escapeRegex(query), 'gi');
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
            const matchStart = m.index;
            const matchEnd = m.index + m[0].length;

            // Find the paragraph containing the match start.
            let para: ParagraphTextData | undefined;
            for (const p of paragraphs) {
                if (matchStart >= p.globalStart && matchStart < p.globalStart + p.text.length) {
                    para = p;
                    break;
                }
            }
            if (!para) { if (m[0].length === 0) re.lastIndex++; continue; }

            // Skip matches that span paragraph boundaries — they cannot be represented
            // as a single Range (cross-paragraph Ranges are impractical with frozen divs).
            if (matchEnd > para.globalStart + para.text.length) {
                if (m[0].length === 0) re.lastIndex++;
                continue;
            }

            const localStart = matchStart - para.globalStart;
            const localEnd = matchEnd - para.globalStart;

            if (para.frozen) {
                // Frozen div: store div + local offsets; thaw on demand when navigated to.
                this.matchEntries.push({ kind: 'frozen', div: para.div, localStart, localEnd, viewStart: matchStart });
            } else {
                const range = createRangeInParagraph(para.segments, localStart, localEnd);
                if (range) {
                    this.matchEntries.push({ kind: 'thawed', range, viewStart: matchStart });
                }
            }

            if (m[0].length === 0) re.lastIndex++;
        }

        if (this.matchEntries.length === 0) {
            this.updateCount();
            return;
        }
        this.applyHitHighlights();

        // Re-search (user keeps typing): stay on the same index if still valid.
        // First search: focus the nearest hit at or after the cursor position.
        if (prevIndex >= 0 && prevIndex < this.matchEntries.length) {
            this.setFocus(prevIndex, scroll);
        } else {
            this.setFocus(this.findFirstIndexAtOrAfter(this.prSearchOffset ?? 0), scroll);
        }
    }

    // Returns the index of the first match whose viewStart is >= offset.
    // Wraps to 0 if no match is at or after offset (cursor is past all matches).
    private findFirstIndexAtOrAfter(offset: number): number {
        for (let i = 0; i < this.matchEntries.length; i++) {
            if (this.matchEntries[i].viewStart >= offset) return i;
        }
        return 0;
    }

    private navigate(delta: 1 | -1): void {
        if (this.matchEntries.length === 0) return;
        const next = (this.currentIndex + delta + this.matchEntries.length) % this.matchEntries.length;
        this.setFocus(next, true);
    }

    // scroll=true: thaw frozen match on demand, move the DOM cursor to the hit,
    //              update lastNavigatedOffset, restore focus to the input, and scroll into view.
    // scroll=false: update highlight and count only (called from onContentChanged).
    private setFocus(index: number, scroll: boolean): void {
        this.currentIndex = index;
        this.updateCount();
        this.applyFocusHighlight();

        const entry = this.matchEntries[index];
        if (!entry || !scroll) return;

        // Typing or navigation is restoring control to the search input; clear the flag
        // so the focus highlight is shown again and close() will restore the cursor.
        this.editorFocused = false;

        // Resolve the range: thaw frozen div on demand when the user navigates to it.
        let range: Range;
        if (entry.kind === 'thawed') {
            range = entry.range;
        } else {
            this.virtualizer?.thawDiv(entry.div);
            const segments = extractSegmentsFromDiv(entry.div, this.editorElementRef.el);
            const r = createRangeInParagraph(segments, entry.localStart, entry.localEnd);
            if (!r) return;
            range = r;
            // Upgrade entry to thawed so subsequent navigation and highlighting use the live Range.
            this.matchEntries[index] = { kind: 'thawed', range, viewStart: entry.viewStart };
            this.applyFocusHighlight();
        }

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

    // Upgrades FrozenMatchEntries whose divs have since been thawed by the IntersectionObserver.
    // Called in the scrollRangeIntoView rAF callback so hits on divs that entered the viewport
    // after navigation are included in the next highlight paint.
    private updateFrozenToThawedEntries(): void {
        for (let i = 0; i < this.matchEntries.length; i++) {
            const entry = this.matchEntries[i];
            if (entry.kind !== 'frozen') continue;
            if (this.virtualizer?.isFrozen(entry.div)) continue;
            const segments = extractSegmentsFromDiv(entry.div, this.editorElementRef.el);
            const range = createRangeInParagraph(segments, entry.localStart, entry.localEnd);
            if (range) {
                this.matchEntries[i] = { kind: 'thawed', range, viewStart: entry.viewStart };
            }
        }
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
            // Upgrade any entries whose divs were thawed by the IntersectionObserver
            // during the scroll (e.g. divs adjacent to the navigated-to paragraph).
            this.updateFrozenToThawedEntries();
            this.applyHitHighlights();
            this.applyFocusHighlight();
            requestAnimationFrame(() => {
                this.editorElementRef.el.classList.remove('tate-search-repaint');
            });
        });
    }

    private applyHitHighlights(): void {
        if (typeof CSS === 'undefined' || !CSS.highlights) return;
        // Only thawed entries have live Ranges; frozen entries are off-screen and unhighlighted.
        const thawedRanges = this.matchEntries
            .filter((e): e is ThawedMatchEntry => e.kind === 'thawed')
            .map(e => e.range);
        if (thawedRanges.length > 0) {
            CSS.highlights.set('tate-search-hit', new Highlight(...thawedRanges));
        } else {
            CSS.highlights.delete('tate-search-hit');
        }
    }

    private applyFocusHighlight(): void {
        if (typeof CSS === 'undefined' || !CSS.highlights) return;
        if (this.editorFocused) return;
        const entry = this.matchEntries[this.currentIndex];
        if (entry && entry.kind === 'thawed') {
            const h = new Highlight(entry.range);
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
        if (this.matchEntries.length === 0) {
            const hasQuery = !!(this.inputEl?.value);
            this.countEl.textContent = hasQuery ? 'No results' : '';
            this.countEl.classList.toggle('tate-search-no-match', hasQuery);
        } else {
            this.countEl.textContent = `${this.currentIndex + 1}/${this.matchEntries.length}`;
            this.countEl.classList.remove('tate-search-no-match');
        }
    }
}
