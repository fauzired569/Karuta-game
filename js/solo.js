// solo.js — Mode Solo: 1 pemain manusia vs 3 bot.
// Dipanggil oleh boot.js via `await import('./solo.js')`.
// Top-level side-effect: bangun UI setup, wire kontrol, tampilkan layar setup.

import { KANJI, STRUCTURE } from './data.js';
import { buildPool, shuffle, rollBotParams } from './core.js';

// =========================================================
// Konstanta
// =========================================================
const FIELD_SIZE       = 20;
const MIN_POOL         = 8;
const ROUND_TIMEOUT_MS = 15000;
const NEXT_ROUND_DELAY = 2500;

const HUMAN_ID   = 'you';
const HUMAN_NAME = 'Kamu';
const BOTS = [
  { id: 'bot1', name: 'Bot A' },
  { id: 'bot2', name: 'Bot B' },
  { id: 'bot3', name: 'Bot C' },
];

// =========================================================
// Helpers
// =========================================================
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(el => {
    el.classList.toggle('active', el.id === id);
  });
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function toast(msg, kind = '') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast show ' + (kind || '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = 'toast ' + (kind || ''); }, 2200);
}

// =========================================================
// State
// =========================================================
const state = {
  pool: [],           // kanji ids untuk game aktif
  used: new Set(),
  players: {},        // id → { name, score }
  round: null,        // { targetId, cards, done }
  botTimers: [],
  roundTimer: null,
  nextTimer: null,
  running: false,
};

function resetPlayers() {
  state.players = { [HUMAN_ID]: { name: HUMAN_NAME, score: 0 } };
  BOTS.forEach(b => { state.players[b.id] = { name: b.name, score: 0 }; });
}

function clearTimers() {
  state.botTimers.forEach(t => clearTimeout(t));
  state.botTimers = [];
  clearTimeout(state.roundTimer);
  state.roundTimer = null;
  clearTimeout(state.nextTimer);
  state.nextTimer = null;
}

// =========================================================
// Setup UI (pemilih buku/bab)
// =========================================================
const selectedBooks    = new Set();
const selectedChapters = new Set();

function buildSetupUI() {
  const bookListEl = document.getElementById('bookList');
  if (!bookListEl) return;
  bookListEl.innerHTML = '';

  Object.entries(STRUCTURE).forEach(([book, chapters]) => {
    const bookDiv = document.createElement('div');
    bookDiv.className = 'book';
    bookDiv.innerHTML = `
      <div class="book-head">
        <input type="checkbox" data-book="${escHtml(book)}">
        <span>${escHtml(book)}</span>
        <span class="cnt">${chapters.length} bab</span>
      </div>
      <div class="chapters"></div>
    `;
    const chaptersEl = bookDiv.querySelector('.chapters');
    chapters.forEach(ch => {
      const key = `${book}::${ch}`;
      const lbl = document.createElement('label');
      lbl.className = 'chk';
      lbl.innerHTML = `
        <input type="checkbox" data-chapter="${escHtml(key)}">
        <span>${escHtml(ch)}</span>
      `;
      chaptersEl.appendChild(lbl);
    });
    bookListEl.appendChild(bookDiv);
  });
}

function onBookListChange(e) {
  const t = e.target;
  const bookListEl = document.getElementById('bookList');
  if (!bookListEl) return;

  if (t.matches('[data-book]')) {
    const book = t.dataset.book;
    const chapters = STRUCTURE[book] || [];
    chapters.forEach(ch => {
      const key = `${book}::${ch}`;
      const cb = bookListEl.querySelector(`[data-chapter="${CSS.escape(key)}"]`);
      if (cb) cb.checked = t.checked;
      if (t.checked) selectedChapters.add(key);
      else selectedChapters.delete(key);
    });
    if (t.checked) selectedBooks.add(book);
    else selectedBooks.delete(book);
  } else if (t.matches('[data-chapter]')) {
    const key = t.dataset.chapter;
    if (t.checked) selectedChapters.add(key);
    else selectedChapters.delete(key);
    const book = key.split('::')[0];
    const bookCb = bookListEl.querySelector(`[data-book="${CSS.escape(book)}"]`);
    const chapters = STRUCTURE[book] || [];
    const allChecked = chapters.every(ch => selectedChapters.has(`${book}::${ch}`));
    if (bookCb) bookCb.checked = allChecked;
    if (allChecked) selectedBooks.add(book);
    else selectedBooks.delete(book);
  }
  updatePoolInfo();
}

