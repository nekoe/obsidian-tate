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
│   ├── SyncCoordinator.ts     # 双方向同期制御（外部変更検出・ファイル読み込み）
│   └── DebounceQueue.ts       # デバウンス（現在未使用）
└── ui/
    ├── EditorElement.ts       # contenteditable div DOM管理
    ├── SegmentMap.ts          # ソースオフセット ↔ 表示オフセット双方向マッピング
    ├── SegmentMap.test.ts     # SegmentMap ユニットテスト（vitest）
    └── UndoManager.ts         # 独自 Undo/Redo スタック（現在未使用）
styles.css                     # 縦書きCSS（writing-mode: vertical-rl）
manifest.json                  # プラグインメタデータ（id: obsidian-tate）
```

## 重要な設計上の決定

### contenteditable divによる縦書き実現
`writing-mode: vertical-rl` をcontenteditable divに適用する。textareaへの`writing-mode`適用はChrome 119以降が必要だが、ObsidianのElectronバージョンによっては未対応のため、より広く動作するcontenteditable divを採用する。テキストの取得には `getValue()`（カスタム `serializeNode()` DOMウォーカー）、設定には `setValue()`（`innerHTML = parseToHtml(content)`）を使用する。

### 双方向同期の競合防止（Proxy Editor モデル）
- ファイルへの書き込みは CM6（Obsidian の標準 Markdown エディタ）の autosave に一本化。`SyncCoordinator` は読み取り専用（`vault.modify` / `DebounceQueue` を使用しない）
- `el.innerHTML` への直接代入はinputイベントを発生させないため、`isApplyingExternalChange` フラグは不要
- `SyncCoordinator.loadFile()` と `onExternalModify()` はどちらも非同期（vault.read）なのでシーケンス番号（loadSeq, externalModifySeq）を使って古い結果を捨てる
- CM6 autosave が発火した `modify` イベントは内容比較（`externalContent === getEditorValue()`）でスキップ

### ビューを閉じるときのデータロスト防止
`onClose()` の先頭で `commitToCm6()` を呼ぶことで、未コミットのバーストを確実に CM6 に書き込む。CM6 がその後 autosave でファイルに保存する。

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

**ライブ変換**: `》`/`］` 入力時に `handleRubyCompletion()` / `handleTcyCompletion()` / `handleBoutenCompletion()` が記法を要素に変換する。IME対応のため `input`（`isComposing=false`）と `compositionend` の両方で呼ぶ。全操作は `insertAnnotationElement()` による直接 DOM 操作で統一（`execCommand` 不使用）。`handleTcyCompletion` と `handleBoutenCompletion` は `handleAnnotationCompletion()` に共通化。これらのメソッドは `boolean`（変換が発生したか）を返し、`view.ts` が `true` のとき `commitToCm6()` を呼ぶ。展開中（`expandedEl` が非 null）または DOM 操作中（`isModifyingDom` が true）はライブ変換を行わない（再入防止）。

### インライン展開（Obsidian Markdown エディタ風）
`document` の `selectionchange` イベントを `registerDomEvent(document, 'selectionchange', ...)` で登録し、カーソル位置に応じて ruby/tcy/bouten 要素をその場で展開・収束する。

- **展開**: カーソルが `<ruby>`・`<span data-tcy="explicit">`・`<span data-bouten>` に入ると `expandForEditing()` が要素を `<span class="tate-editing">` に置換し、Aozora 生テキストを表示する。このとき `expandedElOriginalText` に展開前のテキストを保存する（変化検出用）。`inBurst = false` もリセットする
- **収束**: カーソルが外れると `collapseEditing()` が `parseInlineToHtml()` で再パースして元の要素に戻す。編集内容は反映される（`parseToHtml()` を使うと段落 `<div>` の中に `<div>` がネストするため禁止）。収束は常に直接 DOM 操作で統一（`execCommand` 不使用）。`collapseEditing()` は `boolean`（内容変化の有無）を返す。`view.ts` の `selectionchange` ハンドラが `true` のとき `commitToCm6()` を呼ぶ
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
- **ルビ**: `wrapSelectionWithRuby()` が直接 DOM 操作で `<span class="tate-editing">｜text《》</span>` を挿入する。`expandedEl` と `expandedElOriginalText` を直接セットしてインライン展開状態にする。ユーザーがルビ文字を入力後カーソルを外すと `collapseEditing()` が `<ruby>` 要素に収束し、`view.ts` の selectionchange ハンドラが `commitToCm6()` を呼ぶ
- **縦中横・傍点**: `wrapSelectionWith()` に共通化。`insertAnnotationElement()` で直接 DOM 操作により選択テキストを要素に置換する。`setCursorAfter()` でカーソルを要素の**直後**に置く。カーソルが要素内にあると `selectionchange → expandForEditing()` が呼ばれ意図しない展開が発生するため
- **ライブ変換後のカーソル移動**: `handleRubyCompletion()` / `handleAnnotationCompletion()` でも同様に、`insertAnnotationElement()` + `setCursorAfter()` でカーソルを要素の**直後**に置く。これがないと直後の `selectionchange` で `expandForEditing()` が即発火して記法が展開状態のまま残るように見えてしまう
- **エラー通知**: 選択なし・ビュー未開は `new Notice(...)` で通知。`editorEl` が null のときは `applyAnnotation()` が早期リターンする（誤メッセージを出さない）
- **CM6 同期**: ラップ成功後に `view.ts` の `applyAnnotation()` が `commitToCm6()` を呼ぶ（tcy/bouten のみ。ルビは collapseEditing 時に selectionchange 経由でコミット）

### ファイル切り替えの検知
`file-open` ワークスペースイベントを使う（`active-leaf-change` より正確）。縦書きビュー自身がアクティブになっても `file-open` は発火しないため、表示中のファイルが意図せずリセットされない。

### Undo/Redo 対応（Proxy Editor モデル）

Undo/Redo は CM6（Obsidian 標準エディタ）に完全委譲する。縦書きビューは独自の Undo スタックを持たない。

**コミットポイントによる CM6 への書き込み**

縦書きビューへの入力は `commitToCm6()`（`view.ts`）で CM6 に差分 `replaceRange` する。前後の共通プレフィックス・サフィックスを除いた変化部分だけを置換するため、CM6 が正確な編集位置を記録し Undo 後のカーソルが編集箇所に来る。CM6 の履歴エントリとなるため、その後 `editor.undo()` で確実に元に戻せる。

**`lastCommittedContent`（IME 競合防止）**

`VerticalWritingView` が保持する「最後に CM6 にコミットした確定済みテキスト」。IME 変換中は DOM に未確定テキストが含まれるため、`getEditorValue()` をそのまま `onExternalModify()` の比較に使うと CM6 autosave の `modify` イベントで誤ってビューがリセットされる。`lastCommittedContent` は IME 変換中に更新されないため、autosave 由来の `modify` を正しくスキップできる。更新タイミング: `commitToCm6()` 完了時・ロード時・外部変更適用時。

コミットポイント:

| 操作 | コミットタイミング |
|------|-----------------|
| ペースト | `paste` イベント後に即時 |
| IME 確定 | `compositionend` 後に即時 |
| ライブ変換 | `input` イベントで `boolean` 返却が `true` のとき |
| アノテーション収束 | `selectionchange` で `collapseEditing()` が `true` を返したとき |
| ナビゲーションキー | `keydown` で矢印・Home/End/PgUp/PgDn 検出時 |
| mousedown | クリック時（バースト終了） |
| ビューを閉じる | `onClose()` 先頭 |
| tcy/bouten コマンド | `applyAnnotation()` 内 |

**`inBurst` フラグの役割（変更後）**

`inBurst = true` は「CM6 に未コミットの変更がある」状態を表す（旧: 独自 Undo スタック向けのバーストグループ制御）。`onBeforeInput()` で `inBurst = true` にし、`commitToCm6()` 内の `resetBurst()` で `false` に戻す。

**Undo/Redo 実行フロー（`doUndoRedo()`）**

```
commitToCm6()                    // 未コミットのバーストを先に CM6 に書き込む
prevContent = lastCommittedContent
cm6.undo() / cm6.redo()          // CM6 側で Undo/Redo を実行
newContent = cm6.getValue()
if newContent === prevContent: return  // スタック空などで変化なし → カーソルそのまま
srcOffset = deriveUndoRedoCursor(prevContent, newContent)
editorEl.applyFromCm6(newContent, srcOffset)
```

**`cm6.getCursor()` を使わない理由**

`cm6.undo()` 後の `cm6.getCursor()` は「undo されたトランザクションの直前に `setCursor()` でセットした位置」を返す。これは前回の `commitToCm6()` がセットした位置であり、今回の編集箇所とは無関係なためドキュメント端に飛ぶことがある。

**`deriveUndoRedoCursor(prev, next)`**

prevContent → newContent の差分（共通プレフィックス・サフィックスを除く）から `next` 上の変化領域末尾を返す:
- undo（テキスト復元）: 復元テキストの末尾 → 例:「うえお」削除の undo → 「お」の直後
- redo（削除の再実行）: 削除点（変化領域の先頭 = fromStart = fromEndNext）
- 変化なし（スタック空）: 呼び出し元で early return するため到達しない

**`applyFromCm6()` によるカーソル復元**

`EditorElement.applyFromCm6(content, srcOffset)`:
1. `expandedEl` / `expandedElOriginalText` / `savedRange` をクリア（stale 参照除去）
2. 内容変化がある場合 `el.innerHTML = parseToHtml(content)` で DOM を更新
3. `buildSegmentMap(content)` + `srcToView(segs, srcOffset)` でソースオフセットを表示オフセットに変換
4. `setVisibleOffset(viewOffset)` でカーソルを設定

### SegmentMap（ソース ↔ 表示オフセット変換）

`src/ui/SegmentMap.ts` が Aozora 記法テキストの双方向オフセットマッピングを担う。

```typescript
// セグメント種別: plain / ruby-explicit / ruby-implicit / tcy / bouten / newline
export function buildSegmentMap(source: string): Segment[];
export function srcToView(segs: readonly Segment[], srcOffset: number): number;
export function viewToSrc(segs: readonly Segment[], viewOffset: number): number;
```

**srcLen ルール（ソース上の文字数）**:
- `ruby-explicit` `｜base《rt》`: baseLen + rtLen + 3（`｜`, `《`, `》`）
- `ruby-implicit` `base《rt》`: baseLen + rtLen + 2（`《`, `》`）
- `tcy` `content［＃「content」は縦中横］`: contentLen × 2 + 9
- `bouten` `content［＃「content」に傍点］`: contentLen × 2 + 8
- `newline` `\n`: 1

**srcToView ルール（ソースオフセット → 表示オフセット）**:
- `ruby-explicit`: local=0（`｜`）→ viewStart、1..baseLen（base）→ viewStart + local - 1、≥ baseLen + 1（`《rt》`）→ viewStart + baseLen
- `ruby-implicit`: local 0..baseLen（base）→ viewStart + local、≥ baseLen（`《rt》`）→ viewStart + baseLen
- `tcy` / `bouten`: local 0..contentLen（content）→ viewStart + local、≥ contentLen（注記部分）→ viewStart + contentLen

パーサは `parseInlineToHtml()` と同じ優先順位（明示ルビ → tcy → bouten → 省略ルビ）で処理する。

**差分更新（Incremental Update）— 将来の最適化（Phase 4）**

現状 `buildSegmentMap()` は全文スキャン（O(文書長)）。長編文書でコミットポイントが頻繁に来ると重くなる可能性がある。

最適化案: 変更があった段落（行）だけを再パースし、それ以降のセグメントの `srcStart` / `viewStart` に差分（`offsetDelta`）を加算してずらす。
- 変更行を特定 → その行のセグメントを再計算 → 後続セグメントを `±delta` でシフト
- 全文パース不要なので長編でも高速
- 未変更セグメントの再利用により O(変更行のソース長 + 後続セグメント数) に削減できる

### ペーストのプレーンテキスト化
`contenteditable` div はデフォルトでクリップボードの `text/html` を優先してペーストするため、インライン展開スパンのスタイルや外部 HTML のスタイルが貼り付けられてしまう。`paste` イベントで `e.preventDefault()` した後、`e.clipboardData.getData('text/plain')` でプレーンテキストのみ取得し、`document.execCommand('insertText', false, text)` で挿入する。`execCommand('insertText')` は deprecated だが Electron では動作し、カーソル位置への挿入・選択範囲の置換を一括処理できる。ペースト後は `view.ts` の `paste` ハンドラが `commitToCm6()` を即時呼ぶ。

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
