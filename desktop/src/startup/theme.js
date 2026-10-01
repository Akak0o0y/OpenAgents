// Run before the stylesheet paints; the shell resolves the saved app preference.
document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light';
