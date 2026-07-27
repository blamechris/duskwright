import {createNodeAsap, removeNode} from './utils/dom';

export function createOrUpdateStyle(css: string, _type: string): void {
    createNodeAsap({
        selectNode: () => document.getElementById('dark-reader-style')!,
        createNode: (target) => {
            // ADR 0001 item 8: data-darkreader-mode was written onto <html> here. Nothing
            // read it, and <html> is page-owned.
            const style = document.createElement('style');
            style.id = 'dark-reader-style';
            style.classList.add('darkreader');
            style.type = 'text/css';
            style.textContent = css;
            target.appendChild(style);
        },
        updateNode: (existing) => {
            if (css.replace(/^\s+/gm, '') !== existing.textContent!.replace(/^\s+/gm, '')) {
                existing.textContent = css;
            }
        },
        selectTarget: () => document.head,
        createTarget: () => {
            const head = document.createElement('head');
            document.documentElement.insertBefore(head, document.documentElement.firstElementChild);
            return head;
        },
        isTargetMutation: (mutation) => mutation.target.nodeName.toLowerCase() === 'head',
    });
}

export function removeStyle(): void {
    removeNode(document.getElementById('dark-reader-style'));
}
