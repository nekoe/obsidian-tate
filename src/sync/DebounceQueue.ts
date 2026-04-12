export class DebounceQueue {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private pending: (() => Promise<void>) | null = null;
    private readonly delayMs: number;

    constructor(delayMs = 500) {
        this.delayMs = delayMs;
    }

    schedule(fn: () => Promise<void>): void {
        this.pending = fn;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = setTimeout(async () => {
            this.timer = null;
            const f = this.pending;
            this.pending = null;
            if (f) await f();
        }, this.delayMs);
    }

    // ペンディング中のコールバックをキャンセルせず即時実行する（ビューを閉じる際などに使用）
    async flushAndExecute(): Promise<void> {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.pending) {
            const f = this.pending;
            this.pending = null;
            await f();
        }
    }
}
