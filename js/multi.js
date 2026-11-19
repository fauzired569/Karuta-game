// js/multi.js — Logika multiplayer: host (wasit) + player, Firebase RTDB v9 modular
// Self-contained — TIDAK mem-import penalty.js (logika penalti inline).

import { firebaseConfig } from './firebase-config.js';
import { KANJI, STRUCTURE } from './data.js';
import { buildPool } from './core.js';
import { createAntiCheat } from './anti-cheat.js';

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  getDatabase, ref, set, get, update, remove, onValue, onDisconnect,
  runTransaction, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';

// =========================================================
// Konstanta
// =========================================================
const MAX_PLAYERS        = 15;
const FIELD_SIZE         = 20;
const MIN_POOL           = 8;
const ROUND_TIMEOUT_MS   = 15000;
const NEXT_ROUND_DELAY   = 2500;
const ROOM_CODE_LEN      = 4;
const ROOM_CODE_CHARS    = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SESSION_KEY        = 'karuta_session_v1';
const SESSION_TTL_MS     = 6 * 60 * 60 * 1000;

// =========================================================
// PENALTY (inline — sebelumnya di penalty.js)
// =========================================================
const PENALTY_PER_FLAG = 1;
const PENALTY_TYPES = new Set([
  'copy_attempt',
  'cut_attempt',
  'context_menu',
  'devtools_f12',
  'devtools_shortcut',
  'shortcut_c_in_prompt',
  'shortcut_x_in_prompt',
  'shortcut_u',
  'shortcut_s',
  'shortcut_p',
]);

function isPenaltyType(type) {
  return PENALTY_TYPES.has(String(type || ''));
}

async function applyPenalty(dbArg, code, uid, amount = PENALTY_PER_FLAG) {
  if (!dbArg || !code || !uid) return { committed: false, newScore: null };
  const delta = Math.abs(Number(amount) || 0);
  if (delta <= 0) return { committed: false, newScore: null };

  const scoreRef = ref(dbArg, `rooms/${code}/players/${uid}/score`);
  try {
    const result = await runTransaction(scoreRef, (current) => {
      const base = (typeof current === 'number') ? current : 0;
      return base - delta;
    });
    const raw = result.snapshot.val();
    return {
      committed: !!result.committed,
      newScore: typeof raw === 'number' ? raw : null,
    };
  } catch (err) {
    console.warn('[penalty] transaction gagal:', err);
    return { committed: false, newScore: null };
  }
}

// =========================================================
// Firebase singleton
// =========================================================
let app, auth, db;
let myUid = null;

function initFirebase() {
  if (app) return;
  app  = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db   = getDatabase(app);
}

async function signIn() {
  initFirebase();
  return new Promise((resolve, reject) => {
    const unsub = onAuthStateChanged(auth, (user) => {
      unsub();
      if (user) return resolve(user);
      signInAnonymously(auth).then(c => resolve(c.user)).catch(reject);
    });
  });
}

// =========================================================
// Utils
// =========================================================
function shuffle(arr) {
  const a = (arr || []).slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function genRoomCode() {
  let s = '';
  for (let i = 0; i < ROOM_CODE_LEN; i++) {
    s += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return s;
}

function escHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
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

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(el => {
    el.classList.toggle('active', el.id === id);
  });
}

function getReading(card) {
  if (!card) return '';
  if (typeof card.reading === 'string' && card.reading) return card.reading;
  if (typeof card.yomi    === 'string' && card.yomi)    return card.yomi;
  if (Array.isArray(card.reading) && card.reading.length) return card.reading.join('、');
  return '';
}

// =========================================================
// Render helpers
// =========================================================
function renderPrompt(el, reading, meaning) {
  if (!el) return;
  el.innerHTML = `
    <span class="prompt-reading">${escHtml(reading || '')}</span>
    <span class="prompt-meaning">${escHtml(meaning || '?')}</span>
  `;
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
}

function renderScores(el, players, myUidArg, flags = {}) {
  if (!el) return;
  const list = Object.entries(players || {})
    .filter(([_, p]) => !p.isHost)
    .sort((a, b) => (Number(b[1].score) || 0) - (Number(a[1].score) || 0));

  el.innerHTML = list.map(([id, p]) => {
    const f = flags[id] || {};
    const count = Object.keys(f).length;
    const score = Number(p.score) || 0;
    const negative = score < 0;
    const warn = count > 0
      ? `<span class="warn-badge" title="Aktivitas mencurigakan">⚠ ${count}</span>`
      : '';
    return `
      <div class="chip ${id === myUidArg ? 'you' : ''} ${count > 0 ? 'suspicious' : ''} ${negative ? 'negative' : ''}">
        <span class="cname">${escHtml(p.name || '?')}${warn}</span>
        <span class="cpts">${score}</span>
      </div>`;
  }).join('');
}

function renderField(fieldEl, cardIds) {
  if (!fieldEl) return;
  fieldEl.innerHTML = '';
  const ordered = shuffle(cardIds || []);
  ordered.forEach((id, i) => {
    const card = KANJI.find(k => k.id === id);
    if (!card) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'card';
    if (card.kanji.length >= 4) btn.classList.add('len-xl');
    else if (card.kanji.length >= 3) btn.classList.add('len-lg');
    btn.dataset.id = id;
    btn.style.animationDelay = (i * 18) + 'ms';
    btn.innerHTML = `<span class="kanji">${escHtml(card.kanji)}</span>`;
    fieldEl.appendChild(btn);
  });
}

// =========================================================
// PLAYER STATE
// =========================================================
let playerState = {
  code: null, uid: null, name: '', isHost: false,
  currentRound: null, players: {}, settings: null,
  lastCardsKey: null, lastRoundNumber: 0, clickedThisRound: false,
  currentScreen: null, metaStatus: 'lobby',
  unsub: [], antiCheat: null,
};

function saveSession() {
  if (!playerState.code || !playerState.name) return;
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      code: playerState.code, name: playerState.name, savedAt: Date.now(),
    }));
  } catch {}
}

