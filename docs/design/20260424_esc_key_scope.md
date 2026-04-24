# ESC Key Handling via Obsidian Scope API

Created: 2026-04-24

## Problem

Pressing ESC while the tate view is active switches the active leaf to a MarkdownView.

## Root Cause

Obsidian registers a global `keydown` listener on the window in the **capture phase**:

```javascript
// obsidian/app.js (minified)
window.addEventListener("keydown", this.onKeyEvent.bind(this), true)
//                                                              ^^^^ capture phase
```

Because the listener runs in the capture phase, it executes before any DOM `keydown`
handler on `contenteditable` (which runs in the bubbling phase). This means
`stopPropagation()` or `preventDefault()` in the tate view's own `keydown` handler has
no effect — Obsidian's handler has already run by the time the bubbling-phase listener fires.

Obsidian's global ESC handler (registered in the root keymap scope at startup) checks
whether the active leaf's view has `navigation === true`. `ItemView.navigation` defaults
to `false`, so the handler always finds the condition unsatisfied for the tate view and
switches to the most recently active leaf that has `navigation === true` (typically a
MarkdownView):

```javascript
// Simplified pseudocode of Obsidian's global ESC handler
if (!(activeLeaf && activeLeaf.view.navigation)) {
    const target = findMostRecentNavigableLeaf();
    setActiveLeaf(target, { focus: true });
}
```

### Why `navigation = true` is not the fix

Setting `navigation = true` on `VerticalWritingView` prevents the leaf switch, but
introduces a worse regression: Obsidian's `getActiveFileView()` short-circuits on
`navigation === true` and returns `null` for any view that is not a `FileView`. This
causes `getActiveFile()` to return `null` whenever the tate view is active, which fires
`file-open(null)` and wipes the editor content.

Additionally, `navigation = true` makes Obsidian treat the view as a navigation target:
opening a file while the tate view is active replaces it with a MarkdownView, and the
"Back" navigation button returns to the tate view — behaviour the user does not want.

## Solution: Obsidian Scope API

Obsidian's `onKeyEvent` processes the active scope stack before deciding whether to
propagate the native DOM event:

```javascript
// Simplified pseudocode
onKeyEvent(evt) {
    const result = this.scope.handleKey(evt, ctx); // active scope (top of stack)
    if (result === false) {
        evt.preventDefault();
        evt.stopPropagation(); // suppress global ESC handler and DOM bubbling
    }
}
```

Scopes are stacked with `app.keymap.pushScope(scope)`. The most recently pushed scope
takes priority. Returning `false` from a handler in that scope causes Obsidian itself to
call `preventDefault()` + `stopPropagation()`, which prevents the global ESC handler in
the root scope from running.

`VerticalWritingView` creates a dedicated `Scope` and registers an ESC handler that
returns `false`, except during IME composition (`evt.isComposing === true`), so the user
can still dismiss IME candidate windows with ESC:

```typescript
this.escScope.register([], 'Escape', (evt) => {
    if (evt.isComposing) return; // let IME cancel proceed normally
    return false;               // suppress Obsidian's global ESC handler
});
```

## Parent Scope

The `Scope` must be constructed with `app.scope` (the root scope) as its parent:

```typescript
this.escScope = new Scope(this.app.scope);
```

`handleKey` only delegates to `this.parent` when no registered key matches. Without a
parent, any key not explicitly handled by this scope — such as Cmd-P for the command
palette — would silently fall through to nothing instead of reaching the root scope's
handlers, breaking all global shortcuts while the tate view is active.

## Scope Lifecycle

The scope is pushed onto the keymap stack while the tate view is the active leaf, and
popped when any other leaf becomes active or when the view is closed.

| Event | Action |
|---|---|
| `onOpen` completes and the view is already active | `pushScope` |
| `active-leaf-change` → this leaf becomes active | `pushScope` |
| `active-leaf-change` → another leaf becomes active | `popScope` |
| `onClose` | `popScope` |

`popScope` is safe to call even when the scope is not currently on the stack: Obsidian's
implementation removes it from `prevScopes` if present, or does nothing if absent.

Multiple tate views open simultaneously each hold their own `Scope` instance and push/pop
independently, so there is no interference between them.
