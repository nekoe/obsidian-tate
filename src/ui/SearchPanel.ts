import { App, sanitizeHTMLToDom, Scope, setIcon } from 'obsidian';
import type { EditorElement } from './EditorElement';
import type { ParagraphVirtualizer } from './ParagraphVirtualizer';
import { isInsideRtNode } from './domHelpers';
import { buildSegmentMap, viewToSrc, type Segment } from './SegmentMap';
import { parseInlineToHtml, serializeNode } from './AozoraParser';

// ---- Match entry types ----

// A match entry may refer to an in-window div (div != null, range != null) or an off-window
// paragraph (div/range null). Off-window entries are resolved lazily via ensureInWindow() when
// the user navigates to them.
interface MatchEntry {
    paragraphIndex: number;
    div: HTMLElement | null;  // null = off-window (no DOM node)
    localStart: number;       // visible offset within this paragraph
    localEnd: number;
    range: Range | null;      // null until div is in-window
    viewStart: number;        // visible-text offset of match start in combined text
}

// ---- Text extraction helpers ----

interface LocalSegment {
    node: Text;
    start: number; // local visible offset within this paragraph
    length: number;
}

interface ParagraphTextData {
    paragraphIndex: number;
    div: HTMLElement | null;  // null for off-window paragraphs
    globalStart: number;      // where this paragraph's visible text starts in the combined string
    text: string;             // visible text for this paragraph
    segments: LocalSegment[]; // populated for in-window divs; empty for off-window
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

// Iterates paragraphRecords by index: in-window divs are read from DOM text nodes,
// off-window paragraphs are read from paragraphRecords[i].src via buildParagraphVisibleText.
function extractHybridText(
    editorEl: HTMLDivElement,
    virtualizer: ParagraphVirtualizer,
): { text: string; paragraphs: ParagraphTextData[] } {
    const paragraphs: ParagraphTextData[] = [];
    let globalOffset = 0;

    for (let i = 0; i < virtualizer.paragraphRecords.length; i++) {
        const div = virtualizer.getWindowDiv(i);
        if (!div) {
            const src = virtualizer.paragraphRecords[i].src;
            const text = virtualizer.buildParagraphVisibleText(src);
            paragraphs.push({ paragraphIndex: i, div: null, globalStart: globalOffset, text, segments: [] });
            globalOffset += text.length;
        } else {
            const segments = extractSegmentsFromDiv(div, editorEl);
            const text = segments.map(s => (s.node.textContent ?? '').replace(/\u200B/g, '')).join('');
            paragraphs.push({ paragraphIndex: i, div, globalStart: globalOffset, text, segments });
            globalOffset += text.length;
        }
    }

    return { text: paragraphs.map(p => p.text).join(''), paragraphs };
}

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

// Returns [srcBase, baseLen] for the base text of a non-plain segment.
// ruby-explicit ｜base《rt》: base starts at srcStart+1 (after ｜).
// All others (ruby-implicit, bouten, tcy, heading-*): base starts at srcStart.
function getBaseRange(seg: Segment): [srcBase: number, baseLen: number] {
    if (seg.kind === 'ruby-explicit') return [seg.srcStart + 1, seg.baseLen ?? seg.viewLen];
    return [seg.srcStart, seg.viewLen];
}

// Builds the replacement source string for a view-space match [viewStart, viewEnd).
// When the match partially overlaps a non-plain segment, the annotation is stripped and
// the unmatched portion of the base text is preserved as plain text:
//   - match starts mid-segment → unmatched base prefix prepended before replacement
//   - match ends mid-segment   → unmatched base suffix appended after replacement
function buildReplacedSrc(
    srcLine: string,
    segs: readonly Segment[],
    viewStart: number,
    viewEnd: number,
    replacement: string,
): string {
    let srcStart = viewToSrc(segs, viewStart);
    let srcEnd   = viewToSrc(segs, viewEnd);
    let prefix = '';
    let suffix = '';

    for (const seg of segs) {
        if (seg.kind === 'plain' || seg.kind === 'newline') continue;
        const segViewEnd = seg.viewStart + seg.viewLen;
        const [srcBase, baseLen] = getBaseRange(seg);

        if (viewStart > seg.viewStart && viewStart < segViewEnd) {
            // Match starts inside this segment: keep the unmatched base prefix as plain text.
            const localStart = viewStart - seg.viewStart;
            prefix = srcLine.slice(srcBase, srcBase + localStart);
            srcStart = seg.srcStart;
        }
        if (viewEnd > seg.viewStart && viewEnd < segViewEnd) {
            // Match ends inside this segment: keep the unmatched base suffix as plain text.
            const localEnd = viewEnd - seg.viewStart;
            suffix = srcLine.slice(srcBase + localEnd, srcBase + baseLen);
            srcEnd = seg.srcStart + seg.srcLen;
        }
    }

    return srcLine.slice(0, srcStart) + prefix + replacement + suffix + srcLine.slice(srcEnd);
}

// ---- SearchPanel ----

export class SearchPanel {
    private panelEl: HTMLElement | null = null;
    private inputEl: HTMLInputElement | null = null;
    private countEl: HTMLElement | null = null;
    private replaceInputEl: HTMLInputElement | null = null;
    private replaceRowEl: HTMLElement | null = null;
    private toggleBtnEl: HTMLButtonElement | null = null;

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
    private commitCallback: (() => void) | null = null;

