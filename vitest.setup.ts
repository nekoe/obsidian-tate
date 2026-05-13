// In production, Obsidian provides activeDocument as a global for popout window
// compatibility. Alias it to document so source files that use activeDocument
// work correctly under the happy-dom test environment.
if (typeof document !== 'undefined') {
    (globalThis as Record<string, unknown>).activeDocument = document;
}

// In production, Obsidian augments Node with an instanceOf<T>(type) method for
// cross-window (popout) safety. Polyfill it in the test environment so that
// source code using node.instanceOf(HTMLElement) works under happy-dom/jsdom.
if (typeof Node !== 'undefined' && !('instanceOf' in Node.prototype)) {
    Object.defineProperty(Node.prototype, 'instanceOf', {
        value<T>(type: abstract new (...args: never[]) => T): this is T {
            return this instanceof type;
        },
        writable: true,
        configurable: true,
    });
}
