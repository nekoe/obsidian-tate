// Single source of truth for Aozora notation patterns.
//
// Each notation is defined once here as a flag-less, anchor-less pattern body. Call sites
// build the concrete RegExp they need via the factory helpers below, choosing the right
// flags for their use:
//   • scanRegex      — global scan of all matches in a string (parsers, tokenizers)
//   • completionRegex — end-anchored match-before-cursor (live conversion as the user types)
//   • plainRegex      — single unanchored match (offset/correction lookups)
//
// Keeping the pattern bodies here ensures AozoraParser (DOM generation) and SegmentMap
// (offset computation) can never drift apart — a drift would corrupt cursor mapping.

// CJK Unified Ideographs (U+4E00–U+9FFF) + Extension A (U+3400–U+4DBF) + Extension B + iteration marks.
export const KANJI_RE_STR = '[\u4E00-\u9FFF\u3400-\u4DBF\u{20000}-\u{2A6DF}々〆〤]+';

export interface AozoraPattern {
    readonly body: string;
    readonly unicode: boolean;
}

// Explicit ruby: ｜base《rt》 (or |base《rt》). Group 1 = base, group 2 = rt.
export const EXPLICIT_RUBY: AozoraPattern = {
    body: '[|｜]([^|｜《》\\n]+)《([^《》\\n]*)》',
    unicode: false,
};

// Implicit ruby: kanji《rt》. Group 1 = base, group 2 = rt. Requires the 'u' flag for KANJI_RE_STR.
export const IMPLICIT_RUBY: AozoraPattern = {
    body: `(${KANJI_RE_STR})《([^《》\\n]*)》`,
    unicode: true,
};

// Tate-chu-yoko: content［＃「content」は縦中横］. Group 1 = content.
export const TCY: AozoraPattern = {
    body: '［＃「([^「」\\n]+)」は縦中横］',
    unicode: false,
};

// Bouten (emphasis marks): content［＃「content」に傍点］. Group 1 = content.
export const BOUTEN: AozoraPattern = {
    body: '［＃「([^「」\\n]+)」に傍点］',
    unicode: false,
};

// Heading: content［＃「content」は(大|中|小)見出し］. Group 1 = content, group 2 = level kanji.
export const HEADING: AozoraPattern = {
    body: '［＃「([^「」\\n]+)」は(大|中|小)見出し］',
    unicode: false,
};

// Returns a fresh global RegExp (own lastIndex) for scanning all matches in a string.
export function scanRegex(p: AozoraPattern): RegExp {
    return new RegExp(p.body, p.unicode ? 'gu' : 'g');
}

// Returns an end-anchored RegExp for matching a completed notation just before the cursor.
export function completionRegex(p: AozoraPattern): RegExp {
    return new RegExp(p.body + '$', p.unicode ? 'u' : '');
}

// Returns an unanchored, non-global RegExp for a single match (e.g. with String.match to read m.index).
export function plainRegex(p: AozoraPattern): RegExp {
    return new RegExp(p.body, p.unicode ? 'u' : '');
}

export type HeadingLevel = 'large' | 'mid' | 'small';

// Maps the level kanji captured by HEADING (大/中/小) to the internal level name.
export function headingLevelFromKanji(kanji: string): HeadingLevel {
    return kanji === '大' ? 'large' : kanji === '中' ? 'mid' : 'small';
}
