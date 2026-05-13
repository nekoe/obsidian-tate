// In production, Obsidian provides activeDocument as a global for popout window
// compatibility. Alias it to document so source files that use activeDocument
// work correctly under the happy-dom test environment.
if (typeof document !== 'undefined') {
    (globalThis as Record<string, unknown>).activeDocument = document;
}
