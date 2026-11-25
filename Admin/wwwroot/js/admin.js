document.addEventListener('submit', event => {
    const message = event.target.dataset.confirm;
    if (message && !window.confirm(message)) event.preventDefault();
});

document.addEventListener('click', async event => {
    const dialog = document.getElementById('editor-dialog');
    if (!dialog || typeof dialog.showModal !== 'function') return;
    if (event.target.closest('[data-cancel]') && dialog.open) {
        event.preventDefault();
        dialog.close();
        return;
    }
    const link = event.target.closest('a[data-editor]');
    if (!link || event.ctrlKey || event.shiftKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    try {
        const response = await fetch(link.href, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
        if (response.redirected || !response.ok) { location.assign(link.href); return; }
        const content = new DOMParser().parseFromString(await response.text(), 'text/html');
        const editor = content.querySelector('.editor');
        if (!editor) { location.assign(link.href); return; }
        document.getElementById('editor-content').replaceChildren(editor);
        if (!dialog.open) dialog.showModal();
        dialog.querySelector('[name=Name]').focus();
    } catch { location.assign(link.href); }
});
