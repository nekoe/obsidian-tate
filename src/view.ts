import { ItemView, MarkdownView, TFile, WorkspaceLeaf } from 'obsidian';
import type TatePlugin from './main';
import { SyncCoordinator } from './sync/SyncCoordinator';
import { EditorElement } from './ui/EditorElement';
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
        this.registerDomEvent(editorEl.el, 'input', (e: Event) => {
            syncCoordinator.onEditorChange();
            if (!(e as InputEvent).isComposing) {
                editorEl.handleRubyCompletion();
            }
        });
        this.registerDomEvent(editorEl.el, 'compositionend', () => {
            editorEl.handleRubyCompletion();
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
        // dispose() は未保存の書き込みを即時実行してからクリーンアップする
        await this.syncCoordinator?.dispose();
    }

    applySettings(settings: TatePluginSettings): void {
        this.editorEl?.applySettings(settings);
    }
}
