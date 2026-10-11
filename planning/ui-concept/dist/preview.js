const app = document.getElementById('app');
const frame = document.getElementById('frame');
const themeSelect = document.getElementById('theme-select');
document.getElementById('theme-options').innerHTML = '<span class="theme-label">Theme</span>' + EverythingTheme.options.map(theme =>
  `<button class="theme-option" data-select-theme="${theme.id}" aria-pressed="false"><span class="theme-swatch" data-theme="${theme.id}" aria-hidden="true"><i></i><i></i><i></i></span><span>${theme.name}<small>${theme.mode}</small></span><span class="theme-check" aria-hidden="true">✓</span></button>`
).join('');
themeSelect.innerHTML = EverythingTheme.options.map(theme => `<option value="${theme.id}">${theme.name} — ${theme.mode}</option>`).join('');
const themeButtons = document.querySelectorAll('[data-select-theme]');
function syncTheme() {
  const theme = EverythingTheme.current();
  themeSelect.value = theme;
  for (const button of themeButtons) {
    const selected = button.dataset.selectTheme === theme;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
  app.contentWindow.postMessage({type:'theme', theme}, location.origin);
  const url = new URL(location.href);
  // Only keep a query override when the user opened a themed link.
  if (url.searchParams.has('theme')) {
    url.searchParams.set('theme', theme);
    history.replaceState(null, '', url);
  }
}
themeButtons.forEach(button => button.addEventListener('click', () => EverythingTheme.apply(button.dataset.selectTheme)));
themeSelect.addEventListener('change', () => EverythingTheme.apply(themeSelect.value));
window.addEventListener('themechange', syncTheme);
app.addEventListener('load', syncTheme);
syncTheme();
document.querySelectorAll('[data-screen]').forEach(button => button.addEventListener('click', () => app.contentWindow.postMessage({type:'navigate', screen:button.dataset.screen}, location.origin)));
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== app.contentWindow || event.data.type !== 'screen') return;
  document.querySelectorAll('[data-screen]').forEach(button => {
    const selected = button.dataset.screen === event.data.screen;
    button.classList.toggle('active', selected);
    if (selected) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
  });
});
for (const device of ['desktop', 'phone']) document.getElementById(device).addEventListener('click', () => {
  frame.classList.toggle('phone', device === 'phone');
  for (const id of ['desktop','phone']) {
    document.getElementById(id).classList.toggle('active', id === device);
    document.getElementById(id).setAttribute('aria-pressed', String(id === device));
  }
});
document.getElementById('reset').addEventListener('click', () => app.contentWindow.postMessage({type:'reset'},location.origin));
