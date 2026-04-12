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
`writing-mode: vertical-rl` をcontenteditable divに適用する。textareaへの`writing-mode`適用はChrome 119以降が必要だが、ObsidianのElectronバージョンによっては未対応のため、より広く動作するcontenteditable divを採用する。テキストの取得には `getValue()`（カスタム `serializeNode()` DOMウォーカー）、設定には `setValue()`（`innerHTML = parseToHtml(content)`）を使用する。

### 双方向同期の競合防止
- `el.innerHTML` への直接代入はinputイベントを発生させないため、`isApplyingExternalChange` フラグは不要
- `SyncCoordinator.loadFile()` と `onExternalModify()` はどちらも非同期（vault.read）なのでシーケンス番号（loadSeq, externalModifySeq）を使って古い結果を捨てる
- 自分の `vault.modify` が発火した `modify` イベントは内容比較（`externalContent === getEditorValue()`）でスキップ

### ビューを閉じるときのデータロスト防止
`DebounceQueue.flushAndExecute()` はタイマーをキャンセルしつつペンディング中のコールバックを即時実行する。`SyncCoordinator.dispose()` から呼ぶことで、500msデバウンス待機中でもビューを閉じる際に確実に保存される。

### DOMイベントの自動解除
inputイベントと compositionend イベントは `this.registerDomEvent(el, 'input', ...)` / `this.registerDomEvent(el, 'compositionend', ...)` で登録する（`addEventListener` の直接呼び出しは禁止）。Obsidianの `Component.registerDomEvent` を使うと `onClose` 時に自動解除される。

### Aozora記法のパース・シリアライズ
`EditorElement` が青空文庫記法とDOM要素の双方向変換を担う。

**パースパイプライン**（`parseToHtml()` → `innerHTML`）:  
`applyParsers()` が `ParseSegment[]`（`text` / `html` の union型）を順番に変換する。優先順位:

1. 明示ルビ `|base《rt》` → `<ruby data-ruby-explicit="true">`
2. 明示縦中横 `X［＃「X」は縦中横］` → `<span data-tcy="explicit" class="tcy">`
3. 省略ルビ `kanji《rt》`（直前の漢字連続を自動検出）→ `<ruby data-ruby-explicit="false">`

**シリアライズ**（`serializeNode()` → ファイルテキスト）:
- `<ruby data-ruby-explicit="true">` → `|base《rt》`
- `<ruby data-ruby-explicit="false">` → `base《rt》`
- `<span data-tcy="explicit">` → `X［＃「X」は縦中横］`
- `<span class="tate-editing">` → 子ノードのテキストをそのまま返す（インライン展開中の生テキスト）

**ライブ変換**: `》` / `］` 入力時に `handleRubyCompletion()` / `handleTcyCompletion()` がDOMを直接書き換える。IME対応のため `input`（`isComposing=false`）と `compositionend` の両方で呼ぶ。DOM操作（テキストノード分割→要素挿入→カーソル配置）は `replaceTextWithElement()` に共通化。展開中（`expandedEl` が非 null）はライブ変換を行わない。

### インライン展開（Obsidian Markdown エディタ風）
`document` の `selectionchange` イベントを `registerDomEvent(document, 'selectionchange', ...)` で登録し、カーソル位置に応じて ruby/tcy 要素をその場で展開・収束する。

- **展開**: カーソルが `<ruby>` または `<span data-tcy="explicit">` に入ると `expandForEditing()` が要素を `<span class="tate-editing">` に置換し、Aozora 生テキストを表示する
- **収束**: カーソルが外れると `collapseEditing()` が `parseToHtml()` で再パースして元の要素に戻す。編集内容は反映される
- **カーソル位置**: `rawOffsetForExpand()` が ruby（base/rt それぞれ）・tcy のカーソル位置を raw テキスト上のオフセットに変換する
- **再入防止**: `isModifyingDom` フラグで DOM 操作中の `selectionchange` 再入をブロックする
- **`setValue()` との競合防止**: `this.expandedEl = null` は `getValue() === content` の早期リターン**より前**に実行すること（detach 済みノード参照を防ぐ）
- **複数ビュー対策**: `handleSelectionChange()` 先頭で `expandedEl` が null かつカーソルがエディタ外の場合は即リターンする

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
