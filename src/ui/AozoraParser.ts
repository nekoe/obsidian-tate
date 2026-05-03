// Unicode range for kanji characters (used for implicit ruby detection)
// CJK Unified Ideographs (U+4E00–U+9FFF) + Extension A (U+3400–U+4DBF) + iteration marks
export const KANJI_RE_STR = '[\u4E00-\u9FFF\u3400-\u4DBF\u{20000}-\u{2A6DF}々〆〤]+';

// Intermediate representation for the parser pipeline
type ParseSegment = { type: 'text'; text: string } | { type: 'html'; html: string };

// ---- Parser (Aozora notation → innerHTML) ----

// For full document: wraps each paragraph in a <div> (so text-indent applies per paragraph)
export function parseToHtml(text: string): string {
    // Return a minimal paragraph even for empty content: returning '' would leave the
    // contenteditable :empty (showing the placeholder on empty files) and cause
    // InputTransformer.getContainingParagraphDiv() to always return null, misfiring
    // auto-indent on every keystroke until a paragraph div exists.
    if (!text) return '<div><br></div>';
    return text
        .split('\n')
        .map(line => `<div>${parseInlineToHtml(line) || '<br>'}</div>`)
        .join('');
}

// For inline elements: converts Aozora notation to HTML without wrapping in <div> (used by collapseEditing)
export function parseInlineToHtml(text: string): string {
    return applyParsers(text, [
        splitByExplicitRuby,
        splitByExplicitTcy,
        splitByExplicitBouten,
        splitByImplicitRuby,
    ]);
}

// Applies parsers in sequence to text and returns an HTML string
function applyParsers(
    text: string,
    parsers: Array<(t: string) => ParseSegment[]>,
): string {
    let segments: ParseSegment[] = [{ type: 'text', text }];
    for (const parser of parsers) {
        segments = segments.flatMap(seg =>
            seg.type === 'text' ? parser(seg.text) : [seg]
        );
    }
    return segments
        .map(seg => seg.type === 'html' ? seg.html : esc(seg.text))
        .join('');
}

// Splits explicit ruby ｜base《rt》 (or |base《rt》)
function splitByExplicitRuby(text: string): ParseSegment[] {
    const result: ParseSegment[] = [];
    const re = /[|｜]([^|｜《》\n]+)《([^《》\n]*)》/g;
    let lastIndex = 0;
    let m: RegExpExecArray | null;

    while ((m = re.exec(text)) !== null) {
        if (m.index > lastIndex) {
            result.push({ type: 'text', text: text.slice(lastIndex, m.index) });
        }
        result.push({
            type: 'html',
            html: `<ruby data-ruby-explicit="true">${esc(m[1])}<rt>${esc(m[2])}</rt></ruby>`,
        });
        lastIndex = re.lastIndex;
    }
    if (lastIndex < text.length) {
        result.push({ type: 'text', text: text.slice(lastIndex) });
    }
    return result;
}

// Splits explicit tate-chu-yoko X［＃「X」は縦中横］
function splitByExplicitTcy(text: string): ParseSegment[] {
    return splitByAnnotation(
        text,
        /［＃「([^「」\n]+)」は縦中横］/g,
        c => `<span data-tcy="explicit" class="tcy">${esc(c)}</span>`,
    );
}

// Splits bouten base［＃「base」に傍点］
function splitByExplicitBouten(text: string): ParseSegment[] {
    return splitByAnnotation(
        text,
        /［＃「([^「」\n]+)」に傍点］/g,
        c => `<span data-bouten="sesame" class="bouten">${esc(c)}</span>`,
    );
}