function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch {}
}

function readSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); }
  catch { return null; }
}

// =========================================================
// Flag reporting + penalti otomatis
// =========================================================
async function reportPlayerFlag(type, extra = {}) {
  const code = playerState.code;
  const uid  = playerState.uid;
  if (!code || !uid) return;
  const round = Number(extra.round) || playerState.currentRound?.number || 0;
  const key = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  set(ref(db, `rooms/${code}/flags/${uid}/${key}`), {
    type: String(type).slice(0, 64), round, at: Date.now(),
  }).catch(err => console.warn('flag write failed:', err));

  if (!isPenaltyType(type)) return;

  try {
    const { committed, newScore } = await applyPenalty(db, code, uid, PENALTY_PER_FLAG);
    if (committed) {
      toast(`⚠ Kecurangan terdeteksi! −${PENALTY_PER_FLAG} poin (skor: ${newScore})`, 'warn');
    }
  } catch (err) {
    console.warn('penalty failed:', err);
  }
}

// =========================================================
// HOST STATE
// =========================================================
let hostState = {
  code: null, uid: null, pool: [], used: new Set(),
  roundNumber: 0, roundTimer: null,
  unsubPlayers: null, unsubRound: null, unsubMeta: null, unsubFlags: null,
  flags: {}, playersCache: {}, processedRounds: new Set(),
  currentRound: null, metaStatus: 'lobby', maxPlayers: 8,
  finished: false, settings: null, _pendingPool: [],
};

function hostCleanup() {
  if (hostState.unsubPlayers) try { hostState.unsubPlayers(); } catch {}
  if (hostState.unsubRound)   try { hostState.unsubRound();   } catch {}
  if (hostState.unsubMeta)    try { hostState.unsubMeta();    } catch {}
  if (hostState.unsubFlags)   try { hostState.unsubFlags();   } catch {}
  if (hostState.roundTimer) clearTimeout(hostState.roundTimer);

  hostState.code = null; hostState.uid = null;
  hostState.pool = []; hostState.used = new Set();
  hostState.roundNumber = 0; hostState.roundTimer = null;
  hostState.unsubPlayers = null; hostState.unsubRound = null;
  hostState.unsubMeta = null; hostState.unsubFlags = null;
  hostState.flags = {}; hostState.playersCache = {};
  hostState.processedRounds = new Set();
  hostState.currentRound = null; hostState.metaStatus = 'lobby';
  hostState.finished = false; hostState.settings = null;
  hostState._pendingPool = [];
}

// =========================================================
// HOST — Pool helpers
// =========================================================
function poolIdsFromSettings(settings) {
  const raw = settings?.pool;
  if (!raw) return [];
  let ids;
  if (Array.isArray(raw))              ids = raw;
  else if (typeof raw === 'object')    ids = Object.values(raw);   // Firebase object → array
  else                                 return [];
  const seen = new Set();
  return ids.filter(id => {
    if (typeof id !== 'string' || seen.has(id)) return false;
    seen.add(id);
    return KANJI.some(k => k.id === id);
  });
}

async function loadPoolFromSettings(code) {
  if (!code) throw new Error('loadPoolFromSettings: code kosong');

  let settings = hostState.settings;
  if (!settings) {
    const snap = await get(ref(db, `rooms/${code}/settings`));
    settings = snap.val() || {};
  }
  hostState.settings = settings;

  let ids = poolIdsFromSettings(settings);
  if (ids.length === 0) {
    console.warn('[host] pool kosong — fallback ke seluruh KANJI');
    ids = KANJI.map(k => k.id);
  }

  hostState.pool = ids;
  const poolSet = new Set(ids);
  hostState.used = new Set([...(hostState.used || [])].filter(id => poolSet.has(id)));
  console.info(`[host] pool siap: ${ids.length} kanji`);
  return ids;
}

