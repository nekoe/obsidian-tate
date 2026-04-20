// Minimal stub for the 'obsidian' package used in unit tests.
// Only the symbols required by the tested modules are implemented.

export function sanitizeHTMLToDom(html: string): DocumentFragment {
    const div = document.createElement('div');
    div.innerHTML = html;
    const frag = document.createDocumentFragment();
    while (div.firstChild) frag.appendChild(div.firstChild);
    return frag;
}
