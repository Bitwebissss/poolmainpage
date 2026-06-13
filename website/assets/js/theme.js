/* theme.js -- Shared theme manager for Pool & API Docs
   Single localStorage key, single source of truth for data-bs-theme.
   Both pages include this file BEFORE their own script. */

(function () {
  'use strict';

  const LS_THEME = 'mc-theme';
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

  const resolve = (t) => (t === 'auto' ? (mediaQuery.matches ? 'dark' : 'light') : t);

  const apply = (t) => {
    document.documentElement.setAttribute('data-bs-theme', resolve(t));

    // Highlight the active item in any theme menu on the page
    document.querySelectorAll('[data-theme]').forEach((el) => {
      el.classList.toggle('active', el.dataset.theme === t);
    });

    // Let each page update its own labels/icons
    document.dispatchEvent(new CustomEvent('themechange', { detail: { theme: t } }));
  };

  const get = () => localStorage.getItem(LS_THEME) || 'auto';

  const set = (t) => {
    localStorage.setItem(LS_THEME, t);
    apply(t);
  };

  const init = () => {
    apply(get());
    mediaQuery.addEventListener('change', () => {
      if (get() === 'auto') apply('auto');
    });
  };

  window.Theme = { init, set, get };
})();
