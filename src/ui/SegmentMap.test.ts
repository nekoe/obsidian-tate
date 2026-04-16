import { describe, it, expect } from 'vitest';
import { buildSegmentMap, srcToView, viewToSrc, Segment } from './SegmentMap';

// ---- helpers ----

/** セグメントの srcStart+srcLen が連続していることを検証 */
function assertContiguous(segs: Segment[], srcLen: number): void {
    let pos = 0;
    for (const s of segs) {
        expect(s.srcStart).toBe(pos);
        pos += s.srcLen;
    }
    expect(pos).toBe(srcLen);
}

/** セグメントの viewStart+viewLen が連続していることを検証 */
function assertViewContiguous(segs: Segment[]): void {
    let pos = 0;
    for (const s of segs) {
        expect(s.viewStart).toBe(pos);
        pos += s.viewLen;
    }
}

// ================================================================
// buildSegmentMap
// ================================================================

describe('buildSegmentMap', () => {
    it('空文字列', () => {
        const segs = buildSegmentMap('');
        expect(segs).toHaveLength(0);
    });

    it('plain テキストのみ', () => {
        const src = 'Hello世界';
        const segs = buildSegmentMap(src);
        expect(segs).toHaveLength(1);
        expect(segs[0]).toMatchObject({
            kind: 'plain', srcStart: 0, srcLen: 7, viewStart: 0, viewLen: 7,
        });
        assertContiguous(segs, src.length);
    });

    it('改行のみ', () => {
        const src = '\n';
        const segs = buildSegmentMap(src);
        expect(segs).toHaveLength(1);
        expect(segs[0]).toMatchObject({
            kind: 'newline', srcStart: 0, srcLen: 1, viewStart: 0, viewLen: 0,
        });
    });

    it('改行を含む複数段落', () => {
        const src = 'ABC\nDEF';
        const segs = buildSegmentMap(src);
        expect(segs).toHaveLength(3);
        expect(segs[0]).toMatchObject({ kind: 'plain', srcStart: 0, srcLen: 3, viewStart: 0, viewLen: 3 });
        expect(segs[1]).toMatchObject({ kind: 'newline', srcStart: 3, srcLen: 1, viewStart: 3, viewLen: 0 });
        expect(segs[2]).toMatchObject({ kind: 'plain', srcStart: 4, srcLen: 3, viewStart: 3, viewLen: 3 });
        assertContiguous(segs, src.length);
        assertViewContiguous(segs);
    });

    it('明示ルビ ｜漢字《かんじ》', () => {
        const src = '｜漢字《かんじ》'; // ｜(1) + 漢字(2) + 《(1) + かんじ(3) + 》(1) = 8 chars
        const segs = buildSegmentMap(src);
        expect(segs).toHaveLength(1);
        const s = segs[0];
        expect(s.kind).toBe('ruby-explicit');
        expect(s.srcLen).toBe(8);  // 2+3+3=8
        expect(s.viewLen).toBe(2); // base=漢字
        expect(s.baseLen).toBe(2);
        expect(s.rtLen).toBe(3);   // rt=かんじ
        assertContiguous(segs, src.length);
    });

    it('明示ルビ（半角パイプ）|base《rt》', () => {
        const src = '|AB《cd》'; // |(1)+AB(2)+《(1)+cd(2)+》(1) = 7
        const segs = buildSegmentMap(src);
        expect(segs).toHaveLength(1);
        expect(segs[0].kind).toBe('ruby-explicit');
        expect(segs[0].srcLen).toBe(7);
        expect(segs[0].viewLen).toBe(2);
        expect(segs[0].baseLen).toBe(2);
        expect(segs[0].rtLen).toBe(2);
    });

    it('省略ルビ 漢字《かんじ》', () => {
        const src = '漢字《かんじ》'; // 漢字(2)+《(1)+かんじ(3)+》(1) = 7
        const segs = buildSegmentMap(src);
        expect(segs).toHaveLength(1);
        const s = segs[0];
        expect(s.kind).toBe('ruby-implicit');
        expect(s.srcLen).toBe(7);
        expect(s.viewLen).toBe(2);
        expect(s.baseLen).toBe(2);
        expect(s.rtLen).toBe(3);
    });

    it('縦中横 AB［＃「AB」は縦中横］', () => {
        // AB + ［＃「AB」は縦中横］ = 2 + (2*2+9) = 2 + 13 = 15? No wait:
        // srcLen = contentLen*2 + 9 = 2*2+9 = 13
        const src = 'AB［＃「AB」は縦中横］';
        const segs = buildSegmentMap(src);
        expect(segs).toHaveLength(1);
        expect(segs[0].kind).toBe('tcy');
        expect(segs[0].srcLen).toBe(13); // 2*2+9=13
        expect(segs[0].viewLen).toBe(2);
        assertContiguous(segs, src.length);
    });

    it('傍点 AB［＃「AB」に傍点］', () => {
        // srcLen = 2*2+8 = 12
        const src = 'AB［＃「AB」に傍点］';
        const segs = buildSegmentMap(src);
        expect(segs).toHaveLength(1);
        expect(segs[0].kind).toBe('bouten');
        expect(segs[0].srcLen).toBe(12);
        expect(segs[0].viewLen).toBe(2);
        assertContiguous(segs, src.length);
    });

    it('明示ルビ前後に plain テキスト', () => {
        const src = 'ABC｜DE《fg》XYZ';
        const segs = buildSegmentMap(src);
        expect(segs).toHaveLength(3);
        expect(segs[0]).toMatchObject({ kind: 'plain', srcStart: 0, srcLen: 3 });
        expect(segs[1]).toMatchObject({ kind: 'ruby-explicit', baseLen: 2, rtLen: 2 });
        expect(segs[2]).toMatchObject({ kind: 'plain', srcLen: 3 });
        assertContiguous(segs, src.length);
        assertViewContiguous(segs);
    });

    it('縦中横の前に別の plain テキストがある場合', () => {
        // "AX" where X tcy, not "A" matches "AX" — invalid content check
        const src = 'AAB［＃「AB」は縦中横］';
        // "AAB" ends with "AB" → valid, contentStart=1
        const segs = buildSegmentMap(src);
        // Should be: plain('A') + tcy('AB')
        expect(segs).toHaveLength(2);
        expect(segs[0]).toMatchObject({ kind: 'plain', srcStart: 0, srcLen: 1, viewLen: 1 });
        expect(segs[1]).toMatchObject({ kind: 'tcy', viewLen: 2 });
        assertContiguous(segs, src.length);
    });

    it('無効な縦中横（前方テキスト不一致）は平文として出力', () => {
        // ZAB where 注記内は AB だが "Z" + AB の直前テキストは "Z" であり "AB" で終わる → valid
        // Let's use a case that actually is invalid: content="XY" but preceding text ends with "AB"
        const src = 'AB［＃「XY」は縦中横］';
        // "AB" does NOT end with "XY" → invalid match
        const segs = buildSegmentMap(src);
        // whole src should be plain
        expect(segs).toHaveLength(1);
        expect(segs[0].kind).toBe('plain');
        expect(segs[0].srcLen).toBe(src.length);
    });

    it('複合: plain + ルビ + 改行 + tcy', () => {
        const ruby = '｜漢《かん》'; // 1+1+1+2+1=6
        const tcy  = 'A［＃「A」は縦中横］'; // 1*2+9=11
        const src  = `前${ruby}\n${tcy}後`;
        const segs = buildSegmentMap(src);
        assertContiguous(segs, src.length);
        assertViewContiguous(segs);
        // kinds: plain, ruby-explicit, newline, tcy, plain
        const kinds = segs.map(s => s.kind);
        expect(kinds).toEqual(['plain', 'ruby-explicit', 'newline', 'tcy', 'plain']);
    });

    it('省略ルビは漢字連続のみにマッチする（ひらがなにはマッチしない）', () => {
        const src = 'あいう《ふりがな》';
        const segs = buildSegmentMap(src);
        // ひらがなは KANJI_RE にマッチしないので plain のまま
        expect(segs).toHaveLength(1);
        expect(segs[0].kind).toBe('plain');
    });
});