// =========================================================
// HOST — Setup: render book list (SYNC, dipanggil sebelum auth)
// =========================================================
function hostRenderBookList() {
  const el = document.getElementById('bookList');
  if (!el) { console.error('[host] #bookList tidak ditemukan'); return; }

  if (!STRUCTURE || Object.keys(STRUCTURE).length === 0) {
    console.error('[host] STRUCTURE kosong — data.js bermasalah');
    el.innerHTML = '<p class="hint" style="color:#b71c1c">Data kanji tidak tersedia.</p>';
    return;
  }

  try {
    el.innerHTML = Object.entries(STRUCTURE).map(([book, chapters]) => {
      const chaptersHtml = chapters.map(ch => `
        <label class="chapter-label">
          <input type="checkbox" name="chapter"
                 value="${escHtml(book)}::${escHtml(ch)}" checked>
          ${escHtml(ch)}
        </label>
      `).join('');
      return `
        <div class="book-item" data-book="${escHtml(book)}">
          <label class="book-label">
            <input type="checkbox" class="book-check" checked>
            ${escHtml(book)}
          </label>
          <div class="chapter-list">${chaptersHtml}</div>
        </div>
      `;
    }).join('');

    el.querySelectorAll('.book-check').forEach(cb => {
      cb.addEventListener('change', () => {
        cb.closest('.book-item')
          .querySelectorAll('.chapter-label input')
          .forEach(cc => { cc.checked = cb.checked; });
        hostUpdatePool();
      });
    });

    el.querySelectorAll('.chapter-label input').forEach(cb => {
      cb.addEventListener('change', () => {
        const item = cb.closest('.book-item');
        const all = item.querySelectorAll('.chapter-label input');
        const checked = item.querySelectorAll('.chapter-label input:checked');
        const bookCheck = item.querySelector('.book-check');
        if (bookCheck) {
          bookCheck.checked = all.length === checked.length;
          bookCheck.indeterminate = checked.length > 0 && checked.length < all.length;
        }
        hostUpdatePool();
      });
    });

    console.info('[host] book list dirender:', Object.keys(STRUCTURE).length, 'buku');
    hostUpdatePool();
  } catch (e) {
    console.error('[host] render book list gagal:', e);
    el.innerHTML = `<p class="hint" style="color:#b71c1c">Error: ${escHtml(e.message || e)}</p>`;
  }
}

function hostUpdatePool() {
  const checked = [...document.querySelectorAll('#bookList .chapter-label input:checked')];
  const pool = buildPool([], checked.map(c => c.value));
  hostState._pendingPool = pool.map(k => k.id);

  const info = document.getElementById('poolInfo');
  if (info) info.textContent = `${pool.length} kanji`;

  const btnCreate = document.getElementById('btnCreateRoom');
  if (btnCreate) btnCreate.disabled = pool.length < MIN_POOL;

  console.info('[host] pool update:', pool.length, 'kanji terpilih');
}

// =========================================================
// HOST — Create Room
// =========================================================
async function hostCreateRoom(poolIds, maxPlayers = 8) {
  await signIn();
  myUid = auth.currentUser.uid;

  if (!poolIds || poolIds.length < MIN_POOL) {
    throw new Error(`Pilih minimal ${MIN_POOL} kanji.`);
  }

  let code = null;
  for (let i = 0; i < 12; i++) {
    const candidate = genRoomCode();
    const snap = await get(ref(db, `rooms/${candidate}/meta`));
    if (!snap.exists()) { code = candidate; break; }
  }
  if (!code) throw new Error('Gagal membuat kode room. Coba lagi.');

  await set(ref(db, `rooms/${code}`), {
    meta: {
      hostUid: myUid,
      createdAt: Date.now(),
      fieldSize: FIELD_SIZE,
      maxPlayers: Math.max(2, Math.min(MAX_PLAYERS, Number(maxPlayers) || 8)),
      status: 'lobby',
    },
    settings: { pool: poolIds.slice() },
    players: {
      [myUid]: {
        name: 'Wasit', score: 0, isHost: true, online: true, joinedAt: Date.now(),
      },
    },
  });

  onDisconnect(ref(db, `rooms/${code}/players/${myUid}/online`)).set(false);

  hostState.code = code;
  hostState.uid = myUid;
  hostState.pool = poolIds.slice();
  hostState.used = new Set();
  hostState.roundNumber = 0;
  hostState.maxPlayers = Math.max(2, Math.min(MAX_PLAYERS, Number(maxPlayers) || 8));
  hostState.metaStatus = 'lobby';
  hostState.finished = false;
  hostState.settings = { pool: poolIds.slice() };

  hostWatchPlayers();
  hostWatchMeta();
  hostWatchFlags();

  const roomInfoEl = document.getElementById('roomInfo');
  const roomCodeEl = document.getElementById('roomCode');
  if (roomInfoEl) roomInfoEl.hidden = false;
  if (roomCodeEl) roomCodeEl.textContent = code;

  console.info('[host] room dibuat:', code, '—', poolIds.length, 'kanji di pool');
  hostShowLobby();
}

// =========================================================
// HOST — Watchers
// =========================================================
function hostWatchPlayers() {
  const playersRef = ref(db, `rooms/${hostState.code}/players`);
  hostState.unsubPlayers = onValue(playersRef, (snap) => {
    const players = snap.val() || {};
    hostState.playersCache = players;

    const listEl = document.getElementById('hostPlayerList');
    if (listEl) {
      const nonHost = Object.entries(players).filter(([_, p]) => !p.isHost);
      listEl.innerHTML = nonHost.map(([uid, p]) => `
        <li class="lobby-item ${p.online ? '' : 'offline'}">
          <span class="player-name">${escHtml(p.name || '?')}</span>
          <button type="button" class="btn-kick" data-kick="${escHtml(uid)}">Kick</button>
        </li>
      `).join('');
      listEl.querySelectorAll('[data-kick]').forEach(btn => {
        btn.addEventListener('click', () => hostKickPlayer(btn.dataset.kick));
      });
    }

    const countEl = document.getElementById('hostPlayerCount');
    if (countEl) countEl.textContent = Object.values(players).filter(p => !p.isHost).length;
    const maxEl = document.getElementById('hostMaxPlayers');
    if (maxEl) maxEl.textContent = hostState.maxPlayers;

    const btnStart = document.getElementById('btnStartGame');
    if (btnStart) {
      const nonHost = Object.values(players).filter(p => !p.isHost).length;
      btnStart.disabled = (nonHost < 1) || (hostState.metaStatus !== 'lobby');
    }

    if (hostState.metaStatus === 'playing' || hostState.metaStatus === 'finished') {
      hostRenderScores();
    }
  });
}

