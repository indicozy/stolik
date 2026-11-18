// Hero phone demo (see components/mock/PhoneDemo.astro). A scripted chat plays once
// when the demo is in view, then stops at the permission prompt and waits. Only the
// visitor's tap answers it. Reduced motion: no timers, the prompt shows at once.

type Choice = 'allow' | 'deny';

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

export function initPhoneDemo(): void {
  document.querySelectorAll<HTMLElement>('[data-phone-demo]').forEach(setupDemo);
}

function setupDemo(root: HTMLElement): void {
  const one = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel);
  const all = <T extends Element = HTMLElement>(sel: string) => Array.from(root.querySelectorAll<T>(sel));
  const step = (name: string) => one(`[data-step="${name}"]`);

  const keys = one('[data-keys]');
  const hint = one('[data-hint]');
  const sent = one<HTMLElement>('[data-sent]');
  const status = one('[data-status]');
  const strip = one('[data-strip]');
  const announce = one('[data-announce]');
  const replay = one<HTMLButtonElement>('[data-replay]');
  const timers: number[] = [];
  let choice: 'waiting' | Choice = 'waiting';

  const show = (el: Element | null | undefined, on = true) => {
    if (el instanceof HTMLElement) el.hidden = !on;
  };
  const later = (ms: number, fn: () => void) => {
    if (reduced) fn();
    else timers.push(window.setTimeout(fn, ms));
  };
  const stop = () => {
    timers.splice(0).forEach((t) => clearTimeout(t));
  };
  const say = (text: string) => {
    if (announce) announce.textContent = text;
  };

  function setWaiting(on: boolean): void {
    keys?.classList.toggle('is-waiting', on);
    status?.classList.toggle('is-waiting', on);
  }

  function showPrompt(): void {
    show(step('prompt'));
    show(step('keys'));
    show(keys);
    show(hint);
    show(sent, false);
    setWaiting(true);
    say('orbit-api wants to run Bash: npm test. Allow or deny.');
  }

  function reset(): void {
    stop();
    choice = 'waiting';
    all('[data-step], [data-line], [data-outcome]').forEach((el) => show(el, false));
    if (status) status.textContent = 'orbit-api · waiting for permission: Bash(npm test)';
    if (sent) sent.textContent = '';
    say('');
  }

  function play(): void {
    reset();
    show(step('today'));
    if (reduced) {
      show(step('say'));
      showPrompt();
      return;
    }
    later(500, () => show(step('typing-a')));
    later(1500, () => { show(step('typing-a'), false); show(step('say')); });
    later(2100, () => show(step('typing-b')));
    later(3000, () => { show(step('typing-b'), false); showPrompt(); });
  }

  function answer(picked: Choice): void {
    if (choice !== 'waiting') return;
    choice = picked;
    stop();
    setWaiting(false);
    if (sent) {
      sent.textContent = picked === 'allow' ? 'Sent: allow' : 'Sent: deny';
      show(sent);
      sent.tabIndex = -1;
      sent.focus({ preventScroll: true });
    }
    show(keys, false);
    show(hint, false);
    if (status) status.textContent = `orbit-api · permission: ${picked}`;

    if (picked === 'allow') {
      show(one('[data-line="cmd"]'));
      later(600, () => show(one('[data-line="pass"]')));
      say('Sent: allow. The session ran npm test: 214 passed.');
    } else {
      show(one('[data-line="deny"]'));
      say("Sent: deny. The session did not run npm test.");
    }
    const reply = one(`[data-outcome="${picked}"]`);
    later(picked === 'allow' ? 1300 : 900, () => show(reply));
  }

  all<HTMLButtonElement>('[data-answer]').forEach((btn) => {
    btn.addEventListener('click', () => answer(btn.dataset.answer === 'deny' ? 'deny' : 'allow'));
  });
  replay?.addEventListener('click', () => play());

  // Autoplay once the demo is in view. Reduced motion shows the prompt at once.
  if (reduced || !('IntersectionObserver' in window)) {
    play();
  } else {
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      play();
    }, { threshold: 0.5 });
    io.observe(root);
  }
}
