// Day / night follows the device's light / dark setting (which phones and
// computers can switch at sunset). The button overrides it until the device
// switches next. The pages set the theme before drawing (inline script);
// this keeps it current and draws the button.

const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const systemTheme = () => (darkQuery.matches ? 'night' : 'day');

const SUN = '<svg width="16" height="16" style="fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round" aria-hidden="true"><g transform="scale(0.6667)"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"></path></g></svg>Day';
const MOON = '<svg width="16" height="16" style="fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round" aria-hidden="true"><g transform="scale(0.6667)"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"></path></g></svg>Night';

/** Wires the Day / Night `button`. */
export function setupTheme (button) {
  const render = () => {
    button.innerHTML = document.documentElement.dataset.theme === 'night' ? SUN : MOON;
  };
  // The device's theme, or one picked by hand since the device last switched.
  const auto = () => {
    let theme = systemTheme();
    try {
      const o = JSON.parse(localStorage.getItem('loopk.theme'));
      if (o && o.system === theme) theme = o.theme;
      else localStorage.removeItem('loopk.theme');
    } catch { /* none */ }
    document.documentElement.dataset.theme = theme;
    render();
  };
  button.addEventListener('click', () => {
    const theme = document.documentElement.dataset.theme === 'night' ? 'day' : 'night';
    document.documentElement.dataset.theme = theme;
    try {
      if (theme === systemTheme()) localStorage.removeItem('loopk.theme');
      else localStorage.setItem('loopk.theme', JSON.stringify({ theme, system: systemTheme() }));
    } catch { /* private mode */ }
    render();
  });
  darkQuery.addEventListener('change', auto);
  auto();
}
