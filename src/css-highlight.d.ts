// Type declarations for the CSS Custom Highlight API (not yet in TypeScript's DOM lib).
// https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API

declare global {
    interface HighlightRegistry {
        set(name: string, highlight: Highlight): void;
        delete(name: string): boolean;
        clear(): void;
        has(name: string): boolean;
    }

    class Highlight {
        constructor(...ranges: AbstractRange[]);
        priority: number;
    }

    // Augment the built-in CSS namespace to include the Highlight Registry.
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace CSS {
        const highlights: HighlightRegistry;
    }
}

export {};
