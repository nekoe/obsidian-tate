import { TatePluginSettings } from '../settings';
import { buildSegmentMap, srcToView } from './SegmentMap';

// 省略形式で自動検出する漢字の Unicode 範囲
// CJK Unified Ideographs (U+4E00–U+9FFF) + Extension A (U+3400–U+4DBF) + 繰り返し記号
const KANJI_RE_STR = '[\u4E00-\u9FFF\u3400-\u4DBF\u{20000}-\u{2A6DF}々〆〤]+';

// パーサーパイプラインの中間表現
type ParseSegment = { type: 'text'; text: string } | { type: 'html'; html: string };

export class EditorElement {
    readonly el: HTMLDivElement;

    // インライン展開中の編集スパン。null なら展開なし。
    private expandedEl: HTMLSpanElement | null = null;
    // selectionchange ハンドラ内での DOM 操作中に再入しないためのガード
    private isModifyingDom = false;
    // expandForEditing 時のシリアライズ済みテキスト（collapseEditing での変化検出用）
    private expandedElOriginalText: string | null = null;
    // コマンド実行時に使う選択範囲キャッシュ（コマンドパレット起動でフォーカスが外れた後も保持）
    private savedRange: {
        startContainer: Node; startOffset: number;
        endContainer: Node; endOffset: number;
    } | null = null;
    // CM6 への未コミット変更があることを示すフラグ。
    // onBeforeInput でセット、commitToCm6() 完了時（resetBurst()）にクリアされる。
    private inBurst = false;

    constructor(container: HTMLElement) {
        this.el = container.createEl('div');
        this.el.addClass('tate-editor');
        this.el.setAttribute('contenteditable', 'true');
        this.el.setAttribute('spellcheck', 'false');
        this.el.setAttribute('data-placeholder', 'ファイルを開いてください');
    }

    getValue(): string {
        return Array.from(this.el.childNodes)
            .map(n => this.serializeNode(n))
            .join('');
    }

    setValue(content: string, preserveCursor: boolean): void {
        // 外部更新時は展開状態・選択キャッシュをリセット（早期リターンより先に実行）
        this.expandedEl = null;
        this.expandedElOriginalText = null;
        this.savedRange = null;
        if (this.getValue() === content) return;

        if (preserveCursor && document.activeElement === this.el) {
            const pos = this.getVisibleOffset();
            this.el.innerHTML = this.parseToHtml(content);
            this.setVisibleOffset(pos);
        } else {
            this.el.innerHTML = this.parseToHtml(content);
        }
    }

    // ---- インライン展開/収束（selectionchange から呼ぶ） ----