// ================================================================
// srcToView
// ================================================================

describe('srcToView', () => {
    it('plain: 1:1 対応', () => {
        const segs = buildSegmentMap('ABCDE');
        expect(srcToView(segs, 0)).toBe(0);
        expect(srcToView(segs, 3)).toBe(3);
        expect(srcToView(segs, 5)).toBe(5);
    });

    it('空の segs → 0 を返す', () => {
        expect(srcToView([], 0)).toBe(0);
        expect(srcToView([], 10)).toBe(0);
    });

    it('明示ルビ ｜AB《cd》: 各位置のマッピング', () => {
        // src: ｜(0) A(1) B(2) 《(3) c(4) d(5) 》(6)
        // view: A(0) B(1)
        const segs = buildSegmentMap('｜AB《cd》');
        expect(srcToView(segs, 0)).toBe(0); // ｜ → viewStart
        expect(srcToView(segs, 1)).toBe(0); // A → view 0
        expect(srcToView(segs, 2)).toBe(1); // B → view 1
        expect(srcToView(segs, 3)).toBe(2); // 《 → base末尾（viewLen=2）
        expect(srcToView(segs, 4)).toBe(2); // c → base末尾
        expect(srcToView(segs, 5)).toBe(2); // d → base末尾
        expect(srcToView(segs, 6)).toBe(2); // 》→ base末尾
    });

    it('省略ルビ AB《cd》: 各位置のマッピング', () => {
        // src: A(0) B(1) 《(2) c(3) d(4) 》(5)  — but AB must be kanji
        // Use kanji for implicit ruby
        const segs = buildSegmentMap('漢字《かんじ》');
        // base=漢字(2), rt=かんじ(3)
        // src: 漢(0) 字(1) 《(2) か(3) ん(4) じ(5) 》(6)
        expect(srcToView(segs, 0)).toBe(0); // 漢 → view 0
        expect(srcToView(segs, 1)).toBe(1); // 字 → view 1
        expect(srcToView(segs, 2)).toBe(2); // 《 → base末尾
        expect(srcToView(segs, 6)).toBe(2); // 》→ base末尾
    });

    it('縦中横 AB[...]: 各位置のマッピング', () => {
        const segs = buildSegmentMap('AB［＃「AB」は縦中横］');
        // content=AB(0..1), annotation starts at 2
        expect(srcToView(segs, 0)).toBe(0);
        expect(srcToView(segs, 1)).toBe(1);
        expect(srcToView(segs, 2)).toBe(2); // annotation → contentLen
        expect(srcToView(segs, 12)).toBe(2);
    });

    it('改行: 改行位置は viewStart を返す', () => {
        // "AB\nCD"
        // segs: plain(AB, srcStart=0, viewStart=0), newline(srcStart=2, viewStart=2), plain(CD, srcStart=3, viewStart=2)
        const segs = buildSegmentMap('AB\nCD');
        expect(srcToView(segs, 0)).toBe(0); // A
        expect(srcToView(segs, 1)).toBe(1); // B
        expect(srcToView(segs, 2)).toBe(2); // \n → viewStart=2
        expect(srcToView(segs, 3)).toBe(2); // C → viewStart=2（改行後）
        expect(srcToView(segs, 4)).toBe(3); // D
    });

    it('ソース末尾の場合: 全 viewLen を返す', () => {
        const s2 = buildSegmentMap('ABCDE');
        expect(srcToView(s2, 5)).toBe(5);
        expect(srcToView(s2, 99)).toBe(5); // beyond end
    });

    it('前後に plain がある明示ルビ', () => {
        const src = 'X｜AB《cd》Y';
        // plain(X, src=0..0), ruby-explicit(src=1..7), plain(Y, src=8..8)
        const segs = buildSegmentMap(src);
        expect(srcToView(segs, 0)).toBe(0); // X
        expect(srcToView(segs, 1)).toBe(1); // ｜ → viewStart=1
        expect(srcToView(segs, 2)).toBe(1); // A → view 1
        expect(srcToView(segs, 3)).toBe(2); // B → view 2
        expect(srcToView(segs, 8)).toBe(3); // Y
    });
});