function hostWatchMeta() {
  const metaRef = ref(db, `rooms/${hostState.code}/meta`);
  hostState.unsubMeta = onValue(metaRef, (snap) => {
    const meta = snap.val();
    if (!meta) {
      toast('Room tidak tersedia.');
      hostCleanup();
      location.href = 'index.html';
      return;
    }
    hostState.metaStatus = meta.status;

    if (meta.status === 'playing') {
      if (!hostState.pool.length) {
        loadPoolFromSettings(hostState.code).then(() => {
          if (hostState.currentScreen !== 'screen-host-game') hostShowGame();
          else hostRenderPicker();
        }).catch(err => console.warn('[host] reload pool:', err));
      }
    } else if (meta.status === 'finished') {
      hostShowResult();
    }
  });
}

function hostWatchRound() {
  const roundRef = ref(db, `rooms/${hostState.code}/currentRound`);
  hostState.unsubRound = onValue(roundRef, (snap) => {
    const round = snap.val();
    hostState.currentRound = round;
    if (!round) { hostRenderRemainTag(null); return; }
    hostRenderRemainTag(round.remaining);
    if (round.winner && !round.processed && !hostState.processedRounds.has(round.number)) {
      hostProcessWinner(round);
    }
  });
}

function hostWatchFlags() {
  const flagsRef = ref(db, `rooms/${hostState.code}/flags`);
  hostState.unsubFlags = onValue(flagsRef, (snap) => {
    hostState.flags = snap.val() || {};
    const total = Object.values(hostState.flags).reduce(
      (sum, pf) => sum + Object.keys(pf || {}).length, 0
    );
    const btn = document.getElementById('btnReviewFlags');
    const countEl = document.getElementById('flagCount');
    if (btn) btn.hidden = total === 0;
    if (countEl) countEl.textContent = total;
    hostRenderScores();
  });
}

// =========================================================
// HOST — Screens
// =========================================================
function hostShowLobby() {
  showScreen('screen-host-lobby');
  const roomEl = document.getElementById('hostRoomCode');
  if (roomEl) roomEl.textContent = hostState.code || '----';
  const maxEl = document.getElementById('hostMaxPlayers');
  if (maxEl) maxEl.textContent = hostState.maxPlayers;
}

function hostShowGame() {
  showScreen('screen-host-game');
  hostRenderPicker();
  hostRenderScores();
  hostRenderRemainTag(hostState.currentRound?.remaining ?? null);
  const statusEl = document.getElementById('hostStatus');
  if (statusEl) statusEl.textContent = 'Pilih kanji untuk jadi soal…';
}

function hostShowResult() {
  showScreen('screen-host-result');
  hostRenderResult();
}

function hostRenderPrompt(card) {
  const el = document.getElementById('hostMeaning');
  if (!el) return;
  renderPrompt(el, getReading(card), card.meaning);
}

function hostRenderRemainTag(remaining) {
  const el = document.getElementById('hostRemainTag');
  if (!el) return;
  const val = (remaining === null || remaining === undefined) ? '–' : remaining;
  el.innerHTML = `SISA<br>${val}`;
}

function hostRenderScores() {
  const el = document.getElementById('hostScores');
  if (!el) return;
  renderScores(el, hostState.playersCache, hostState.uid, hostState.flags);
}

function hostRenderPicker() {
  const el = document.getElementById('kanjiPicker');
  if (!el) { console.error('[host] #kanjiPicker tidak ditemukan'); return; }

  const pool = hostState.pool || [];
  const used = hostState.used || new Set();
  const available = pool.filter(id => !used.has(id));

  console.info('[host] render picker:', available.length, '/', pool.length, 'kanji tersedia');

  if (available.length === 0) {
    el.innerHTML = '<p class="hint">Tidak ada kanji tersisa. Klik Akhiri untuk selesai.</p>';
    el.onclick = null;
    return;
  }

  el.innerHTML = available.map(id => {
    const card = KANJI.find(k => k.id === id);
    if (!card) return '';
    return `
      <button type="button" class="pick-card" data-id="${escHtml(id)}">
        <span class="kanji">${escHtml(card.kanji)}</span>
        <span class="pick-meaning">${escHtml(card.meaning || '')}</span>
      </button>
    `;
  }).join('');

  el.onclick = (e) => {
    const btn = e.target.closest('.pick-card');
    if (!btn || !el.contains(btn)) return;
    const id = btn.dataset.id;
    if (id) hostPickTarget(id);
  };
}

// =========================================================
// HOST — Lifecycle
// =========================================================
async function hostStartGame() {
  if (!hostState.code) return;

  const nonHost = Object.values(hostState.playersCache || {}).filter(p => !p.isHost).length;
  if (nonHost < 1) { toast('Butuh minimal 1 pemain untuk memulai.'); return; }

  try {
    await loadPoolFromSettings(hostState.code);
  } catch (e) {
    console.error(e);
    toast('Gagal memuat pool kanji.');
    return;
  }

  hostState.used = new Set();
  hostState.roundNumber = 0;
  hostState.processedRounds = new Set();
  hostState.finished = false;
  hostState.currentRound = null;

  try {
    await update(ref(db, `rooms/${hostState.code}/meta`), {
      status: 'playing', startedAt: Date.now(),
    });
  } catch (e) {
    console.error(e);
    toast('Gagal memulai permainan.');
    return;
  }
  hostState.metaStatus = 'playing';

  hostWatchRound();
  hostShowGame();
}

