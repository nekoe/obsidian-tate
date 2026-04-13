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
input / compositionend / paste イベントはすべて `this.registerDomEvent(el, ...)` で登録する（`addEventListener` の直接呼び出しは禁止）。Obsidianの `Component.registerDomEvent` を使うと `onClose` 時に自動解除される。

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

**ライブ変換**: `》`/`］` 入力時に `handleRubyCompletion()` / `handleTcyCompletion()` / `handleBoutenCompletion()` が記法を要素に変換する。IME対応のため `input`（`isComposing=false`）と `compositionend` の両方で呼ぶ。テキスト範囲の選択 + `execCommand('insertHTML')` による置換は `execInsertHtml()` に共通化（Undo スタックへの記録も兼ねる）。`handleTcyCompletion` と `handleBoutenCompletion` は `handleAnnotationCompletion()` に共通化。展開中（`expandedEl` が非 null）または DOM 操作中（`isModifyingDom` が true）はライブ変換を行わない（`execCommand` の再入防止）。

### インライン展開（Obsidian Markdown エディタ風）
`document` の `selectionchange` イベントを `registerDomEvent(document, 'selectionchange', ...)` で登録し、カーソル位置に応じて ruby/tcy/bouten 要素をその場で展開・収束する。

- **展開**: カーソルが `<ruby>`・`<span data-tcy="explicit">`・`<span data-bouten>` に入ると `expandForEditing()` が要素を `<span class="tate-editing">` に置換し、Aozora 生テキストを表示する。このとき `expandedElOriginalText` に展開前のテキストを保存する（変化検出用）
- **収束**: カーソルが外れると `collapseEditing()` が `parseInlineToHtml()` で再パースして元の要素に戻す。編集内容は反映される（`parseToHtml()` を使うと段落 `<div>` の中に `<div>` がネストするため禁止）
- **収束と Undo スタック**: `collapseEditing()` は内容が変化した場合（`expandedElOriginalText` との比較）のみ `execCommand('insertHTML')` で収束する。変化なし（カーソルが通過しただけ）の場合は生 DOM 操作にして Undo スタックを汚染しない。`execCommand` は `input` イベントを発火するため、`handleRubyCompletion()` / `handleAnnotationCompletion()` の冒頭に `if (this.isModifyingDom) return` ガードを置いて再入をブロックすること
- **`collapseEditing()` の detached ノード対策**: `collapseEditing()` の先頭で `expandedEl.isConnected` を確認し、false の場合は `expandedEl` / `expandedElOriginalText` をクリアして即リターンする。Undo で編集スパンが DOM から取り除かれたとき、detached ノードに `parentNode` / `selectNode` を呼ぶと例外が発生して `expandedEl = null` が実行されなくなるため（以降のコマンドが `if (this.expandedEl) return false` で常にブロックされる）
- **孤立スパン（orphan span）の検出と再追跡**: `handleSelectionChange()` の `!isModifyingDom` ブロック先頭で `expandedEl` が null または detached のとき `this.el.querySelector('span.tate-editing')` を実行して DOM の実態と同期する。Undo が `collapseEditing()` の `execCommand` を取り消すと editing スパンが DOM に復活するが `expandedEl = null` のまま（孤立スパン）になるため。再追跡後 `expandedElOriginalText = null` にして `hasChanged = true` とすることで確実に収束させる
- **`collapseEditing()` hasChanged パスのフォーカス保証**: `execCommand('insertHTML')` の前に `this.el.focus()` を呼ぶ。editor 外クリック（サイドバーなど）で editor がフォーカスを失っているとき `execCommand` が失敗してスパンが収束されなくなるため
- **カーソル位置**: `rawOffsetForExpand()` が ruby（base/rt それぞれ）・tcy・bouten のカーソル位置を raw テキスト上のオフセットに変換する（tcy/bouten はコンテンツが先頭にあるため `return offset` のみ）
- **再入防止**: `isModifyingDom` フラグで DOM 操作中の `selectionchange` 再入をブロックする
- **`setValue()` との競合防止**: `this.expandedEl = null` / `this.expandedElOriginalText = null` / `this.savedRange = null` は `getValue() === content` の早期リターン**より前**に実行すること（detach 済みノード参照を防ぐ）
- **`collapseEditing()` 後の `savedRange` クリア**: `collapseEditing()` は DOM を再構築するため、その直後に `this.savedRange = null` を実行して stale ノード参照を破棄する
- **複数ビュー対策**: `handleSelectionChange()` 先頭で `expandedEl` が null かつカーソルがエディタ外の場合は即リターンする

### コマンドパレットからの記法適用
`add-ruby` / `add-tcy` / `add-bouten` コマンドで選択テキストに記法を適用できる。