    // カーソル移動のたびに呼ばれ、ruby/tcy 要素を展開・収束する。
    // collapse によって内容が変化した場合 true を返す（view.ts が commitToCm6 を呼ぶ目安）。
    handleSelectionChange(): boolean {
        // DOM操作外かつエディタ内に非collapsed選択があるときのみキャッシュを更新
        // （外れたときは保持することでコマンドパレット起動後も参照できる）
        if (!this.isModifyingDom) {
            // expandedEl と DOM の tate-editing スパンを同期させる
            // Chromium がノードを再生成した場合などオブジェクト参照がズレることがある。
            // また予期せぬ理由で孤立スパンが生じた場合も DOM の実態に合わせる。
            if (!this.expandedEl || !this.expandedEl.isConnected) {
                const actualSpan = this.el.querySelector('span.tate-editing') as HTMLSpanElement | null;
                if (actualSpan !== this.expandedEl) {
                    this.expandedEl = actualSpan;
                    // 元テキスト不明のため null にして hasChanged = true にする
                    this.expandedElOriginalText = null;
                }
            }

            const sc = window.getSelection();
            if (sc && sc.rangeCount > 0) {
                const rc = sc.getRangeAt(0);
                if (!rc.collapsed
                    && this.el.contains(rc.startContainer)
                    && this.el.contains(rc.endContainer)) {
                    this.savedRange = {
                        startContainer: rc.startContainer,
                        startOffset: rc.startOffset,
                        endContainer: rc.endContainer,
                        endOffset: rc.endOffset,
                    };
                }
            }
        }
        if (this.isModifyingDom) return false;
        // エディタ外の selectionchange は展開中でない限り早期リターン（複数ビュー対策）
        const sel0 = window.getSelection();
        if (!this.expandedEl && (!sel0 || sel0.rangeCount === 0 ||
            !this.el.contains(sel0.getRangeAt(0).startContainer))) return false;
        let contentChanged = false;
        this.isModifyingDom = true;
        try {
            const sel = window.getSelection();
            if (!sel || sel.rangeCount === 0) return false;
            const range = sel.getRangeAt(0);

            // カーソルがまだ展開スパン内にある → 何もしない
            if (this.expandedEl && this.expandedEl.contains(range.startContainer)) {
                return false;
            }

            // カーソルが展開スパン外に出た → 収束してから意図した位置を復元
            if (this.expandedEl) {
                const savedNode = range.startContainer;
                const savedOffset = range.startOffset;

                contentChanged = this.collapseEditing();
                this.savedRange = null; // 収束後は stale ノード参照を破棄

                // ユーザーがカーソルを移動した先（savedNode）を復元する
                if (savedNode.isConnected && this.el.contains(savedNode)) {
                    try {
                        const maxOffset = savedNode.nodeType === Node.TEXT_NODE
                            ? (savedNode as Text).length
                            : savedNode.childNodes.length;
                        const r = document.createRange();
                        r.setStart(savedNode, Math.min(savedOffset, maxOffset));
                        r.collapse(true);
                        sel.removeAllRanges();
                        sel.addRange(r);
                    } catch { /* ノードが切り離されている場合は無視 */ }
                }
            }

            // カーソルがエディタ内にあるか確認
            if (sel.rangeCount === 0) return contentChanged;
            const currentRange = sel.getRangeAt(0);
            if (!this.el.contains(currentRange.startContainer)) return contentChanged;

            // 展開可能な要素（ruby/tcy）の中にいれば展開
            const target = this.findExpandableAncestor(currentRange.startContainer);
            if (target) {
                this.expandForEditing(target, currentRange);
            }
        } finally {
            this.isModifyingDom = false;
        }
        return contentChanged;
    }

    // ---- ルビ・縦中横ライブ変換（input/compositionend から呼ぶ） ----

    // 》が入力されたときに直前のルビ記法を <ruby> 要素に変換する。
    // 変換が行われた場合 true を返す（view.ts が commitToCm6 を呼ぶ目安）。
    handleRubyCompletion(): boolean {
        // 展開中、または DOM 操作中（execCommand の再入）はスキップ
        if (this.expandedEl) return false;
        if (this.isModifyingDom) return false;

        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return false;
        const range = sel.getRangeAt(0);
        if (range.startContainer.nodeType !== Node.TEXT_NODE) return false;
        if (this.isInsideRuby(range.startContainer)) return false;

        const textNode = range.startContainer as Text;
        const textBefore = textNode.textContent?.slice(0, range.startOffset) ?? '';
        if (!textBefore.endsWith('》')) return false;

        // 明示形式を優先: ｜base《rt》 または |base《rt》
        let match = textBefore.match(/[|｜]([^|｜《》\n]+)《([^《》\n]*)》$/);
        let explicit = true;
        if (!match) {
            // 省略形式: 直前の漢字連続部分《rt》
            match = textBefore.match(new RegExp(`(${KANJI_RE_STR})《([^《》\\n]*)》$`, 'u'));
            explicit = false;
        }
        if (!match) return false;

        const base = match[1];
        const rt = match[2];
        const matchStart = range.startOffset - match[0].length;

        this.isModifyingDom = true;
        try {
            const rubyEl = this.createRubyEl(base, rt, explicit);
            const inserted = this.insertAnnotationElement(
                textNode, matchStart, range.startOffset, rubyEl,
            );

            // カーソルを要素の直後に置く
            // カーソルが ruby 内にあると selectionchange → expandForEditing() が即座に発火するため
            this.setCursorAfter(inserted);
            return true;
        } finally {
            this.isModifyingDom = false;
        }
    }