async function hostPickTarget(id) {
  if (!hostState.code) return;
  if (!hostState.pool.includes(id)) { toast('Kanji tidak ada di pool!'); return; }
  if (hostState.used.has(id)) { toast('Kanji sudah dipakai.'); return; }

  const cur = hostState.currentRound;
  if (cur && !cur.processed && !cur.expired && !cur.winner) {
    toast('Selesaikan ronde berjalan dulu.');
    return;
  }

  const target = KANJI.find(k => k.id === id);
  if (!target) return;

  hostState.used.add(id);
  hostState.roundNumber += 1;

  const others = hostState.pool.filter(x => x !== id && !hostState.used.has(x));
  const distractors = shuffle(others).slice(0, Math.min(FIELD_SIZE - 1, others.length));
  const fieldIds = shuffle([id, ...distractors]);

  const round = {
    number: hostState.roundNumber,
    targetMeaning: target.meaning,
    targetReading: getReading(target),
    cards: fieldIds,
    remaining: fieldIds.length,
    startedAt: Date.now(),
    processed: false,
    expired: false,
  };

  try {
    await update(ref(db, `rooms/${hostState.code}`), {
      targetId: id, currentRound: round,
    });
  } catch (e) {
    console.error(e);
    hostState.used.delete(id);
    hostState.roundNumber -= 1;
    toast('Gagal memulai ronde: ' + (e.message || ''));
    return;
  }

  hostRenderPrompt(target);
  hostRenderPicker();
  hostRenderRemainTag(fieldIds.length);

  const statusEl = document.getElementById('hostStatus');
  if (statusEl) statusEl.textContent = 'Ronde berjalan — menunggu pemenang…';

  if (hostState.roundTimer) clearTimeout(hostState.roundTimer);
  hostState.roundTimer = setTimeout(hostTimeoutRound, ROUND_TIMEOUT_MS);
}

async function hostProcessWinner(round) {
  if (!round?.winner?.uid) return;
  if (hostState.processedRounds.has(round.number)) return;
  hostState.processedRounds.add(round.number);

  if (hostState.roundTimer) { clearTimeout(hostState.roundTimer); hostState.roundTimer = null; }

  const winnerUid = round.winner.uid;
  const scoreRef = ref(db, `rooms/${hostState.code}/players/${winnerUid}/score`);
  try {
    await runTransaction(scoreRef, (cur) => (typeof cur === 'number' ? cur : 0) + 1);
  } catch (e) { console.warn('[host] score tx:', e); }

  try {
    await update(ref(db, `rooms/${hostState.code}/currentRound`), {
      processed: true, remaining: 0,
    });
  } catch (e) { console.warn('[host] mark processed:', e); }

  const winnerName = hostState.playersCache[winnerUid]?.name || '?';
  toast(`🎉 ${winnerName} mendapat 1 poin!`);
  const statusEl = document.getElementById('hostStatus');
  if (statusEl) statusEl.textContent = `Pemenang: ${winnerName}. Pilih kanji berikutnya.`;

  const remaining = hostState.pool.filter(x => !hostState.used.has(x));
  if (remaining.length === 0) setTimeout(hostFinishGame, NEXT_ROUND_DELAY);
}

async function hostTimeoutRound() {
  const round = hostState.currentRound;
  if (!round) return;
  if (round.processed || round.winner) return;
  if (hostState.processedRounds.has(round.number)) return;
  hostState.processedRounds.add(round.number);

  try {
    await update(ref(db, `rooms/${hostState.code}/currentRound`), {
      expired: true, processed: true, remaining: 0,
    });
  } catch (e) { console.warn('[host] timeout:', e); }

  toast('⏱ Waktu habis!');
  const statusEl = document.getElementById('hostStatus');
  if (statusEl) statusEl.textContent = 'Waktu habis. Pilih kanji berikutnya.';

  const remaining = hostState.pool.filter(x => !hostState.used.has(x));
  if (remaining.length === 0) setTimeout(hostFinishGame, NEXT_ROUND_DELAY);
}

function hostRenderResult() {
  const el = document.getElementById('hostResultList');
  if (!el) return;
  const list = Object.entries(hostState.playersCache || {})
    .filter(([_, p]) => !p.isHost)
    .sort((a, b) => (Number(b[1].score) || 0) - (Number(a[1].score) || 0));
  el.innerHTML = list.map(([uid, p], i) => {
    const score = Number(p.score) || 0;
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    return `
      <div class="result-row ${score < 0 ? 'negative' : ''}">
        <span class="rank">${medal}</span>
        <span class="name">${escHtml(p.name || '?')}</span>
        <span class="pts ${score < 0 ? 'negative' : ''}">${score}</span>
      </div>`;
  }).join('');
}

async function hostFinishGame() {
  if (!hostState.code) return;
  hostState.finished = true;
  if (hostState.roundTimer) { clearTimeout(hostState.roundTimer); hostState.roundTimer = null; }
  try {
    await update(ref(db, `rooms/${hostState.code}/meta`), { status: 'finished' });
  } catch (e) { console.warn('[host] finish:', e); }
  hostState.metaStatus = 'finished';
  hostShowResult();
}

