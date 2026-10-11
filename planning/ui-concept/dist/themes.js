/* Apply tokens before paint; shared by the preview shell and the app. */
(() => {
  const options = [
    {id:'midnight', name:'Midnight', mode:'Dark · Default'},
    {id:'midnight-dimmed', name:'Midnight Dimmed', mode:'Dark'},
    {id:'graphite', name:'Graphite', mode:'Dark'},
    {id:'graphite-dimmed', name:'Graphite Dimmed', mode:'Dark'},
    {id:'daylight', name:'Daylight', mode:'Light'},
    {id:'sand', name:'Sand', mode:'Light'},
  ];
  const names = options.map(theme => theme.id);
  const key = 'everything-ui-theme-v1';
  const valid = theme => names.includes(theme);
  const query = new URL(location.href).searchParams.get('theme');
  let saved;
  try { saved = localStorage.getItem(key); } catch {}

  function apply(theme, persist = true) {
    if (!valid(theme)) return;
    document.documentElement.dataset.theme = theme;
    if (persist) { try { localStorage.setItem(key, theme); } catch {} }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--surface-page').trim();
    window.dispatchEvent(new CustomEvent('themechange', {detail: theme}));
  }

  window.EverythingTheme = {names, options, apply, current: () => document.documentElement.dataset.theme};
  apply(valid(query) ? query : valid(saved) ? saved : 'midnight');
  window.addEventListener('message', event => {
    if (event.origin === location.origin && event.source === parent && event.data?.type === 'theme') apply(event.data.theme);
  });
  window.addEventListener('storage', event => {
    if (event.key === key) apply(valid(event.newValue) ? event.newValue : 'midnight', false);
  });
})();
