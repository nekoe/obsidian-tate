import { TatePluginSettings } from '../settings';

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
        return this.el.innerText;
    }

    setValue(content: string, preserveCursor: boolean): void {
        if (this.el.innerText === content) return;

        if (preserveCursor && document.activeElement === this.el) {
            const pos = this.getCharOffset();
            this.el.innerText = content;
            this.setCharOffset(Math.min(pos, content.length));
        } else {
            this.el.innerText = content;
        }
    }

    applySettings(settings: TatePluginSettings): void {
        this.el.style.fontFamily = settings.fontFamily;
        this.el.style.fontSize = `${settings.fontSize}px`;
    }

    // contenteditable div は writing-mode: vertical-rl で自動的に幅が広がるため不要
    adjustWidth(): void { /* no-op */ }

    focus(): void {
        this.el.focus();
    }

    // カーソル位置を文字オフセット（先頭からの文字数）で取得する
    private getCharOffset(): number {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return 0;
        const range = sel.getRangeAt(0);
        const preRange = document.createRange();
        preRange.selectNodeContents(this.el);
        preRange.setEnd(range.startContainer, range.startOffset);
        return preRange.toString().length;
    }

    // 文字オフセットを元にカーソル位置を復元する
    private setCharOffset(offset: number): void {
        const sel = window.getSelection();
        if (!sel) return;
        const range = document.createRange();
        let remaining = offset;
        const walker = document.createTreeWalker(this.el, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode() as Text | null;
        while (node) {
            if (remaining <= node.length) {
                range.setStart(node, remaining);
                range.collapse(true);
                sel.removeAllRanges();
                sel.addRange(range);
                return;
            }
            remaining -= node.length;
            node = walker.nextNode() as Text | null;
        }
        // オフセットがコンテンツ長を超えた場合は末尾に配置
        range.selectNodeContents(this.el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
    }
}