async function hostPlayAgain() {
  if (!hostState.code) return;
  hostState.used = new Set();
  hostState.roundNumber = 0;
  hostState.processedRounds = new Set();
  hostState.finished = false;
  hostState.currentRound = null;
  if (hostState.roundTimer) { clearTimeout(hostState.roundTimer); hostState.roundTimer = null; }

  const updates = {
    'meta/status': 'lobby',
    'meta/startedAt': null,
    'currentRound': null,
    'targetId': null,
  };
  Object.entries(hostState.playersCache || {}).forEach(([uid, p]) => {
    if (!p.isHost) updates[`players/${uid}/score`] = 0;
  });

  try {
    await update(ref(db, `rooms/${hostState.code}`), updates);
  } catch (e) {
    console.warn('[host] playAgain:', e);
    toast('Gagal reset permainan.');
    return;
  }
  hostState.metaStatus = 'lobby';
  hostShowLobby();
}

async function hostDisband() {
  const code = hostState.code;
  hostCleanup();
  if (code) {
    try { await remove(ref(db, `rooms/${code}`)); } catch (e) { console.warn(e); }
  }
  location.href = 'index.html';
}

async function hostKickPlayer(uid) {
  if (!hostState.code || !uid) return;
  if (!confirm('Keluarkan pemain ini?')) return;
  try {
    await remove(ref(db, `rooms/${hostState.code}/players/${uid}`));
    toast('Pemain dikeluarkan.');
  } catch (e) { toast('Gagal: ' + (e.message || '')); }
}

function hostShowReview() {
  const dialog = document.getElementById('reviewDialog');
  const content = document.getElementById('reviewContent');
  if (!dialog || !content) return;

  const flags = hostState.flags || {};
  const entries = Object.entries(flags);
  if (entries.length === 0) {
    content.innerHTML = '<p class="hint">Belum ada aktivitas mencurigakan.</p>';
  } else {
    content.innerHTML = entries.map(([uid, pf]) => {
      const name = hostState.playersCache[uid]?.name || uid.slice(0, 6);
      const items = Object.entries(pf || {}).map(([fid, f]) => `
        <div class="flag-row">
          <div class="fr-name">${escHtml(f.type || '?')}</div>
          <div class="fr-detail">Ronde ${f.round ?? '?'}<br>${new Date(f.at || 0).toLocaleTimeString()}</div>
        </div>
      `).join('');
      return `<div class="flag-group">
        <h4 style="margin:8px 0 4px;font-size:14px;">${escHtml(name)} (${Object.keys(pf || {}).length})</h4>
        ${items}
      </div>`;
    }).join('');
  }
  dialog.showModal();
}

// =========================================================
// PLAYER — Join / watchers / screens
// =========================================================
async function playerJoinRoom(rawCode, rawName) {
  const code = String(rawCode || '').trim().toUpperCase();
  const name = String(rawName || '').trim().slice(0, 16);
  if (code.length !== 4) throw new Error('Kode room harus 4 huruf.');
  if (!name) throw new Error('Nama harus diisi.');

  const metaSnap = await get(ref(db, `rooms/${code}/meta`));
  if (!metaSnap.exists()) throw new Error('Room tidak ditemukan.');
  const meta = metaSnap.val();

  const playersSnap = await get(ref(db, `rooms/${code}/players`));
  const players = playersSnap.val() || {};
  const existing = players[myUid];

  if (!existing) {
    if (meta.status !== 'lobby') throw new Error('Permainan sudah berjalan.');
    const nonHostCount = Object.values(players).filter(p => !p.isHost).length;
    if (nonHostCount >= (meta.maxPlayers || MAX_PLAYERS)) throw new Error('Room penuh.');
    await set(ref(db, `rooms/${code}/players/${myUid}`), {
      name, score: 0, isHost: false, online: true, joinedAt: Date.now(),
    });
    onDisconnect(ref(db, `rooms/${code}/players/${myUid}/online`)).set(false);
  } else {
    await set(ref(db, `rooms/${code}/players/${myUid}/online`), true);
  }

  playerState.code = code;
  playerState.uid = myUid;
  playerState.name = existing?.name || name;
  playerState.isHost = false;
  playerState.metaStatus = meta.status;
  playerState.lastRoundNumber = 0;
  playerState.lastCardsKey = null;
  playerState.clickedThisRound = false;

  saveSession();

  const btnLeave = document.getElementById('btnLeaveGame');
  if (btnLeave && !btnLeave._wired) {
    btnLeave._wired = true;
    btnLeave.addEventListener('click', () => {
      if (confirm('Keluar dari permainan?')) playerLeave();
    });
  }

  if (!playerState.antiCheat) {
    playerState.antiCheat = createAntiCheat({
      onFlag: (type, extra) => reportPlayerFlag(type, extra),
      getContext: () => ({ code: playerState.code, round: playerState.currentRound?.number }),
      isRoundActive: () => {
        const r = playerState.currentRound;
        return !!(r && !r.processed && !r.expired);
      },
    });
  }
  playerState.antiCheat.start();

  playerWatchRoom();
}

