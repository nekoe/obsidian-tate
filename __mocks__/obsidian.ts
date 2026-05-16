// Minimal stub for the 'obsidian' package used in unit tests.
// Only the symbols required by the tested modules are implemented.

// Obsidian extends HTMLElement with setCssProps for setting CSS custom properties.
if (typeof HTMLElement !== 'undefined' && !HTMLElement.prototype.setCssProps) {
    HTMLElement.prototype.setCssProps = function(props: Record<string, string>) {
        for (const [key, value] of Object.entries(props)) {
            if (value === '') this.style.removeProperty(key);
            else this.style.setProperty(key, value);
        }
    };
}

export function sanitizeHTMLToDom(html: string): DocumentFragment {
    const div = document.createElement('div');
    div.innerHTML = html;
    const frag = document.createDocumentFragment();
    while (div.firstChild) frag.appendChild(div.firstChild);
    return frag;
}
