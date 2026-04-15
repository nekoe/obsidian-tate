import { TatePluginSettings } from '../settings';
import { buildSegmentMap, srcToView } from './SegmentMap';
import { parseToHtml, serializeNode } from './AozoraParser';
import { InlineEditor } from './InlineEditor';

export class EditorElement {
    readonly el: HTMLDivElement;
    private readonly inlineEditor: InlineEditor;

    constructor(container: HTMLElement) {
        this.el = container.createEl('div');
        this.el.addClass('tate-editor');
        this.el.setAttribute('contenteditable', 'true');
        this.el.setAttribute('spellcheck', 'false');
        this.el.setAttribute('data-placeholder', 'ファイルを開いてください');
        this.inlineEditor = new InlineEditor(this.el);
    }

    getValue(): string {
        return Array.from(this.el.childNodes)
            .map(n => serializeNode(n, this.el))
            .join('');
    }

    setValue(content: string, preserveCursor: boolean): void {
        // 外部更新時は展開状態・選択キャッシュをリセット（早期リターンより先に実行）
        this.inlineEditor.reset();
        if (this.getValue() === content) return;

        if (preserveCursor && document.activeElement === this.el) {
            const pos = this.getVisibleOffset();
            this.el.innerHTML = parseToHtml(content);
            this.setVisibleOffset(pos);
        } else {
            this.el.innerHTML = parseToHtml(content);
        }
    }

    // ---- インライン展開/収束（selectionchange から呼ぶ） ----

    handleSelectionChange(): boolean {
        return this.inlineEditor.handleSelectionChange();
    }

    // ---- ルビ・縦中横ライブ変換（input/compositionend から呼ぶ） ----

    handleRubyCompletion(): boolean {
        return this.inlineEditor.handleRubyCompletion();
    }

    handleTcyCompletion(): boolean {
        return this.inlineEditor.handleTcyCompletion();
    }

    handleBoutenCompletion(): boolean {
        return this.inlineEditor.handleBoutenCompletion();
    }

    // ---- コマンドパレットから呼ぶ選択ラップメソッド ----

    wrapSelectionWithRuby(): boolean {
        return this.inlineEditor.wrapSelectionWithRuby();
    }

    wrapSelectionWithTcy(): boolean {
        return this.inlineEditor.wrapSelectionWithTcy();
    }

    wrapSelectionWithBouten(): boolean {
        return this.inlineEditor.wrapSelectionWithBouten();
    }

    // paste イベントハンドラ: リッチテキストを排除してプレーンテキストのみを挿入する
    handlePaste(e: ClipboardEvent): void {
        e.preventDefault();
        const text = e.clipboardData?.getData('text/plain') ?? '';
        if (!text) return;
        // execCommand('insertText') はカーソル位置へのプレーンテキスト挿入・選択範囲の置換を
        // 一括処理する（deprecated だが Electron では動作する）。
        // beforeinput イベントが発火して onBeforeInput() が inBurst = true にする。
        document.execCommand('insertText', false, text);
        // view.ts が paste 後に commitToCm6() を呼ぶ
    }

    applySettings(settings: TatePluginSettings): void {
        this.el.style.fontFamily = settings.fontFamily;
        this.el.style.fontSize = `${settings.fontSize}px`;
        this.el.toggleClass('tate-auto-indent', settings.autoIndent);
        this.el.style.lineBreak = settings.lineBreak;
    }

    adjustWidth(): void { /* no-op: contenteditable div auto-sizes */ }

    focus(): void {
        this.el.focus();
    }

    // beforeinput イベントで呼ぶ（view.ts から登録）。
    onBeforeInput(): void {
        this.inlineEditor.onBeforeInput();
    }

    // バーストをリセットする（commitToCm6() 完了後・view.ts のナビゲーション処理時に呼ぶ）。
    resetBurst(): void {
        this.inlineEditor.resetBurst();
    }

    // CM6 の Undo/Redo 後に呼ぶ。content を縦書きビューに適用し、
    // srcOffset（CM6 のカーソル位置）を srcToView で変換してカーソルを復元する。
    applyFromCm6(content: string, srcOffset: number): void {
        // 展開中スパンをクリア（CM6 の状態が真実なので強制リセット）
        this.inlineEditor.reset();
        // DOM を更新（差分がある場合のみ）
        if (this.getValue() !== content) {
            this.el.innerHTML = parseToHtml(content);
        }
        // CM6 のソースオフセットを可視オフセットに変換してカーソルを復元
        const segs = buildSegmentMap(content);
        const viewOffset = srcToView(segs, srcOffset);
        this.setVisibleOffset(viewOffset);
    }

    /** tate-editing スパンが展開中かどうかを返す（view.ts のカーソル同期判定用）。 */
    isInlineExpanded(): boolean {
        return this.inlineEditor.isExpanded();
    }

    /** 縦書き表示上の現在カーソル位置（visible offset）を返す（view.ts のカーソル同期用）。 */
    getViewCursorOffset(): number {
        return this.getVisibleOffset();
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
}