    // ］が入力されたときに直前の縦中横記法を <span class="tcy"> 要素に変換する。
    // 変換が行われた場合 true を返す。
    handleTcyCompletion(): boolean {
        return this.handleAnnotationCompletion('］', /［＃「([^「」\n]+)」は縦中横］$/, c => this.createTcyEl(c));
    }

    // ---- コマンドパレットから呼ぶ選択ラップメソッド ----

    // 選択テキストを tate-editing スパンとして展開し、カーソルを《》の間に置く
    // カーソルがスパン外に出ると collapseEditing() が <ruby> 要素に収束する
    wrapSelectionWithRuby(): boolean {
        if (this.expandedEl) return false;
        const resolved = this.resolveSelectionRange();
        if (!resolved) return false;
        const { textNode, startOffset, endOffset } = resolved;
        const selectedText = textNode.textContent!.slice(startOffset, endOffset);
        if (!selectedText) return false;

        const rawText = `｜${selectedText}《》`;
        const span = document.createElement('span');
        span.className = 'tate-editing';
        span.textContent = rawText;

        const parentEl = textNode.parentNode as HTMLElement;

        this.isModifyingDom = true;
        try {
            // 直接 DOM 操作でスパンを挿入（行頭・行末・行中の区別なし）
            const precedingText = textNode.textContent!.slice(0, startOffset);
            const followingText = textNode.textContent!.slice(endOffset);
            const next = textNode.nextSibling;
            parentEl.removeChild(textNode);
            if (precedingText) parentEl.insertBefore(document.createTextNode(precedingText), next);
            parentEl.insertBefore(span, next);
            if (followingText) parentEl.insertBefore(document.createTextNode(followingText), next);

            this.expandedEl = span;
            this.expandedElOriginalText = rawText;

            // カーソルを《と》の間（rawText.length - 1 = 》の直前）に設定
            const spanText = span.firstChild as Text | null;
            if (spanText) {
                const sel = window.getSelection()!;
                const r = document.createRange();
                r.setStart(spanText, rawText.length - 1);
                r.collapse(true);
                sel.removeAllRanges();
                sel.addRange(r);
            }
        } finally {
            this.isModifyingDom = false;
        }

        this.savedRange = null;
        return true;
    }

    // 選択テキストを縦中横要素に変換する
    wrapSelectionWithTcy(): boolean {
        return this.wrapSelectionWith(c => this.createTcyEl(c));
    }

    // 選択テキストを傍点要素に変換する
    wrapSelectionWithBouten(): boolean {
        return this.wrapSelectionWith(c => this.createBoutenEl(c));
    }

    // ］が入力されたときに直前の傍点記法を <span class="bouten"> 要素に変換する。
    // 変換が行われた場合 true を返す。
    handleBoutenCompletion(): boolean {
        return this.handleAnnotationCompletion('］', /［＃「([^「」\n]+)」に傍点］$/, c => this.createBoutenEl(c));
    }

    // ---- 選択ラップ・アノテーション完了の共通ロジック ----

    // tcy/bouten など要素置換型ラップの共通実装
    private wrapSelectionWith(createElement: (content: string) => HTMLElement): boolean {
        if (this.expandedEl) return false;
        const resolved = this.resolveSelectionRange();
        if (!resolved) return false;
        const { textNode, startOffset, endOffset } = resolved;
        const selectedText = textNode.textContent!.slice(startOffset, endOffset);
        if (!selectedText) return false;

        const newEl = createElement(selectedText);

        this.isModifyingDom = true;
        try {
            const inserted = this.insertAnnotationElement(
                textNode, startOffset, endOffset, newEl,
            );

            // カーソルを挿入要素の直後に置く
            // カーソルが要素内にあると selectionchange → expandForEditing() が呼ばれるため
            this.setCursorAfter(inserted);
        } finally {
            this.isModifyingDom = false;
        }
        this.savedRange = null;
        return true;
    }

