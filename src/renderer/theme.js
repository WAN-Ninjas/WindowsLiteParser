'use strict';

// Apply the saved preference before the stylesheet paints, including after a reload.
(() => {
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  // Electron's native theme is initialized from SQLite before the window opens.
  let preference = 'system';
  const paint = () => {
    document.documentElement.dataset.theme = preference === 'system' ? system.matches ? 'dark' : 'light' : preference;
    window.dispatchEvent(new Event('portal-theme-change'));
  };
  window.portalAppearance = {
    set(value) { preference = ['light', 'dark', 'system'].includes(value) ? value : 'system'; paint(); }
  };
  system.addEventListener('change', () => { if (preference === 'system') paint(); });
  window.portalAppearance.set(preference);
})();
