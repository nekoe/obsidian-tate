import type { ParagraphRecord } from './ParagraphVirtualizer';
import { HEADING, scanRegex, headingLevelFromKanji, type HeadingLevel } from './aozoraPatterns';

export type { HeadingLevel };

export interface HeadingEntry {
    text: string;
    level: HeadingLevel;
    paragraphIndex: number;
    viewOffset: number; // prefix sum of viewLen for paragraphs [0, paragraphIndex)
}

// Scans paragraphRecords for heading annotations and returns a flat list of HeadingEntry values.
// viewOffset is the cumulative visible-text offset of the paragraph containing the heading.
// Pure function — no DOM or Obsidian API dependencies.
export function extractHeadings(records: readonly ParagraphRecord[]): HeadingEntry[] {
    const entries: HeadingEntry[] = [];
    const re = scanRegex(HEADING);
    let viewOffset = 0;
    for (let i = 0; i < records.length; i++) {
        const { src, viewLen } = records[i];
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(src)) !== null) {
            const text = m[1];
            const level = headingLevelFromKanji(m[2]);
            entries.push({ text, level, paragraphIndex: i, viewOffset });
        }
        viewOffset += viewLen;
    }
    return entries;
}
