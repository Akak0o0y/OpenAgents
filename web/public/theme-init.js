// Apply the saved appearance before React or styles paint the app.
(() => {
  let theme = 'light';
  try {
    const saved = JSON.parse(localStorage.getItem('openhours.preferences.v1') || '{}');
    if (saved?.appearanceVersion === 2 && ['dark', 'light', 'system'].includes(saved.theme)) theme = saved.theme;
  } catch { /* Invalid or unavailable storage uses the app's light default. */ }
  document.documentElement.dataset.theme = theme === 'system'
    ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme;
})();