    constructor(
        private readonly editorElementRef: EditorElement,
        private readonly container: HTMLElement,
        private readonly app: App,
        private readonly virtualizer: ParagraphVirtualizer,
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
            if (document.activeElement === this.replaceInputEl) {
                this.replaceCurrentMatch();
            } else {
                this.navigate(1);
            }
            return false;
        });
        this.searchScope.register(['Shift'], 'Enter', (evt) => {
            if (evt.isComposing) return;
            if (this.editorFocused) return; // pass through to editor
            if (document.activeElement !== this.replaceInputEl) {
                this.navigate(-1);
            }
            return false; // Shift+Enter in replace input: no-op
        });
        this.searchScope.register([], 'Escape', (evt) => {
            if (evt.isComposing) return;
            this.close();
            return false; // suppress Obsidian's global ESC handler
        });
    }

    setCommitCallback(cb: () => void): void {
        this.commitCallback = cb;
    }

    get isOpen(): boolean {
        return this.panelEl !== null;
    }

    open(initialOffset: number, expandReplace = false): void {
        if (this.isOpen) {
            if (expandReplace) {
                this.showReplaceRow();
                this.replaceInputEl?.focus();
            } else {
                this.inputEl?.focus();
            }
            return;
        }

        this.prSearchOffset = initialOffset;
        this.lastNavigatedOffset = null;
        this.editorFocused = false;
        this.matchEntries = [];
        this.currentIndex = -1;
        this.buildPanel(expandReplace);
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
        this.replaceInputEl = null;
        this.replaceRowEl = null;
        this.toggleBtnEl = null;
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

    private showReplaceRow(): void {
        this.replaceRowEl?.classList.add('tate-replace-visible');
        if (this.toggleBtnEl) setIcon(this.toggleBtnEl, 'chevron-down');
    }

    private hideReplaceRow(): void {
        this.replaceRowEl?.classList.remove('tate-replace-visible');
        if (this.toggleBtnEl) setIcon(this.toggleBtnEl, 'chevron-right');
    }

    private toggleReplaceRow(): void {
        if (this.replaceRowEl?.classList.contains('tate-replace-visible')) {
            this.hideReplaceRow();
        } else {
            this.showReplaceRow();
        }
    }

    private buildPanel(expandReplace: boolean): void {
        const panel = document.createElement('div');
        panel.className = 'tate-search-panel';

        // When focus is on a panel element other than the text inputs (e.g., the replace-all button),
        // forward Cmd-z / Shift+Cmd-z to the editor so Undo/Redo still works.
        panel.addEventListener('keydown', (e) => {
            if (e.target === this.inputEl || e.target === this.replaceInputEl) return;
            if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key === 'z') {
                e.preventDefault();
                e.stopPropagation();
                this.editorElementRef.el.dispatchEvent(
                    new KeyboardEvent('keydown', {
                        key: 'z', code: 'KeyZ',
                        metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey,
                        bubbles: true, cancelable: true,
                    })
                );
            }
        });

        const searchRow = document.createElement('div');
        searchRow.className = 'tate-search-row';

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'tate-search-toggle';
        toggleBtn.tabIndex = -1;
        setIcon(toggleBtn, expandReplace ? 'chevron-down' : 'chevron-right');
        toggleBtn.setAttribute('aria-label', '置換欄を表示');
        toggleBtn.addEventListener('click', () => this.toggleReplaceRow());
        this.toggleBtnEl = toggleBtn;

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
        // Prevent panel input events from bubbling; Escape propagates to the Scope's close() handler.
        input.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') e.stopPropagation();
        });
        this.inputEl = input;

        const count = document.createElement('span');
        count.className = 'tate-search-count';
        count.textContent = '';
        this.countEl = count;

        const nextBtn = document.createElement('button');
        nextBtn.className = 'tate-search-btn';
        nextBtn.tabIndex = -1;
        nextBtn.setAttribute('aria-label', '次へ');
        setIcon(nextBtn, 'arrow-down');
        nextBtn.addEventListener('click', () => this.navigate(1));

        const prevBtn = document.createElement('button');
        prevBtn.className = 'tate-search-btn';
        prevBtn.tabIndex = -1;
        prevBtn.setAttribute('aria-label', '前へ');
        setIcon(prevBtn, 'arrow-up');
        prevBtn.addEventListener('click', () => this.navigate(-1));

        const closeBtn = document.createElement('button');
        closeBtn.className = 'tate-search-btn';
        closeBtn.tabIndex = -1;
        closeBtn.setAttribute('aria-label', '閉じる');
        setIcon(closeBtn, 'x');
        closeBtn.addEventListener('click', () => this.close());

        searchRow.append(toggleBtn, input, count, nextBtn, prevBtn, closeBtn);

        const replaceRow = document.createElement('div');
        replaceRow.className = 'tate-replace-row';
        if (expandReplace) replaceRow.classList.add('tate-replace-visible');
        this.replaceRowEl = replaceRow;

        const replaceInput = document.createElement('input');
        replaceInput.type = 'text';
        replaceInput.className = 'tate-replace-input';
        replaceInput.setAttribute('placeholder', '置換');
        replaceInput.addEventListener('keydown', (e) => {
            // Enter and Shift+Enter are handled entirely in the Scope (capture phase).
            // Escape propagates to the Scope's close() handler.
            if (e.key !== 'Escape') e.stopPropagation();
        });
        this.replaceInputEl = replaceInput;

        const replaceBtn = document.createElement('button');
        replaceBtn.className = 'tate-search-btn';
        replaceBtn.tabIndex = -1;
        replaceBtn.setAttribute('aria-label', '置換');
        setIcon(replaceBtn, 'replace');
        replaceBtn.addEventListener('click', () => this.replaceCurrentMatch());

        const replaceAllBtn = document.createElement('button');
        replaceAllBtn.className = 'tate-search-btn';
        replaceAllBtn.tabIndex = -1;
        replaceAllBtn.setAttribute('aria-label', '全置換');
        setIcon(replaceAllBtn, 'replace-all');
        replaceAllBtn.addEventListener('click', () => this.replaceAllMatches());

        const replaceBtnGroup = document.createElement('div');
        replaceBtnGroup.className = 'tate-replace-btn-group';
        replaceBtnGroup.append(replaceBtn, replaceAllBtn);

        replaceRow.append(replaceInput, replaceBtnGroup);

        panel.append(searchRow, replaceRow);
        // Append to the tate-container so Obsidian's cleanup manages this DOM.
        // position:absolute with top/right anchors to the container's visible edge,
        // which stays fixed even during horizontal scroll of the editor content.
        this.container.appendChild(panel);
        this.panelEl = panel;
    }

    private replaceCurrentMatch(): void {
        if (this.currentIndex < 0 || this.currentIndex >= this.matchEntries.length) return;
        const entry = this.matchEntries[this.currentIndex];
        // setFocus() guarantees div is in-window after navigation; guard just in case.
        if (!entry.div) return;

        const replacement = this.replaceInputEl?.value ?? '';
        const srcLine = Array.from(entry.div.childNodes)
            .map(n => serializeNode(n, this.editorElementRef.el))
            .join('');
        const segs = buildSegmentMap(srcLine);
        const newSrc = buildReplacedSrc(srcLine, segs, entry.localStart, entry.localEnd, replacement);

        entry.div.replaceChildren(sanitizeHTMLToDom(parseInlineToHtml(newSrc) || '<br>'));

        this.commitCallback?.();

        // Rebuild match list; the replaced entry disappears.
        // The old currentIndex now points to what was the next match.
        const nextIndex = this.currentIndex;
        this.runSearch(false);
        if (this.matchEntries.length > 0) {
            this.setFocus(Math.min(nextIndex, this.matchEntries.length - 1), true);
        }
        // setFocus() gives focus to the search input; return it to the replace input.
        this.replaceInputEl?.focus();
    }

    private replaceAllMatches(): void {
        if (this.matchEntries.length === 0) return;
        const replacement = this.replaceInputEl?.value ?? '';

        // Group matches by paragraph index so multiple matches in one paragraph are applied together.
        const byParagraph = new Map<number, MatchEntry[]>();
        for (const entry of this.matchEntries) {
            const arr = byParagraph.get(entry.paragraphIndex) ?? [];
            arr.push(entry);
            byParagraph.set(entry.paragraphIndex, arr);
        }

        // Apply replacements right-to-left within each paragraph so earlier view offsets
        // remain valid after each successive replacement shifts the source string.
        for (const [, entries] of byParagraph) {
            entries.sort((a, b) => b.localStart - a.localStart);
            // Ensure the paragraph div is in the DOM window before modifying.
            const firstEntry = entries[0];
            this.virtualizer.ensureInWindow(firstEntry.paragraphIndex);
            const div = this.virtualizer.getWindowDiv(firstEntry.paragraphIndex);
            if (!div) continue;
            // Update the entry reference so replaceCurrentMatch callers see the resolved div.
            for (const e of entries) e.div = div;
            let srcLine = Array.from(div.childNodes)
                .map(n => serializeNode(n, this.editorElementRef.el))
                .join('');
            for (const entry of entries) {
                const segs = buildSegmentMap(srcLine);
                srcLine = buildReplacedSrc(srcLine, segs, entry.localStart, entry.localEnd, replacement);
            }
            div.replaceChildren(sanitizeHTMLToDom(parseInlineToHtml(srcLine) || '<br>'));
        }

        // Commit all changes as one transaction (syncWindowSrcs is called inside commitToCm6).
        this.commitCallback?.();
        this.runSearch(false);
        if (this.matchEntries.length > 0) {
            this.setFocus(0, true);
            this.replaceInputEl?.focus();
        }
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

        // Build combined visible text. In-window divs are read from DOM; off-window from records.
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

            // Skip matches that span paragraph boundaries (cross-paragraph Ranges are not supported).
            if (matchEnd > para.globalStart + para.text.length) {
                if (m[0].length === 0) re.lastIndex++;
                continue;
            }

            const localStart = matchStart - para.globalStart;
            const localEnd = matchEnd - para.globalStart;

            if (!para.div) {
                // Off-window: no DOM node yet; range created lazily on navigation.
                this.matchEntries.push({ paragraphIndex: para.paragraphIndex, div: null, localStart, localEnd, range: null, viewStart: matchStart });
            } else {
                const range = createRangeInParagraph(para.segments, localStart, localEnd);
                if (range) {
                    this.matchEntries.push({ paragraphIndex: para.paragraphIndex, div: para.div, localStart, localEnd, range, viewStart: matchStart });
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

        // Resolve range: bring off-window paragraph into the DOM window if needed.
        // A cached range is stale in two cases:
        //   1. startContainer is disconnected (node removed to a detached subtree).
        //   2. startContainer is not a Text node — this happens when teleportWindowTo() calls
        //      editorEl.replaceChildren(), removing the paragraph div. The DOM Range live-update
        //      spec moves the boundary from the Text node up to tate-editor (the parent of the
        //      removed div), which stays isConnected=true and defeats the disconnected check.
        //      createRangeInParagraph() always produces Text-node boundaries, so a non-Text
        //      startContainer is an unambiguous signal that the range has been corrupted.
        if (entry.range && (
            !entry.range.startContainer.isConnected ||
            !(entry.range.startContainer instanceof Text)
        )) {
            entry.div   = null;
            entry.range = null;
        }
        let range: Range;
        if (entry.range) {
            range = entry.range;
        } else {
            if (!this.virtualizer.isInWindow(entry.paragraphIndex)) {
                this.virtualizer.teleportWindowTo(entry.paragraphIndex);
            }
            const div = this.virtualizer.getWindowDiv(entry.paragraphIndex);
            if (!div) return;
            const segments = extractSegmentsFromDiv(div, this.editorElementRef.el);
            const r = createRangeInParagraph(segments, entry.localStart, entry.localEnd);
            if (!r) return;
            range = r;
            // Cache the resolved div and range so subsequent navigation reuses them.
            entry.div   = div;
            entry.range = range;
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
        // Only in-window entries have live Ranges; off-window entries are skipped.
        const liveRanges = this.matchEntries
            .filter((e): e is MatchEntry & { range: Range } => e.range !== null)
            .map(e => e.range);
        if (liveRanges.length > 0) {
            CSS.highlights.set('tate-search-hit', new Highlight(...liveRanges));
        } else {
            CSS.highlights.delete('tate-search-hit');
        }
    }

    private applyFocusHighlight(): void {
        if (typeof CSS === 'undefined' || !CSS.highlights) return;
        if (this.editorFocused) return;
        const entry = this.matchEntries[this.currentIndex];
        if (entry?.range) {
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
