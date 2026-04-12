import { TatePluginSettings } from '../settings';

// 省略形式で自動検出する漢字の Unicode 範囲
// CJK Unified Ideographs (U+4E00–U+9FFF) + Extension A (U+3400–U+4DBF) + 繰り返し記号
const KANJI_RE_STR = '[\u4E00-\u9FFF\u3400-\u4DBF\u{20000}-\u{2A6DF}々〆〤]+';

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

        const fullMatch = match[0];
        const base = match[1];
        const rt = match[2];
        const matchStart = range.startOffset - fullMatch.length;

        const before = textNode.textContent!.slice(0, matchStart);
        const after = textNode.textContent!.slice(range.startOffset);

        const rubyEl = this.createRubyEl(base, rt, explicit);
        const parent = textNode.parentNode!;
        const afterNode = document.createTextNode(after);

        parent.insertBefore(afterNode, textNode.nextSibling ?? null);
        parent.insertBefore(rubyEl, afterNode);
        if (before) {
            textNode.textContent = before;
        } else {
            parent.removeChild(textNode);
        }

        // カーソルをルビ要素の直後に配置
        const newRange = document.createRange();
        newRange.setStartAfter(rubyEl);
        newRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(newRange);
    }

    applySettings(settings: TatePluginSettings): void {
        this.el.style.fontFamily = settings.fontFamily;
        this.el.style.fontSize = `${settings.fontSize}px`;
    }

    adjustWidth(): void { /* no-op: contenteditable div auto-sizes */ }

    focus(): void {
        this.el.focus();
    }

    // ---- ルビパーサー（Aozora 記法 → innerHTML） ----

    private parseToHtml(text: string): string {
        const segments = this.splitByExplicitRuby(text);
        const html = segments
            .map(seg =>
                seg.type === 'ruby'
                    ? seg.html!
                    : this.convertImplicitRuby(seg.text!)
            )
            .join('');
        return html.replace(/\n/g, '<br>');
    }

    private splitByExplicitRuby(
        text: string
    ): Array<{ type: 'text' | 'ruby'; text?: string; html?: string }> {
        const result: Array<{ type: 'text' | 'ruby'; text?: string; html?: string }> = [];
        const re = /\|([^|《》\n]+)《([^《》\n]*)》/g;
        let lastIndex = 0;
        let m: RegExpExecArray | null;

        while ((m = re.exec(text)) !== null) {
            if (m.index > lastIndex) {
                result.push({ type: 'text', text: text.slice(lastIndex, m.index) });
            }
            result.push({
                type: 'ruby',
                html: `<ruby data-ruby-explicit="true">${this.esc(m[1])}<rt>${this.esc(m[2])}</rt></ruby>`,
            });
            lastIndex = re.lastIndex;
        }
        if (lastIndex < text.length) {
            result.push({ type: 'text', text: text.slice(lastIndex) });
        }
        return result;
    }

    private convertImplicitRuby(text: string): string {
        const re = new RegExp(`(${KANJI_RE_STR})《([^《》\\n]*)》`, 'gu');
        const parts: string[] = [];
        let lastIndex = 0;
        let m: RegExpExecArray | null;

        while ((m = re.exec(text)) !== null) {
            if (m.index > lastIndex) {
                parts.push(this.esc(text.slice(lastIndex, m.index)));
            }
            parts.push(
                `<ruby data-ruby-explicit="false">${this.esc(m[1])}<rt>${this.esc(m[2])}</rt></ruby>`
            );
            lastIndex = re.lastIndex;
        }
        if (lastIndex < text.length) {
            parts.push(this.esc(text.slice(lastIndex)));
        }
        return parts.join('');
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

    private createRubyEl(base: string, rt: string, explicit: boolean): HTMLElement {
        const rubyEl = document.createElement('ruby');
        rubyEl.setAttribute('data-ruby-explicit', String(explicit));
        rubyEl.appendChild(document.createTextNode(base));
        const rtEl = document.createElement('rt');
        rtEl.textContent = rt;
        rubyEl.appendChild(rtEl);
        return rubyEl;
    }
}