    // tcy/bouten など終端文字で確定するライブ変換の共通実装。
    // 変換が行われた場合 true を返す。
    private handleAnnotationCompletion(
        endChar: string,
        re: RegExp,
        createElement: (content: string) => HTMLElement,
    ): boolean {
        // 展開中、または DOM 操作中（execCommand の再入）はスキップ
        if (this.expandedEl) return false;
        if (this.isModifyingDom) return false;
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return false;
        const range = sel.getRangeAt(0);
        if (range.startContainer.nodeType !== Node.TEXT_NODE) return false;
        if (this.isInsideRuby(range.startContainer)) return false;

        const textNode = range.startContainer as Text;
        const textBefore = textNode.textContent?.slice(0, range.startOffset) ?? '';
        if (!textBefore.endsWith(endChar)) return false;

        const annotationMatch = textBefore.match(re);
        if (!annotationMatch) return false;

        const content = annotationMatch[1];
        const annotationStart = range.startOffset - annotationMatch[0].length;
        if (!textBefore.slice(0, annotationStart).endsWith(content)) return false;

        this.isModifyingDom = true;
        try {
            const newEl = createElement(content);
            const inserted = this.insertAnnotationElement(
                textNode, annotationStart - content.length, range.startOffset, newEl,
            );

            // カーソルを要素の直後に置く
            // カーソルが要素内にあると selectionchange → expandForEditing() が即座に発火するため
            this.setCursorAfter(inserted);
            return true;
        } finally {
            this.isModifyingDom = false;
        }
    }

    // paste イベントハンドラ: リッチテキストを排除してプレーンテキストのみを挿入する
    handlePaste(e: ClipboardEvent): void {
        e.preventDefault();
        const text = e.clipboardData?.getData('text/plain') ?? '';
        if (!text) return;
        // execCommand('insertText') はカーソル位置へのプレーンテキスト挿入・選択範囲の置換を
        // 一括処理する（deprecated だが Electron では動作する）。
        // beforeinput イベントが発火して onBeforeInput() が inBurst = true にする。
        document.execCommand('insertText', false, text);
        // view.ts が paste 後に commitToCm6() を呼ぶ
    }

    applySettings(settings: TatePluginSettings): void {
        this.el.style.fontFamily = settings.fontFamily;
        this.el.style.fontSize = `${settings.fontSize}px`;
        this.el.toggleClass('tate-auto-indent', settings.autoIndent);
        this.el.style.lineBreak = settings.lineBreak;
    }

    adjustWidth(): void { /* no-op: contenteditable div auto-sizes */ }

    focus(): void {
        this.el.focus();
    }

    // ---- インライン展開/収束 プライベートヘルパー ----

    // node の祖先を遡って最初の展開可能要素（ruby/明示tcy）を返す
    private findExpandableAncestor(node: Node): HTMLElement | null {
        let el: HTMLElement | null = node instanceof HTMLElement ? node : node.parentElement;
        while (el && el !== this.el) {
            if (el.tagName === 'RUBY') return el;
            if (el.tagName === 'SPAN' && el.getAttribute('data-tcy') === 'explicit') return el;
            if (el.tagName === 'SPAN' && el.getAttribute('data-bouten')) return el;
            el = el.parentElement;
        }
        return null;
    }

    // target を生テキストの編集スパンに展開し、カーソルを対応位置に設定する
    private expandForEditing(target: HTMLElement, range: Range): void {
        const rawText = this.serializeNode(target);
        const cursorOffset = this.rawOffsetForExpand(
            target, range.startContainer, range.startOffset
        );

        const span = document.createElement('span');
        span.className = 'tate-editing';
        span.textContent = rawText;

        target.parentNode!.replaceChild(span, target);
        this.expandedEl = span;
        this.expandedElOriginalText = rawText; // collapseEditing での変化検出用
        this.inBurst = false; // 展開はナビゲーション操作。直後の入力を新バーストとして扱う。

        const textNode = span.firstChild as Text | null;
        if (textNode) {
            const sel = window.getSelection();
            if (sel) {
                const r = document.createRange();
                r.setStart(textNode, Math.min(cursorOffset, textNode.length));
                r.collapse(true);
                sel.removeAllRanges();
                sel.addRange(r);
            }
        }
    }

