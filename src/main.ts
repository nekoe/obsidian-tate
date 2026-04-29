import { Plugin, WorkspaceLeaf, setIcon } from 'obsidian';
import { TATE_VIEW_TYPE, VerticalWritingView } from './view';
import { DEFAULT_SETTINGS, TatePluginSettings, TateSettingTab } from './settings';

export default class TatePlugin extends Plugin {
    settings: TatePluginSettings = DEFAULT_SETTINGS;
    private cursorPositions: Record<string, number> = {};
    private statusBarItem!: HTMLElement;
    private charCountEl!: HTMLElement;
    // Serializes concurrent saveData() calls so writes are ordered and no update is lost.
    private saveDataPromise: Promise<void> = Promise.resolve();

    async onload(): Promise<void> {
        await this.loadSettings();

        this.statusBarItem = this.addStatusBarItem();
        this.statusBarItem.hide();
        const iconEl = this.statusBarItem.createEl('span', { cls: 'tate-status-icon' });
        setIcon(iconEl, 'tally-3');
        this.charCountEl = this.statusBarItem.createEl('span');

        this.registerView(
            TATE_VIEW_TYPE,
            (leaf) => new VerticalWritingView(leaf, this)
        );

        this.addCommand({
            id: 'open-view',
            name: '縦書きビューを開く',
            checkCallback: (checking) => {
                if (this.getActiveTateView()) return false;
                if (!checking) void this.activateView();
                return true;
            },
        });

        this.addCommand({
            id: 'search',
            name: '検索',
            checkCallback: (checking) => {
                const view = this.getActiveTateView();
                if (!view) return false;
                if (!checking) view.openSearch();
                return true;
            },
        });

        this.addCommand({
            id: 'add-ruby',
            name: '選択テキストにルビを設定 (ruby)',
            checkCallback: (checking) => {
                const view = this.getActiveTateView();
                if (!view) return false;
                if (!checking) view.applyRuby();
                return true;
            },
        });

        this.addCommand({
            id: 'add-tcy',
            name: '選択テキストを縦中横にする (tate-chu-yoko: tcy)',
            checkCallback: (checking) => {
                const view = this.getActiveTateView();
                if (!view) return false;
                if (!checking) view.applyTcy();
                return true;
            },
        });

        this.addCommand({
            id: 'add-bouten',
            name: '選択テキストに傍点を付ける (bouten)',
            checkCallback: (checking) => {
                const view = this.getActiveTateView();
                if (!view) return false;
                if (!checking) view.applyBouten();
                return true;
            },
        });

        this.addSettingTab(new TateSettingTab(this.app, this));

        // Best-effort cursor save on app quit. Not guaranteed to run (Obsidian limitation).
        this.registerEvent(
            this.app.workspace.on('quit', (tasks) => {
                for (const leaf of this.app.workspace.getLeavesOfType(TATE_VIEW_TYPE)) {
                    if (leaf.view instanceof VerticalWritingView) {
                        const p = leaf.view.saveCursorForQuit();
                        if (p) tasks.add(() => p);
                    }
                }
            })
        );
    }

    async loadSettings(): Promise<void> {
        const data = (await this.loadData()) as {
            settings?: Partial<TatePluginSettings>;
            cursorPositions?: Record<string, number>;
        } | null;
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings);
        this.cursorPositions = data?.cursorPositions ?? {};
    }

    async saveSettings(): Promise<void> {
        await this.saveAllData();
    }

    async saveCursorPosition(filePath: string, offset: number): Promise<void> {
        this.cursorPositions[filePath] = offset;
        await this.saveAllData();
    }

    getCursorPosition(filePath: string): number | undefined {
        return this.cursorPositions[filePath];
    }

    async deleteCursorPosition(filePath: string): Promise<void> {
        delete this.cursorPositions[filePath];
        await this.saveAllData();
    }

    renameCursorPosition(oldPath: string, newPath: string): void {
        if (!(oldPath in this.cursorPositions)) return;
        this.cursorPositions[newPath] = this.cursorPositions[oldPath];
        delete this.cursorPositions[oldPath];
        void this.saveAllData();
    }

    private saveAllData(): Promise<void> {
        this.saveDataPromise = this.saveDataPromise
            .then(() => this.saveData({ settings: this.settings, cursorPositions: this.cursorPositions }))
            .catch(() => {});
        return this.saveDataPromise;
    }

    updateCharCount(count: number | null): void {
        if (count === null) {
            this.statusBarItem.hide();
            return;
        }
        this.charCountEl.setText(count.toLocaleString() + '文字');
        this.statusBarItem.show();
    }

    applySettingsToAllViews(): void {
        this.app.workspace.getLeavesOfType(TATE_VIEW_TYPE).forEach((leaf: WorkspaceLeaf) => {
            if (leaf.view instanceof VerticalWritingView) {
                leaf.view.applySettings(this.settings);
            }
        });
    }

    private getActiveTateView(): VerticalWritingView | null {
        return this.app.workspace.getActiveViewOfType(VerticalWritingView);
    }

    private async activateView(): Promise<void> {
        const existing = this.app.workspace.getLeavesOfType(TATE_VIEW_TYPE);
        if (existing.length > 0) {
            void this.app.workspace.revealLeaf(existing[0]);
            return;
        }
        const leaf = this.app.workspace.getLeaf('tab');
        await leaf.setViewState({ type: TATE_VIEW_TYPE, active: true });
        void this.app.workspace.revealLeaf(leaf);
    }
}