function updatePoolInfo() {
  const pool = buildPool([...selectedBooks], [...selectedChapters]);
  const infoEl = document.getElementById('poolInfo');
  const btnStart = document.getElementById('btnStart');
  if (infoEl) {
    infoEl.textContent = pool.length < MIN_POOL
      ? `${pool.length} kanji (min ${MIN_POOL})`
      : `${pool.length} kanji`;
  }
  if (btnStart) btnStart.disabled = pool.length < MIN_POOL;
  return pool;
}

// =========================================================
// Rendering game
// =========================================================
function renderScores() {
  const el = document.getElementById('scores');
  if (!el) return;
  const order = [HUMAN_ID, ...BOTS.map(b => b.id)];
  el.innerHTML = order.map(id => {
    const p = state.players[id];
    if (!p) return '';
    return `
      <div class="chip ${id === HUMAN_ID ? 'you' : ''}">
        <span class="cname">${escHtml(p.name)}</span>
        <span class="cpts">${p.score}</span>
      </div>
    `;
  }).join('');
}

function renderField(cardIds) {
  const fieldEl = document.getElementById('field');
  if (!fieldEl) return;
  fieldEl.innerHTML = '';
  cardIds.forEach((id, i) => {
    const card = KANJI.find(k => k.id === id);
    if (!card) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'card';
    if (card.kanji.length >= 4) btn.classList.add('len-xl');
    else if (card.kanji.length >= 3) btn.classList.add('len-lg');
    btn.dataset.id = id;
    btn.style.animationDelay = (i * 18) + 'ms';
    btn.innerHTML = `
      <span class="kanji">${escHtml(card.kanji)}</span>
    `;
    fieldEl.appendChild(btn);
  });
}

// =========================================================
// Game loop
// =========================================================
function startGame(poolIds) {
  clearTimers();
  state.pool = poolIds.slice();
  state.used = new Set();
  state.round = null;
  state.running = true;
  resetPlayers();
  renderScores();
  showScreen('screen-game');
  nextRound();
}

function nextRound() {
  if (!state.running) return;
  clearTimers();

  const remaining = state.pool.filter(id => !state.used.has(id));
  if (remaining.length === 0) {
    endGame();
    return;
  }

  // Pilih target acak dari pool yang belum dipakai
  const targetId = remaining[Math.floor(Math.random() * remaining.length)];
  state.used.add(targetId);

  // Field = target + distractor acak
  const fieldSize = Math.min(FIELD_SIZE, state.pool.length);
  const others    = state.pool.filter(id => id !== targetId);
  const distract  = shuffle(others).slice(0, Math.max(0, fieldSize - 1));
  const cards     = shuffle([targetId, ...distract]);

  const round = { targetId, cards, done: false };
  state.round = round;

  // Update prompt: hiragana (atas) + arti (bawah) — konsisten dengan multiplayer
  const target = KANJI.find(k => k.id === targetId);
  const meaningEl = document.getElementById('meaning');
  if (meaningEl) {
    meaningEl.innerHTML = `
      <span class="prompt-reading">${escHtml(target?.reading || '')}</span>
      <span class="prompt-meaning">${escHtml(target?.meaning || '?')}</span>
    `;
    meaningEl.classList.remove('pop');
    void meaningEl.offsetWidth;
    meaningEl.classList.add('pop');
  }

  // Update sisa
  const remainEl = document.getElementById('remainTag');
  if (remainEl) remainEl.innerHTML = `SISA<br>${state.pool.length - state.used.size}`;

  renderField(cards);

  // Jadwalkan jawaban bot
  BOTS.forEach(bot => {
    const { skill, reactionTime } = rollBotParams();
    const timer = setTimeout(() => {
      if (state.round !== round || round.done) return;
      if (Math.random() < skill) {
        endRound(bot.id);
      }
      // Gagal skill roll: bot "salah" → tidak ada poin, ronde tetap lanjut.
    }, reactionTime);
    state.botTimers.push(timer);
  });

  // Timer wasit
  state.roundTimer = setTimeout(() => {
    if (state.round !== round || round.done) return;
    endRound(null); // tidak ada pemenang
  }, ROUND_TIMEOUT_MS);
}

