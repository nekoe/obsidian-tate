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
    ├── EditorElement.ts       # contenteditable div DOM management (facade over AozoraParser and InlineEditor)
    ├── AozoraParser.ts        # Aozora notation ↔ DOM bidirectional conversion (parse + serialize)
    ├── InlineEditor.ts        # Inline expand/collapse of ruby/tcy/bouten elements while editing
    ├── SegmentMap.ts          # Source offset ↔ view offset bidirectional mapping
    └── SegmentMap.test.ts     # SegmentMap unit tests (vitest)
styles.css                     # Vertical writing CSS (writing-mode: vertical-rl)
manifest.json                  # Plugin metadata (id: obsidian-tate)
```

## Development Guide

- All source code comments (TypeScript and CSS) must be written in English.
- Important design decisions and research findings must be saved as design documents under `docs/design/YYYYMMDD_{topic}.md`. Dates are embedded in filenames to preserve a history of decision-making over time.
- When multiple design documents conflict, the document with the more recent date takes precedence.

## Key Design Decisions

See the design documents in `docs/design/` for details:

- [Proxy Editor Model (bidirectional sync and Undo/Redo design)](docs/design/20260415_proxy_editor_model.md)
- [Aozora Notation: Parsing, Serialization, and Inline Expansion](docs/design/20260415_aozora_inline_editing.md)
- [SegmentMap — Source ↔ View Offset Mapping](docs/design/20260415_segment_map.md)
- [DOM and UX Design Decisions (contenteditable div, events, paste, auto-indent)](docs/design/20260415_dom_and_ux.md)

## Settings

`TatePluginSettings` (`src/settings.ts`):
- `fontFamily`: CSS font-family string (default: Hiragino Mincho ProN family)
- `fontSize`: numeric value in px (default: 18)
- `autoIndent`: auto-indent ON/OFF (default: `true`)
- `lineBreak`: line-break rule `'normal' | 'strict' | 'loose' | 'anywhere'` (default: `'normal'`). Passed directly to the CSS `line-break` property.

After changing settings, call `plugin.applySettingsToAllViews()` to apply them immediately to all open views.

## Obsidian API Notes

- `containerEl.children[1]` is the ItemView content area (Obsidian convention)
- All `vault.on('modify/delete/rename')` listeners must be registered with `registerEvent`
- Use `getLeaf('tab')` to open a tab (avoid deprecated methods)
- Use `workspace.getLeavesOfType(TATE_VIEW_TYPE)` to find existing vertical writing tabs
