import { TatePluginSettings } from '../settings';

// 省略形式で自動検出する漢字の Unicode 範囲
// CJK Unified Ideographs (U+4E00–U+9FFF) + Extension A (U+3400–U+4DBF) + 繰り返し記号
const KANJI_RE_STR = '[\u4E00-\u9FFF\u3400-\u4DBF\u{20000}-\u{2A6DF}々〆〤]+';

// パーサーパイプラインの中間表現
type ParseSegment = { type: 'text'; text: string } | { type: 'html'; html: string };

export class EditorElement {
    readonly el: HTMLDivElement;

    constructor(container: HTMLElement) {
        this.el = container.createEl('div');
        this.el.addClass('tate-editor');
        this.el.setAttribute('contenteditable', 'true');
        this.el.setAttribute('spellcheck', 'false');
        this.el.setAttribute('data-placeholder', 'ファイルを開いてください');
    }

    getValue(): string {
        return Array.from(this.el.childNodes)
            .map(n => this.serializeNode(n))
            .join('');
    }

    setValue(content: string, preserveCursor: boolean): void {
        if (this.getValue() === content) return;

        if (preserveCursor && document.activeElement === this.el) {
            const pos = this.getVisibleOffset();
            this.el.innerHTML = this.parseToHtml(content);
            this.setVisibleOffset(pos);
        } else {
            this.el.innerHTML = this.parseToHtml(content);
        }
    }

    // 》が入力されたときに直前のルビ記法を <ruby> 要素に変換する。
    // input（isComposing=false）および compositionend の後に呼ぶ。
    handleRubyCompletion(): void {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        if (range.startContainer.nodeType !== Node.TEXT_NODE) return;
        // <ruby> 内（ベーステキスト・rt）では変換しない
        if (this.isInsideRuby(range.startContainer)) return;

        const textNode = range.startContainer as Text;
        const textBefore = textNode.textContent?.slice(0, range.startOffset) ?? '';
        if (!textBefore.endsWith('》')) return;

        // 明示形式を優先: |base《rt》
        let match = textBefore.match(/\|([^|《》\n]+)《([^《》\n]*)》$/);
        let explicit = true;
        if (!match) {
            // 省略形式: 直前の漢字連続部分《rt》
            match = textBefore.match(new RegExp(`(${KANJI_RE_STR})《([^《》\\n]*)》$`, 'u'));
            explicit = false;
        }
        if (!match) return;

        const base = match[1];
        const rt = match[2];
        const matchStart = range.startOffset - match[0].length;

        this.replaceTextWithElement(
            textNode,
            matchStart,
            range.startOffset,
            this.createRubyEl(base, rt, explicit),
        );
    }

    // ］が入力されたときに直前の縦中横記法を <span class="tcy"> 要素に変換する。
    // input（isComposing=false）および compositionend の後に呼ぶ。
    handleTcyCompletion(): void {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        if (range.startContainer.nodeType !== Node.TEXT_NODE) return;
        // <ruby> 内では変換しない
        if (this.isInsideRuby(range.startContainer)) return;

        const textNode = range.startContainer as Text;
        const textBefore = textNode.textContent?.slice(0, range.startOffset) ?? '';
        if (!textBefore.endsWith('］')) return;

        // 縦中横記法: X［＃「X」は縦中横］
        const annotationMatch = textBefore.match(/［＃「([^「」\n]+)」は縦中横］$/);
        if (!annotationMatch) return;

        const tcyContent = annotationMatch[1];
        const annotationStart = range.startOffset - annotationMatch[0].length;
        // 注記の直前のテキストが tcyContent で終わっていることを確認
        if (!textBefore.slice(0, annotationStart).endsWith(tcyContent)) return;

        const tcyStart = annotationStart - tcyContent.length;

        this.replaceTextWithElement(
            textNode,
            tcyStart,
            range.startOffset,
            this.createTcyEl(tcyContent, 'explicit'),
        );
    }

    applySettings(settings: TatePluginSettings): void {
        this.el.style.fontFamily = settings.fontFamily;
        this.el.style.fontSize = `${settings.fontSize}px`;
    }

    adjustWidth(): void { /* no-op: contenteditable div auto-sizes */ }

    focus(): void {
        this.el.focus();
    }

    // ---- パーサー（Aozora 記法 → innerHTML） ----

    private parseToHtml(text: string): string {
        const result = this.applyParsers(text, [
            t => this.splitByExplicitRuby(t),
            t => this.splitByExplicitTcy(t),
            t => this.splitByImplicitRuby(t),
            t => this.splitByAutoTcy(t),
        ]);
        return result.replace(/\n/g, '<br>');
    }

