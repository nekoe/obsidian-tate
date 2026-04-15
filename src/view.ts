import { Editor, ItemView, MarkdownView, Notice, TFile, WorkspaceLeaf } from 'obsidian';
import type TatePlugin from './main';
import { SyncCoordinator } from './sync/SyncCoordinator';
import { EditorElement } from './ui/EditorElement';
import { buildSegmentMap, viewToSrc } from './ui/SegmentMap';
import { TatePluginSettings } from './settings';

export const TATE_VIEW_TYPE = 'tate-vertical-writing';

export class VerticalWritingView extends ItemView {
    private editorEl: EditorElement | null = null;
    private syncCoordinator: SyncCoordinator | null = null;

    constructor(leaf: WorkspaceLeaf, private readonly plugin: TatePlugin) {
        super(leaf);
    }

    getViewType(): string { return TATE_VIEW_TYPE; }
    getDisplayText(): string { return '縦書き'; }
    getIcon(): string { return 'pilcrow'; }

    async onOpen(): Promise<void> {
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass('tate-container');

        // ローカル変数に代入することでクロージャ内での ! 不要を排除
        const editorEl = new EditorElement(container);
        this.editorEl = editorEl;
        editorEl.applySettings(this.plugin.settings);

        const syncCoordinator = new SyncCoordinator(
            this.app.vault,
            () => editorEl.getValue(),
            (content, preserveCursor) => editorEl.setValue(content, preserveCursor),
        );
        this.syncCoordinator = syncCoordinator;

        // registerDomEvent で登録することで onClose 時に自動解除される

        this.registerDomEvent(editorEl.el, 'paste', (e: ClipboardEvent) => {
            if (!this.guardCm6(e)) return; // CM6 がなければブロック
            editorEl.handlePaste(e);
            this.commitToCm6(); // ペーストは即時コミット
        });
        this.registerDomEvent(editorEl.el, 'beforeinput', (e: InputEvent) => {
            if (!this.guardCm6(e)) return; // CM6 がなければ入力をブロック（readonly）
            editorEl.onBeforeInput();
        });
        this.registerDomEvent(editorEl.el, 'input', (e: Event) => {
            if (!(e as InputEvent).isComposing) {
                const annotated = editorEl.handleRubyCompletion()
                               || editorEl.handleTcyCompletion()
                               || editorEl.handleBoutenCompletion();
                if (annotated) this.commitToCm6(); // 記法変換は即時コミット
            }
        });
        this.registerDomEvent(editorEl.el, 'compositionend', () => {
            editorEl.handleRubyCompletion();
            editorEl.handleTcyCompletion();
            editorEl.handleBoutenCompletion();
            this.commitToCm6(); // IME 確定はコミットポイント
        });
        this.registerDomEvent(document, 'selectionchange', () => {
            const contentChanged = editorEl.handleSelectionChange();
            if (contentChanged) this.commitToCm6(); // collapse で内容が変わった場合のみ
        });
        this.registerDomEvent(editorEl.el, 'mousedown', () => {
            this.commitToCm6(); // クリックはバースト終了 = コミットポイント
            editorEl.resetBurst();
        });
        this.registerDomEvent(editorEl.el, 'keydown', (e: KeyboardEvent) => {
            // Ctrl+Z / Cmd+Z: Undo、Ctrl+Shift+Z / Cmd+Shift+Z: Redo
            if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key === 'z') {
                e.preventDefault();
                this.doUndoRedo(editorEl, e.shiftKey);
                return;
            }
            // ナビゲーションキーはコミットポイント（次の入力を別の CM6 エントリにする）
            // isComposing=true の間は IME 変換候補選択なので除外する
            if (!e.isComposing && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
                 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
                this.commitToCm6();
                editorEl.resetBurst();
            }
        });

        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                if (file instanceof TFile) syncCoordinator.onExternalModify(file);
            })
        );
        this.registerEvent(
            this.app.vault.on('delete', (file) => {
                if (file instanceof TFile) syncCoordinator.onFileDelete(file);
            })
        );
        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                if (file instanceof TFile) syncCoordinator.onFileRename(file, oldPath);
            })
        );

        // file-open は active-leaf-change より正確にファイル切り替えを検知できる
        this.registerEvent(
            this.app.workspace.on('file-open', (file) => {
                if (!file || file === syncCoordinator.currentFile) return;
                syncCoordinator.loadFile(file);
            })
        );

        await this.loadInitialFile(syncCoordinator);
    }

    private async loadInitialFile(syncCoordinator: SyncCoordinator): Promise<void> {
        // 縦書きビューを開く直前にアクティブだったファイルを使う
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
            await syncCoordinator.loadFile(activeFile);
            return;
        }
        // アクティブファイルがなければ開いている Markdown ビューの先頭ファイルを使う
        for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
            if (leaf.view instanceof MarkdownView && leaf.view.file) {
                await syncCoordinator.loadFile(leaf.view.file);
                return;
            }
        }
    }

    async onClose(): Promise<void> {
        // 閉じる前に未コミットの変更を CM6 に書き込む
        this.commitToCm6();
        this.syncCoordinator?.dispose();
    }

    applySettings(settings: TatePluginSettings): void {
        this.editorEl?.applySettings(settings);
    }

    applyRuby(): void {
        if (!this.editorEl) return;
        if (!this.editorEl.wrapSelectionWithRuby()) {
            new Notice('テキストを選択してください');
        }
        // Ruby はインライン展開状態になるため、collapseEditing 完了時に commitToCm6 が呼ばれる
    }
    applyTcy(): void    { this.applyAnnotation(el => el.wrapSelectionWithTcy()); }
    applyBouten(): void { this.applyAnnotation(el => el.wrapSelectionWithBouten()); }

    private applyAnnotation(wrap: (el: EditorElement) => boolean): void {
        if (!this.editorEl) return;
        if (!wrap(this.editorEl)) {
            new Notice('テキストを選択してください');
        } else {
            this.commitToCm6(); // tcy/bouten は即時確定するのでコミット
        }
    }

    // ---- CM6 連携ヘルパー ----

    /** currentFile を開いている MarkdownView の CM6 エディタを返す。見つからなければ null。 */
    private getCm6Editor(): Editor | null {
        const file = this.syncCoordinator?.currentFile;
        if (!file) return null;
        for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
            const mv = leaf.view;
            if (mv instanceof MarkdownView && mv.file === file) {
                return mv.editor;
            }
        }
        return null;
    }

    /** CM6 エディタが利用できない場合、入力イベントをキャンセルして Notice を出す。
     *  CM6 が利用可能なら true を返す。 */
    private guardCm6(e: Event): boolean {
        if (this.getCm6Editor()) return true;
        e.preventDefault();
        new Notice('縦書きエディタを使用するには、対応する Markdown ビューを開いてください');
        return false;
    }

    /** 縦書きエディタの現在内容を CM6 に全文 replaceRange でコミットする。
     *  内容が変化した場合は CM6 カーソルも縦書きビューのカーソル位置に同期する。
     *  tate-editing 展開中はカーソル同期をスキップ（収束時の selectionchange で同期される）。 */
    private commitToCm6(): void {
        const el = this.editorEl;
        if (!el) return;
        const cm6 = this.getCm6Editor();
        if (!cm6) return;
        const content = el.getValue();
        if (content === cm6.getValue()) return; // 差分なし
        const lastLine = cm6.lastLine();
        const lastCh = cm6.getLine(lastLine).length;
        cm6.replaceRange(content, { line: 0, ch: 0 }, { line: lastLine, ch: lastCh });
        // tate-editing 展開中はカーソル同期をスキップ（カーソルが生テキスト内にあり
        // viewToSrc の入力空間と一致しないため）。収束後の commitToCm6 で正しく同期される。
        if (!el.isInlineExpanded()) {
            const segs = buildSegmentMap(content);
            const srcOffset = viewToSrc(segs, el.getViewCursorOffset());
            cm6.setCursor(cm6.offsetToPos(srcOffset));
        }
        el.resetBurst();
    }

    /** Undo (isRedo=false) または Redo (isRedo=true) を CM6 に委譲し、
     *  srcToView でカーソルを復元する。 */
    private doUndoRedo(editorEl: EditorElement, isRedo: boolean): void {
        const cm6 = this.getCm6Editor();
        if (!cm6) return;
        // 未コミットの変更があれば先にコミット（CM6 undo/redo の基準を揃える）
        this.commitToCm6();
        // CM6 側で Undo/Redo を実行
        if (isRedo) cm6.redo(); else cm6.undo();
        // CM6 の新しい状態を縦書きビューに反映（srcToView でカーソルを復元）
        const newContent = cm6.getValue();
        const srcOffset = cm6.posToOffset(cm6.getCursor());
        editorEl.applyFromCm6(newContent, srcOffset);
    }
}