// ================================================================
// viewToSrc
// ================================================================

describe('viewToSrc', () => {
    it('plain: 1:1 対応', () => {
        const segs = buildSegmentMap('ABCDE');
        expect(viewToSrc(segs, 0)).toBe(0);
        expect(viewToSrc(segs, 3)).toBe(3);
        expect(viewToSrc(segs, 5)).toBe(5);
    });

    it('空の segs → 0 を返す', () => {
        expect(viewToSrc([], 0)).toBe(0);
    });

    it('明示ルビ ｜AB《cd》: view → src（｜の分 +1 シフト）', () => {
        const segs = buildSegmentMap('｜AB《cd》');
        // view 0 → src 1（A）、view 1 → src 2（B）
        expect(viewToSrc(segs, 0)).toBe(1);
        expect(viewToSrc(segs, 1)).toBe(2);
        expect(viewToSrc(segs, 2)).toBe(7); // end of segment
    });

    it('省略ルビ 漢字《かんじ》: view → src（そのまま）', () => {
        const segs = buildSegmentMap('漢字《かんじ》');
        expect(viewToSrc(segs, 0)).toBe(0);
        expect(viewToSrc(segs, 1)).toBe(1);
        expect(viewToSrc(segs, 2)).toBe(7); // end of segment
    });

    it('縦中横 AB[...]: view → src（content 先頭から）', () => {
        const segs = buildSegmentMap('AB［＃「AB」は縦中横］');
        expect(viewToSrc(segs, 0)).toBe(0);
        expect(viewToSrc(segs, 1)).toBe(1);
        expect(viewToSrc(segs, 2)).toBe(13); // end of segment
    });

    it('改行をまたぐ場合', () => {
        const segs = buildSegmentMap('AB\nCD');
        // view 0=A, 1=B, 2=C(srcStart=3), 3=D
        expect(viewToSrc(segs, 0)).toBe(0);
        expect(viewToSrc(segs, 1)).toBe(1);
        expect(viewToSrc(segs, 2)).toBe(3); // Cはsrcオフセット3
        expect(viewToSrc(segs, 3)).toBe(4);
    });

    it('前後に plain がある明示ルビ（srcToView の逆）', () => {
        const src = 'X｜AB《cd》Y';
        const segs = buildSegmentMap(src);
        // srcToView: src1→view1, src2→view1, src3→view2, src8→view3
        // viewToSrc: view1→src2(A), view2→src3(B), view3→src8(Y)
        expect(viewToSrc(segs, 0)).toBe(0); // X
        expect(viewToSrc(segs, 1)).toBe(2); // A（｜の分ずれる）
        expect(viewToSrc(segs, 2)).toBe(3); // B
        expect(viewToSrc(segs, 3)).toBe(8); // Y
    });
});

// ================================================================
// srcToView / viewToSrc の連携（カーソル復元のユースケース）
// ================================================================

describe('srcToView + viewToSrc 連携', () => {
    it('plain テキスト: srcToView → viewToSrc がほぼ元に戻る', () => {
        const segs = buildSegmentMap('ABCDE');
        for (let i = 0; i <= 5; i++) {
            expect(viewToSrc(segs, srcToView(segs, i))).toBe(i);
        }
    });

    it('明示ルビ: base 内の src は往復が成立する', () => {
        // src: ｜(0)A(1)B(2)《(3)cd(4,5)》(6)
        // base chars are at src 1 and 2
        const segs = buildSegmentMap('｜AB《cd》');
        expect(viewToSrc(segs, srcToView(segs, 1))).toBe(1); // A
        expect(viewToSrc(segs, srcToView(segs, 2))).toBe(2); // B
    });

    it('縦中横: content 内の src は往復が成立する', () => {
        const segs = buildSegmentMap('AB［＃「AB」は縦中横］');
        expect(viewToSrc(segs, srcToView(segs, 0))).toBe(0);
        expect(viewToSrc(segs, srcToView(segs, 1))).toBe(1);
    });
});