function playerWatchRoom() {
  playerState.unsub.forEach(fn => { try { fn(); } catch {} });
  playerState.unsub = [];
  const code = playerState.code;

  playerState.unsub.push(onValue(ref(db, `rooms/${code}/meta`), (snap) => {
    const meta = snap.val();
    if (!meta) { toast('Room dibubarkan.'); playerLeave(); return; }
    playerState.metaStatus = meta.status;
    if (meta.status === 'finished') playerShowResult();
    else if (meta.status === 'lobby') {
      if (playerState.currentScreen !== 'screen-multi-join') playerShowLobby();
    }
  }));

  playerState.unsub.push(onValue(ref(db, `rooms/${code}/players`), (snap) => {
    const players = snap.val() || {};
    playerState.players = players;
    if (!players[myUid]) { toast('Anda dikeluarkan.'); playerLeave(); return; }
    if (playerState.currentScreen === 'screen-multi-lobby') playerRenderLobby();
    if (playerState.currentScreen === 'screen-game') playerRenderScores();
    if (playerState.currentScreen === 'screen-result') playerRenderResult();
  }));

  playerState.unsub.push(onValue(ref(db, `rooms/${code}/currentRound`), (snap) => {
    const round = snap.val();
    playerState.currentRound = round;
    if (round) {
      if (playerState.metaStatus === 'finished') playerShowResult();
      else { playerShowGame(); playerRenderGame(); }
    } else if (playerState.currentScreen === 'screen-game') {
      playerShowLobby();
    }
  }));

  playerShowLobby();
}

function playerShowScreen(id) { showScreen(id); playerState.currentScreen = id; }

function playerShowJoinForm({ prefilledRoom = null } = {}) {
  playerShowScreen('screen-multi-join');
  const codeInput = document.getElementById('joinCode');
  const nameInput = document.getElementById('joinName');
  const btnJoin   = document.getElementById('btnJoin');
  if (codeInput && prefilledRoom) codeInput.value = prefilledRoom.toUpperCase();
  if (nameInput) nameInput.value = playerState.name || '';
  if (btnJoin && !btnJoin._wired) {
    btnJoin._wired = true;
    btnJoin.addEventListener('click', async () => {
      const code = (document.getElementById('joinCode')?.value || '').trim();
      const name = (document.getElementById('joinName')?.value || '').trim();
      try {
        btnJoin.disabled = true;
        await playerJoinRoom(code, name);
      } catch (e) {
        toast(e.message || 'Gagal bergabung.');
      } finally {
        btnJoin.disabled = false;
      }
    });
  }
}

function playerShowLobby() { playerShowScreen('screen-multi-lobby'); playerRenderLobby(); }
function playerShowGame() {
  if (playerState.currentScreen !== 'screen-game') {
    playerShowScreen('screen-game');
    playerState.lastCardsKey = null;
  }
}
function playerShowResult() { playerShowScreen('screen-result'); playerRenderResult(); }

function playerRenderLobby() {
  const roomEl = document.getElementById('lobbyCode');
  if (roomEl) roomEl.textContent = playerState.code || '----';
  const listEl = document.getElementById('lobbyPlayers');
  const countEl = document.getElementById('lobbyCount');
  const entries = Object.entries(playerState.players || {});
  if (countEl) countEl.textContent = entries.length;
  if (listEl) {
    listEl.innerHTML = entries.map(([uid, p]) => `
      <li class="lobby-item ${uid === myUid ? 'you' : ''} ${p.online ? '' : 'offline'}">
        <span class="player-name">${escHtml(p.name || '?')}${p.isHost ? ' 👑' : ''}</span>
      </li>
    `).join('');
  }
}

function playerRenderGame() {
  const round = playerState.currentRound;
  const meaningEl = document.getElementById('meaning');
  const fieldEl = document.getElementById('field') || document.getElementById('cardField');

  if (!round) {
    renderPrompt(meaningEl, '', 'Menunggu soal…');
    if (fieldEl) fieldEl.innerHTML = '<p class="hint">Menunggu soal dari wasit…</p>';
    playerRenderScores();
    return;
  }

  if (playerState.lastRoundNumber !== round.number) {
    playerState.lastRoundNumber = round.number;
    playerState.clickedThisRound = false;
    playerState.lastCardsKey = null;
  }

  renderPrompt(meaningEl, round.targetReading, round.targetMeaning);

  const cardsKey = (round.cards || []).join(',');
  if (cardsKey !== playerState.lastCardsKey) {
    playerState.lastCardsKey = cardsKey;
    renderField(fieldEl, round.cards || []);
    wireFieldClicks();
  }

  playerRenderScores();
  if (round.winner) highlightWinnerCard(round.winner.cardId);
}

function playerRenderScores() {
  const el = document.getElementById('scores') || document.getElementById('playerScores');
  if (!el) return;
  renderScores(el, playerState.players, myUid, {});
}

function playerRenderResult() {
  const el = document.getElementById('resultList');
  if (!el) return;
  const list = Object.entries(playerState.players || {})
    .filter(([_, p]) => !p.isHost)
    .sort((a, b) => (Number(b[1].score) || 0) - (Number(a[1].score) || 0));
  el.innerHTML = list.map(([uid, p], i) => {
    const score = Number(p.score) || 0;
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    return `
      <div class="result-row ${uid === myUid ? 'you' : ''} ${score < 0 ? 'negative' : ''}">
        <span class="rank">${medal}</span>
        <span class="name">${escHtml(p.name || '?')}</span>
        <span class="pts ${score < 0 ? 'negative' : ''}">${score}</span>
      </div>`;
  }).join('');
}

function wireFieldClicks() {
  const fieldEl = document.getElementById('field') || document.getElementById('cardField');
  if (!fieldEl) return;
  fieldEl.querySelectorAll('.card').forEach(btn => {
    if (btn._wired) return;
    btn._wired = true;
    btn.addEventListener('click', () => handleCardClick(btn));
  });
}