function endRound(winnerId) {
  const round = state.round;
  if (!round || round.done) return;
  round.done = true;
  clearTimers();

  if (winnerId && state.players[winnerId]) {
    state.players[winnerId].score++;
    renderScores();
    const isYou = winnerId === HUMAN_ID;
    toast(`${state.players[winnerId].name} menang ronde ini!`, isYou ? 'good' : '');
  } else {
    toast('Tidak ada yang menjawab', 'bad');
  }

  // Matikan klik & buka kartu yang benar
  document.querySelectorAll('#field .card').forEach(el => { el.style.pointerEvents = 'none'; });
  const correct = document.querySelector(`#field .card[data-id="${CSS.escape(round.targetId)}"]`);
  if (correct) correct.classList.add('found');

  // Jeda sebelum ronde berikutnya
  state.nextTimer = setTimeout(() => {
    if (!state.running) return;
    nextRound();
  }, NEXT_ROUND_DELAY);
}

function endGame() {
  state.running = false;
  clearTimers();

  const order = [HUMAN_ID, ...BOTS.map(b => b.id)];
  const sorted = order
    .map(id => ({ id, ...state.players[id] }))
    .filter(p => p && p.name)
    .sort((a, b) => b.score - a.score);

  const listEl = document.getElementById('resultList');
  if (listEl) {
    listEl.innerHTML = sorted.map((p, i) => `
      <div class="rank-row ${p.id === HUMAN_ID ? 'you' : ''}">
        <div class="rank">${i + 1}</div>
        <div class="rname">${escHtml(p.name)}</div>
        <div class="rpts">${p.score}</div>
      </div>
    `).join('');
  }
  showScreen('screen-result');
}

// =========================================================
// Input manusia (event delegation, dipasang sekali)
// =========================================================
function onFieldClick(e) {
  const btn = e.target.closest('.card');
  if (!btn) return;
  const round = state.round;
  if (!round || round.done) return;
  if (btn.style.pointerEvents === 'none') return;

  if (btn.dataset.id === round.targetId) {
    endRound(HUMAN_ID);
  } else {
    btn.classList.add('wrong');
    setTimeout(() => btn.classList.remove('wrong'), 500);
  }
}

// =========================================================
// Wiring kontrol UI
// =========================================================
function wireControls() {
  document.getElementById('bookList')?.addEventListener('change', onBookListChange);

  document.getElementById('btnAll')?.addEventListener('click', () => {
    const bookListEl = document.getElementById('bookList');
    if (!bookListEl) return;
    bookListEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.checked = true;
      if (cb.dataset.book) selectedBooks.add(cb.dataset.book);
      if (cb.dataset.chapter) selectedChapters.add(cb.dataset.chapter);
    });
    updatePoolInfo();
  });

  document.getElementById('btnNone')?.addEventListener('click', () => {
    const bookListEl = document.getElementById('bookList');
    if (!bookListEl) return;
    bookListEl.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
    selectedBooks.clear();
    selectedChapters.clear();
    updatePoolInfo();
  });

  document.getElementById('btnStart')?.addEventListener('click', () => {
    const pool = buildPool([...selectedBooks], [...selectedChapters]);
    if (pool.length < MIN_POOL) return;
    startGame(pool.map(k => k.id));
  });

  document.getElementById('field')?.addEventListener('click', onFieldClick);

  document.getElementById('btnAgain')?.addEventListener('click', () => {
    // Pool yang sama, skor & used di-reset di startGame
    if (state.pool.length < MIN_POOL) {
      showScreen('screen-setup');
      return;
    }
    startGame(state.pool);
  });

  document.getElementById('btnChange')?.addEventListener('click', () => {
    // Hentikan timer yang mungkin masih jalan, kembali ke setup tanpa reset pilihan
    state.running = false;
    clearTimers();
    showScreen('screen-setup');
  });
}

// =========================================================
// Init — side-effect entry point
// =========================================================
(function init() {
  showScreen('screen-setup');
  buildSetupUI();
  updatePoolInfo();
  resetPlayers();
  wireControls();
})();
})();