    // 編集スパンを収束し、内容を再パースして元の位置に挿入する（カーソルは呼び出し元が処理）。
    // 内容が変化した場合 true を返す（view.ts が commitToCm6 を呼ぶ目安）。
    private collapseEditing(): boolean {
        if (!this.expandedEl) return false;
        // detached ノードは単純にクリアして終了
        // （parentNode / selectNode を呼ぶと例外が発生するため）
        if (!this.expandedEl.isConnected) {
            this.expandedEl = null;
            this.expandedElOriginalText = null;
            return false;
        }

        let rawText = this.expandedEl.textContent ?? '';
        const hasChanged = this.expandedElOriginalText === null
            || rawText !== this.expandedElOriginalText;

        const parent = this.expandedEl.parentNode!;
        const nextSibling = this.expandedEl.nextSibling;

        // 前方テキスト取り込み補正（hasChanged の場合のみ意味あり）
        // アノテーション「」内容がスパン内の前方テキストより長い場合、
        // 不足分の文字をスパン直前のテキストノードから取り込む
        let precedingTextNode: Text | null = null;
        let precedingChars = '';
        if (hasChanged) {
            const extraChars = this.getExtraCharsFromAnnotation(rawText);
            if (extraChars.length > 0) {
                const prev = this.expandedEl.previousSibling;
                if (prev?.nodeType === Node.TEXT_NODE) {
                    const prevText = prev as Text;
                    if ((prevText.textContent ?? '').endsWith(extraChars)) {
                        precedingTextNode = prevText;
                        precedingChars = extraChars;
                        rawText = precedingChars + rawText;
                    }
                }
            }
        }

        // parseToHtml は使わない（<div> で包むため段落 <div> 内でネストする）
        const html = this.parseInlineToHtml(rawText);

        // 前方テキストから取り込んだ分を削除
        if (precedingTextNode?.isConnected) {
            precedingTextNode.textContent = (precedingTextNode.textContent ?? '')
                .slice(0, -precedingChars.length);
        }

        // 直接 DOM 操作（行頭・行末・行中の区別なし）
        parent.removeChild(this.expandedEl);
        this.expandedEl = null;
        this.expandedElOriginalText = null;
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;
        while (tempDiv.firstChild) {
            parent.insertBefore(tempDiv.firstChild, nextSibling);
        }

        // 収束後は次の入力を新バーストとして扱う
        this.inBurst = false;
        return hasChanged;
    }

    // 要素内のカーソル位置を raw テキスト上の文字オフセットに変換する
    private rawOffsetForExpand(el: HTMLElement, node: Node, offset: number): number {
        if (el.tagName === 'RUBY') {
            const explicit = el.getAttribute('data-ruby-explicit') !== 'false';
            const prefix = explicit ? 1 : 0; // '|'
            const baseLen = Array.from(el.childNodes)
                .filter(n => !(n instanceof HTMLElement && n.tagName === 'RT'))
                .reduce((sum, n) => sum + (n.textContent?.length ?? 0), 0);
            const rt = el.querySelector('rt');

            if (rt && rt.contains(node)) {
                // カーソルが <rt> 内: prefix + base + '《' + offset
                return prefix + baseLen + 1 + offset;
            } else {
                // カーソルがベーステキスト内: prefix + offset
                return prefix + offset;
            }
        } else {
            // <span data-tcy="explicit"> / <span data-bouten>: raw = 'X［＃「X」は縦中横/に傍点］'
            // コンテンツ部分 (X) は先頭にある
            return offset;
        }
    }

    // ---- パーサー（Aozora 記法 → innerHTML） ----