    // テキストにパーサーを順番に適用し、HTML 文字列を返す。
    // 各パーサーは 'text' セグメントのみを処理し、'html' セグメントはそのまま通過する。
    private applyParsers(
        text: string,
        parsers: Array<(t: string) => ParseSegment[]>
    ): string {
        let segments: ParseSegment[] = [{ type: 'text', text }];
        for (const parser of parsers) {
            segments = segments.flatMap(seg =>
                seg.type === 'text' ? parser(seg.text) : [seg]
            );
        }
        return segments
            .map(seg => seg.type === 'html' ? seg.html : this.esc(seg.text))
            .join('');
    }

    // 明示ルビ |base《rt》 を分割する
    private splitByExplicitRuby(text: string): ParseSegment[] {
        const result: ParseSegment[] = [];
        const re = /\|([^|《》\n]+)《([^《》\n]*)》/g;
        let lastIndex = 0;
        let m: RegExpExecArray | null;

        while ((m = re.exec(text)) !== null) {
            if (m.index > lastIndex) {
                result.push({ type: 'text', text: text.slice(lastIndex, m.index) });
            }
            result.push({
                type: 'html',
                html: `<ruby data-ruby-explicit="true">${this.esc(m[1])}<rt>${this.esc(m[2])}</rt></ruby>`,
            });
            lastIndex = re.lastIndex;
        }
        if (lastIndex < text.length) {
            result.push({ type: 'text', text: text.slice(lastIndex) });
        }
        return result;
    }

    // 明示縦中横 X［＃「X」は縦中横］ を分割する
    private splitByExplicitTcy(text: string): ParseSegment[] {
        const result: ParseSegment[] = [];
        const re = /［＃「([^「」\n]+)」は縦中横］/g;
        let lastIndex = 0;
        let m: RegExpExecArray | null;

        while ((m = re.exec(text)) !== null) {
            const tcyContent = m[1];
            const annotationStart = m.index;

            // 注記の直前（lastIndex から annotationStart まで）が tcyContent で終わっていなければ無効
            if (!text.slice(lastIndex, annotationStart).endsWith(tcyContent)) {
                // 無効な注記: re.lastIndex まで明示的にテキストとして追加し lastIndex を進める
                result.push({ type: 'text', text: text.slice(lastIndex, re.lastIndex) });
                lastIndex = re.lastIndex;
                continue;
            }

            const tcyStart = annotationStart - tcyContent.length;
            if (tcyStart > lastIndex) {
                result.push({ type: 'text', text: text.slice(lastIndex, tcyStart) });
            }
            result.push({
                type: 'html',
                html: `<span data-tcy="explicit" class="tcy">${this.esc(tcyContent)}</span>`,
            });
            lastIndex = re.lastIndex;
        }
        if (lastIndex < text.length) {
            result.push({ type: 'text', text: text.slice(lastIndex) });
        }
        return result;
    }

    // 省略ルビ kanji《rt》 を分割する
    private splitByImplicitRuby(text: string): ParseSegment[] {
        const re = new RegExp(`(${KANJI_RE_STR})《([^《》\\n]*)》`, 'gu');
        const result: ParseSegment[] = [];
        let lastIndex = 0;
        let m: RegExpExecArray | null;

        while ((m = re.exec(text)) !== null) {
            if (m.index > lastIndex) {
                result.push({ type: 'text', text: text.slice(lastIndex, m.index) });
            }
            result.push({
                type: 'html',
                html: `<ruby data-ruby-explicit="false">${this.esc(m[1])}<rt>${this.esc(m[2])}</rt></ruby>`,
            });
            lastIndex = re.lastIndex;
        }
        if (lastIndex < text.length) {
            result.push({ type: 'text', text: text.slice(lastIndex) });
        }
        return result;
    }

    // 2〜4桁の連続半角数字を自動縦中横として分割する（表示専用・保存時は元テキストに戻す）
    private splitByAutoTcy(text: string): ParseSegment[] {
        const re = /(?<![0-9])[0-9]{2,4}(?![0-9])/g;
        const result: ParseSegment[] = [];
        let lastIndex = 0;
        let m: RegExpExecArray | null;

        while ((m = re.exec(text)) !== null) {
            if (m.index > lastIndex) {
                result.push({ type: 'text', text: text.slice(lastIndex, m.index) });
            }
            result.push({
                type: 'html',
                html: `<span data-tcy="auto" class="tcy">${this.esc(m[0])}</span>`,
            });
            lastIndex = re.lastIndex;
        }
        if (lastIndex < text.length) {
            result.push({ type: 'text', text: text.slice(lastIndex) });
        }
        return result;
    }

