# obsidian-tate

Obsidian用の縦書きモードプラグイン。

## ビルド

```bash
npm install       # 初回のみ
npm run dev       # 開発モード（ファイル変更を監視してリビルド）
npm run build     # プロダクションビルド（TypeScript型チェック + esbuild）
```

ビルド成果物は `main.js`（プロジェクトルート）。

## Obsidianへのインストール（開発時）

```bash
cp main.js manifest.json styles.css ~/.obsidian/plugins/obsidian-tate/
```

## ファイル構成

```
src/
├── main.ts                    # TatePlugin（エントリポイント）
├── view.ts                    # VerticalWritingView（ItemView）
├── settings.ts                # TatePluginSettings型 + TateSettingTab
├── sync/
│   └── SyncCoordinator.ts     # 双方向同期制御（外部変更検出・ファイル読み込み）
└── ui/
    ├── EditorElement.ts       # contenteditable div DOM管理
    ├── SegmentMap.ts          # ソースオフセット ↔ 表示オフセット双方向マッピング
    └── SegmentMap.test.ts     # SegmentMap ユニットテスト（vitest）
styles.css                     # 縦書きCSS（writing-mode: vertical-rl）
manifest.json                  # プラグインメタデータ（id: obsidian-tate）
```

## 開発ガイド

- ソースコード（TypeScript・CSS）のコメントはすべて英語で書くこと。
- 設計上の重要な決定事項や調査結果はデザインドキュメントとして `docs/design/YYYYMMDD_{テーマ}.md` に保存すること。日付はファイル名に埋め込み、意思決定の変遷を履歴として参照できるようにする。
- 複数のデザインドキュメント間で記述が競合する場合は、日付が新しいドキュメントの内容が正確である。

## 重要な設計上の決定

詳細はデザインドキュメント（`docs/design/`）を参照:

- [Proxy Editor モデル（双方向同期・Undo/Redo 設計）](docs/design/20260415_proxy_editor_model.md)
- [Aozora 記法のパース・シリアライズ・インライン展開](docs/design/20260415_aozora_inline_editing.md)
- [SegmentMap — ソース ↔ 表示オフセット変換](docs/design/20260415_segment_map.md)
- [DOM・UX 設計決定（contenteditable div・イベント・ペースト・字下げ）](docs/design/20260415_dom_and_ux.md)

## 設定

`TatePluginSettings`（`src/settings.ts`）:
- `fontFamily`: CSS font-family 形式（デフォルト: Hiragino Mincho ProN系）
- `fontSize`: px数値（デフォルト: 18）
- `autoIndent`: 自動字下げ ON/OFF（デフォルト: `true`）
- `lineBreak`: 禁則処理ルール `'normal' | 'strict' | 'loose' | 'anywhere'`（デフォルト: `'normal'`）。CSS `line-break` プロパティに直接渡す

設定変更後は `plugin.applySettingsToAllViews()` を呼んで開いているビューに即時反映する。

## Obsidian API 注意点

- `containerEl.children[1]` がItemViewのコンテンツエリア（Obsidianの慣例）
- `vault.on('modify/delete/rename')` はすべて `registerEvent` で登録すること
- `getLeaf('tab')` でタブを開く（非推奨メソッドを使わない）
- `workspace.getLeavesOfType(TATE_VIEW_TYPE)` で既存の縦書きタブを検索する
