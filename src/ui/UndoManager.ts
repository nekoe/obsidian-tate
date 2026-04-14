export type Snapshot = { readonly text: string; readonly cursor: number };

export class UndoManager {
    private undoStack: Snapshot[] = [];
    private redoStack: Snapshot[] = [];

    /** スナップショットを Undo スタックに積む（Redo スタックはクリア） */
    push(snap: Snapshot): void {
        this.undoStack.push(snap);
        this.redoStack = [];
    }

    /** Undo スタックからスナップショットを取り出す */
    popUndo(): Snapshot | null {
        return this.undoStack.pop() ?? null;
    }

    /** Redo スタックからスナップショットを取り出す */
    popRedo(): Snapshot | null {
        return this.redoStack.pop() ?? null;
    }

    /** Redo スタックにスナップショットを積む（Undo 後に現在状態を保存） */
    pushRedo(snap: Snapshot): void {
        this.redoStack.push(snap);
    }

    /** Undo スタックにスナップショットを積む（Redo 後に現在状態を保存） */
    pushUndo(snap: Snapshot): void {
        this.undoStack.push(snap);
    }

    get canUndo(): boolean { return this.undoStack.length > 0; }
    get canRedo(): boolean { return this.redoStack.length > 0; }

    /** スタックをクリア（ファイル切り替え時など） */
    clear(): void {
        this.undoStack = [];
        this.redoStack = [];
    }
}
