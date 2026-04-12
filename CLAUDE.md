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
│   ├── SyncCoordinator.ts     # 双方向同期制御
│   └── DebounceQueue.ts       # デバウンス（flushAndExecute付き）
└── ui/
    └── EditorElement.ts       # contenteditable div DOM管理
styles.css                     # 縦書きCSS（writing-mode: vertical-rl）
manifest.json                  # プラグインメタデータ（id: obsidian-tate）
```

## 重要な設計上の決定

### contenteditable divによる縦書き実現
`writing-mode: vertical-rl` をcontenteditable divに適用する。textareaへの`writing-mode`適用はChrome 119以降が必要だが、ObsidianのElectronバージョンによっては未対応のため、より広く動作するcontenteditable divを採用する。テキストの取得・設定には`innerText`を使用する。

### 双方向同期の競合防止
- `el.innerText` への直接代入はinputイベントを発生させないため、`isApplyingExternalChange` フラグは不要
- `SyncCoordinator.loadFile()` と `onExternalModify()` はどちらも非同期（vault.read）なのでシーケンス番号（loadSeq, externalModifySeq）を使って古い結果を捨てる
- 自分の `vault.modify` が発火した `modify` イベントは内容比較（`externalContent === getEditorValue()`）でスキップ

### ビューを閉じるときのデータロスト防止
`DebounceQueue.flushAndExecute()` はタイマーをキャンセルしつつペンディング中のコールバックを即時実行する。`SyncCoordinator.dispose()` から呼ぶことで、500msデバウンス待機中でもビューを閉じる際に確実に保存される。

### DOMイベントの自動解除
inputイベントは `this.registerDomEvent(el, 'input', ...)` で登録する（`addEventListener` の直接呼び出しは禁止）。Obsidianの `Component.registerDomEvent` を使うと `onClose` 時に自動解除される。

### ファイル切り替えの検知
`file-open` ワークスペースイベントを使う（`active-leaf-change` より正確）。縦書きビュー自身がアクティブになっても `file-open` は発火しないため、表示中のファイルが意図せずリセットされない。

## 設定

`TatePluginSettings`（`src/settings.ts`）:
- `fontFamily`: CSS font-family 形式（デフォルト: Hiragino Mincho ProN系）
- `fontSize`: px数値（デフォルト: 18）

設定変更後は `plugin.applySettingsToAllViews()` を呼んで開いているビューに即時反映する。

## Obsidian API 注意点

- `containerEl.children[1]` がItemViewのコンテンツエリア（Obsidianの慣例）
- `vault.on('modify/delete/rename')` はすべて `registerEvent` で登録すること
- `getLeaf('tab')` でタブを開く（非推奨メソッドを使わない）
- `workspace.getLeavesOfType(TATE_VIEW_TYPE)` で既存の縦書きタブを検索する
