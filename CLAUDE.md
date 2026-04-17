# obsidian-tate

Vertical writing mode plugin for Obsidian.

## Build

```bash
npm install       # First time only
npm run dev       # Development mode (watch and rebuild on file changes)
npm run build     # Production build (TypeScript type check + esbuild)
```

Build output: `main.js` (project root).

## Install into Obsidian (development)

```bash
cp main.js manifest.json styles.css {YOUR_VAULT_PATH}/.obsidian/plugins/tate/
```

## File Structure

```
src/
├── main.ts                    # TatePlugin (entry point)
├── view.ts                    # VerticalWritingView (ItemView)
├── settings.ts                # TatePluginSettings type + TateSettingTab
├── sync/
│   └── SyncCoordinator.ts     # Bidirectional sync control (external change detection, file loading)
└── ui/
    ├── EditorElement.ts       # contenteditable div DOM management (facade over AozoraParser, InlineEditor, and InputTransformer)
    ├── AozoraParser.ts        # Aozora notation ↔ DOM bidirectional conversion (parse + serialize)
    ├── InlineEditor.ts        # Inline expand/collapse of ruby/tcy/bouten elements while editing
    ├── InputTransformer.ts    # Space conversion, auto-indent, and bracket de-indent on beforeinput
    ├── SegmentMap.ts          # Source offset ↔ view offset bidirectional mapping
    └── SegmentMap.test.ts     # SegmentMap unit tests (vitest)
styles.css                     # Vertical writing CSS (writing-mode: vertical-rl)
manifest.json                  # Plugin metadata (id: obsidian-tate)
```

## Version Bump

Always use `npm version` to bump the version. Never edit `manifest.json`, `package.json`, or `versions.json` directly.

```bash
npm version patch   # 1.x.y → 1.x.(y+1)
npm version minor   # 1.x.y → 1.(x+1).0
npm version major   # 1.x.y → (x+1).0.0
```

`npm version` automatically runs `version-bump.mjs` (updates `manifest.json` and `versions.json`), stages those files, and creates a git commit + tag.

## Development Guide

- All source code comments (TypeScript and CSS) must be written in English.
- Important design decisions and research findings must be saved as design documents under `docs/design/YYYYMMDD_{topic}.md`. Dates are embedded in filenames to preserve a history of decision-making over time.
- When multiple design documents conflict, the document with the more recent date takes precedence.
- Obsidian Developer Documentation: https://docs.obsidian.md

## Key Design Decisions

See the design documents in `docs/design/` for details:

- [Proxy Editor Model (bidirectional sync and Undo/Redo design)](docs/design/20260415_proxy_editor_model.md)
- [Aozora Notation: Parsing, Serialization, and Inline Expansion](docs/design/20260415_aozora_inline_editing.md)
- [SegmentMap — Source ↔ View Offset Mapping](docs/design/20260415_segment_map.md)
- [DOM and UX Design Decisions (contenteditable div, events, paste)](docs/design/20260415_dom_and_ux.md)
- [Input Transformer: Space Conversion, Auto-Indent, and Bracket De-indent](docs/design/20260417_input_transformer.md)

## Settings

`TatePluginSettings` (`src/settings.ts`):
- `fontFamily`: CSS font-family string (default: Hiragino Mincho ProN family)
- `fontSize`: numeric value in px (default: 18)
- `lineBreak`: line-break rule `'normal' | 'strict' | 'loose' | 'anywhere'` (default: `'normal'`). Passed directly to the CSS `line-break` property.
- `convertHalfWidthSpace`: convert typed half-width space to full-width space (U+3000) (default: `true`)
- `autoIndentOnInput`: insert leading full-width spaces at line start when a character is typed (default: `true`)
- `matchPrecedingIndent`: match the leading full-width space count of the preceding paragraph (default: `true`). Independent of `autoIndentOnInput`.
- `removeBracketIndent`: remove one leading full-width space when a full-width opening bracket is typed at line start (default: `true`)

After changing settings, call `plugin.applySettingsToAllViews()` to apply them immediately to all open views.

## Obsidian API Notes

- `containerEl.children[1]` is the ItemView content area (Obsidian convention)
- All `vault.on('modify/delete/rename')` listeners must be registered with `registerEvent`
- Use `getLeaf('tab')` to open a tab (avoid deprecated methods)
- Use `workspace.getLeavesOfType(TATE_VIEW_TYPE)` to find existing vertical writing tabs
