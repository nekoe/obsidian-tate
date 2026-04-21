// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { parseInlineToHtml, parseToHtml, serializeNode } from './AozoraParser';

// ---- Round-trip helpers ----

function inlineRoundTrip(source: string): string {
    const container = document.createElement('div');
    container.innerHTML = parseInlineToHtml(source);
    return Array.from(container.childNodes)
        .map(n => serializeNode(n, container))
        .join('');
}

function fullRoundTrip(source: string): string {
    const rootEl = document.createElement('div');
    rootEl.innerHTML = parseToHtml(source);
    return Array.from(rootEl.childNodes)
        .map(n => serializeNode(n, rootEl))
        .join('');
}

// ================================================================
// parseInlineToHtml
// ================================================================

describe('parseInlineToHtml', () => {
    it('empty string', () => {
        expect(parseInlineToHtml('')).toBe('');
    });

    it('plain text is returned as-is', () => {
        expect(parseInlineToHtml('hello')).toBe('hello');
    });

    it('HTML special characters are escaped', () => {
        expect(parseInlineToHtml('a<b>&c')).toBe('a&lt;b&gt;&amp;c');
    });

    // ---- Explicit ruby ----

    it('explicit ruby with full-width pipe ｜', () => {
        expect(parseInlineToHtml('｜東京《とうきょう》')).toBe(
            '<ruby data-ruby-explicit="true">東京<rt>とうきょう</rt></ruby>'
        );
    });

    it('explicit ruby with half-width pipe |', () => {
        expect(parseInlineToHtml('|東京《とうきょう》')).toBe(
            '<ruby data-ruby-explicit="true">東京<rt>とうきょう</rt></ruby>'
        );
    });

    it('explicit ruby with empty rt', () => {
        expect(parseInlineToHtml('｜東京《》')).toBe(
            '<ruby data-ruby-explicit="true">東京<rt></rt></ruby>'
        );
    });

    it('explicit ruby surrounded by plain text', () => {
        expect(parseInlineToHtml('前｜東京《とうきょう》後')).toBe(
            '前<ruby data-ruby-explicit="true">東京<rt>とうきょう</rt></ruby>後'
        );
    });

    it('base text with HTML special chars is escaped inside ruby', () => {
        expect(parseInlineToHtml('｜A&B《rt》')).toBe(
            '<ruby data-ruby-explicit="true">A&amp;B<rt>rt</rt></ruby>'
        );
    });

    // ---- Implicit ruby ----

    it('implicit ruby (kanji base)', () => {
        expect(parseInlineToHtml('東京《とうきょう》')).toBe(
            '<ruby data-ruby-explicit="false">東京<rt>とうきょう</rt></ruby>'
        );
    });

    it('hiragana is NOT matched as implicit ruby base', () => {
        expect(parseInlineToHtml('あいう《ふりがな》')).toBe('あいう《ふりがな》');
    });

    it('katakana is NOT matched as implicit ruby base', () => {
        expect(parseInlineToHtml('アイウ《ふりがな》')).toBe('アイウ《ふりがな》');
    });

    it('explicit ruby takes priority over implicit when ｜ is present', () => {
        // ｜東 is matched as explicit first; remaining 《》 has no kanji prefix → plain
        expect(parseInlineToHtml('｜東《ひがし》《とう》')).toBe(
            '<ruby data-ruby-explicit="true">東<rt>ひがし</rt></ruby>《とう》'
        );
    });

    // ---- Tate-chu-yoko ----

    it('tate-chu-yoko notation', () => {
        expect(parseInlineToHtml('AB［＃「AB」は縦中横］')).toBe(
            '<span data-tcy="explicit" class="tcy">AB</span>'
        );
    });

    it('tcy with content mismatch is output as plain text', () => {
        // Preceding text ends with "CD", not "AB" → invalid
        expect(parseInlineToHtml('CD［＃「AB」は縦中横］')).toBe('CD［＃「AB」は縦中横］');
    });

    it('tcy preceded by extra plain text', () => {
        // "XAB" ends with "AB" → valid; plain("X") + tcy("AB")
        expect(parseInlineToHtml('XAB［＃「AB」は縦中横］')).toBe(
            'X<span data-tcy="explicit" class="tcy">AB</span>'
        );
    });

    // ---- Bouten ----

    it('bouten (emphasis marks)', () => {
        expect(parseInlineToHtml('春［＃「春」に傍点］')).toBe(
            '<span data-bouten="sesame" class="bouten">春</span>'
        );
    });

    it('bouten with content mismatch is output as plain text', () => {
        expect(parseInlineToHtml('夏［＃「春」に傍点］')).toBe('夏［＃「春」に傍点］');
    });

    // ---- Mixed content ----

    it('mixed: ruby + tcy + bouten + plain', () => {
        const src = '｜春《はる》中AB［＃「AB」は縦中横］末春［＃「春」に傍点］';
        expect(parseInlineToHtml(src)).toBe(
            '<ruby data-ruby-explicit="true">春<rt>はる</rt></ruby>' +
            '中' +
            '<span data-tcy="explicit" class="tcy">AB</span>' +
            '末' +
            '<span data-bouten="sesame" class="bouten">春</span>'
        );
    });
});