async function handleCardClick(btn) {
  const cardId = btn.dataset.id;
  const round = playerState.currentRound;
  if (!cardId || !round) return;
  if (btn.disabled || btn.classList.contains('correct')) return;
  if (round.winner || round.processed || round.expired) return;
  if (playerState.clickedThisRound) return;

  const target = KANJI.find(k =>
    k.meaning === round.targetMeaning && k.reading === round.targetReading
  );
  if (!target || cardId !== target.id) {
    btn.classList.add('wrong');
    setTimeout(() => btn.classList.remove('wrong'), 400);
    return;
  }

  playerState.clickedThisRound = true;
  try {
    const result = await runTransaction(
      ref(db, `rooms/${playerState.code}/currentRound/winner`),
      (cur) => (cur && cur.uid) ? cur : { uid: myUid, cardId, round: round.number }
    );
    if (result.committed) btn.classList.add('correct');
  } catch (e) { console.warn('winner write failed:', e); }
}

function highlightWinnerCard(cardId) {
  const fieldEl = document.getElementById('field') || document.getElementById('cardField');
  if (!fieldEl) return;
  fieldEl.querySelectorAll('.card').forEach(card => {
    card.disabled = true;
    if (card.dataset.id === cardId) card.classList.add('correct');
  });
}

async function playerLeave() {
  if (playerState.antiCheat) { playerState.antiCheat.stop(); playerState.antiCheat = null; }
  playerState.unsub.forEach(fn => { try { fn(); } catch {} });
  playerState.unsub = [];
  const code = playerState.code;
  const uid  = playerState.uid;
  playerState.code = null; playerState.uid = null;
  playerState.currentRound = null; playerState.players = {};
  playerState.lastCardsKey = null; playerState.lastRoundNumber = 0;
  playerState.clickedThisRound = false; playerState.currentScreen = null;
  clearSession();
  if (code && uid) { try { await remove(ref(db, `rooms/${code}/players/${uid}`)); } catch {} }
  location.href = 'play.html?mode=multi';
}

// =========================================================
// INIT — Host (render DULU, baru auth)
// =========================================================
export async function initHost() {
  // 1. Render setup UI SEGERA — sebelum auth, agar selalu tampil
  hostRenderBookList();
  hostWireSetupControls();

  // 2. Auth Firebase (tidak memblokir UI)
  try {
    await signIn();
    myUid = auth.currentUser.uid;
    console.info('[host] auth OK, uid:', myUid);
  } catch (e) {
    console.error('[host] auth gagal:', e);
    toast('Gagal autentikasi. Periksa koneksi & Firebase.');
  }
}

function hostWireSetupControls() {
  const btnAll    = document.getElementById('btnAll');
  const btnNone   = document.getElementById('btnNone');
  const btnCreate = document.getElementById('btnCreateRoom');
  const maxInput  = document.getElementById('maxPlayersInput');

  if (btnAll) btnAll.onclick = () => {
    document.querySelectorAll('#bookList input[type="checkbox"]').forEach(c => { c.checked = true; });
    hostUpdatePool();
  };
  if (btnNone) btnNone.onclick = () => {
    document.querySelectorAll('#bookList input[type="checkbox"]').forEach(c => {
      c.checked = false;
      if (c.classList.contains('book-check')) c.indeterminate = false;
    });
    hostUpdatePool();
  };
  if (btnCreate) btnCreate.onclick = async () => {
    const pool = hostState._pendingPool || [];
    const maxPlayers = Math.max(2, Math.min(MAX_PLAYERS, Number(maxInput?.value) || 8));
    if (pool.length < MIN_POOL) { toast(`Pilih minimal ${MIN_POOL} kanji.`); return; }
    try {
      btnCreate.disabled = true;
      await hostCreateRoom(pool, maxPlayers);
    } catch (e) {
      console.error(e);
      toast(e.message || 'Gagal membuat room.');
      btnCreate.disabled = false;
    }
  };

  const btnStart   = document.getElementById('btnStartGame');
  const btnFinish  = document.getElementById('btnFinishGame');
  const btnReview  = document.getElementById('btnReviewFlags');
  const btnAgain   = document.getElementById('btnPlayAgain');
  const btnCopy    = document.getElementById('btnCopyCode');

  if (btnStart)  btnStart.onclick  = hostStartGame;
  if (btnFinish) btnFinish.onclick = hostFinishGame;
  if (btnReview) btnReview.onclick = hostShowReview;
  if (btnAgain)  btnAgain.onclick  = hostPlayAgain;
  if (btnCopy) btnCopy.onclick = () => {
    const txt = (document.getElementById('roomCode')?.textContent || '').trim();
    if (!txt || txt === '----') return;
    navigator.clipboard?.writeText(txt).then(
      () => toast('Kode disalin!'),
      () => toast('Gagal menyalin.')
    );
  };

  document.querySelectorAll('[data-disband]').forEach(btn => {
    btn.onclick = () => {
      if (confirm('Bubarkan room? Semua pemain akan dikeluarkan.')) hostDisband();
    };
  });

  document.getElementById('btnCloseReview')?.addEventListener('click', () => {
    document.getElementById('reviewDialog')?.close();
  });
}

// =========================================================
// INIT — Player
// =========================================================
export async function initPlayer({ prefilledRoom = null } = {}) {
  await signIn();
  myUid = auth.currentUser.uid;

  const session = readSession();
  if (session && Date.now() - session.savedAt < SESSION_TTL_MS) {
    try {
      playerState.name = session.name;
      await playerJoinRoom(session.code, session.name);
      return;
    } catch (e) {
      console.warn('session reconnect failed:', e);
      clearSession();
    }
  }
  playerShowJoinForm({ prefilledRoom });
}