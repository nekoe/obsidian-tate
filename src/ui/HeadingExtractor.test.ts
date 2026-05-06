import { describe, it, expect } from 'vitest';
import { extractHeadings } from './HeadingExtractor';
import type { ParagraphRecord } from './ParagraphVirtualizer';

function rec(src: string, viewLen: number): ParagraphRecord {
    return { src, viewLen, width: 0 };
}

describe('extractHeadings', () => {
    it('returns empty array for empty records', () => {
        expect(extractHeadings([])).toEqual([]);
    });

    it('returns empty array when no headings present', () => {
        const records = [rec('吾輩は猫である。', 8), rec('名前はまだ無い。', 8)];
        expect(extractHeadings(records)).toEqual([]);
    });

    it('extracts a single large heading', () => {
        const src = '序章［＃「序章」は大見出し］';
        const records = [rec(src, 2)];
        const result = extractHeadings(records);
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ text: '序章', level: 'large', paragraphIndex: 0, viewOffset: 0 });
    });

    it('extracts mid heading', () => {
        const src = '第一節［＃「第一節」は中見出し］';
        const records = [rec(src, 3)];
        const result = extractHeadings(records);
        expect(result[0]).toMatchObject({ text: '第一節', level: 'mid', paragraphIndex: 0, viewOffset: 0 });
    });

    it('extracts small heading', () => {
        const src = 'はじめに［＃「はじめに」は小見出し］';
        const records = [rec(src, 4)];
        const result = extractHeadings(records);
        expect(result[0]).toMatchObject({ text: 'はじめに', level: 'small', paragraphIndex: 0, viewOffset: 0 });
    });

    it('accumulates viewOffset across paragraphs', () => {
        const records = [
            rec('吾輩は猫である。', 8),
            rec('序章［＃「序章」は大見出し］', 2),
            rec('第一節［＃「第一節」は中見出し］', 3),
        ];
        const result = extractHeadings(records);
        expect(result).toHaveLength(2);
        expect(result[0]).toMatchObject({ text: '序章', level: 'large', paragraphIndex: 1, viewOffset: 8 });
        expect(result[1]).toMatchObject({ text: '第一節', level: 'mid', paragraphIndex: 2, viewOffset: 10 });
    });

    it('handles multiple headings in one paragraph', () => {
        const src = '序章［＃「序章」は大見出し］第一節［＃「第一節」は中見出し］';
        const records = [rec(src, 5)];
        const result = extractHeadings(records);
        expect(result).toHaveLength(2);
        expect(result[0]).toMatchObject({ text: '序章', level: 'large', viewOffset: 0 });
        expect(result[1]).toMatchObject({ text: '第一節', level: 'mid', viewOffset: 0 });
    });

    it('mixes plain paragraphs and heading paragraphs', () => {
        const records = [
            rec('序章［＃「序章」は大見出し］', 2),
            rec('本文テキスト。', 7),
            rec('はじめに［＃「はじめに」は小見出し］', 4),
        ];
        const result = extractHeadings(records);
        expect(result).toHaveLength(2);
        expect(result[0]).toMatchObject({ paragraphIndex: 0, viewOffset: 0 });
        expect(result[1]).toMatchObject({ paragraphIndex: 2, viewOffset: 9 });
    });
});
