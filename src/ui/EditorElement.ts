import { TatePluginSettings } from '../settings';

export class EditorElement {
    readonly textarea: HTMLTextAreaElement;

    constructor(container: HTMLElement) {
        this.textarea = container.createEl('textarea');
        this.textarea.addClass('tate-editor');
        this.textarea.setAttribute('spellcheck', 'false');
        this.textarea.setAttribute('placeholder', 'ファイルを開いてください');
    }

    getValue(): string {
        return this.textarea.value;
    }

    setValue(content: string, preserveCursor: boolean): void {
        if (preserveCursor) {
            const start = this.textarea.selectionStart;
            const end = this.textarea.selectionEnd;
            this.textarea.value = content;
            this.textarea.setSelectionRange(
                Math.min(start, content.length),
                Math.min(end, content.length)
            );
        } else {
            this.textarea.value = content;
        }
        this.adjustWidth();
    }

    applySettings(settings: TatePluginSettings): void {
        this.textarea.style.fontFamily = settings.fontFamily;
        this.textarea.style.fontSize = `${settings.fontSize}px`;
    }

    // 縦書きモードでコンテンツ幅に合わせて textarea 幅を自動調整する
    // view.ts 側で registerDomEvent から呼ぶ
    adjustWidth(): void {
        this.textarea.style.width = 'auto';
        this.textarea.style.width = `${this.textarea.scrollWidth}px`;
    }

    focus(): void {
        this.textarea.focus();
    }
}
