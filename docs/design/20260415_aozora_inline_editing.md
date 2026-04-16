# Aozora 記法のパース・シリアライズ・インライン展開

作成日: 2026-04-15

## Aozora 記法のパース・シリアライズ

`AozoraParser.ts` が青空文庫記法と DOM 要素の双方向変換を担う。

### パースパイプライン（`parseToHtml()` / `parseInlineToHtml()` → DOM）

`parseToHtml()` と `parseInlineToHtml()` の 2 層構造:
- `parseToHtml(text)`: `setValue()` 用。テキストを `\n` で分割し、各段落を `<div>` で包む（字下げのため）。空文字の場合は `''` を返して `:empty::before` プレースホルダーを有効にする
- `parseInlineToHtml(text)`: `collapseEditing()` 用。`<div>` で包まずインライン記法のみ変換する

`applyParsers()` が `ParseSegment[]`（`text` / `html` の union 型）を順番に変換する。優先順位:

1. 明示ルビ `｜base《rt》`（`|` 半角も受け付ける）→ `<ruby data-ruby-explicit="true">`
2. 明示縦中横 `X［＃「X」は縦中横］` → `<span data-tcy="explicit" class="tcy">`
3. 傍点 `X［＃「X」に傍点］` → `<span data-bouten="sesame" class="bouten">`
4. 省略ルビ `kanji《rt》`（直前の漢字連続を自動検出）→ `<ruby data-ruby-explicit="false">`

縦中横・傍点は同一構造の「前方参照型アノテーション記法」なので `splitByAnnotation()` に共通化されている。

### シリアライズ（`serializeNode()` → ファイルテキスト）

- `<ruby data-ruby-explicit="true">` → `｜base《rt》`（全角 `｜` U+FF5C で出力）
- `<ruby data-ruby-explicit="false">` → `base《rt》`
- `<span data-tcy="explicit">` → `X［＃「X」は縦中横］`
- `<span data-bouten="sesame">` → `X［＃「X」に傍点］`
- `<span class="tate-editing">` → 子ノードのテキストをそのまま返す（インライン展開中の生テキスト）

**重要**: `getValue()` は tate-editing スパン展開中・収束後いずれの状態でも同じ Aozora 生テキストを返す。

**ルビ区切り文字 `｜` の表示制御**: シリアライズは全角 `｜` で統一し、収束時は `<ruby>` 要素内なので不可視。インライン展開時の生テキストとしてのみ可視になる。

### ライブ変換

`》`/`］` 入力時に `handleRubyCompletion()` / `handleTcyCompletion()` / `handleBoutenCompletion()` が記法を要素に変換する。IME 対応のため `input`（`isComposing=false`）と `compositionend` の両方で呼ぶ。全操作は `insertAnnotationElement()` による直接 DOM 操作で統一（`execCommand` 不使用）。`handleTcyCompletion` と `handleBoutenCompletion` は `handleAnnotationCompletion()` に共通化。これらのメソッドは `boolean`（変換が発生したか）を返し、`view.ts` が `true` のとき `commitToCm6()` を呼ぶ。展開中（`expandedEl` が非 null）または DOM 操作中（`isModifyingDom` が true）はライブ変換を行わない（再入防止）。

## インライン展開（Obsidian Markdown エディタ風）

`document` の `selectionchange` イベントを `registerDomEvent(document, 'selectionchange', ...)` で登録し、カーソル位置に応じて ruby/tcy/bouten 要素をその場で展開・収束する。

### 展開

カーソルが `<ruby>`・`<span data-tcy="explicit">`・`<span data-bouten>` に入ると `expandForEditing()` が要素を `<span class="tate-editing">` に置換し、Aozora 生テキストを表示する。このとき `expandedElOriginalText` に展開前のテキストを保存する（変化検出用）。`inBurst = false` もリセットする。

### 収束

カーソルが外れると `collapseEditing()` が `parseInlineToHtml()` で再パースして元の要素に戻す。編集内容は反映される（`parseToHtml()` を使うと段落 `<div>` の中に `<div>` がネストするため禁止）。収束は常に直接 DOM 操作で統一（`execCommand` 不使用）。`collapseEditing()` は `boolean`（内容変化の有無）を返す。`view.ts` の `selectionchange` ハンドラが `true` のとき `commitToCm6()` を呼ぶ。

