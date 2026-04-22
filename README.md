# TATE — Vertical Writing Mode for Obsidian

An Obsidian plugin that brings authentic vertical writing (縦書き) to your notes. Built on `writing-mode: vertical-rl`, it renders and edits Japanese text in the traditional top-to-bottom, right-to-left layout.

[日本語版 README はこちら](README-ja.md)

## Features

### Ruby, Tate-chu-yoko, and Emphasis Marks via Aozora Notation

The plugin supports the annotation syntax used by [Aozora Bunko](https://www.aozora.gr.jp/), a digital library of Japanese literature.

| Notation | Renders as |
|----------|------------|
| `｜東京《とうきょう》` or `東京《とうきょう》` (consecutive kanji) | Ruby (furigana) |
| `２０２５［＃「２０２５」は縦中横］` | Tate-chu-yoko (digits/latin rotated upright) |
| `春［＃「春」に傍点］` | Emphasis dots (sesame marks) |

**Applying via Command Palette**

Select text, open the command palette (`Ctrl+P` / `Cmd+P`), and run one of:

- `Add ruby to selection (ruby)`
- `Make selection tate-chu-yoko (tate-chu-yoko: tcy)`
- `Add emphasis marks to selection (bouten)`

**Inline Editing**

Moving the cursor into a ruby, tate-chu-yoko, or emphasis mark element expands it into raw Aozora text in place — the same behavior as Obsidian's Markdown editor. Moving the cursor out collapses it back to the rendered form. Pressing **Enter** while an element is expanded also collapses it immediately.

### Auto-indent and Typography Helpers

Four independent settings refine how text is entered in the vertical view. All of them write actual full-width space characters (U+3000) into the file — not just visual CSS indentation.

| Setting | What it does |
|---------|--------------|
| **Convert half-width space to full-width** | Replaces a typed half-width space (Space key) with a full-width space `　`. Applies everywhere except paste. |
| **Auto-indent on input** | Inserts one full-width space at the start of a line when a character is typed there (covers both direct input and Japanese IME). |
| **Match preceding paragraph indent** | When Enter is pressed to start a new paragraph, automatically inserts the same number of leading full-width spaces as the preceding paragraph. Works independently of the setting above. |
| **Remove bracket indent** | When a full-width opening bracket (`「『（` etc.) is typed after leading spaces, removes one leading space — following traditional Japanese typography where brackets are not indented. |

All four are on by default.

### Line-break Rules (Kinsoku)

Controls which characters are forbidden at the start or end of a line (punctuation, brackets, etc.) via the CSS `line-break` property.

| Rule | Description |
|------|-------------|
| `Normal` | Standard kinsoku rules (default) |
| `Strict` | Strictest — small kana (っ, ゅ, etc.) are also kept from line starts |
| `Loose` | Newspaper style — relaxed rules that favor tighter wrapping |
| `Anywhere` | No restrictions — break anywhere |

## Installation (from source)

1. Clone the repository and build:

```bash
git clone https://github.com/nekoe/obsidian-tate
cd obsidian-tate
npm install
npm run build
```

2. Copy the build output to your Obsidian plugins folder:

```bash
cp main.js manifest.json styles.css {YOUR_VAULT_PATH}/.obsidian/plugins/tate/
```

3. Enable the plugin in Obsidian under **Settings → Community Plugins**.

## Usage

- Run `縦書きビューを開く` from the command palette (`Ctrl+P` / `Cmd+P`).
- The view opens as a tab and automatically loads the active file.
- Edits are kept in sync with the underlying Obsidian file in both directions.

## Known Limitations

- **IME input after emphasis marks:** When the cursor is placed immediately after an emphasis mark (bouten) and text is entered via IME, the composition text temporarily appears with sesame marks applied. The marks disappear once the IME input is confirmed.
- **Deletion at ruby/tate-chu-yoko boundaries:** Pressing Delete or Backspace with the cursor placed at the very start or end of a ruby or tate-chu-yoko element does not delete the adjacent character. To delete, either select the text first, or expand the element inline and delete from within.
- **Consecutive Aozora notation input:** Typing one Aozora notation immediately after another may cause the second notation to be inserted incorrectly or cursor movement to behave unexpectedly.
- **Typing into a line-initial Aozora element:** When an Aozora notation element appears at the very start of a line, placing the cursor at the line beginning triggers its inline expansion automatically. Any characters typed while expanded are inserted inside the element, but once it collapses they are treated as plain text.

## Settings

Configure under **Settings → TATE**:

| Setting | Description | Default |
|---------|-------------|---------|
| Font family | Font used in the vertical view (CSS `font-family` syntax) | Hiragino Mincho ProN |
| Font size | Font size in the vertical view (px) | 22 |
| Convert half-width space to full-width | Replace typed space with full-width space `　` | On |
| Auto-indent on input | Insert one `　` at line start when a character is typed | On |
| Match preceding paragraph indent | On Enter, copy the indent of the paragraph above | On |
| Remove bracket indent | Remove one leading `　` when a full-width bracket is typed after spaces | On |
| Line-break rule | Kinsoku rule set for line start/end restrictions | Normal |