    // ドキュメント全体用: 各段落を <div> で包む（text-indent を段落ごとに適用するため）
    private parseToHtml(text: string): string {
        if (!text) return '';
        return text
            .split('\n')
            .map(line => `<div>${this.parseInlineToHtml(line) || '<br>'}</div>`)
            .join('');
    }

    // インライン要素用: <div> で包まずAozora記法をHTML変換する（collapseEditing で使用）
    private parseInlineToHtml(text: string): string {
        return this.applyParsers(text, [
            t => this.splitByExplicitRuby(t),
            t => this.splitByExplicitTcy(t),
            t => this.splitByExplicitBouten(t),
            t => this.splitByImplicitRuby(t),
        ]);
    }

    // テキストにパーサーを順番に適用し、HTML 文字列を返す
    private applyParsers(
        text: string,
        parsers: Array<(t: string) => ParseSegment[]>
    ): string {
        let segments: ParseSegment[] = [{ type: 'text', text }];
        for (const parser of parsers) {
            segments = segments.flatMap(seg =>
                seg.type === 'text' ? parser(seg.text) : [seg]
            );
        }
        return segments
            .map(seg => seg.type === 'html' ? seg.html : this.esc(seg.text))
            .join('');
    }

    // 明示ルビ ｜base《rt》（または |base《rt》）を分割する
    private splitByExplicitRuby(text: string): ParseSegment[] {
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
                html: `<ruby data-ruby-explicit="true">${this.esc(m[1])}<rt>${this.esc(m[2])}</rt></ruby>`,
            });
            lastIndex = re.lastIndex;
        }
        if (lastIndex < text.length) {
            result.push({ type: 'text', text: text.slice(lastIndex) });
        }
        return result;
    }

    // 明示縦中横 X［＃「X」は縦中横］ を分割する
    private splitByExplicitTcy(text: string): ParseSegment[] {
        return this.splitByAnnotation(
            text,
            /［＃「([^「」\n]+)」は縦中横］/g,
            c => `<span data-tcy="explicit" class="tcy">${this.esc(c)}</span>`,
        );
    }

    // 傍点 base［＃「base」に傍点］ を分割する
    private splitByExplicitBouten(text: string): ParseSegment[] {
        return this.splitByAnnotation(
            text,
            /［＃「([^「」\n]+)」に傍点］/g,
            c => `<span data-bouten="sesame" class="bouten">${this.esc(c)}</span>`,
        );
    }

    // 前方参照型アノテーション記法「content［＃「content」...］」の共通分割ロジック
    private splitByAnnotation(
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
    private splitByImplicitRuby(text: string): ParseSegment[] {
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
                html: `<ruby data-ruby-explicit="false">${this.esc(m[1])}<rt>${this.esc(m[2])}</rt></ruby>`,
            });
            lastIndex = re.lastIndex;
        }
        if (lastIndex < text.length) {
            result.push({ type: 'text', text: text.slice(lastIndex) });
        }
        return result;
    }

    private esc(text: string): string {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ---- DOM シリアライザ（innerHTML → Aozora 記法） ----

    private serializeNode(node: Node): string {
        if (node.nodeType === Node.TEXT_NODE) {
            return node.textContent ?? '';
        }
        if (!(node instanceof HTMLElement)) return '';

        switch (node.tagName) {
            case 'RUBY': {
                const explicit = node.getAttribute('data-ruby-explicit') !== 'false';
                const base = Array.from(node.childNodes)
                    .filter(n => !(n instanceof HTMLElement && n.tagName === 'RT'))
                    .map(n => this.serializeNode(n))
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
                    .map(n => this.serializeNode(n))
                    .join('');
            }
            case 'BR':
                // Chrome が contenteditable div の末尾に追加する表示用 <br> はスキップ
                if (
                    node.parentElement !== this.el &&
                    node.parentElement?.tagName === 'DIV' &&
                    node === node.parentElement.lastChild
                ) {
                    return '';
                }
                return '\n';
            case 'DIV':
                // Chrome の contenteditable が生成するブロック div
                {
                    const content = Array.from(node.childNodes)
                        .map(n => this.serializeNode(n))
                        .join('');
                    return node.previousSibling !== null ? '\n' + content : content;
                }
            default:
                return Array.from(node.childNodes)
                    .map(n => this.serializeNode(n))
                    .join('');
        }
    }

    // ---- カーソル操作（<rt> 内を除いた visible 文字数でオフセット管理） ----

    private getVisibleOffset(): number {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return 0;
        const range = sel.getRangeAt(0);
        let count = 0;
        const walker = document.createTreeWalker(this.el, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode() as Text | null;

        while (node) {
            if (node === range.startContainer) {
                if (!this.isInsideRt(node)) count += range.startOffset;
                break;
            }
            if (!this.isInsideRt(node)) count += node.length;
            node = walker.nextNode() as Text | null;
        }
        return count;
    }

    private setVisibleOffset(offset: number): void {
        const sel = window.getSelection();
        if (!sel) return;
        let remaining = offset;
        const walker = document.createTreeWalker(this.el, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode() as Text | null;

        while (node) {
            if (!this.isInsideRt(node)) {
                if (remaining <= node.length) {
                    const range = document.createRange();
                    range.setStart(node, remaining);
                    range.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(range);
                    return;
                }
                remaining -= node.length;
            }
            node = walker.nextNode() as Text | null;
        }

        const range = document.createRange();
        range.selectNodeContents(this.el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
    }

    private isInsideRt(node: Node): boolean {
        let parent = node.parentElement;
        while (parent && parent !== this.el) {
            if (parent.tagName === 'RT') return true;
            parent = parent.parentElement;
        }
        return false;
    }

    private isInsideRuby(node: Node): boolean {
        let parent = node.parentElement;
        while (parent && parent !== this.el) {
            if (parent.tagName === 'RUBY') return true;
            parent = parent.parentElement;
        }
        return false;
    }

    // savedRange を正規化して { textNode, startOffset, endOffset } を返す。
    // Chrome はブロック末尾（行末）で選択すると endContainer が親 <div> や <br> になることがある。
    // その場合 textNode.length を endOffset として正規化し、行頭・行末の選択にも対応する。
    private resolveSelectionRange(): { textNode: Text; startOffset: number; endOffset: number } | null {
        const r = this.savedRange;
        if (!r || r.startContainer.nodeType !== Node.TEXT_NODE) return null;
        const textNode = r.startContainer as Text;

        // 理想ケース: 同一テキストノード内の選択
        if (r.endContainer === r.startContainer) {
            if (r.startOffset === r.endOffset) return null; // 空選択
            return { textNode, startOffset: r.startOffset, endOffset: r.endOffset };
        }

        // Chrome のブロック末尾選択: endContainer が親要素（<div>）の場合
        const parent = textNode.parentNode;
        if (!parent) return null;
        if (r.endContainer === parent) {
            const textNodeIdx = Array.from(parent.childNodes).indexOf(textNode);
            if (textNodeIdx !== -1 && r.endOffset > textNodeIdx) {
                return { textNode, startOffset: r.startOffset, endOffset: textNode.length };
            }
        }
        // Chrome のブロック末尾選択: endContainer が同じ親の <br> 兄弟の場合
        if (r.endContainer.nodeType === Node.ELEMENT_NODE &&
            (r.endContainer as Element).tagName === 'BR' &&
            r.endContainer.parentNode === parent) {
            return { textNode, startOffset: r.startOffset, endOffset: textNode.length };
        }

        return null;
    }

    // テキストノードの [matchStart, matchEnd) を element で置き換える直接 DOM 操作。
    // 行頭・行末・行中の区別なく常に直接 DOM 操作で統一する（execCommand 不使用）。
    // 挿入した要素を返す。
    private insertAnnotationElement(
        textNode: Text,
        matchStart: number,
        matchEnd: number,
        element: HTMLElement,
    ): HTMLElement {
        const parentEl = textNode.parentNode as HTMLElement;

        // テキストノードを分割して要素を挿入
        const precedingText = textNode.textContent!.slice(0, matchStart);
        const followingText = textNode.textContent!.slice(matchEnd);
        const next = textNode.nextSibling;
        parentEl.removeChild(textNode);
        if (precedingText) parentEl.insertBefore(document.createTextNode(precedingText), next);
        parentEl.insertBefore(element, next);
        if (followingText) parentEl.insertBefore(document.createTextNode(followingText), next);

        return element;
    }

    // beforeinput イベントで呼ぶ（view.ts から登録）。
    // CM6 への未コミット変更があることを示す inBurst フラグをセットする。
    onBeforeInput(): void {
        this.inBurst = true;
    }

    // バーストをリセットする（commitToCm6() 完了後・view.ts のナビゲーション処理時に呼ぶ）。
    resetBurst(): void {
        this.inBurst = false;
    }

    // CM6 の Undo/Redo 後に呼ぶ。content を縦書きビューに適用し、
    // srcOffset（CM6 のカーソル位置）を srcToView で変換してカーソルを復元する。
    applyFromCm6(content: string, srcOffset: number): void {
        // 展開中スパンをクリア（CM6 の状態が真実なので強制リセット）
        this.expandedEl = null;
        this.expandedElOriginalText = null;
        this.savedRange = null;
        this.inBurst = false;
        // DOM を更新（差分がある場合のみ）
        if (this.getValue() !== content) {
            this.el.innerHTML = this.parseToHtml(content);
        }
        // CM6 のソースオフセットを可視オフセットに変換してカーソルを復元
        const segs = buildSegmentMap(content);
        const viewOffset = srcToView(segs, srcOffset);
        this.setVisibleOffset(viewOffset);
    }

    // カーソルを node の直後に移動する。
    // ライブ変換・コマンドで要素を挿入した直後に呼び、カーソルが要素内に入って
    // selectionchange → expandForEditing() が即発火するのを防ぐ。
    private setCursorAfter(node: Node): void {
        const sel = window.getSelection();
        if (!sel) return;
        const r = document.createRange();
        r.setStartAfter(node);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
    }

    // インライン編集後の収束時に、アノテーション「」内容がスパン内の前方テキストより
    // 長い場合に直前テキストノードから取り込むべき文字列を返す。
    // 例: rawText = '30[#「130」縦中横]' → '1' を返す（content.length=3 > leadingLen=2 → 差分=1文字）
    // 一致する場合（正常アノテーション）は '' を返す。
    private getExtraCharsFromAnnotation(rawText: string): string {
        const patterns = [
            /［＃「([^「」\n]+)」は縦中横］/,
            /［＃「([^「」\n]+)」に傍点］/,
        ];
        for (const re of patterns) {
            const m = rawText.match(re);
            if (!m || m.index === undefined) continue;
            const content = m[1];
            const leadingText = rawText.slice(0, m.index);
            if (!leadingText.endsWith(content) && content.length > leadingText.length) {
                const extraCount = content.length - leadingText.length;
                return content.slice(0, extraCount);
            }
        }
        return '';
    }

    private createRubyEl(base: string, rt: string, explicit: boolean): HTMLElement {
        const rubyEl = document.createElement('ruby');
        rubyEl.setAttribute('data-ruby-explicit', String(explicit));
        rubyEl.appendChild(document.createTextNode(base));
        const rtEl = document.createElement('rt');
        rtEl.textContent = rt;
        rubyEl.appendChild(rtEl);
        return rubyEl;
    }

    private createTcyEl(content: string): HTMLElement {
        const span = document.createElement('span');
        span.setAttribute('data-tcy', 'explicit');
        span.className = 'tcy';
        span.textContent = content;
        return span;
    }

    private createBoutenEl(content: string): HTMLElement {
        const span = document.createElement('span');
        span.setAttribute('data-bouten', 'sesame');
        span.className = 'bouten';
        span.textContent = content;
        return span;
    }
}
