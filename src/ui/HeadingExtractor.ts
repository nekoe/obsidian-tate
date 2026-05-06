import type { ParagraphRecord } from './ParagraphVirtualizer';

export type HeadingLevel = 'large' | 'mid' | 'small';

export interface HeadingEntry {
    text: string;
    level: HeadingLevel;
    paragraphIndex: number;
    viewOffset: number; // prefix sum of viewLen for paragraphs [0, paragraphIndex)
}

const HEADING_RE = /［＃「([^「」\n]+)」は(大|中|小)見出し］/g;

// Scans paragraphRecords for heading annotations and returns a flat list of HeadingEntry values.
// viewOffset is the cumulative visible-text offset of the paragraph containing the heading.
// Pure function — no DOM or Obsidian API dependencies.
export function extractHeadings(records: readonly ParagraphRecord[]): HeadingEntry[] {
    const entries: HeadingEntry[] = [];
    let viewOffset = 0;
    for (let i = 0; i < records.length; i++) {
        const { src, viewLen } = records[i];
        HEADING_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = HEADING_RE.exec(src)) !== null) {
            const text = m[1];
            const level: HeadingLevel =
                m[2] === '大' ? 'large' : m[2] === '中' ? 'mid' : 'small';
            entries.push({ text, level, paragraphIndex: i, viewOffset });
        }
        viewOffset += viewLen;
    }
    return entries;
}
