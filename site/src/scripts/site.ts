const KEY = 'starlight-theme';
const root = document.documentElement;

// Theme: data-theme on <html>, shared key with Starlight.
function applyToggleLabels(): void {
  const dark = root.dataset.theme === 'dark';
  document.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]').forEach((b) => {
    b.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  });
}

function readStored(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

document.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]').forEach((b) => {
  b.hidden = false;
  b.addEventListener('click', () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(KEY, next); } catch {}
    root.dataset.theme = next;
    applyToggleLabels();
  });
});

matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
  const s = readStored();
  if (s === 'light' || s === 'dark') return;
  root.dataset.theme = e.matches ? 'light' : 'dark';
  applyToggleLabels();
});
applyToggleLabels();

// Header border after scroll.
const onScroll = () => root.toggleAttribute('data-scrolled', window.scrollY > 8);
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

// Mobile menu: close on link click and Escape.
document.querySelectorAll<HTMLDetailsElement>('.td-menu').forEach((menu) => {
  menu.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => { menu.open = false; }));
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  document.querySelectorAll<HTMLDetailsElement>('.td-menu[open]').forEach((m) => {
    m.open = false;
    m.querySelector('summary')?.focus();
  });
});

// Copy buttons.
document.querySelectorAll<HTMLElement>('[data-copy-block]').forEach((block) => {
  const btn = block.querySelector<HTMLButtonElement>('[data-copy]');
  const live = block.querySelector<HTMLElement>('[data-copy-live]');
  const code = block.querySelector('code');
  if (!btn || !live || !code) return;
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(btn.dataset.copy ?? '');
      btn.classList.add('is-copied');
      live.textContent = 'Copied';
      setTimeout(() => { btn.classList.remove('is-copied'); live.textContent = ''; }, 1600);
    } catch {
      live.textContent = 'Press Ctrl+C';
      const range = document.createRange();
      range.selectNodeContents(code);
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  });
});

// Rise-in on intersection (only when motion is allowed; see head script).
if (root.classList.contains('td-motion')) {
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
    });
  }, { threshold: 0.15 });
  document.querySelectorAll('.td-rise').forEach((el) => io.observe(el));
}
