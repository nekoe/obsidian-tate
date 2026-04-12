import { TFile, Vault } from 'obsidian';
import { DebounceQueue } from './DebounceQueue';

export class SyncCoordinator {
    private readonly writeDebounce: DebounceQueue;
    // シーケンス番号: loadFile/onExternalModifyが並走したとき古い結果を捨てる
    private loadSeq = 0;
    private externalModifySeq = 0;
    currentFile: TFile | null = null;

    constructor(
        private readonly vault: Vault,
        private readonly getEditorValue: () => string,
        private readonly setEditorValue: (content: string, preserveCursor: boolean) => void,
        debounceMs = 500
    ) {
        this.writeDebounce = new DebounceQueue(debounceMs);
    }

    async loadFile(file: TFile): Promise<void> {
        const seq = ++this.loadSeq;
        this.currentFile = file;
        const content = await this.vault.read(file);
        // await 後に別の loadFile が呼ばれていたら破棄
        if (seq !== this.loadSeq) return;
        this.setEditorValue(content, false);
    }

    onEditorChange(): void {
        if (!this.currentFile) return;
        // textarea.value への直接代入は input イベントを発生させないため、
        // isApplyingExternalChange フラグは不要
        this.writeDebounce.schedule(async () => {
            if (!this.currentFile) return;
            await this.vault.modify(this.currentFile, this.getEditorValue());
        });
    }

    async onExternalModify(file: TFile): Promise<void> {
        if (file !== this.currentFile) return;
        const seq = ++this.externalModifySeq;
        const externalContent = await this.vault.read(file);
        // await 後に別の onExternalModify が並走していたら古い結果を捨てる
        if (seq !== this.externalModifySeq || file !== this.currentFile) return;
        // vault.modify した自分自身の書き込みによるイベントなら無視
        if (externalContent === this.getEditorValue()) return;
        this.setEditorValue(externalContent, true);
    }

    onFileDelete(file: TFile): void {
        if (file !== this.currentFile) return;
        this.currentFile = null;
        this.setEditorValue('', false);
    }

    onFileRename(file: TFile, oldPath: string): void {
        if (this.currentFile && this.currentFile.path === oldPath) {
            this.currentFile = file;
        }
    }

    async dispose(): Promise<void> {
        // デバウンス待機中の書き込みがあれば即時実行してからクリーンアップ
        await this.writeDebounce.flushAndExecute();
        this.currentFile = null;
    }
}
