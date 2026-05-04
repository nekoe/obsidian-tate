import { TFile, Vault } from 'obsidian';

export class SyncCoordinator {
    // Sequence numbers: discard stale results when loadFile/checkAndApplyExternalChange run concurrently
    private loadSeq = 0;
    private externalCheckSeq = 0;
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
        // Discard if another loadFile was called after this await
        if (seq !== this.loadSeq) return;
        this.setEditorValue(content, false);
    }

    // Reads the current file from vault and applies external changes if the content differs.
    // Called on tate view activation instead of reacting to vault.on('modify').
    // This avoids a race between vault.read() and concurrent commitToCm6() calls that
    // was previously triggering spurious full DOM rebuilds during rapid IME input or Undo spam:
    // while the tate view is active it is the only writer, so vault modify events are always
    // CM6 autosave noise and can be safely ignored until the view is reactivated.
    async checkAndApplyExternalChange(): Promise<void> {
        if (!this.currentFile) return;
        const seq = ++this.externalCheckSeq;
        const externalContent = await this.vault.read(this.currentFile);
        // Discard if a newer check or a file switch happened during the read
        if (seq !== this.externalCheckSeq || this.currentFile === null) return;
        if (externalContent === this.getEditorValue()) return;
        this.setEditorValue(externalContent, true);
    }

    onFileDelete(file: TFile): void {
        if (file !== this.currentFile) return;
        this.currentFile = null;
        this.setEditorValue('', false);
    }

    clearCurrentFile(): void {
        this.currentFile = null;
        // Increment sequence numbers to discard any in-flight loadFile/checkAndApplyExternalChange
        // results, preventing a stale async read from overwriting the cleared editor after this call.
        this.loadSeq++;
        this.externalCheckSeq++;
    }

    onFileRename(file: TFile, oldPath: string): void {
        if (this.currentFile && this.currentFile.path === oldPath) {
            this.currentFile = file;
        }
    }

    dispose(): void {
        // No flush needed: writes are delegated entirely to CM6 autosave
        this.currentFile = null;
    }
}
