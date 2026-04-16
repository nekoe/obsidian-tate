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

- `Add ruby to selection (Ruby)`
- `Make selection tate-chu-yoko (Tate-Chu-Yoko: TCY)`
- `Add emphasis marks to selection (Bouten)`

**Inline Editing**

Moving the cursor into a ruby, tate-chu-yoko, or emphasis mark element expands it into raw Aozora text in place — the same behavior as Obsidian's Markdown editor. Moving the cursor out collapses it back to the rendered form.

### Auto-indent

The first character of each paragraph is automatically indented by one em. Can be toggled in settings (default: on).

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
cp main.js manifest.json styles.css ~/.obsidian/plugins/obsidian-tate/
```

3. Enable the plugin in Obsidian under **Settings → Community Plugins**.

## Usage

- Run `縦書きViewを開く` from the command palette (`Ctrl+P` / `Cmd+P`).
- The view opens as a tab and automatically loads the active file.
- Edits are kept in sync with the underlying Obsidian file in both directions.

## Settings

Configure under **Settings → TATE**:

| Setting | Description | Default |
|---------|-------------|---------|
| Font family | Font used in the vertical view (CSS `font-family` syntax) | Hiragino Mincho ProN |
| Font size | Font size in the vertical view (px) | 18 |
| Auto-indent | Indent the first character of each paragraph by 1 em | On |
| Line-break rule | Kinsoku rule set for line start/end restrictions | Normal |
