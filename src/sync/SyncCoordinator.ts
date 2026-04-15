import { TFile, Vault } from 'obsidian';

export class SyncCoordinator {
    // シーケンス番号: loadFile/onExternalModifyが並走したとき古い結果を捨てる
    private loadSeq = 0;
    private externalModifySeq = 0;
    currentFile: TFile | null = null;

    constructor(
        private readonly vault: Vault,
        private readonly getEditorValue: () => string,
        private readonly setEditorValue: (content: string, preserveCursor: boolean) => void,
    ) {}

    async loadFile(file: TFile): Promise<void> {
        const seq = ++this.loadSeq;
        this.currentFile = file;
        const content = await this.vault.read(file);
        // await 後に別の loadFile が呼ばれていたら破棄
        if (seq !== this.loadSeq) return;
        this.setEditorValue(content, false);
    }

    async onExternalModify(file: TFile): Promise<void> {
        if (file !== this.currentFile) return;
        const seq = ++this.externalModifySeq;
        const externalContent = await this.vault.read(file);
        // await 後に別の onExternalModify が並走していたら古い結果を捨てる
        if (seq !== this.externalModifySeq || file !== this.currentFile) return;
        // CM6 の autosave が発火した modify イベントは内容比較でスキップ
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

    dispose(): void {
        // vault.modify は CM6 autosave に一本化されたため、flush 処理は不要
        this.currentFile = null;
    }
}
