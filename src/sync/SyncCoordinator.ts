import { TFile, Vault } from 'obsidian';

// Maximum number of self-written contents to track for vault.on('modify') discrimination.
// CM6 may write intermediate versions to vault (one debounce flush per quiet period), so
// we need to remember more than just the latest committed content.
const MAX_SELF_WRITES = 20;

export class SyncCoordinator {
    // Sequence numbers: discard stale results when loadFile/checkAndApplyExternalChange run concurrently
    private loadSeq = 0;
    private externalCheckSeq = 0;
    currentFile: TFile | null = null;

    // Rolling set of recent self-written contents. CM6 may autosave an intermediate committed
    // version after we have already advanced to a newer version, causing vault.on('modify')
    // to fire with stale content. Tracking all recent commits lets onModify() reliably
    // distinguish self-writes (any version in this set) from external changes (not in this set).
    private readonly selfWriteContents = new Set<string>();

    constructor(
        private readonly vault: Vault,
        private readonly getEditorValue: () => string,
        private readonly setEditorValue: (content: string, preserveCursor: boolean) => void,
    ) {}

    async loadFile(file: TFile): Promise<void> {
        const seq = ++this.loadSeq;
        this.currentFile = file;
        this.selfWriteContents.clear(); // discard previous file's history
        const content = await this.vault.read(file);
        // Discard if another loadFile was called after this await
        if (seq !== this.loadSeq) return;
        this.setEditorValue(content, false);
    }

    // Records a self-written content so onModify() can identify the resulting vault.on('modify')
    // event as a self-write and ignore it. Called by view.ts after every commitToCm6().
    notifySelfWrite(content: string): void {
        this.selfWriteContents.add(content);
        if (this.selfWriteContents.size > MAX_SELF_WRITES) {
            // Set iteration is insertion-ordered; delete the oldest entry
            this.selfWriteContents.delete(this.selfWriteContents.values().next().value!);
        }
    }

    // Handles vault.on('modify'): ignores self-writes (CM6 autosave), applies external changes
    // (e.g. Obsidian Sync delivering an edit from another machine while this view is active).
    async onModify(file: TFile): Promise<void> {
        if (file !== this.currentFile) return;
        const seq = ++this.externalCheckSeq;
        const vaultContent = await this.vault.read(file);
        // Discard if a newer check or a file switch happened during the read
        if (seq !== this.externalCheckSeq || this.currentFile === null) return;
        // Self-write: vault received a content that we committed — ignore
        if (this.selfWriteContents.has(vaultContent)) return;
        // Already current: vault and editor agree (race-free double-check)
        if (vaultContent === this.getEditorValue()) return;
        this.setEditorValue(vaultContent, true);
    }

    // Reads the current file from vault and applies external changes if the content differs.
    // Called on tate view activation to catch changes made while the view was inactive
    // (e.g. edits in MarkdownView, or Obsidian Sync delivering changes between sessions).
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
        this.selfWriteContents.clear();
        this.setEditorValue('', false);
    }

    clearCurrentFile(): void {
        this.currentFile = null;
        this.selfWriteContents.clear();
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
        this.selfWriteContents.clear();
    }
}
