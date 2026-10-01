import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
// One entry point. tailwind.css imports theme.css into a cascade layer so the
// two stylesheets have a defined relationship rather than an accidental one -
// see the layer note at the top of that file.
import './tailwind.css';
import { applyTheme, applyCodeTheme, readPreferences } from './lib/preferences.js';

const preferences = readPreferences();
applyTheme(preferences.theme);
applyCodeTheme(preferences.codeTheme);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