### `collapseEditing()` の前方テキスト取り込み

`getExtraCharsFromAnnotation()` が「」内容とスパン内前方テキストを比較し、「」内容が長い場合（例: content=`130`, leading=`30` → 差分=`1`文字）は直前テキストノードの末尾から一致する文字を取り込む（例: テキスト `A1` + tcy `30` → 「30」→「130」編集 → テキスト `A` + tcy `130`）。

### `collapseEditing()` の detached ノード対策

`collapseEditing()` の先頭で `expandedEl.isConnected` を確認し、false の場合は `expandedEl` / `expandedElOriginalText` をクリアして即リターンする。detached ノードに `parentNode` / `selectNode` を呼ぶと例外が発生するため。

### 孤立スパン（orphan span）の検出と再追跡

`handleSelectionChange()` の `!isModifyingDom` ブロック先頭で `expandedEl` が null または detached のとき `this.el.querySelector('span.tate-editing')` を実行して DOM の実態と同期する。予期せぬ経路で編集スパンが DOM に残った場合のロバストネス対策。再追跡後 `expandedElOriginalText = null` にして `hasChanged = true` とすることで確実に収束させる。

### カーソル位置

`rawOffsetForExpand()` が ruby（base/rt それぞれ）・tcy・bouten のカーソル位置を raw テキスト上のオフセットに変換する（tcy/bouten はコンテンツが先頭にあるため `return offset` のみ）。

### 再入防止

`isModifyingDom` フラグで DOM 操作中の `selectionchange` 再入をブロックする。

### `setValue()` との競合防止

`this.expandedEl = null` / `this.expandedElOriginalText = null` / `this.savedRange = null` は `getValue() === content` の早期リターン**より前**に実行すること（detach 済みノード参照を防ぐ）。

### `collapseEditing()` 後の `savedRange` クリア

`collapseEditing()` は DOM を再構築するため、その直後に `this.savedRange = null` を実行して stale ノード参照を破棄する。

### 複数ビュー対策

`handleSelectionChange()` 先頭で `expandedEl` が null かつカーソルがエディタ外の場合は即リターンする。

## コマンドパレットからの記法適用

`add-ruby` / `add-tcy` / `add-bouten` コマンドで選択テキストに記法を適用できる。

### 選択範囲キャッシュ

`handleSelectionChange()` の先頭（`isModifyingDom` チェックより前）で、エディタ内に非 collapsed 選択があるとき `savedRange` フィールドに保存する。コマンドパレットを開くとフォーカスが離れるが、エディタ外の selectionchange ではキャッシュを**更新しない**（保持する）ことで、コマンド実行時に選択を復元できる。

### ルビ

`wrapSelectionWithRuby()` が直接 DOM 操作で `<span class="tate-editing">｜text《》</span>` を挿入する。`expandedEl` と `expandedElOriginalText` を直接セットしてインライン展開状態にする。ユーザーがルビ文字を入力後カーソルを外すと `collapseEditing()` が `<ruby>` 要素に収束し、`view.ts` の selectionchange ハンドラが `commitToCm6()` を呼ぶ。

### 縦中横・傍点

`wrapSelectionWith()` に共通化。`insertAnnotationElement()` で直接 DOM 操作により選択テキストを要素に置換する。`setCursorAfter()` でカーソルを要素の**直後**に置く。カーソルが要素内にあると `selectionchange → expandForEditing()` が呼ばれ意図しない展開が発生するため。

### ライブ変換後のカーソル移動

`handleRubyCompletion()` / `handleAnnotationCompletion()` でも同様に、`insertAnnotationElement()` + `setCursorAfter()` でカーソルを要素の**直後**に置く。これがないと直後の `selectionchange` で `expandForEditing()` が即発火して記法が展開状態のまま残るように見えてしまう。

### エラー通知・CM6 同期

- 選択なし・ビュー未開は `new Notice(...)` で通知。`editorEl` が null のときは `applyAnnotation()` が早期リターンする（誤メッセージを出さない）
- ラップ成功後に `view.ts` の `applyAnnotation()` が `commitToCm6()` を呼ぶ（tcy/bouten のみ。ルビは collapseEditing 時に selectionchange 経由でコミット）
