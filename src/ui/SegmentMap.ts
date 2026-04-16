// Unicode range for kanji characters (same as EditorElement.ts)
const KANJI_RE_STR = '[\u4E00-\u9FFF\u3400-\u4DBF\u{20000}-\u{2A6DF}々〆〤]+';

export type SegmentKind = 'plain' | 'ruby-explicit' | 'ruby-implicit' | 'tcy' | 'bouten' | 'newline';

export interface Segment {
    readonly kind: SegmentKind;
    readonly srcStart: number;   // Start offset in the source text
    readonly srcLen: number;     // Length in the source text
    readonly viewStart: number;  // Start position in visible offset space (excluding RT)
    readonly viewLen: number;    // Visible character count (plain=srcLen, ruby=baseLen, tcy/bouten=contentLen, newline=0)
    readonly baseLen?: number;   // ruby only: character count of the base text
    readonly rtLen?: number;     // ruby only: character count of the RT text
}

// ---- Internal pipeline types ----

interface ResolvedItem {
    readonly resolved: true;
    readonly kind: SegmentKind;
    readonly srcLen: number;
    readonly viewLen: number;
    readonly baseLen?: number;
    readonly rtLen?: number;
}

interface UnresolvedItem {
    readonly resolved: false;
    readonly raw: string;
}

type PipelineItem = ResolvedItem | UnresolvedItem;

// ---- Public API ----

/**
 * Builds a Segment array from Aozora source text.
 * Recognizes notations in the same priority order as parseInlineToHtml():
 *   1. Explicit ruby ｜base《rt》
 *   2. Tate-chu-yoko content［＃「content」は縦中横］
 *   3. Bouten content［＃「content」に傍点］
 *   4. Implicit ruby kanji《rt》
 *   5. Newline \n
 */
export function buildSegmentMap(source: string): Segment[] {
    const tokens = tokenize(source);
    const segments: Segment[] = [];
    let srcPos = 0;
    let viewPos = 0;

    for (const tok of tokens) {
        const seg: Segment = {
            kind: tok.kind,
            srcStart: srcPos,
            srcLen: tok.srcLen,
            viewStart: viewPos,
            viewLen: tok.viewLen,
        };
        // Optional fields: assigned explicitly because spread is not type-safe here
        if (tok.baseLen !== undefined) (seg as { baseLen?: number }).baseLen = tok.baseLen;
        if (tok.rtLen !== undefined) (seg as { rtLen?: number }).rtLen = tok.rtLen;
        segments.push(seg);
        srcPos += tok.srcLen;
        viewPos += tok.viewLen;
    }

    return segments;
}

/**
 * Converts a source text offset to a visible offset.
 *
 * plain:         1:1 mapping
 * ruby-explicit: local=0(｜) → viewStart,
 *                local=1..baseLen(base) → viewStart+(local-1),
 *                local≥baseLen+1(《rt》) → viewStart+baseLen
 * ruby-implicit: local=0..baseLen(base) → viewStart+local,
 *                local≥baseLen+1(《rt》) → viewStart+baseLen
 * tcy/bouten:    local=0..viewLen(content) → viewStart+local,
 *                local≥viewLen+1(annotation) → viewStart+viewLen
 * newline:       → viewStart (viewLen=0, passed through as-is)
 */
export function srcToView(segs: readonly Segment[], srcOffset: number): number {
    for (const seg of segs) {
        if (srcOffset < seg.srcStart) break;
        if (srcOffset < seg.srcStart + seg.srcLen) {
            return mapSrcLocalToView(seg, srcOffset - seg.srcStart);
        }
    }
    if (segs.length === 0) return 0;
    const last = segs[segs.length - 1];
    return last.viewStart + last.viewLen;
}

/**
 * Converts a visible offset to a source text offset.
 * Skips newline segments (viewLen=0) and resolves using the first non-zero segment that contains the offset.
 *
 * plain:         1:1 mapping
 * ruby-explicit: view local 0..baseLen → src local 1..baseLen+1 (+1 for ｜)
 * ruby-implicit: view local 0..baseLen → src local 0..baseLen (no shift)
 * tcy/bouten:    view local 0..contentLen → src local 0..contentLen (content is at the front)
 */
export function viewToSrc(segs: readonly Segment[], viewOffset: number): number {
    for (const seg of segs) {
        if (seg.viewLen === 0) continue;
        if (viewOffset < seg.viewStart + seg.viewLen) {
            const local = Math.max(0, viewOffset - seg.viewStart);
            return mapViewLocalToSrc(seg, local);
        }
    }
    if (segs.length === 0) return 0;
    const last = segs[segs.length - 1];
    return last.srcStart + last.srcLen;
}

// ---- Internal helpers ----

function mapSrcLocalToView(seg: Segment, local: number): number {
    switch (seg.kind) {
        case 'plain':
        case 'newline':
            return seg.viewStart + local;
        case 'ruby-explicit': {
            // ｜base《rt》: local 0=｜, 1..baseLen=base, baseLen+1..=《rt》
            const baseLen = seg.baseLen ?? seg.viewLen;
            if (local === 0) return seg.viewStart;
            if (local <= baseLen) return seg.viewStart + local - 1;
            return seg.viewStart + seg.viewLen;
        }
        case 'ruby-implicit': {
            // base《rt》: local 0..baseLen=base, baseLen+1..=《rt》
            const baseLen = seg.baseLen ?? seg.viewLen;
            if (local <= baseLen) return seg.viewStart + local;
            return seg.viewStart + seg.viewLen;
        }
        case 'tcy':
        case 'bouten': {
            // content[annotation]: local 0..viewLen=content, viewLen+1..=annotation
            if (local <= seg.viewLen) return seg.viewStart + local;
            return seg.viewStart + seg.viewLen;
        }
    }
}

