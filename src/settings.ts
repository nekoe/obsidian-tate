import { App, PluginSettingTab, Setting } from 'obsidian';
import type TatePlugin from './main';

export interface TatePluginSettings {
    fontFamily: string;
    fontSize: number;
    autoIndent: boolean;
    lineBreak: 'normal' | 'strict' | 'loose' | 'anywhere';
}

export const DEFAULT_SETTINGS: TatePluginSettings = {
    fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", "YuMincho", "MS Mincho", serif',
    fontSize: 18,
    autoIndent: true,
    lineBreak: 'normal',
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

        new Setting(containerEl)
            .setName('自動字下げ')
            .setDesc('各段落の行頭を1文字分インデントする')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoIndent)
                .onChange(async (value) => {
                    this.plugin.settings.autoIndent = value;
                    await this.plugin.saveSettings();
                    this.plugin.applySettingsToAllViews();
                }));

        new Setting(containerEl)
            .setName('禁則処理')
            .setDesc('行頭・行末に置けない文字のルールセット（CSS line-break プロパティ）')
            .addDropdown(dropdown => dropdown
                .addOption('normal',   'Normal   — 一般的な禁則ルール')
                .addOption('strict',   'Strict   — 最も厳格（小書き仮名も行頭不可）')
                .addOption('loose',    'Loose    — 新聞スタイル（改行を優先）')
                .addOption('anywhere', 'Anywhere — 禁則なし（どこでも改行）')
                .setValue(this.plugin.settings.lineBreak)
                .onChange(async (value) => {
                    this.plugin.settings.lineBreak = value as TatePluginSettings['lineBreak'];
                    await this.plugin.saveSettings();
                    this.plugin.applySettingsToAllViews();
                }));
    }
}