// ================================================================
// parseToHtml
// ================================================================

describe('parseToHtml', () => {
    it('empty string returns a single empty paragraph', () => {
        expect(parseToHtml('')).toBe('<div><br></div>');
    });

    it('single line wrapped in div', () => {
        expect(parseToHtml('hello')).toBe('<div>hello</div>');
    });

    it('blank line becomes <div><br></div>', () => {
        // "\n" splits into ['', ''] → two divs with <br>
        expect(parseToHtml('\n')).toBe('<div><br></div><div><br></div>');
    });

    it('two lines', () => {
        expect(parseToHtml('A\nB')).toBe('<div>A</div><div>B</div>');
    });

    it('blank line between two lines', () => {
        expect(parseToHtml('A\n\nB')).toBe('<div>A</div><div><br></div><div>B</div>');
    });

    it('aozora notation inside line', () => {
        expect(parseToHtml('｜東京《とうきょう》')).toBe(
            '<div><ruby data-ruby-explicit="true">東京<rt>とうきょう</rt></ruby></div>'
        );
    });

    it('multiline with notations on different lines', () => {
        expect(parseToHtml('前\n｜東《ひがし》\n後')).toBe(
            '<div>前</div>' +
            '<div><ruby data-ruby-explicit="true">東<rt>ひがし</rt></ruby></div>' +
            '<div>後</div>'
        );
    });
});

// ================================================================
// serializeNode
// ================================================================

describe('serializeNode', () => {
    it('text node returns its text content', () => {
        const root = document.createElement('div');
        const text = document.createTextNode('hello');
        root.appendChild(text);
        expect(serializeNode(text, root)).toBe('hello');
    });

    // ---- Ruby ----

    it('explicit ruby → ｜base《rt》', () => {
        const root = document.createElement('div');
        root.innerHTML = '<ruby data-ruby-explicit="true">東京<rt>とうきょう</rt></ruby>';
        expect(serializeNode(root.firstChild!, root)).toBe('｜東京《とうきょう》');
    });

    it('implicit ruby → base《rt》 (no leading ｜)', () => {
        const root = document.createElement('div');
        root.innerHTML = '<ruby data-ruby-explicit="false">東京<rt>とうきょう</rt></ruby>';
        expect(serializeNode(root.firstChild!, root)).toBe('東京《とうきょう》');
    });

    it('ruby with missing data-ruby-explicit defaults to explicit', () => {
        const root = document.createElement('div');
        root.innerHTML = '<ruby>東京<rt>とうきょう</rt></ruby>';
        expect(serializeNode(root.firstChild!, root)).toBe('｜東京《とうきょう》');
    });

    // ---- Tcy / Bouten ----

    it('tcy span → content［＃「content」は縦中横］', () => {
        const root = document.createElement('div');
        root.innerHTML = '<span data-tcy="explicit" class="tcy">AB</span>';
        expect(serializeNode(root.firstChild!, root)).toBe('AB［＃「AB」は縦中横］');
    });

    it('bouten span → content［＃「content」に傍点］', () => {
        const root = document.createElement('div');
        root.innerHTML = '<span data-bouten="sesame" class="bouten">春</span>';
        expect(serializeNode(root.firstChild!, root)).toBe('春［＃「春」に傍点］');
    });

    // ---- Cursor anchor ----

    it('cursor anchor span with U+200B only returns empty string', () => {
        const root = document.createElement('div');
        root.innerHTML = '<span class="tate-cursor-anchor">\u200B</span>';
        expect(serializeNode(root.firstChild!, root)).toBe('');
    });

    it('cursor anchor span with real text strips U+200B', () => {
        const root = document.createElement('div');
        root.innerHTML = '<span class="tate-cursor-anchor">あ\u200B</span>';
        expect(serializeNode(root.firstChild!, root)).toBe('あ');
    });

    // ---- tate-editing span ----

    it('tate-editing span serializes children as plain text', () => {
        const root = document.createElement('div');
        root.innerHTML = '<span class="tate-editing">｜東京《とうきょう》</span>';
        expect(serializeNode(root.firstChild!, root)).toBe('｜東京《とうきょう》');
    });

    // ---- DIV ----

    it('first div child has no leading newline', () => {
        const root = document.createElement('div');
        root.innerHTML = '<div>hello</div>';
        expect(serializeNode(root.firstChild!, root)).toBe('hello');
    });

    it('subsequent div child gets leading newline', () => {
        const root = document.createElement('div');
        root.innerHTML = '<div>A</div><div>B</div>';
        const [first, second] = Array.from(root.childNodes);
        expect(serializeNode(first, root)).toBe('A');
        expect(serializeNode(second, root)).toBe('\nB');
    });

    // ---- BR ----

    it('decorative trailing BR inside paragraph div returns empty string', () => {
        const root = document.createElement('div');
        root.innerHTML = '<div><br></div>';
        const innerDiv = root.firstChild as HTMLElement;
        const br = innerDiv.firstChild!;
        expect(serializeNode(br, root)).toBe('');
    });

    it('non-trailing BR returns newline', () => {
        const root = document.createElement('div');
        root.innerHTML = '<div>A<br>B</div>';
        const innerDiv = root.firstChild as HTMLElement;
        const br = innerDiv.childNodes[1]; // middle child
        expect(serializeNode(br, root)).toBe('\n');
    });

    it('BR directly inside rootEl returns newline', () => {
        const root = document.createElement('div');
        const br = document.createElement('br');
        root.appendChild(br);
        // parentElement === rootEl → not a decorative BR → returns '\n'
        expect(serializeNode(br, root)).toBe('\n');
    });
});

