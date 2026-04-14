export type UndoEntry =
    | { readonly kind: 'native' }
    | { readonly kind: 'annotation'; undo(): void; redo(): void; };

export class UndoManager {
    private undoStack: UndoEntry[] = [];
    private redoStack: UndoEntry[] = [];

    /** 記法操作エントリを積む（Redo スタックはクリア） */
    pushAnnotation(undo: () => void, redo: () => void): void {
        this.undoStack.push({ kind: 'annotation', undo, redo });
        this.redoStack = [];
    }

    /**
     * ネイティブ Undo マーカーを積む。
     * 直前がすでに native なら重複スキップ。Redo スタックはクリア。
     */
    pushNativeMarker(): void {
        const top = this.undoStack[this.undoStack.length - 1];
        if (top?.kind === 'native') return;
        this.undoStack.push({ kind: 'native' });
        this.redoStack = [];
    }

    /**
     * Undo 操作。エントリを 1 つ取り出して返す。
     * - annotation: entry.undo() を実行して Redo スタックへ移す
     * - native: Redo スタックにマーカーを積む（execCommand 委譲は呼び出し元が行う）
     * - 空: null を返す
     */
    undo(): UndoEntry | null {
        const entry = this.undoStack.pop() ?? null;
        if (!entry) return null;
        if (entry.kind === 'annotation') {
            entry.undo();
            this.redoStack.push(entry);
        } else {
            this.redoStack.push({ kind: 'native' });
        }
        return entry;
    }

    /**
     * Redo 操作。エントリを 1 つ取り出して返す。
     * - annotation: entry.redo() を実行して Undo スタックへ移す
     * - native: Undo スタックにマーカーを積む（execCommand 委譲は呼び出し元が行う）
     * - 空: null を返す
     */
    redo(): UndoEntry | null {
        const entry = this.redoStack.pop() ?? null;
        if (!entry) return null;
        if (entry.kind === 'annotation') {
            entry.redo();
            this.undoStack.push(entry);
        } else {
            this.undoStack.push({ kind: 'native' });
        }
        return entry;
    }

    /** スタックをクリア（ファイル切り替え時など） */
    clear(): void {
        this.undoStack = [];
        this.redoStack = [];
    }

    get canUndo(): boolean { return this.undoStack.length > 0; }
    get canRedo(): boolean { return this.redoStack.length > 0; }
}
