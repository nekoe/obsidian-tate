import { Notice, Plugin, WorkspaceLeaf } from 'obsidian';
import { TATE_VIEW_TYPE, VerticalWritingView } from './view';
import { DEFAULT_SETTINGS, TatePluginSettings, TateSettingTab } from './settings';

export default class TatePlugin extends Plugin {
    settings: TatePluginSettings = DEFAULT_SETTINGS;

    async onload(): Promise<void> {
        await this.loadSettings();

        this.registerView(
            TATE_VIEW_TYPE,
            (leaf) => new VerticalWritingView(leaf, this)
        );

        this.addCommand({
            id: 'open-view',
            name: '縦書きViewを開く',
            callback: () => this.activateView(),
        });

        this.addCommand({
            id: 'add-ruby',
            name: '選択テキストにルビを設定 (Ruby)',
            callback: () => this.dispatchToView(v => v.applyRuby()),
        });

        this.addCommand({
            id: 'add-tcy',
            name: '選択テキストを縦中横にする (Tate-Chu-Yoko: TCY)',
            callback: () => this.dispatchToView(v => v.applyTcy()),
        });

        this.addCommand({
            id: 'add-bouten',
            name: '選択テキストに傍点を付ける (Bouten)',
            callback: () => this.dispatchToView(v => v.applyBouten()),
        });

        this.addSettingTab(new TateSettingTab(this.app, this));
    }

    async loadSettings(): Promise<void> {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    applySettingsToAllViews(): void {
        this.app.workspace.getLeavesOfType(TATE_VIEW_TYPE).forEach((leaf: WorkspaceLeaf) => {
            if (leaf.view instanceof VerticalWritingView) {
                leaf.view.applySettings(this.settings);
            }
        });
    }

    private dispatchToView(action: (view: VerticalWritingView) => void): void {
        const leaves = this.app.workspace.getLeavesOfType(TATE_VIEW_TYPE);
        if (leaves.length === 0) {
            new Notice('縦書きビューが開いていません');
            return;
        }
        action(leaves[0].view as VerticalWritingView);
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