// ================================================================
// Round-trip: parse → DOM → serialize → original
// ================================================================

describe('inline round-trip (parseInlineToHtml → serializeNode)', () => {
    it('plain text', () => {
        expect(inlineRoundTrip('hello world')).toBe('hello world');
    });

    it('explicit ruby', () => {
        expect(inlineRoundTrip('｜東京《とうきょう》')).toBe('｜東京《とうきょう》');
    });

    it('implicit ruby', () => {
        expect(inlineRoundTrip('東京《とうきょう》')).toBe('東京《とうきょう》');
    });

    it('tcy', () => {
        expect(inlineRoundTrip('AB［＃「AB」は縦中横］')).toBe('AB［＃「AB」は縦中横］');
    });

    it('bouten', () => {
        expect(inlineRoundTrip('春［＃「春」に傍点］')).toBe('春［＃「春」に傍点］');
    });

    it('explicit ruby surrounded by plain text', () => {
        expect(inlineRoundTrip('前｜東京《とうきょう》後')).toBe('前｜東京《とうきょう》後');
    });

    it('implicit ruby surrounded by plain text', () => {
        expect(inlineRoundTrip('前東京《とうきょう》後')).toBe('前東京《とうきょう》後');
    });

    it('mixed: ruby + tcy + bouten', () => {
        const src = '前｜東京《とうきょう》中AB［＃「AB」は縦中横］末春［＃「春」に傍点］後';
        expect(inlineRoundTrip(src)).toBe(src);
    });
});

describe('full round-trip (parseToHtml → serializeNode)', () => {
    it('single line', () => {
        expect(fullRoundTrip('hello')).toBe('hello');
    });

    it('multiple lines', () => {
        expect(fullRoundTrip('A\nB\nC')).toBe('A\nB\nC');
    });

    it('blank line', () => {
        expect(fullRoundTrip('A\n\nB')).toBe('A\n\nB');
    });

    it('single newline', () => {
        expect(fullRoundTrip('\n')).toBe('\n');
    });

    it('line with ruby notation', () => {
        expect(fullRoundTrip('｜東京《とうきょう》')).toBe('｜東京《とうきょう》');
    });

    it('leading blank line', () => {
        expect(fullRoundTrip('\nA')).toBe('\nA');
    });

    it('multiple lines with various notations', () => {
        const src = '前\n｜東京《とうきょう》\nAB［＃「AB」は縦中横］\n春［＃「春」に傍点］\n後';
        expect(fullRoundTrip(src)).toBe(src);
    });
});
