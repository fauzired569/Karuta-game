// js/anti-cheat.js
// Deteksi aktivitas mencurigakan selama permainan (tab-hidden, copy,
// context menu, shortcut DevTools, dll). Murni client-side — hanya deterrent.
// Flag dikirim ke Firebase untuk ditinjau HOST (bukan auto-kick).

export function createAntiCheat({ onFlag, getContext, isRoundActive }) {
  let active = false;
  const detach = [];
  const recent = new Map(); // type -> lastAt (ms)

  function shouldFire(type) {
    const now = Date.now();
    const last = recent.get(type) || 0;
    if (now - last < 2000) return false;     // throttle 2 detik per tipe
    recent.set(type, now);
    return true;
  }

  function fire(type, extra) {
    if (!active) return;
    if (typeof isRoundActive === 'function' && !isRoundActive()) return;
    if (!shouldFire(type)) return;
    try {
      const ctx = getContext ? getContext() : {};
      onFlag?.(type, { ...ctx, ...(extra || {}) });
    } catch (e) {
      console.warn('[anti-cheat] handler error:', e);
    }
  }

  // ---- helpers untuk deteksi area prompt ----
  const PROMPT_SEL = '#meaning, #hostMeaning, .meaning, .prompt-reading, .prompt-meaning';

  function inPrompt(node) {
    if (!node) return false;
    if (node.nodeType === 3) node = node.parentElement;       // text node
    if (!node || node.nodeType !== 1) return false;
    return !!(node.closest && node.closest(PROMPT_SEL));
  }

  function selectionInPrompt() {
    try {
      const sel = window.getSelection?.();
      if (!sel || sel.rangeCount === 0) return false;
      const a = sel.anchorNode, f = sel.focusNode;
      return inPrompt(a) || inPrompt(f);
    } catch { return false; }
  }

  // ---- handlers ----
  function onVisibility() {
    if (document.visibilityState === 'hidden') fire('tab_hidden');
  }
  function onBlur() { fire('window_blur'); }
  function onContextMenu(e) {
    if (inPrompt(e.target)) {
      e.preventDefault();
      fire('context_menu');
    }
  }
  function onCopyCut(e) {
    if (inPrompt(e.target) || selectionInPrompt()) {
      e.preventDefault?.();
      fire(e.type === 'copy' ? 'copy_attempt' : 'cut_attempt');
    }
  }
  function onKeyDown(e) {
    const k = (e.key || '').toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;

    // Ctrl/Cmd + C/X/A saat fokus di area prompt
    const focusInPrompt = inPrompt(document.activeElement) || inPrompt(e.target);
    if (mod && !shift && ['c', 'x', 'a'].includes(k) && focusInPrompt) {
      fire('shortcut_' + k + '_in_prompt');
    }
    // Shortcut mencetak / view-source
    if (mod && ['p', 's', 'u'].includes(k)) fire('shortcut_' + k);
    // DevTools
    if (e.key === 'F12') fire('devtools_f12');
    if (mod && shift && ['i', 'j', 'c'].includes(k)) fire('devtools_shortcut');
  }
  function onSelectStart(e) {
    if (inPrompt(e.target)) fire('select_attempt');
  }

  function attach(target, ev, fn, opts) {
    target.addEventListener(ev, fn, opts);
    detach.push(() => target.removeEventListener(ev, fn, opts));
  }

  return {
    start() {
      if (active) return;
      active = true;
      attach(document, 'visibilitychange', onVisibility);
      attach(window, 'blur', onBlur);
      attach(document, 'contextmenu', onContextMenu);
      attach(document, 'copy', onCopyCut);
      attach(document, 'cut', onCopyCut);
      attach(document, 'keydown', onKeyDown);
      attach(document, 'selectstart', onSelectStart);
    },
    stop() {
      if (!active) return;
      active = false;
      detach.forEach(fn => fn());
      detach.length = 0;
      recent.clear();
    },
    isActive: () => active,
  };
}