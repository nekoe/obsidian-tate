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
    ├── EditorElement.ts       # contenteditable div DOM管理
    └── UndoManager.ts         # 独自 Undo/Redo スタック
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
- `parseInlineToHtml(text)`: `collapseEditing()` 用。`<div>` で包まずインライン記法のみ変換する

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

**重要**: `getValue()` は tate-editing スパン展開中・収束後いずれの状態でも同じ Aozora 生テキストを返す。tate-editing スパンがそのままシリアライズされるため（例: `｜漢字《かんじ》`）、スナップショットとして保存した `text` は収束後の DOM でも `setValue()` で正しく復元できる。

**ルビ区切り文字 `｜` の表示制御**: シリアライズは全角 `｜` で統一し、収束時は `<ruby>` 要素内なので不可視。インライン展開時の生テキストとしてのみ可視になる。

**ライブ変換**: `》`/`］` 入力時に `handleRubyCompletion()` / `handleTcyCompletion()` / `handleBoutenCompletion()` が記法を要素に変換する。IME対応のため `input`（`isComposing=false`）と `compositionend` の両方で呼ぶ。全操作は `insertAnnotationElement()` による直接 DOM 操作で統一（`execCommand` 不使用）。DOM 変更前に `pushSnapshot()` を呼んでスナップショットを保存する。`handleTcyCompletion` と `handleBoutenCompletion` は `handleAnnotationCompletion()` に共通化。展開中（`expandedEl` が非 null）または DOM 操作中（`isModifyingDom` が true）はライブ変換を行わない（再入防止）。

### インライン展開（Obsidian Markdown エディタ風）
`document` の `selectionchange` イベントを `registerDomEvent(document, 'selectionchange', ...)` で登録し、カーソル位置に応じて ruby/tcy/bouten 要素をその場で展開・収束する。

- **展開**: カーソルが `<ruby>`・`<span data-tcy="explicit">`・`<span data-bouten>` に入ると `expandForEditing()` が要素を `<span class="tate-editing">` に置換し、Aozora 生テキストを表示する。このとき `expandedElOriginalText` に展開前のテキストを保存する（変化検出用）。`inBurst = false` もリセットして直後の入力を新バーストとして扱う
- **収束**: カーソルが外れると `collapseEditing()` が `parseInlineToHtml()` で再パースして元の要素に戻す。編集内容は反映される（`parseToHtml()` を使うと段落 `<div>` の中に `<div>` がネストするため禁止）。収束は常に直接 DOM 操作で統一（`execCommand` 不使用）。収束後に `inBurst = false` をリセットする
- **`collapseEditing()` の前方テキスト取り込み**: `getExtraCharsFromAnnotation()` が「」内容とスパン内前方テキストを比較し、「」内容が長い場合（例: content=`130`, leading=`30` → 差分=`1`文字）は直前テキストノードの末尾から一致する文字を取り込む（例: テキスト `A1` + tcy `30` → 「30」→「130」編集 → テキスト `A` + tcy `130`）
- **`collapseEditing()` の detached ノード対策**: `collapseEditing()` の先頭で `expandedEl.isConnected` を確認し、false の場合は `expandedEl` / `expandedElOriginalText` をクリアして即リターンする。detached ノードに `parentNode` / `selectNode` を呼ぶと例外が発生するため
- **孤立スパン（orphan span）の検出と再追跡**: `handleSelectionChange()` の `!isModifyingDom` ブロック先頭で `expandedEl` が null または detached のとき `this.el.querySelector('span.tate-editing')` を実行して DOM の実態と同期する。予期せぬ経路で編集スパンが DOM に残った場合のロバストネス対策。再追跡後 `expandedElOriginalText = null` にして `hasChanged = true` とすることで確実に収束させる
- **カーソル位置**: `rawOffsetForExpand()` が ruby（base/rt それぞれ）・tcy・bouten のカーソル位置を raw テキスト上のオフセットに変換する（tcy/bouten はコンテンツが先頭にあるため `return offset` のみ）
- **再入防止**: `isModifyingDom` フラグで DOM 操作中の `selectionchange` 再入をブロックする
- **`setValue()` との競合防止**: `this.expandedEl = null` / `this.expandedElOriginalText = null` / `this.savedRange = null` は `getValue() === content` の早期リターン**より前**に実行すること（detach 済みノード参照を防ぐ）
- **`collapseEditing()` 後の `savedRange` クリア**: `collapseEditing()` は DOM を再構築するため、その直後に `this.savedRange = null` を実行して stale ノード参照を破棄する
- **複数ビュー対策**: `handleSelectionChange()` 先頭で `expandedEl` が null かつカーソルがエディタ外の場合は即リターンする