- **選択範囲キャッシュ**: `handleSelectionChange()` の先頭（`isModifyingDom` チェックより前）で、エディタ内に非 collapsed 選択があるとき `savedRange` フィールドに保存する。コマンドパレットを開くとフォーカスが離れるが、エディタ外の selectionchange ではキャッシュを**更新しない**（保持する）ことで、コマンド実行時に選択を復元できる
- **ルビ**: `wrapSelectionWithRuby()` が `execInsertHtml()` で `<span class="tate-editing" data-ruby-new="1">｜text《》</span>` を挿入する。`data-ruby-new` 属性で挿入したスパンを `querySelector` で特定し（挿入後すぐ属性を除去）、`expandedEl` と `expandedElOriginalText` をセットしてインライン展開状態にする。ユーザーがルビ文字を入力後カーソルを外すと `collapseEditing()` が `execCommand('insertHTML')` で `<ruby>` 要素に収束する
- **縦中横・傍点**: `wrapSelectionWith()` に共通化。`execInsertHtml()` で選択テキストを要素に置換する。挿入後は `data-wrap-new="1"` 一時属性で要素を特定し、カーソルを要素の**直後**に置く。カーソルが要素内にあると `selectionchange → expandForEditing()` が呼ばれ、Undo 時に DOM と Undo スタックが不整合になって "tcy 30 と普通の 30 が両方残る" バグが発生するため
- **ライブ変換後のカーソル移動**: `handleRubyCompletion()` / `handleAnnotationCompletion()` でも同様に、`execInsertHtml()` 後に `data-new-el="1"` 一時属性で挿入要素を特定し、カーソルを要素の**直後**に置く。これがないと `execCommand` 後のカーソルが要素内に入り、直後の `selectionchange` で `expandForEditing()` が即座に発火して「`《》` が消えてルビ文字が平文のまま残る」ように見えてしまう
- **エラー通知**: 選択なし・ビュー未開は `new Notice(...)` で通知。`editorEl` が null のときは `applyAnnotation()` が早期リターンする（誤メッセージを出さない）
- **同期**: ラップ成功後に `view.ts` の `applyAnnotation()` が `syncCoordinator.onEditorChange()` を呼ぶ（`EditorElement` は `SyncCoordinator` を知らないため）

### ファイル切り替えの検知
`file-open` ワークスペースイベントを使う（`active-leaf-change` より正確）。縦書きビュー自身がアクティブになっても `file-open` は発火しないため、表示中のファイルが意図せずリセットされない。

### Undo/Redo 対応
記法適用操作（ライブ変換・コマンド）はすべて `document.execCommand('insertHTML')` 経由でブラウザの Undo スタックに記録する。これにより通常入力（キーボード）・ペーストと同一スタックで自然に共存し、ブラウザが Redo（Cmd+Shift+Z）も自動提供する。

- **`execInsertHtml(textNode, start, end, html)`**: テキストノードの `[start, end)` を選択してから `execCommand('insertHTML')` で置換するヘルパー。ライブ変換と収束の共通処理
- **Undo の粒度**:
  - コマンド（tcy/bouten）: 1回のUndoで選択テキストに戻る
  - コマンド（ルビ）: Undoでルビ文字入力を1文字ずつ戻し、最後にコマンド実行前のテキストに戻る
  - ライブ変換（`》`/`］`）: 1回のUndoで変換前のAozora生テキストに戻る
- **生DOM操作との使い分け**: `setValue()`（`innerHTML` 直接代入）と `expandForEditing()`（`replaceChild`）は Undo スタックに載せない。これらは外部変更やカーソル通過など、ユーザー操作の記録対象でないため
- **`execCommand` は deprecated**: `insertHTML` は `insertText`（ペーストで使用中）と同様に deprecated だが、Electron では安定動作する

### ペーストのプレーンテキスト化
`contenteditable` div はデフォルトでクリップボードの `text/html` を優先してペーストするため、インライン展開スパンのスタイルや外部 HTML のスタイルが貼り付けられてしまう。`paste` イベントで `e.preventDefault()` した後、`e.clipboardData.getData('text/plain')` でプレーンテキストのみ取得し、`document.execCommand('insertText', false, text)` で挿入する。`execCommand('insertText')` は deprecated だが Electron では動作し、カーソル位置への挿入・選択範囲の置換・アンドゥ履歴への追加を一括処理できる。

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
- `lineBreak`: 禁則処理ルール `'normal' | 'strict' | 'loose' | 'anywhere'`（デフォルト: `'normal'`）。CSS `line-break` プロパティに直接渡す

設定変更後は `plugin.applySettingsToAllViews()` を呼んで開いているビューに即時反映する。

## Obsidian API 注意点

- `containerEl.children[1]` がItemViewのコンテンツエリア（Obsidianの慣例）
- `vault.on('modify/delete/rename')` はすべて `registerEvent` で登録すること
- `getLeaf('tab')` でタブを開く（非推奨メソッドを使わない）
- `workspace.getLeavesOfType(TATE_VIEW_TYPE)` で既存の縦書きタブを検索する
