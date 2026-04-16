# SegmentMap — Source ↔ View Offset Bidirectional Mapping

Created: 2026-04-15

## Overview

`src/ui/SegmentMap.ts` handles bidirectional offset mapping for Aozora notation text. In Aozora notation, annotation parts of `ruby` / `tcy` / `bouten` exist in the file (source) but are not visible in the display, so the offset gap between source and view must be absorbed.

## API

```typescript
// Segment kinds: plain / ruby-explicit / ruby-implicit / tcy / bouten / newline
export function buildSegmentMap(source: string): Segment[];
export function srcToView(segs: readonly Segment[], srcOffset: number): number;
export function viewToSrc(segs: readonly Segment[], viewOffset: number): number;
```

## srcLen Rules (character count in source)

| Kind | Example notation | srcLen |
|------|-----------------|--------|
| `ruby-explicit` | `｜base《rt》` | baseLen + rtLen + 3 (`｜`, `《`, `》`) |
| `ruby-implicit` | `base《rt》` | baseLen + rtLen + 2 (`《`, `》`) |
| `tcy` | `content［＃「content」は縦中横］` | contentLen × 2 + 9 |
| `bouten` | `content［＃「content」に傍点］` | contentLen × 2 + 8 |
| `newline` | `\n` | 1 |

## srcToView Rules (source offset → view offset)

- `ruby-explicit`: local=0 (`｜`) → viewStart; 1..baseLen (base) → viewStart + local − 1; ≥ baseLen + 1 (`《rt》`) → viewStart + baseLen
- `ruby-implicit`: local 0..baseLen (base) → viewStart + local; ≥ baseLen (`《rt》`) → viewStart + baseLen
- `tcy` / `bouten`: local 0..contentLen (content) → viewStart + local; ≥ contentLen (annotation part) → viewStart + contentLen

The parser processes tokens in the same priority order as `parseInlineToHtml()` (explicit ruby → tcy → bouten → implicit ruby).

## Usage

- `commitToCm6()` (`view.ts`): converts the view cursor position to a source offset via `viewToSrc()` to sync the CM6 cursor.
- `applyFromCm6()` (`EditorElement.ts`): converts a source offset to a view offset via `srcToView()` and restores the cursor with `setVisibleOffset()`.

## Incremental Update — Future Optimization

`buildSegmentMap()` currently performs a full scan (O(document length)). It is called from `commitToCm6()` and `applyFromCm6()`.

### Necessity (priority: low)

| Document size | Characters | Current cost | Perception |
|---|---|---|---|
| Short | ~10k | < 0.1ms | No issue |
| Medium | ~50k | ~0.5ms | No issue |
| Long | ~300k | ~3ms | May be noticeable |

Commit points are infrequent (navigation keys, `compositionend`, etc. — not every keystroke), so this is not a problem for typical Obsidian notes. Priority increases if a View→Source click position mapping is implemented in the future (calling `viewToSrc` on every `selectionchange`).

### Design Options

**Option A (recommended): Cache + delta update**

Reuse `fromStart` / `fromEndOld` / `fromEndNew` already computed by `commitToCm6()`:
1. Identify the segment containing `fromStart`
2. Remove segments in the `fromStart`–`fromEndOld` range
3. Re-parse `content[fromStart..fromEndNew]` and insert new segments
4. Shift `srcStart` / `viewStart` of subsequent segments by `±delta` (`delta = fromEndNew − fromEndOld`)

→ Reduces cost to O(source length of changed line + number of subsequent segments)

**Option B: Cache only (minimal cost)**

Retain the previous result and content; skip recomputation if content is unchanged. Effective for repeated processing of the same content (e.g., rapid `selectionchange` events), but a full scan is still required whenever content changes.
