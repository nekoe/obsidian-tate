import { Plugin, WorkspaceLeaf } from 'obsidian';
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

        this.addRibbonIcon('pilcrow', '縦書きで開く', () => this.activateView());

        this.addCommand({
            id: 'open-tate-view',
            name: 'TATE: Open vertical writing view',
            callback: () => this.activateView(),
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

    private async activateView(): Promise<void> {
        const existing = this.app.workspace.getLeavesOfType(TATE_VIEW_TYPE);
        if (existing.length > 0) {
            this.app.workspace.revealLeaf(existing[0]);
            return;
        }
        const leaf = this.app.workspace.getLeaf('tab');
        await leaf.setViewState({ type: TATE_VIEW_TYPE, active: true });
        this.app.workspace.revealLeaf(leaf);
    }
}