function mapViewLocalToSrc(seg: Segment, local: number): number {
    switch (seg.kind) {
        case 'plain':
        case 'newline':
            return seg.srcStart + local;
        case 'ruby-explicit':
            // view local 0..baseLen → src local 1..baseLen+1 (shifted by 1 for ｜)
            return seg.srcStart + 1 + local;
        case 'ruby-implicit':
        case 'tcy':
        case 'bouten':
            return seg.srcStart + local;
    }
}

// ---- Tokenizer ----

function tokenize(source: string): ResolvedItem[] {
    let items: PipelineItem[] = [{ resolved: false, raw: source }];

    const tcyRe    = /［＃「([^「」\n]+)」は縦中横］/g;
    const boutenRe = /［＃「([^「」\n]+)」に傍点］/g;

    // Recognize each notation in the same order as parseInlineToHtml()
    items = flatScan(items, scanExplicitRuby);
    items = flatScan(items, raw => scanAnnotation(raw, tcyRe,    'tcy',    9));
    items = flatScan(items, raw => scanAnnotation(raw, boutenRe, 'bouten', 8));
    items = flatScan(items, scanImplicitRuby);
    items = flatScan(items, scanNewlines);

    // Remaining unresolved items are plain text (non-newline text left after scanNewlines)
    return items.map(item => {
        if (!item.resolved) {
            const len = item.raw.length;
            return { resolved: true as const, kind: 'plain' as const, srcLen: len, viewLen: len };
        }
        return item;
    });
}

function flatScan(
    items: PipelineItem[],
    scanner: (raw: string) => PipelineItem[],
): PipelineItem[] {
    return items.flatMap(item => (item.resolved ? [item] : scanner(item.raw)));
}

function scanExplicitRuby(raw: string): PipelineItem[] {
    const re = /[|｜]([^|｜《》\n]+)《([^《》\n]*)》/g;
    const result: PipelineItem[] = [];
    let lastIndex = 0;
    let m: RegExpExecArray | null;

    while ((m = re.exec(raw)) !== null) {
        if (m.index > lastIndex) {
            result.push({ resolved: false, raw: raw.slice(lastIndex, m.index) });
        }
        const baseLen = m[1].length;
        const rtLen   = m[2].length;
        result.push({
            resolved: true, kind: 'ruby-explicit',
            srcLen: baseLen + rtLen + 3, // ｜ + base + 《 + rt + 》
            viewLen: baseLen, baseLen, rtLen,
        });
        lastIndex = re.lastIndex;
    }
    if (lastIndex < raw.length) result.push({ resolved: false, raw: raw.slice(lastIndex) });
    return result;
}

function scanAnnotation(
    raw: string,
    re: RegExp,
    kind: 'tcy' | 'bouten',
    bracketFixedLen: number, // 9=tcy, 8=bouten (fixed character count including 「」 and keyword)
): PipelineItem[] {
    re.lastIndex = 0;
    const result: PipelineItem[] = [];
    let lastIndex = 0;
    let m: RegExpExecArray | null;

    while ((m = re.exec(raw)) !== null) {
        const content        = m[1];
        const annotationStart = m.index; // position of ［

        // Invalid match (content not present just before annotation): output as plain text
        if (!raw.slice(lastIndex, annotationStart).endsWith(content)) {
            result.push({ resolved: false, raw: raw.slice(lastIndex, re.lastIndex) });
            lastIndex = re.lastIndex;
            continue;
        }

        const contentStart = annotationStart - content.length;
        if (contentStart > lastIndex) {
            result.push({ resolved: false, raw: raw.slice(lastIndex, contentStart) });
        }
        result.push({
            resolved: true, kind,
            srcLen:  content.length * 2 + bracketFixedLen, // content + ［＃「content」...］
            viewLen: content.length,
        });
        lastIndex = re.lastIndex;
    }
    if (lastIndex < raw.length) result.push({ resolved: false, raw: raw.slice(lastIndex) });
    return result;
}

function scanImplicitRuby(raw: string): PipelineItem[] {
    const re = new RegExp(`(${KANJI_RE_STR})《([^《》\\n]*)》`, 'gu');
    const result: PipelineItem[] = [];
    let lastIndex = 0;
    let m: RegExpExecArray | null;

    while ((m = re.exec(raw)) !== null) {
        if (m.index > lastIndex) {
            result.push({ resolved: false, raw: raw.slice(lastIndex, m.index) });
        }
        const baseLen = m[1].length;
        const rtLen   = m[2].length;
        result.push({
            resolved: true, kind: 'ruby-implicit',
            srcLen: baseLen + rtLen + 2, // base + 《 + rt + 》
            viewLen: baseLen, baseLen, rtLen,
        });
        lastIndex = re.lastIndex;
    }
    if (lastIndex < raw.length) result.push({ resolved: false, raw: raw.slice(lastIndex) });
    return result;
}

function scanNewlines(raw: string): PipelineItem[] {
    const parts  = raw.split('\n');
    const result: PipelineItem[] = [];
    for (let i = 0; i < parts.length; i++) {
        if (parts[i].length > 0) result.push({ resolved: false, raw: parts[i] });
        if (i < parts.length - 1) {
            result.push({ resolved: true, kind: 'newline', srcLen: 1, viewLen: 0 });
        }
    }
    return result;
}
