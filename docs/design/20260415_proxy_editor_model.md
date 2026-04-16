# Proxy Editor モデル — 双方向同期・Undo/Redo 設計

作成日: 2026-04-15

## 概要

縦書きビューは「Proxy Editor」として動作する。ファイルへの書き込みは CM6（Obsidian 標準 Markdown エディタ）の autosave に一本化し、縦書きビュー自身はファイルに直接書き込まない。

## 双方向同期の競合防止

- `SyncCoordinator` は読み取り専用（`vault.modify` / `DebounceQueue` を使用しない）
- `el.innerHTML` への直接代入は input イベントを発生させないため、`isApplyingExternalChange` フラグは不要
- `SyncCoordinator.loadFile()` と `onExternalModify()` はどちらも非同期（vault.read）なのでシーケンス番号（`loadSeq`, `externalModifySeq`）を使って古い結果を捨てる
- CM6 autosave が発火した `modify` イベントは内容比較（`externalContent === getEditorValue()`）でスキップ

## ビューを閉じるときのデータロスト防止

`onClose()` の先頭で `commitToCm6()` を呼ぶことで、未コミットのバーストを確実に CM6 に書き込む。CM6 がその後 autosave でファイルに保存する。

## `commitToCm6()` — 差分コミット

縦書きビューへの入力は `commitToCm6()`（`view.ts`）で CM6 に差分 `replaceRange` する。前後の共通プレフィックス・サフィックスを除いた変化部分だけを置換するため、CM6 が正確な編集位置を記録し Undo 後のカーソルが編集箇所に来る。

## `lastCommittedContent` — IME 競合防止

`VerticalWritingView` が保持する「最後に CM6 にコミットした確定済みテキスト」。IME 変換中は DOM に未確定テキストが含まれるため、`getEditorValue()` をそのまま `onExternalModify()` の比較に使うと CM6 autosave の `modify` イベントで誤ってビューがリセットされる。`lastCommittedContent` は IME 変換中に更新されないため、autosave 由来の `modify` を正しくスキップできる。

更新タイミング: `commitToCm6()` 完了時・ロード時・外部変更適用時。

## コミットポイント一覧

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

## `inBurst` フラグ

`inBurst = true` は「CM6 に未コミットの変更がある」状態を表す。`onBeforeInput()` で `true` にし、`commitToCm6()` 内の `resetBurst()` で `false` に戻す。

## Undo/Redo 対応

Undo/Redo は CM6 に完全委譲する。縦書きビューは独自の Undo スタックを持たない。

### 実行フロー（`doUndoRedo()`）

```
commitToCm6()                    // 未コミットのバーストを先に CM6 に書き込む
prevContent = lastCommittedContent
cm6.undo() / cm6.redo()          // CM6 側で Undo/Redo を実行
newContent = cm6.getValue()
if newContent === prevContent: return  // スタック空などで変化なし → カーソルそのまま
srcOffset = deriveUndoRedoCursor(prevContent, newContent)
editorEl.applyFromCm6(newContent, srcOffset)
```

### `cm6.getCursor()` を使わない理由

`cm6.undo()` 後の `cm6.getCursor()` は「undo されたトランザクションの直前に `setCursor()` でセットした位置」を返す。これは前回の `commitToCm6()` がセットした位置であり、今回の編集箇所とは無関係なためドキュメント端に飛ぶことがある。

### `deriveUndoRedoCursor(prev, next)`

prevContent → newContent の差分（共通プレフィックス・サフィックスを除く）から `next` 上の変化領域末尾を返す:
- undo（テキスト復元）: 復元テキストの末尾 → 例:「うえお」削除の undo → 「お」の直後
- redo（削除の再実行）: 削除点（変化領域の先頭 = fromStart = fromEndNext）
- 変化なし（スタック空）: 呼び出し元で early return するため到達しない

### `applyFromCm6()` によるカーソル復元

`EditorElement.applyFromCm6(content, srcOffset)`:
1. `expandedEl` / `expandedElOriginalText` / `savedRange` をクリア（stale 参照除去）
2. 内容変化がある場合 `replaceChildren(sanitizeHTMLToDom(parseToHtml(content)))` で DOM を更新
3. `buildSegmentMap(content)` + `srcToView(segs, srcOffset)` でソースオフセットを表示オフセットに変換
4. `setVisibleOffset(viewOffset)` でカーソルを設定
