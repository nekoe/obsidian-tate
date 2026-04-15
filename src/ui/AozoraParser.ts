// Unicode range for kanji characters (used for implicit ruby detection)
// CJK Unified Ideographs (U+4E00–U+9FFF) + Extension A (U+3400–U+4DBF) + 繰り返し記号
export const KANJI_RE_STR = '[\u4E00-\u9FFF\u3400-\u4DBF\u{20000}-\u{2A6DF}々〆〤]+';

// パーサーパイプラインの中間表現
type ParseSegment = { type: 'text'; text: string } | { type: 'html'; html: string };

// ---- パーサー（Aozora 記法 → innerHTML） ----

// ドキュメント全体用: 各段落を <div> で包む（text-indent を段落ごとに適用するため）
export function parseToHtml(text: string): string {
    if (!text) return '';
    return text
        .split('\n')
        .map(line => `<div>${parseInlineToHtml(line) || '<br>'}</div>`)
        .join('');
}

// インライン要素用: <div> で包まずAozora記法をHTML変換する（collapseEditing で使用）
export function parseInlineToHtml(text: string): string {
    return applyParsers(text, [
        splitByExplicitRuby,
        splitByExplicitTcy,
        splitByExplicitBouten,
        splitByImplicitRuby,
    ]);
}

// テキストにパーサーを順番に適用し、HTML 文字列を返す
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

// 明示ルビ ｜base《rt》（または |base《rt》）を分割する
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

// 明示縦中横 X［＃「X」は縦中横］ を分割する
function splitByExplicitTcy(text: string): ParseSegment[] {
    return splitByAnnotation(
        text,
        /［＃「([^「」\n]+)」は縦中横］/g,
        c => `<span data-tcy="explicit" class="tcy">${esc(c)}</span>`,
    );
}

// 傍点 base［＃「base」に傍点］ を分割する
function splitByExplicitBouten(text: string): ParseSegment[] {
    return splitByAnnotation(
        text,
        /［＃「([^「」\n]+)」に傍点］/g,
        c => `<span data-bouten="sesame" class="bouten">${esc(c)}</span>`,
    );
}

// 前方参照型アノテーション記法「content［＃「content」...］」の共通分割ロジック
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

        // 注記の直前が content で終わっていなければ無効: マッチ全体を平文として出力
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

// 省略ルビ kanji《rt》 を分割する
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

// ---- DOM シリアライザ（innerHTML → Aozora 記法） ----

/**
 * DOM ノードを Aozora 記法テキストにシリアライズする。
 * rootEl: contenteditable のルート要素（段落末尾 <br> の判定に使用）
 */
export function serializeNode(node: Node, rootEl: HTMLElement): string {
    if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent ?? '';
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
            // tate-editing スパンや不明なスパン: 子ノードをシリアライズ
            return Array.from(node.childNodes)
                .map(n => serializeNode(n, rootEl))
                .join('');
        }
        case 'BR':
            // Chrome が contenteditable div の末尾に追加する表示用 <br> はスキップ
            if (
                node.parentElement !== rootEl &&
                node.parentElement?.tagName === 'DIV' &&
                node === node.parentElement.lastChild
            ) {
                return '';
            }
            return '\n';
        case 'DIV': {
            // Chrome の contenteditable が生成するブロック div
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
