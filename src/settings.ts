import { App, PluginSettingTab, Setting } from 'obsidian';
import type TatePlugin from './main';

export interface TatePluginSettings {
    fontFamily: string;
    fontSize: number;
    lineBreak: 'normal' | 'strict' | 'loose' | 'anywhere';
    convertHalfWidthSpace: boolean;
    autoIndentOnInput: boolean;
    matchPrecedingIndent: boolean;
    removeBracketIndent: boolean;
    expandRubyInline: boolean;
    expandTcyInline: boolean;
    expandBoutenInline: boolean;
}

export const DEFAULT_SETTINGS: TatePluginSettings = {
    fontFamily: '"Hiragino Mincho ProN", "Yu Mincho", "YuMincho", "MS Mincho", serif',
    fontSize: 18,
    lineBreak: 'normal',
    convertHalfWidthSpace: true,
    autoIndentOnInput: true,
    matchPrecedingIndent: true,
    removeBracketIndent: true,
    expandRubyInline: true,
    expandTcyInline: true,
    expandBoutenInline: true,
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
        new Setting(containerEl).setName('縦書きビュー 設定').setHeading();

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

        new Setting(containerEl).setName('字下げ設定').setHeading();

        new Setting(containerEl)
            .setName('入力された半角スペースを全角スペースに変換')
            .setDesc('スペースキーで入力した半角スペースを全角スペース（　）に変換する')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.convertHalfWidthSpace)
                .onChange(async (value) => {
                    this.plugin.settings.convertHalfWidthSpace = value;
                    await this.plugin.saveSettings();
                    this.plugin.applySettingsToAllViews();
                }));

        new Setting(containerEl)
            .setName('行頭に文字を入力すると自動で字下げ')
            .setDesc('行頭にカーソルがある状態で文字を入力すると、一文字分の全角スペースを自動挿入する')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoIndentOnInput)
                .onChange(async (value) => {
                    this.plugin.settings.autoIndentOnInput = value;
                    await this.plugin.saveSettings();
                    this.plugin.applySettingsToAllViews();
                }));

        new Setting(containerEl)
            .setName('字下げを前の行に揃える')
            .setDesc('前の段落の先頭全角スペース数に合わせる')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.matchPrecedingIndent)
                .onChange(async (value) => {
                    this.plugin.settings.matchPrecedingIndent = value;
                    await this.plugin.saveSettings();
                    this.plugin.applySettingsToAllViews();
                }));

        new Setting(containerEl)
            .setName('行頭に開きカギ括弧が入力された場合に字下げを自動削除')
            .setDesc('行頭の全角スペースの後ろに全角開き括弧を入力したとき、行頭の全角スペースを1文字削除する')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.removeBracketIndent)
                .onChange(async (value) => {
                    this.plugin.settings.removeBracketIndent = value;
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

        new Setting(containerEl).setName('インライン展開').setHeading();

        new Setting(containerEl)
            .setName('ルビをインライン展開する')
            .setDesc('カーソルがルビ上に移動したとき、青空記法テキストに展開して編集できるようにする')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.expandRubyInline)
                .onChange(async (value) => {
                    this.plugin.settings.expandRubyInline = value;
                    await this.plugin.saveSettings();
                    this.plugin.applySettingsToAllViews();
                }));

        new Setting(containerEl)
            .setName('縦中横をインライン展開する')
            .setDesc('カーソルが縦中横上に移動したとき、青空記法テキストに展開して編集できるようにする')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.expandTcyInline)
                .onChange(async (value) => {
                    this.plugin.settings.expandTcyInline = value;
                    await this.plugin.saveSettings();
                    this.plugin.applySettingsToAllViews();
                }));

        new Setting(containerEl)
            .setName('傍点をインライン展開する')
            .setDesc('カーソルが傍点上に移動したとき、青空記法テキストに展開して編集できるようにする')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.expandBoutenInline)
                .onChange(async (value) => {
                    this.plugin.settings.expandBoutenInline = value;
                    await this.plugin.saveSettings();
                    this.plugin.applySettingsToAllViews();
                }));
    }
}