// Shared split logic for forward-reference annotation notation: content［＃「content」...］
function splitByAnnotation(
    text: string,
    re: RegExp,
    buildHtml: (content: string) => string,
): ParseSegment[] {
    const result: ParseSegment[] = [];
    let lastIndex = 0;
    let m: RegExpExecArray | null;

    while ((m = re.exec(text)) !== null) {
        const content = m[1];
        const annotationStart = m.index;

        // Invalid if the text before the annotation does not end with content: output the whole match as plain text
        if (!text.slice(lastIndex, annotationStart).endsWith(content)) {
            result.push({ type: 'text', text: text.slice(lastIndex, re.lastIndex) });
            lastIndex = re.lastIndex;
            continue;
        }

        const contentStart = annotationStart - content.length;
        if (contentStart > lastIndex) {
            result.push({ type: 'text', text: text.slice(lastIndex, contentStart) });
        }
        result.push({ type: 'html', html: buildHtml(content) });
        lastIndex = re.lastIndex;
    }
    if (lastIndex < text.length) {
        result.push({ type: 'text', text: text.slice(lastIndex) });
    }
    return result;
}

// Splits implicit ruby kanji《rt》
function splitByImplicitRuby(text: string): ParseSegment[] {
    const re = new RegExp(`(${KANJI_RE_STR})《([^《》\\n]*)》`, 'gu');
    const result: ParseSegment[] = [];
    let lastIndex = 0;
    let m: RegExpExecArray | null;

    while ((m = re.exec(text)) !== null) {
        if (m.index > lastIndex) {
            result.push({ type: 'text', text: text.slice(lastIndex, m.index) });
        }
        result.push({
            type: 'html',
            html: `<ruby data-ruby-explicit="false">${esc(m[1])}<rt>${esc(m[2])}</rt></ruby>`,
        });
        lastIndex = re.lastIndex;
    }
    if (lastIndex < text.length) {
        result.push({ type: 'text', text: text.slice(lastIndex) });
    }
    return result;
}

function esc(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- DOM serializer (innerHTML → Aozora notation) ----

/**
 * Serializes a DOM node to Aozora notation text.
 * rootEl: root element of the contenteditable div (used to detect trailing <br> at paragraph end)
 */
export function serializeNode(node: Node, rootEl: HTMLElement): string {
    if (node.nodeType === Node.TEXT_NODE) {
        // Normalize &nbsp; (U+00A0) to a regular space. Chrome's contenteditable inserts
        // U+00A0 at the start/end of split paragraphs (e.g. after Enter) to prevent
        // leading/trailing whitespace from being collapsed by HTML rendering rules.
        return (node.textContent ?? '').replace(/ /g, ' ');
    }
    if (!(node instanceof HTMLElement)) return '';

    switch (node.tagName) {
        case 'RUBY': {
            const explicit = node.getAttribute('data-ruby-explicit') !== 'false';
            const base = Array.from(node.childNodes)
                .filter(n => !(n instanceof HTMLElement && n.tagName === 'RT'))
                .map(n => serializeNode(n, rootEl))
                .join('');
            const rt = node.querySelector('rt')?.textContent ?? '';
            return explicit ? `｜${base}《${rt}》` : `${base}《${rt}》`;
        }
        case 'SPAN': {
            const tcy = node.getAttribute('data-tcy');
            if (tcy === 'explicit') {
                const content = node.textContent ?? '';
                return `${content}［＃「${content}」は縦中横］`;
            }
            if (node.getAttribute('data-bouten')) {
                const content = node.textContent ?? '';
                return `${content}［＃「${content}」に傍点］`;
            }
            if (node.classList.contains('tate-cursor-anchor')) {
                // Cursor anchor: transparent to serialization; strip U+200B placeholder
                return (node.textContent ?? '').replace(/\u200B/g, '');
            }
            // tate-editing span or unknown span: serialize child nodes
            return Array.from(node.childNodes)
                .map(n => serializeNode(n, rootEl))
                .join('');
        }
        case 'BR':
            // Skip the decorative <br> Chrome appends at the end of a contenteditable div
            if (
                node.parentElement !== rootEl &&
                node.parentElement?.tagName === 'DIV' &&
                node === node.parentElement.lastChild
            ) {
                return '';
            }
            return '\n';
        case 'DIV': {
            // Block div generated by Chrome's contenteditable
            const content = Array.from(node.childNodes)
                .map(n => serializeNode(n, rootEl))
                .join('');
            return node.previousSibling !== null ? '\n' + content : content;
        }
        default:
            return Array.from(node.childNodes)
                .map(n => serializeNode(n, rootEl))
                .join('');
    }
}
