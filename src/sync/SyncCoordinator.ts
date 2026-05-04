import { TFile, Vault } from 'obsidian';

export class SyncCoordinator {
    // Sequence numbers: discard stale results when loadFile/onExternalModify run concurrently
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
        // Discard if another loadFile was called after this await
        if (seq !== this.loadSeq) return;
        this.setEditorValue(content, false);
    }

    async onExternalModify(file: TFile): Promise<void> {
        if (file !== this.currentFile) return;
        const seq = ++this.externalModifySeq;
        // Snapshot committed content before the async gap. A new commit during vault.read()
        // advances getEditorValue(), making the post-read equality check fail even for a CM6
        // autosave of an older commit (e.g. IME confirm → immediate next IME confirm).
        // Comparing against the snapshot catches that case and prevents a spurious full rebuild.
        const committedAtDispatch = this.getEditorValue();
        const externalContent = await this.vault.read(file);
        // Discard stale result if another onExternalModify ran concurrently after this await
        if (seq !== this.externalModifySeq || file !== this.currentFile) return;
        // Skip CM6 autosave events: the vault write may have been queued before a subsequent
        // commit, so compare against both the current committed content and the snapshot.
        if (externalContent === this.getEditorValue()) return;
        if (externalContent === committedAtDispatch) return;
        this.setEditorValue(externalContent, true);
    }

    onFileDelete(file: TFile): void {
        if (file !== this.currentFile) return;
        this.currentFile = null;
        this.setEditorValue('', false);
    }

    clearCurrentFile(): void {
        this.currentFile = null;
        // Increment sequence numbers to discard any in-flight loadFile/onExternalModify results,
        // preventing a stale async read from overwriting the cleared editor after this call.
        this.loadSeq++;
        this.externalModifySeq++;
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
