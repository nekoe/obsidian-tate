import { App, PluginSettingTab, Setting } from 'obsidian';
import type TatePlugin from './main';

export interface TatePluginSettings {
    fontFamily: string;
    fontSize: number;
}

export const DEFAULT_SETTINGS: TatePluginSettings = {
    fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", "YuMincho", "MS Mincho", serif',
    fontSize: 18,
};

export class TateSettingTab extends PluginSettingTab {
    plugin: TatePlugin;

    constructor(app: App, plugin: TatePlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: '縦書きビュー 設定' });

        new Setting(containerEl)
            .setName('フォントファミリー')
            .setDesc('縦書き表示に使うフォント（CSS font-family 形式）')
            .addText(text => text
                .setPlaceholder('"Hiragino Mincho ProN", serif')
                .setValue(this.plugin.settings.fontFamily)
                .onChange(async (value) => {
                    this.plugin.settings.fontFamily = value;
                    await this.plugin.saveSettings();
                    this.plugin.applySettingsToAllViews();
                }));

        new Setting(containerEl)
            .setName('フォントサイズ (px)')
            .setDesc('縦書きビューのフォントサイズ（ピクセル）')
            .addSlider(slider => slider
                .setLimits(10, 48, 1)
                .setValue(this.plugin.settings.fontSize)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.fontSize = value;
                    await this.plugin.saveSettings();
                    this.plugin.applySettingsToAllViews();
                }));
    }
}
