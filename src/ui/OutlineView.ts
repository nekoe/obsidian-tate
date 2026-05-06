import { ItemView, WorkspaceLeaf } from 'obsidian';
import type TatePlugin from '../main';
import { TATE_VIEW_TYPE, VerticalWritingView } from '../view';
import type { HeadingEntry } from './HeadingExtractor';

export const TATE_OUTLINE_VIEW_TYPE = 'tate-outline';

export class OutlineView extends ItemView {
    private listEl: HTMLElement | null = null;
    private emptyEl: HTMLElement | null = null;

    constructor(leaf: WorkspaceLeaf, private readonly plugin: TatePlugin) {
        super(leaf);
    }

    getViewType(): string { return TATE_OUTLINE_VIEW_TYPE; }
    getDisplayText(): string { return '縦書きアウトライン'; }
    getIcon(): string { return 'list'; }

    async onOpen(): Promise<void> {
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass('tate-outline-container');

        this.listEl = container.createEl('ul', { cls: 'tate-outline-list' });
        this.emptyEl = container.createEl('div', {
            cls: 'tate-outline-empty',
            text: '見出しがありません',
        });
        this.emptyEl.hide();

        // Refresh when the active leaf changes so the outline follows the active tate view.
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                this.plugin.refreshOutline();
            })
        );

        this.plugin.refreshOutline();
    }

    async onClose(): Promise<void> {
        this.listEl = null;
        this.emptyEl = null;
    }

    updateHeadings(headings: HeadingEntry[]): void {
        if (!this.listEl || !this.emptyEl) return;
        this.listEl.empty();

        if (headings.length === 0) {
            this.listEl.hide();
            this.emptyEl.show();
            return;
        }
        this.emptyEl.hide();
        this.listEl.show();

        for (const entry of headings) {
            const li = this.listEl.createEl('li', {
                cls: `tate-outline-item tate-outline-${entry.level}`,
            });
            li.textContent = entry.text;
            li.addEventListener('click', () => this.jumpTo(entry));
        }
    }

    private jumpTo(entry: HeadingEntry): void {
        const active = this.app.workspace.getActiveViewOfType(VerticalWritingView);
        const tateView = active ?? (() => {
            const leaves = this.app.workspace.getLeavesOfType(TATE_VIEW_TYPE);
            return leaves.length > 0 && leaves[0].view instanceof VerticalWritingView
                ? leaves[0].view : null;
        })();
        if (!tateView) return;
        tateView.jumpToViewOffset(entry.viewOffset);
        void this.app.workspace.revealLeaf(tateView.leaf);
    }
}