### コマンドパレットからの記法適用
`add-ruby` / `add-tcy` / `add-bouten` コマンドで選択テキストに記法を適用できる。

- **選択範囲キャッシュ**: `handleSelectionChange()` の先頭（`isModifyingDom` チェックより前）で、エディタ内に非 collapsed 選択があるとき `savedRange` フィールドに保存する。コマンドパレットを開くとフォーカスが離れるが、エディタ外の selectionchange ではキャッシュを**更新しない**（保持する）ことで、コマンド実行時に選択を復元できる
- **ルビ**: `wrapSelectionWithRuby()` が `pushSnapshot()` でスナップショットを保存した後、直接 DOM 操作で `<span class="tate-editing">｜text《》</span>` を挿入する。`expandedEl` と `expandedElOriginalText` を直接セットしてインライン展開状態にする。ユーザーがルビ文字を入力後カーソルを外すと `collapseEditing()` が `<ruby>` 要素に収束する
- **縦中横・傍点**: `wrapSelectionWith()` に共通化。`pushSnapshot()` 後、`insertAnnotationElement()` で直接 DOM 操作により選択テキストを要素に置換する。`setCursorAfter()` でカーソルを要素の**直後**に置く。カーソルが要素内にあると `selectionchange → expandForEditing()` が呼ばれ Undo スタックが不整合になるため
- **ライブ変換後のカーソル移動**: `handleRubyCompletion()` / `handleAnnotationCompletion()` でも同様に、`insertAnnotationElement()` + `setCursorAfter()` でカーソルを要素の**直後**に置く。これがないと直後の `selectionchange` で `expandForEditing()` が即発火して記法が展開状態のまま残るように見えてしまう
- **エラー通知**: 選択なし・ビュー未開は `new Notice(...)` で通知。`editorEl` が null のときは `applyAnnotation()` が早期リターンする（誤メッセージを出さない）
- **同期**: ラップ成功後に `view.ts` の `applyAnnotation()` が `syncCoordinator.onEditorChange()` を呼ぶ（`EditorElement` は `SyncCoordinator` を知らないため）

### ファイル切り替えの検知
`file-open` ワークスペースイベントを使う（`active-leaf-change` より正確）。縦書きビュー自身がアクティブになっても `file-open` は発火しないため、表示中のファイルが意図せずリセットされない。

### Undo/Redo 対応（統合スナップショット方式）

`UndoManager`（`src/ui/UndoManager.ts`）が独自のスタックを管理する。全操作（テキスト入力・削除・ペースト・記法コマンド・ライブ変換・インライン編集）を単一スタックで統一管理する。

**スナップショットの構造**

```typescript
type Snapshot = { text: string; cursor: number };
// text:   getValue() の結果（Aozora 生テキスト）
// cursor: getCollapsedCursor() の結果（収束後 DOM での visible offset）
```

**バースト方式によるUndo粒度**

連続するキー入力を1つのUndo単位にまとめる `inBurst` フラグを持つ:
- `onBeforeInput()`: `inBurst = false` のときのみ `pushSnapshot()` を呼び、`inBurst = true` にする
- ナビゲーションキー（矢印・Home/End/PgUp/PgDn）・mousedown: `resetBurst()` で `inBurst = false` にリセット
- 記法操作（ライブ変換・コマンド）・`collapseEditing()`・`expandForEditing()`: `inBurst = false` をリセット

**スナップショットの保存タイミング**

| 操作 | 保存タイミング |
|------|--------------|
| テキスト入力（バースト開始） | `onBeforeInput()` でバースト初回のみ |
| ペースト | `handlePaste()` で `execCommand` 呼び出し直前に明示的に保存 |
| ライブ変換（`》`/`］`） | DOM 変更前に `pushSnapshot()` |
| コマンド（ruby/tcy/bouten） | DOM 変更前に `pushSnapshot()` |

**`getCollapsedCursor()`**

tate-editing スパン内のカーソルを「収束後の DOM における visible offset」に変換する関数。`undo()`/`redo()` で保存するスナップショットに使い、`setValue()` + `setVisibleOffset()` で正確に復元できる:

- tate-editing 外: `getVisibleOffset()` と同値
- 明示ルビ `｜base《rt》`: カーソルが base 内なら `prefix(1)` 分シフト、rt/括弧内なら baseLen 相当
- 省略ルビ `base《rt》`: カーソルが base 内ならそのまま、rt/括弧内なら baseLen 相当
- tcy/bouten `content［＃...］`: `indexOf('［＃')` までがコンテンツ部分、括弧内は contentLen 相当

**undo()/redo() のフロー**

```
collapseEditingIfExpanded()   // 展開中なら先に収束
popUndo() / popRedo()         // スタックから取り出す
current = { getValue(), getCollapsedCursor() }  // 現状を保存
pushRedo(current) / pushUndo(current)
setValue(entry.text, false)   // isUndoRedoing=true なのでスタッククリアされない
setVisibleOffset(entry.cursor)
inBurst = false
```

**インライン編集中の Undo (Q3 A)**

undo() は常に `collapseEditingIfExpanded()` で先に収束してからスナップショットを復元する。`setValue()` 後に `setVisibleOffset()` でカーソルを収束後位置に置くと、カーソルがアノテーション要素内（ruby の base 末尾など）に入り、直後の `handleSelectionChange()` → `expandForEditing()` が自動的に tate-editing スパンを再展開する。これによりインライン編集状態を維持したまま Undo が動作する。

**カーソル復元の制約**: undo 後のカーソルは tate-editing スパン内の `《` 直前（base 末尾位置）に復元される（入力していた rt フィールド内の正確な位置ではない）。内容は正しく復元される。

**setValue() でのスタッククリア保護**

`setValue()` は `!preserveCursor && !isUndoRedoing` のときのみ `undoManager.clear()` を呼ぶ。undo/redo から `setValue(entry.text, false)` を呼ぶ際に `isUndoRedoing = true` であるためスタックが破壊されない。

### 差分方式への移行（未実装・将来の検討）

現行の全文スナップショット方式は O(文書長) × O(履歴数) のメモリを消費する。Myers' diff Algorithm による差分方式に移行すると O(編集距離) × O(履歴数) に削減できる。

**パッチ表現**

```typescript
type Op =
  | { kind: 'retain'; len: number }
  | { kind: 'insert'; text: string }
  | { kind: 'delete'; text: string }; // 逆方向パッチ生成のため元テキストを保持
type Patch = Op[];
```

逆方向パッチ（Undo 用）は `insert ↔ delete` の交換で生成できる。

**タイミング**

- 記法コマンド: DOM 変更前後の2点が明確なので変更前後で diff を計算しやすい
- テキスト入力（バースト）: バースト開始時に `text_before` を保存し、バースト終了時（次バースト開始・ナビゲーション・Undo 押下時）に `diff(text_before, getValue())` を計算してシール

**メモリ比較**

| | 現行（全文） | 差分方式 |
|---|---|---|
| 1エントリ | O(文書長) | O(編集距離) |
| 5万字 × 1000ステップ | ~100MB | ~数百KB |

**実装上の注意点**

- Unicode: Myers' diff は文字単位。サロゲートペア・結合文字を `Array.from(text)` ベースで扱わないと壊れる
- 検証: `applyPatch(applyPatch(text, patch), invertPatch(patch)) === text` を担保するテストが必要
- バースト終了の検出: バーストが終わった時点でシール処理を追加する必要がある

**推奨**: まず `UndoManager` に `maxEntries`（例: 500ステップ上限）を追加して全文スナップショット方式のままメモリを制限する方法も有効。10万字超の長編文書を扱う場合や長時間セッションが想定される場合に差分方式への移行を検討する。

### ペーストのプレーンテキスト化
`contenteditable` div はデフォルトでクリップボードの `text/html` を優先してペーストするため、インライン展開スパンのスタイルや外部 HTML のスタイルが貼り付けられてしまう。`paste` イベントで `e.preventDefault()` した後、`e.clipboardData.getData('text/plain')` でプレーンテキストのみ取得し、`document.execCommand('insertText', false, text)` で挿入する。`execCommand('insertText')` は deprecated だが Electron では動作し、カーソル位置への挿入・選択範囲の置換を一括処理できる。`handlePaste()` は `execCommand` 呼び出しの直前に `pushSnapshot()` を明示的に呼ぶ（`execCommand` が `beforeinput` を発火しない場合のフォールバック）。

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
