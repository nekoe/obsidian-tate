# SegmentMap — Source ↔ View Offset Bidirectional Mapping

作成日: 2026-04-15

## 概要

`src/ui/SegmentMap.ts` が Aozora 記法テキストの双方向オフセットマッピングを担う。Aozora 記法では `ruby` / `tcy` / `bouten` の注記部分がファイル上（ソース）には存在するが表示上は不可視になるため、ソースオフセットと表示オフセットのズレを吸収する必要がある。

## API

```typescript
// Segment kinds: plain / ruby-explicit / ruby-implicit / tcy / bouten / newline
export function buildSegmentMap(source: string): Segment[];
export function srcToView(segs: readonly Segment[], srcOffset: number): number;
export function viewToSrc(segs: readonly Segment[], viewOffset: number): number;
```

## srcLen ルール（ソース上の文字数）

| 種別 | 記法例 | srcLen |
|------|--------|--------|
| `ruby-explicit` | `｜base《rt》` | baseLen + rtLen + 3（`｜`, `《`, `》`）|
| `ruby-implicit` | `base《rt》` | baseLen + rtLen + 2（`《`, `》`）|
| `tcy` | `content［＃「content」は縦中横］` | contentLen × 2 + 9 |
| `bouten` | `content［＃「content」に傍点］` | contentLen × 2 + 8 |
| `newline` | `\n` | 1 |

## srcToView ルール（ソースオフセット → 表示オフセット）

- `ruby-explicit`: local=0（`｜`）→ viewStart、1..baseLen（base）→ viewStart + local - 1、≥ baseLen + 1（`《rt》`）→ viewStart + baseLen
- `ruby-implicit`: local 0..baseLen（base）→ viewStart + local、≥ baseLen（`《rt》`）→ viewStart + baseLen
- `tcy` / `bouten`: local 0..contentLen（content）→ viewStart + local、≥ contentLen（注記部分）→ viewStart + contentLen

パーサは `parseInlineToHtml()` と同じ優先順位（明示ルビ → tcy → bouten → 省略ルビ）で処理する。

## 利用箇所

- `commitToCm6()`（`view.ts`）: `viewToSrc()` で表示カーソル位置をソースオフセットに変換し、CM6 カーソルを同期する
- `applyFromCm6()`（`EditorElement.ts`）: `srcToView()` でソースオフセットを表示オフセットに変換し、`setVisibleOffset()` でカーソルを復元する

## 差分更新（Incremental Update）— 将来の最適化

現状 `buildSegmentMap()` は全文スキャン（O(文書長)）。`commitToCm6()` と `applyFromCm6()` から呼ばれる。

### 実施の必要性（優先度: 低）

| 文書規模 | 文字数 | 現状コスト | 体感 |
|---|---|---|---|
| 短編 | 〜1万字 | < 0.1ms | 問題なし |
| 中編 | 〜5万字 | 〜0.5ms | 問題なし |
| 長編 | 〜30万字 | 〜3ms | 気になりうる |

コミットポイントは高頻度ではない（キー入力ごとではなく nav キー・compositionend など）ため、一般的な Obsidian ノートでは問題にならない。将来 View→Source クリック位置マッピングを実装する場合（`viewToSrc` を `selectionchange` 内で毎回呼ぶ）は優先度が上がる。

### 設計案

**案A（推奨）: キャッシュ + デルタ更新**

`commitToCm6()` が既に計算している `fromStart` / `fromEndOld` / `fromEndNew` を使う:
1. `fromStart` を含むセグメントを特定
2. `fromStart`〜`fromEndOld` 範囲のセグメントを削除
3. `content[fromStart..fromEndNew]` を再パースして新セグメントを挿入
4. 後続セグメントの `srcStart` / `viewStart` を `±delta` でシフト（`delta = fromEndNew - fromEndOld`）

→ O(変更行のソース長 + 後続セグメント数) に削減

**案B: キャッシュのみ（最小コスト）**

前回の結果と内容を保持し、同一内容なら再計算をスキップ。`selectionchange` 連打など同一内容を複数回処理するケースに効くが、内容が変わるたびフルスキャンするのは変わらない。