    private esc(text: string): string {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ---- DOM シリアライザ（innerHTML → Aozora 記法） ----

    private serializeNode(node: Node): string {
        if (node.nodeType === Node.TEXT_NODE) {
            return node.textContent ?? '';
        }
        if (!(node instanceof HTMLElement)) return '';

        switch (node.tagName) {
            case 'RUBY': {
                const explicit = node.getAttribute('data-ruby-explicit') !== 'false';
                const base = Array.from(node.childNodes)
                    .filter(n => !(n instanceof HTMLElement && n.tagName === 'RT'))
                    .map(n => this.serializeNode(n))
                    .join('');
                const rt = node.querySelector('rt')?.textContent ?? '';
                return explicit ? `|${base}《${rt}》` : `${base}《${rt}》`;
            }
            case 'SPAN': {
                const tcy = node.getAttribute('data-tcy');
                if (tcy === 'explicit') {
                    const content = node.textContent ?? '';
                    return `${content}［＃「${content}」は縦中横］`;
                }
                if (tcy === 'auto') {
                    // 自動検出分はマークアップなしで保存
                    return node.textContent ?? '';
                }
                return Array.from(node.childNodes)
                    .map(n => this.serializeNode(n))
                    .join('');
            }
            case 'BR':
                // Chrome が contenteditable div の末尾に追加する表示用 <br> はスキップ
                if (
                    node.parentElement !== this.el &&
                    node.parentElement?.tagName === 'DIV' &&
                    node === node.parentElement.lastChild
                ) {
                    return '';
                }
                return '\n';
            case 'DIV':
                // Chrome の contenteditable が生成するブロック div。
                // 前に sibling があれば改行として扱う。
                {
                    const content = Array.from(node.childNodes)
                        .map(n => this.serializeNode(n))
                        .join('');
                    return node.previousSibling !== null ? '\n' + content : content;
                }
            default:
                return Array.from(node.childNodes)
                    .map(n => this.serializeNode(n))
                    .join('');
        }
    }

    // ---- カーソル操作（<rt> 内を除いた visible 文字数でオフセット管理） ----

    private getVisibleOffset(): number {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return 0;
        const range = sel.getRangeAt(0);
        let count = 0;
        const walker = document.createTreeWalker(this.el, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode() as Text | null;

        while (node) {
            if (node === range.startContainer) {
                if (!this.isInsideRt(node)) count += range.startOffset;
                break;
            }
            if (!this.isInsideRt(node)) count += node.length;
            node = walker.nextNode() as Text | null;
        }
        return count;
    }

    private setVisibleOffset(offset: number): void {
        const sel = window.getSelection();
        if (!sel) return;
        let remaining = offset;
        const walker = document.createTreeWalker(this.el, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode() as Text | null;

        while (node) {
            if (!this.isInsideRt(node)) {
                if (remaining <= node.length) {
                    const range = document.createRange();
                    range.setStart(node, remaining);
                    range.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(range);
                    return;
                }
                remaining -= node.length;
            }
            node = walker.nextNode() as Text | null;
        }

        const range = document.createRange();
        range.selectNodeContents(this.el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
    }

    private isInsideRt(node: Node): boolean {
        let parent = node.parentElement;
        while (parent && parent !== this.el) {
            if (parent.tagName === 'RT') return true;
            parent = parent.parentElement;
        }
        return false;
    }

    private isInsideRuby(node: Node): boolean {
        let parent = node.parentElement;
        while (parent && parent !== this.el) {
            if (parent.tagName === 'RUBY') return true;
            parent = parent.parentElement;
        }
        return false;
    }

    // テキストノードの [matchStart, matchEnd) を newEl に置き換え、カーソルを newEl 直後に配置する
    private replaceTextWithElement(
        textNode: Text,
        matchStart: number,
        matchEnd: number,
        newEl: HTMLElement,
    ): void {
        const before = textNode.textContent!.slice(0, matchStart);
        const after = textNode.textContent!.slice(matchEnd);
        const parent = textNode.parentNode!;
        const afterNode = document.createTextNode(after);

        parent.insertBefore(afterNode, textNode.nextSibling ?? null);
        parent.insertBefore(newEl, afterNode);
        if (before) {
            textNode.textContent = before;
        } else {
            parent.removeChild(textNode);
        }

        const sel = window.getSelection()!;
        const newRange = document.createRange();
        newRange.setStartAfter(newEl);
        newRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(newRange);
    }

    private createRubyEl(base: string, rt: string, explicit: boolean): HTMLElement {
        const rubyEl = document.createElement('ruby');
        rubyEl.setAttribute('data-ruby-explicit', String(explicit));
        rubyEl.appendChild(document.createTextNode(base));
        const rtEl = document.createElement('rt');
        rtEl.textContent = rt;
        rubyEl.appendChild(rtEl);
        return rubyEl;
    }

    private createTcyEl(content: string, mode: 'explicit' | 'auto'): HTMLElement {
        const span = document.createElement('span');
        span.setAttribute('data-tcy', mode);
        span.className = 'tcy';
        span.textContent = content;
        return span;
    }
}
