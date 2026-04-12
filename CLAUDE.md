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

**パースパイプライン**（`parseToHtml()` / `parseInlineToHtml()` → `innerHTML`）:

`parseToHtml()` と `parseInlineToHtml()` の2層構造になっている:
- `parseToHtml(text)`: `setValue()` 用。テキストを `\n` で分割し、各段落を `<div>` で包む（字下げのため）。空文字の場合は `''` を返して `:empty::before` プレースホルダーを有効にする
- `parseInlineToHtml(text)`: `collapseEditing()` 用。`<div>` で包まずインライン記法のみ変換する。段落 `<div>` の内側で収束処理を行う際に呼ぶ（`parseToHtml()` を使うと `<div>` がネストしてしまう）

`applyParsers()` が `ParseSegment[]`（`text` / `html` の union型）を順番に変換する。優先順位:

1. 明示ルビ `｜base《rt》`（`|` 半角も受け付ける）→ `<ruby data-ruby-explicit="true">`
2. 明示縦中横 `X［＃「X」は縦中横］` → `<span data-tcy="explicit" class="tcy">`
3. 傍点 `X［＃「X」に傍点］` → `<span data-bouten="sesame" class="bouten">`
4. 省略ルビ `kanji《rt》`（直前の漢字連続を自動検出）→ `<ruby data-ruby-explicit="false">`

縦中横・傍点は同一構造の「前方参照型アノテーション記法」なので `splitByAnnotation()` に共通化されている。

**シリアライズ**（`serializeNode()` → ファイルテキスト）:
- `<ruby data-ruby-explicit="true">` → `｜base《rt》`（全角 `｜` U+FF5C で出力）
- `<ruby data-ruby-explicit="false">` → `base《rt》`
- `<span data-tcy="explicit">` → `X［＃「X」は縦中横］`
- `<span data-bouten="sesame">` → `X［＃「X」に傍点］`
- `<span class="tate-editing">` → 子ノードのテキストをそのまま返す（インライン展開中の生テキスト）

**ルビ区切り文字 `｜` の表示制御**: シリアライズは全角 `｜` で統一し、収束時は `<ruby>` 要素内なので不可視。インライン展開時の生テキストとしてのみ可視になる。

**ライブ変換**: `》`/`］` 入力時に `handleRubyCompletion()` / `handleTcyCompletion()` / `handleBoutenCompletion()` がDOMを直接書き換える。IME対応のため `input`（`isComposing=false`）と `compositionend` の両方で呼ぶ。DOM操作（テキストノード分割→要素挿入→カーソル配置）は `replaceTextWithElement()` に共通化。`handleTcyCompletion` と `handleBoutenCompletion` は `handleAnnotationCompletion()` に共通化。展開中（`expandedEl` が非 null）はライブ変換を行わない。

### インライン展開（Obsidian Markdown エディタ風）
`document` の `selectionchange` イベントを `registerDomEvent(document, 'selectionchange', ...)` で登録し、カーソル位置に応じて ruby/tcy/bouten 要素をその場で展開・収束する。

- **展開**: カーソルが `<ruby>`・`<span data-tcy="explicit">`・`<span data-bouten>` に入ると `expandForEditing()` が要素を `<span class="tate-editing">` に置換し、Aozora 生テキストを表示する
- **収束**: カーソルが外れると `collapseEditing()` が `parseInlineToHtml()` で再パースして元の要素に戻す。編集内容は反映される（`parseToHtml()` を使うと段落 `<div>` の中に `<div>` がネストするため禁止）
- **カーソル位置**: `rawOffsetForExpand()` が ruby（base/rt それぞれ）・tcy・bouten のカーソル位置を raw テキスト上のオフセットに変換する（tcy/bouten はコンテンツが先頭にあるため `return offset` のみ）
- **再入防止**: `isModifyingDom` フラグで DOM 操作中の `selectionchange` 再入をブロックする
- **`setValue()` との競合防止**: `this.expandedEl = null` と `this.savedRange = null` は `getValue() === content` の早期リターン**より前**に実行すること（detach 済みノード参照を防ぐ）
- **`collapseEditing()` 後の `savedRange` クリア**: `collapseEditing()` は DOM を再構築するため、その直後に `this.savedRange = null` を実行して stale ノード参照を破棄する
- **複数ビュー対策**: `handleSelectionChange()` 先頭で `expandedEl` が null かつカーソルがエディタ外の場合は即リターンする

### コマンドパレットからの記法適用
`add-ruby` / `add-tcy` / `add-bouten` コマンドで選択テキストに記法を適用できる。

- **選択範囲キャッシュ**: `handleSelectionChange()` の先頭（`isModifyingDom` チェックより前）で、エディタ内に非 collapsed 選択があるとき `savedRange` フィールドに保存する。コマンドパレットを開くとフォーカスが離れるが、エディタ外の selectionchange ではキャッシュを**更新しない**（保持する）ことで、コマンド実行時に選択を復元できる
- **ルビ**: `wrapSelectionWithRuby()` が選択テキストを `｜text《》` とした `<span class="tate-editing">` スパンとして挿入し、`expandedEl` をセットしてインライン展開状態にする。ユーザーがルビ文字を入力後カーソルを外すと `collapseEditing()` が `<ruby>` 要素に収束する
- **縦中横・傍点**: `wrapSelectionWith()` に共通化。`savedRange` の選択テキストを `replaceTextWithElement()` で要素に置換する
- **エラー通知**: 選択なし・ビュー未開は `new Notice(...)` で通知。`editorEl` が null のときは `applyAnnotation()` が早期リターンする（誤メッセージを出さない）
- **同期**: ラップ成功後に `view.ts` の `applyAnnotation()` が `syncCoordinator.onEditorChange()` を呼ぶ（`EditorElement` は `SyncCoordinator` を知らないため）

### ファイル切り替えの検知
`file-open` ワークスペースイベントを使う（`active-leaf-change` より正確）。縦書きビュー自身がアクティブになっても `file-open` は発火しないため、表示中のファイルが意図せずリセットされない。

### 自動字下げ
`text-indent: 1em` を CSS で適用する（ファイルには保存しない）。

- `parseToHtml()` が段落を `<div>` で包む構造になっているため、`.tate-editor.tate-auto-indent` に `text-indent: 1em` を設定するだけで CSS 継承により各段落 `<div>` にも適用される
- ユーザーが新規入力中（まだ `<div>` が生成されていない状態）でも、`.tate-editor` 自体の `text-indent` が直接テキストに適用されるため、常に字下げが有効になる
- `applySettings()` で `el.toggleClass('tate-auto-indent', settings.autoIndent)` によりクラスを付け外しする

## 設定

`TatePluginSettings`（`src/settings.ts`）:
- `fontFamily`: CSS font-family 形式（デフォルト: Hiragino Mincho ProN系）
- `fontSize`: px数値（デフォルト: 18）
- `autoIndent`: 自動字下げ ON/OFF（デフォルト: `true`）

設定変更後は `plugin.applySettingsToAllViews()` を呼んで開いているビューに即時反映する。

## Obsidian API 注意点

- `containerEl.children[1]` がItemViewのコンテンツエリア（Obsidianの慣例）
- `vault.on('modify/delete/rename')` はすべて `registerEvent` で登録すること
- `getLeaf('tab')` でタブを開く（非推奨メソッドを使わない）
- `workspace.getLeavesOfType(TATE_VIEW_TYPE)` で既存の縦書きタブを検索する
