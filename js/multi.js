// multi.js — Logika multiplayer: host (wasit) + player, Firebase RTDB v9 modular
//
// Changelog:
//   [+] Anti-cheat integration via './anti-cheat.js'
//   [+] Session reconnect via sessionStorage
//   [+] Flag reporting per-round (ditinjau HOST, bukan auto-kick)
//   [+] Winner race via runTransaction + rule !data.exists()
//   [+] Per-player field shuffle (anti-collusion posisi)
//   [+] PENALTI OTOMATIS: flag kategori curang → −1 poin (skor boleh negatif)
//   [+] Toast peringatan di sisi pemain yang dihukum
//   [~] Rekonstruksi penuh blok host & player

import { firebaseConfig } from './firebase-config.js';
import { KANJI, STRUCTURE } from './data.js';
import { buildPool } from './core.js';
import { createAntiCheat } from './anti-cheat.js';
import { applyPenalty, isPenaltyType, PENALTY_PER_FLAG } from './penalty.js';

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
const MAX_PLAYERS        = 8;
const FIELD_SIZE         = 20;
const MIN_POOL           = 8;
const ROUND_TIMEOUT_MS   = 15000;
const NEXT_ROUND_DELAY   = 2500;
const ROOM_CODE_LEN      = 4;
const ROOM_CODE_CHARS    = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const SESSION_KEY        = 'karuta_session_v1';
const SESSION_TTL_MS     = 6 * 60 * 60 * 1000; // 6 jam

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
      signInAnonymously(auth)
        .then(c => resolve(c.user))
        .catch(reject);
    });
  });
}

// =========================================================
// Utils
// =========================================================
const delay = ms => new Promise(r => setTimeout(r, ms));

function shuffle(arr) {
  const a = arr.slice();
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

function showFirstExistingScreen(...ids) {
  for (const id of ids) {
    if (document.getElementById(id)) {
      showScreen(id);
      return true;
    }
  }
  return false;
}

// =========================================================
// Reading lookup toleran variasi field di data.js
// =========================================================
function getReading(card) {
  if (!card) return '';
  if (typeof card.reading    === 'string' && card.reading)    return card.reading;
  if (typeof card.yomi       === 'string' && card.yomi)       return card.yomi;
  if (typeof card.hiragana   === 'string' && card.hiragana)   return card.hiragana;
  if (typeof card.kana       === 'string' && card.kana)       return card.kana;
  if (typeof card.furigana   === 'string' && card.furigana)   return card.furigana;
  if (Array.isArray(card.reading)  && card.reading.length)  return card.reading.join('、');
  if (Array.isArray(card.readings) && card.readings.length) return card.readings.join('、');
  if (Array.isArray(card.yomi)     && card.yomi.length)     return card.yomi.join('、');
  const on  = card.readings?.on  || card.reading?.on;
  const kun = card.readings?.kun || card.reading?.kun;
  if (on || kun) return [on, kun].filter(Boolean).join('、');
  return '';
}

// =========================================================
// Prompt / Score / Field rendering
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
      ? `<span class="warn-badge" title="Aktivitas mencurigakan terdeteksi">⚠ ${count}</span>`
      : '';
    return `
      <div class="chip ${id === myUidArg ? 'you' : ''} ${count > 0 ? 'suspicious' : ''} ${negative ? 'negative' : ''}">
        <span class="cname">${escHtml(p.name || '?')}${warn}</span>
        <span class="cpts">${score}</span>
      </div>
    `;
  }).join('');
}

function renderField(fieldEl, cardIds) {
  if (!fieldEl) {
    console.warn('renderField: field element not found');
    return;
  }
  fieldEl.innerHTML = '';

  // Per-player shuffle
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
// PLAYER STATE (deklarasi lebih awal agar dipakai saveSession/reportFlag)
// =========================================================
let playerState = {
  code: null,
  uid: null,
  name: '',
  isHost: false,
  currentRound: null,
  players: {},
  settings: null,
  lastCardsKey: null,
  lastRoundNumber: 0,
  clickedThisRound: false,
  currentScreen: null,
  unsub: [],
  antiCheat: null,
};

// =========================================================
// Session (auto-reconnect)
// =========================================================
function saveSession() {
  if (!playerState.code || !playerState.name) return;
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      code: playerState.code,
      name: playerState.name,
      savedAt: Date.now(),
    }));
  } catch {}
}

function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch {}
}

function readSession() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
  } catch { return null; }
}

// =========================================================
// Flag reporting + PENALTI OTOMATIS
// =========================================================
async function reportPlayerFlag(type, extra = {}) {
  const code = playerState.code;
  const uid  = playerState.uid;
  if (!code || !uid) return;
  const round = Number(extra.round) || playerState.currentRound?.number || 0;
  const key = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // 1. Catat flag ke Firebase (untuk ditinjau host)
  set(ref(db, `rooms/${code}/flags/${uid}/${key}`), {
    type: String(type).slice(0, 64),
    round,
    at: Date.now(),
  }).catch(err => console.warn('flag write failed:', err));

  // 2. Penalti otomatis hanya untuk tipe kategori curang
  if (!isPenaltyType(type)) return;

  try {
    const { committed, newScore } = await applyPenalty(db, code, uid, PENALTY_PER_FLAG);
    if (committed) {
      toast(`⚠ Kecurangan terdeteksi! −${PENALTY_PER_FLAG} poin (skor: ${newScore})`, 'warn');
    }
  } catch (err) {
    console.warn('penalty transaction failed:', err);
  }
}

// =========================================================
// HOST STATE
// =========================================================
let hostState = {
  code: null,
  uid: null,
  pool: [],
  used: new Set(),
  roundNumber: 0,
  roundTimer: null,
  tickInterval: null,
  unsubPlayers: null,
  unsubRound: null,
  unsubMeta: null,
  unsubFlags: null,
  flags: {},
  playersCache: {},
  processedRounds: new Set(),
  currentRound: null,
  metaStatus: 'lobby',
  maxPlayers: 8,
  finished: false,
};

let hostLobbyRenderFn = null;

function clearHostState() {
  if (hostState.unsubPlayers) hostState.unsubPlayers();
  if (hostState.unsubRound) hostState.unsubRound();
  if (hostState.unsubMeta) hostState.unsubMeta();
  if (hostState.unsubFlags) hostState.unsubFlags();
  if (hostState.roundTimer) clearTimeout(hostState.roundTimer);
  if (hostState.tickInterval) clearInterval(hostState.tickInterval);

  hostState.code = null;
  hostState.uid = null;
  hostState.pool = [];
  hostState.used = new Set();
  hostState.roundNumber = 0;
  hostState.roundTimer = null;
  hostState.tickInterval = null;
  hostState.unsubPlayers = null;
  hostState.unsubRound = null;
  hostState.unsubMeta = null;
  hostState.unsubFlags = null;
  hostState.flags = {};
  hostState.playersCache = {};
  hostState.processedRounds = new Set();
  hostState.currentRound = null;
  hostState.metaStatus = 'lobby';
  hostState.finished = false;
}

// =========================================================
// HOST — Create Room
// =========================================================
async function hostCreateRoom(selectedIds, maxPlayers = 8) {
  await signIn();
  myUid = auth.currentUser.uid;

  let code = null;
  for (let i = 0; i < 12; i++) {
    const candidate = genRoomCode();
    const snap = await get(ref(db, `rooms/${candidate}/meta`));
    if (!snap.exists()) { code = candidate; break; }
  }
  if (!code) throw new Error('Gagal membuat kode room. Coba lagi.');

  clearHostState();

  const roomData = {
    meta: {
      status: 'lobby',
      hostUid: myUid,
      createdAt: serverTimestamp(),
      fieldSize: FIELD_SIZE,
      maxPlayers: Math.max(2, Math.min(15, Number(maxPlayers) || 8))
    },
    players: {
      [myUid]: {
        name: 'Wasit (Host)',
        score: 0,
        isHost: true,
        online: true,
        joinedAt: serverTimestamp()
      }
    },
    settings: { pool: selectedIds }
  };
  await set(ref(db, `rooms/${code}`), roomData);
  await onDisconnect(ref(db, `rooms/${code}/players/${myUid}/online`)).set(false);

  hostState.code = code;
  hostState.uid = myUid;
  hostState.pool = shuffle(selectedIds.slice());
  hostState.used = new Set();
  hostState.roundNumber = 0;
  hostState.playersCache = roomData.players;
  hostState.flags = {};
  hostState.finished = false;
  hostState.metaStatus = 'lobby';
  hostState.maxPlayers = roomData.meta.maxPlayers;

  // Tampilkan kode di setup screen
  const roomInfo = document.getElementById('roomInfo');
  const roomCodeEl = document.getElementById('roomCode');
  if (roomInfo) roomInfo.hidden = false;
  if (roomCodeEl) roomCodeEl.textContent = code;

  const copyBtn = document.getElementById('btnCopyCode');
  if (copyBtn) {
    copyBtn.onclick = () => {
      navigator.clipboard?.writeText(code).then(
        () => toast('Kode disalin!'),
        () => toast('Gagal menyalin')
      );
    };
  }

  // Wire review dialog close
  document.getElementById('btnCloseReview')?.addEventListener('click', () => {
    document.getElementById('reviewDialog')?.close();
  });

  // Watch room state
  hostWatchPlayers();
  hostWatchMeta();
  hostWatchFlags();

  // Auto-navigate ke lobby setelah jeda (agar host sempat salin kode)
  setTimeout(() => {
    hostShowLobby();
  }, 2500);
}

// =========================================================
// HOST — Watchers
// =========================================================
function hostWatchPlayers() {
  if (hostState.unsubPlayers) hostState.unsubPlayers();
  const playersRef = ref(db, `rooms/${hostState.code}/players`);
  hostState.unsubPlayers = onValue(playersRef, (snap) => {
    hostState.playersCache = snap.val() || {};
    if (hostLobbyRenderFn) hostLobbyRenderFn();
    const scoreEl = document.getElementById('hostScores');
    if (scoreEl) renderScores(scoreEl, hostState.playersCache, hostState.uid, hostState.flags);

    const startBtn = document.getElementById('btnStartGame');
    if (startBtn) {
      const nonHost = Object.values(hostState.playersCache).filter(p => !p.isHost);
      startBtn.disabled = nonHost.length < 1 || hostState.metaStatus === 'playing';
    }
  });
}

function hostWatchMeta() {
  if (hostState.unsubMeta) hostState.unsubMeta();
  const metaRef = ref(db, `rooms/${hostState.code}/meta`);
  hostState.unsubMeta = onValue(metaRef, (snap) => {
    const meta = snap.val();
    if (!meta) return;
    hostState.metaStatus = meta.status;
    hostState.maxPlayers = meta.maxPlayers || 8;

    if (meta.status === 'finished') {
      hostState.finished = true;
      hostShowResult();
    }
  });
}

function hostWatchRound() {
  if (hostState.unsubRound) hostState.unsubRound();
  const roundRef = ref(db, `rooms/${hostState.code}/currentRound`);
  hostState.unsubRound = onValue(roundRef, (snap) => {
    const round = snap.val();
    if (!round) {
      hostState.currentRound = null;
      hostRenderPicker();
      return;
    }

    const prev = hostState.currentRound;
    hostState.currentRound = round;

    // Ronde baru
    if (!prev || prev.number !== round.number) {
      renderPrompt(document.getElementById('hostMeaning'), round.targetReading, round.targetMeaning);
      if (hostState.playersCache) {
        renderScores(
          document.getElementById('hostScores'),
          hostState.playersCache, hostState.uid, hostState.flags
        );
      }
    }

    // Winner muncul → proses
    if (round.winner && !round.processed && !hostState.processedRounds.has(round.number)) {
      hostProcessWinner(round);
    }

    hostRenderPicker();
  });
}

function hostWatchFlags() {
  if (hostState.unsubFlags) hostState.unsubFlags();
  const flagsRef = ref(db, `rooms/${hostState.code}/flags`);
  hostState.unsubFlags = onValue(flagsRef, (snap) => {
    hostState.flags = snap.val() || {};
    hostRenderFlags();
    // Refresh score display agar badge & chip.negative akurat
    if (hostState.playersCache) {
      renderScores(
        document.getElementById('hostScores'),
        hostState.playersCache, hostState.uid, hostState.flags
      );
    }
  });
}

// =========================================================
// HOST — Screens
// =========================================================
function hostShowLobby() {
  showScreen('screen-host-lobby');
  hostLobbyRenderFn = hostRenderLobby;
  hostRenderLobby();
}

function hostShowGame() {
  showScreen('screen-host-game');
  if (!hostState.unsubRound) hostWatchRound();
  hostRenderScores();
  hostRenderPicker();
}

function hostShowResult() {
  showScreen('screen-host-result');
  hostRenderResult();
}

// =========================================================
// HOST — Lobby / Book list rendering
// =========================================================
function hostRenderBookList() {
  const container = document.getElementById('bookList');
  if (!container) return;

  container.innerHTML = Object.entries(STRUCTURE).map(([book, chapters]) => `
    <div class="book-item">
      <label class="book-label">
        <input type="checkbox" data-book="${escHtml(book)}">
        <span>${escHtml(book)}</span>
      </label>
      <div class="chapter-list">
        ${chapters.map(ch => `
          <label class="chapter-label">
            <input type="checkbox" data-book="${escHtml(book)}" data-chapter="${escHtml(ch)}">
            <span>${escHtml(ch)}</span>
          </label>
        `).join('')}
      </div>
    </div>
  `).join('');

  hostWireBookEvents();
  hostUpdatePool();
}

function hostWireBookEvents() {
  const bookList = document.getElementById('bookList');
  if (!bookList) return;

  bookList.querySelectorAll('input[data-book]').forEach(inp => {
    inp.addEventListener('change', () => {
      const book = inp.dataset.book;
      const chapter = inp.dataset.chapter || null;

      if (chapter === null) {
        // Toggle buku: sinkronkan semua chapter
        bookList.querySelectorAll(`input[data-chapter][data-book="${CSS.escape(book)}"]`)
          .forEach(ch => { ch.checked = inp.checked; });
      } else {
        // Sinkronkan parent book
        const parentBook = bookList.querySelector(`input[data-book="${CSS.escape(book)}"]:not([data-chapter])`);
        const chapters = bookList.querySelectorAll(`input[data-chapter][data-book="${CSS.escape(book)}"]`);
        const allOn = Array.from(chapters).every(c => c.checked);
        if (parentBook) parentBook.checked = allOn;
      }
      hostUpdatePool();
    });
  });
}

function hostUpdatePool() {
  const bookList = document.getElementById('bookList');
  const infoEl = document.getElementById('poolInfo');
  const btnCreate = document.getElementById('btnCreateRoom');
  if (!bookList) return;

  const chapters = Array.from(bookList.querySelectorAll('input[data-chapter]:checked'))
    .map(i => `${i.dataset.book}::${i.dataset.chapter}`);
  const books = Array.from(bookList.querySelectorAll('input[data-book]:not([data-chapter]):checked'))
    .map(i => i.dataset.book);

  const pool = buildPool(books, chapters);
  hostState._pendingPool = pool.map(k => k.id);

  if (infoEl) infoEl.textContent = `${pool.length} kanji`;
  if (btnCreate) btnCreate.disabled = pool.length < MIN_POOL;
}

function hostRenderLobby() {
  const roomCodeEl = document.getElementById('hostRoomCode');
  const countEl = document.getElementById('hostPlayerCount');
  const maxEl = document.getElementById('hostMaxPlayers');
  const listEl = document.getElementById('hostPlayerList');
  const startBtn = document.getElementById('btnStartGame');

  if (roomCodeEl) roomCodeEl.textContent = hostState.code || '----';

  const players = hostState.playersCache || {};
  const entries = Object.entries(players);
  const nonHost = entries.filter(([_, p]) => !p.isHost);

  if (countEl) countEl.textContent = entries.length;
  if (maxEl) maxEl.textContent = hostState.maxPlayers || 8;

  if (listEl) {
    listEl.innerHTML = entries.map(([uid, p]) => `
      <li class="lobby-item ${uid === hostState.uid ? 'you' : ''} ${p.online ? '' : 'offline'}">
        <span class="player-name">${escHtml(p.name || '?')}${p.isHost ? ' 👑' : ''}</span>
        ${!p.isHost ? `<button class="btn-kick" data-kick="${escHtml(uid)}" type="button">Kick</button>` : ''}
      </li>
    `).join('');

    listEl.querySelectorAll('[data-kick]').forEach(btn => {
      btn.addEventListener('click', () => hostKickPlayer(btn.dataset.kick));
    });
  }

  if (startBtn) {
    startBtn.disabled = nonHost.length < 1 || hostState.metaStatus === 'playing';
  }
}

// =========================================================
// HOST — Kick
// =========================================================
async function hostKickPlayer(uid) {
  if (!hostState.code || !uid) return;
  try {
    await remove(ref(db, `rooms/${hostState.code}/players/${uid}`));
    toast('Pemain dikeluarkan.');
  } catch (e) {
    console.error(e);
    toast('Gagal mengeluarkan pemain.');
  }
}

// =========================================================
// HOST — Start game / Round lifecycle
// =========================================================
async function hostStartGame() {
  const nonHost = Object.values(hostState.playersCache || {}).filter(p => !p.isHost && p.online);
  if (nonHost.length < 1) {
    toast('Butuh minimal 1 pemain (non-host) untuk memulai.');
    return;
  }

  try {
    await update(ref(db, `rooms/${hostState.code}/meta`), {
      status: 'playing',
      startedAt: serverTimestamp(),
    });
  } catch (e) {
    console.error(e);
    toast('Gagal memulai permainan.');
    return;
  }

  if (!hostState.unsubRound) hostWatchRound();

  hostShowGame();
  hostStartTicker();

  const statusEl = document.getElementById('hostStatus');
  if (statusEl) statusEl.textContent = 'Pilih kanji pertama untuk jadi soal…';
}

function hostStartTicker() {
  if (hostState.tickInterval) return;
  hostState.tickInterval = setInterval(() => {
    const round = hostState.currentRound;
    if (!round) return;
    if (round.processed || round.expired) return;

    const elapsed = Date.now() - (round.startedAt || Date.now());
    const remainSec = Math.max(0, Math.ceil((ROUND_TIMEOUT_MS - elapsed) / 1000));

    const tag = document.getElementById('hostRemainTag');
    if (tag) tag.innerHTML = `SISA<br>${remainSec}`;

    if (remainSec === 0 && !round.winner) {
      hostTimeoutRound(round);
    }
  }, 250);
}

function hostRenderPicker() {
  const picker = document.getElementById('kanjiPicker');
  if (!picker) return;

  const round = hostState.currentRound;
  const roundActive = round && !round.processed && !round.expired;

  const available = hostState.pool.filter(id => !hostState.used.has(id));

  if (available.length === 0) {
    picker.innerHTML = '<p class="hint" style="text-align:center;padding:20px;">Semua kanji sudah dipakai. Akhiri permainan atau bubarkan room.</p>';
    return;
  }

  picker.innerHTML = available.map(id => {
    const k = KANJI.find(x => x.id === id);
    if (!k) return '';
    return `<button type="button" class="kanji-btn" data-id="${escHtml(id)}" ${roundActive ? 'disabled' : ''}>
      <span class="kanji">${escHtml(k.kanji)}</span>
      <span class="reading">${escHtml(k.reading)}</span>
      <span class="meaning">${escHtml(k.meaning)}</span>
    </button>`;
  }).join('');

  picker.querySelectorAll('.kanji-btn').forEach(btn => {
    btn.addEventListener('click', () => hostStartRound(btn.dataset.id));
  });
}

async function hostStartRound(targetId) {
  if (hostState.currentRound && !hostState.currentRound.processed && !hostState.currentRound.expired) {
    toast('Tunggu ronde sebelumnya selesai.');
    return;
  }

  const target = KANJI.find(k => k.id === targetId);
  if (!target) return;

  const available = hostState.pool.filter(id => !hostState.used.has(id) && id !== targetId);
  const distractorCount = Math.min(FIELD_SIZE - 1, available.length);
  const distractors = shuffle(available).slice(0, distractorCount);
  const cards = [targetId, ...distractors];

  hostState.roundNumber += 1;
  const round = {
    number: hostState.roundNumber,
    targetMeaning: target.meaning,
    targetReading: target.reading,
    cards,
    remaining: cards.length,
    startedAt: Date.now(),
    processed: false,
    expired: false,
  };

  hostState.used.add(targetId);
  hostState.currentRound = round;

  try {
    await update(ref(db, `rooms/${hostState.code}`), {
      targetId,
      currentRound: round,
    });
  } catch (e) {
    console.error('start round failed:', e);
    toast('Gagal memulai ronde.');
    return;
  }

  const statusEl = document.getElementById('hostStatus');
  if (statusEl) statusEl.textContent = `Soal: ${target.meaning} — cari kanji yang cocok!`;
}

async function hostProcessWinner(round) {
  const winnerUid = round.winner?.uid;
  if (!winnerUid) return;
  if (hostState.processedRounds.has(round.number)) return;
  hostState.processedRounds.add(round.number);

  try {
    const scoreRef = ref(db, `rooms/${hostState.code}/players/${winnerUid}/score`);
    await runTransaction(scoreRef, (cur) => (Number(cur) || 0) + 1);
  } catch (e) {
    console.warn('score increment failed:', e);
  }

  try {
    await update(ref(db, `rooms/${hostState.code}/currentRound`), { processed: true });
  } catch (e) {
    console.warn('mark processed failed:', e);
  }

  const winner = hostState.playersCache[winnerUid];
  const statusEl = document.getElementById('hostStatus');
  if (statusEl) statusEl.textContent = `${winner?.name || '?'} benar! +1 poin`;

  setTimeout(() => {
    hostState.currentRound = null;
    hostRenderPicker();
    if (statusEl) statusEl.textContent = 'Pilih kanji untuk soal berikutnya…';
  }, NEXT_ROUND_DELAY);
}

async function hostTimeoutRound(round) {
  if (hostState.processedRounds.has(round.number)) return;
  hostState.processedRounds.add(round.number);

  try {
    await update(ref(db, `rooms/${hostState.code}/currentRound`), { expired: true });
  } catch (e) {
    console.warn('mark expired failed:', e);
  }

  const statusEl = document.getElementById('hostStatus');
  if (statusEl) statusEl.textContent = 'Waktu habis — tidak ada yang menjawab.';

  setTimeout(() => {
    hostState.currentRound = null;
    hostRenderPicker();
    if (statusEl) statusEl.textContent = 'Pilih kanji untuk soal berikutnya…';
  }, NEXT_ROUND_DELAY);
}

// =========================================================
// HOST — Score / Result rendering
// =========================================================
function hostRenderScores() {
  renderScores(
    document.getElementById('hostScores'),
    hostState.playersCache, hostState.uid, hostState.flags
  );
}

function hostRenderResult() {
  const listEl = document.getElementById('hostResultList');
  if (!listEl) return;
  const list = Object.entries(hostState.playersCache || {})
    .filter(([_, p]) => !p.isHost)
    .sort((a, b) => (Number(b[1].score) || 0) - (Number(a[1].score) || 0));

  listEl.innerHTML = list.map(([uid, p], i) => {
    const score = Number(p.score) || 0;
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    return `
      <div class="result-row ${score < 0 ? 'negative' : ''}">
        <span class="rank">${medal}</span>
        <span class="name">${escHtml(p.name || '?')}</span>
        <span class="pts ${score < 0 ? 'negative' : ''}">${score}</span>
      </div>
    `;
  }).join('');
}

// =========================================================
// HOST — Finish / Play again / Disband
// =========================================================
async function hostFinishGame() {
  if (!hostState.code) return;
  try {
    await update(ref(db, `rooms/${hostState.code}/meta`), { status: 'finished' });
    hostState.finished = true;
    hostShowResult();
  } catch (e) {
    console.error(e);
    toast('Gagal mengakhiri permainan.');
  }
}

async function hostPlayAgain() {
  const code = hostState.code;
  if (!code) return;

  const updates = {
    'meta/status': 'lobby',
    'meta/startedAt': null,
    'currentRound': null,
    'targetId': null,
    'flags': null,
  };

  for (const uid of Object.keys(hostState.playersCache || {})) {
    if (!hostState.playersCache[uid].isHost) {
      updates[`players/${uid}/score`] = 0;
    }
  }

  try {
    await update(ref(db, `rooms/${code}`), updates);
  } catch (e) {
    console.error(e);
    toast('Gagal reset permainan.');
    return;
  }

  hostState.used = new Set();
  hostState.roundNumber = 0;
  hostState.currentRound = null;
  hostState.processedRounds = new Set();
  hostState.flags = {};
  hostState.finished = false;

  hostShowLobby();
}

async function hostDisband() {
  if (!hostState.code) {
    showFirstExistingScreen('screen-host-setup', 'screen-mode');
    return;
  }
  try {
    await remove(ref(db, `rooms/${hostState.code}`));
  } catch (e) {
    console.warn('disband failed:', e);
  }
  clearHostState();
  location.href = 'index.html';
}

// =========================================================
// HOST — Flag review
// =========================================================
function hostShowReview() {
  const dialog = document.getElementById('reviewDialog');
  if (!dialog) return;
  hostRenderFlags();
  if (!dialog.open) {
    try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); }
  }
}

function hostRenderFlags() {
  const content = document.getElementById('reviewContent');
  const btn = document.getElementById('btnReviewFlags');
  const count = document.getElementById('flagCount');

  const flags = hostState.flags || {};
  let totalFlags = 0;
  const byPlayer = {};
  for (const [uid, playerFlags] of Object.entries(flags)) {
    const list = Object.values(playerFlags || {});
    if (list.length) {
      byPlayer[uid] = list;
      totalFlags += list.length;
    }
  }

  if (btn) btn.hidden = totalFlags === 0;
  if (count) count.textContent = totalFlags;

  if (!content) return;

  if (totalFlags === 0) {
    content.innerHTML = '<p class="hint">Belum ada aktivitas mencurigakan.</p>';
    return;
  }

  content.innerHTML = Object.entries(byPlayer).map(([uid, list]) => {
    const player = hostState.playersCache?.[uid];
    const name = player?.name || uid.slice(0, 6);
    const score = Number(player?.score) || 0;
    const sorted = list.slice().sort((a, b) => (b.at || 0) - (a.at || 0));
    const details = sorted.slice(0, 6).map(f =>
      `${escHtml(f.type)} <span style="opacity:.6">(r${f.round})</span>`
    ).join('<br>');
    const more = sorted.length > 6 ? `<div style="opacity:.6">+${sorted.length - 6} lainnya</div>` : '';
    const scoreTag = score < 0 ? ` <span style="color:#b71c1c">(${score})</span>` : '';
    return `
      <div class="flag-row">
        <div>
          <div class="fr-name">${escHtml(name)}${scoreTag}</div>
          <div class="hint" style="margin-top:4px;">${sorted.length} pelanggaran</div>
        </div>
        <div class="fr-detail">${details}${more}</div>
      </div>
    `;
  }).join('');
}

// =========================================================
// PLAYER — Join / Screen navigation
// =========================================================
function playerShowScreen(id) {
  showScreen(id);
  playerState.currentScreen = id;
}

function playerShowJoinForm({ prefilledRoom = null } = {}) {
  playerShowScreen('screen-multi-join');
  const codeInput = document.getElementById('joinCode');
  const nameInput = document.getElementById('joinName');
  const btnJoin = document.getElementById('btnJoin');

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
      name,
      score: 0,
      isHost: false,
      online: true,
      joinedAt: serverTimestamp(),
    });
    await onDisconnect(ref(db, `rooms/${code}/players/${myUid}/online`)).set(false);
  } else {
    // Reconnect
    await set(ref(db, `rooms/${code}/players/${myUid}/online`), true);
  }

  playerState.code = code;
  playerState.uid = myUid;
  playerState.name = existing?.name || name;
  playerState.isHost = false;

  saveSession();

  // Aktifkan anti-cheat
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

// =========================================================
// PLAYER — Watchers
// =========================================================
function playerWatchRoom() {
  playerState.unsub.forEach(fn => fn());
  playerState.unsub = [];

  const code = playerState.code;

  // Meta: deteksi room dibubarkan / permainan selesai
  const metaRef = ref(db, `rooms/${code}/meta`);
  playerState.unsub.push(onValue(metaRef, (snap) => {
    const meta = snap.val();
    if (!meta) {
      toast('Room dibubarkan.');
      playerLeave();
      return;
    }
    if (meta.status === 'finished') {
      playerShowResult();
    }
  }));

  // Players: update lobby & scores
  const playersRef = ref(db, `rooms/${code}/players`);
  playerState.unsub.push(onValue(playersRef, (snap) => {
    const players = snap.val() || {};
    playerState.players = players;
    if (!players[myUid]) {
      // Pemain di-kick / keluar
      toast('Anda dikeluarkan dari room.');
      playerLeave();
      return;
    }
    if (playerState.currentScreen === 'screen-player-lobby') playerRenderLobby();
    if (playerState.currentScreen === 'screen-player-game') playerRenderScores();
  }));

  // CurrentRound: tampilkan game / balik ke lobby
  const roundRef = ref(db, `rooms/${code}/currentRound`);
  playerState.unsub.push(onValue(roundRef, (snap) => {
    const round = snap.val();
    playerState.currentRound = round;
    if (round) {
      playerShowGame();
      playerRenderGame();
    } else {
      // Tidak ada ronde aktif — kembali ke lobby (mis. setelah host play again)
      if (playerState.currentScreen === 'screen-player-game') {
        playerShowLobby();
      }
    }
  }));

  playerShowLobby();
}

// =========================================================
// PLAYER — Screens
// =========================================================
function playerShowLobby() {
  playerShowScreen('screen-player-lobby');
  playerRenderLobby();
}

function playerShowGame() {
  if (playerState.currentScreen !== 'screen-player-game') {
    playerShowScreen('screen-player-game');
    playerState.lastCardsKey = null;
  }
}

function playerShowResult() {
  playerShowScreen('screen-player-result');
  playerRenderResult();
}

// =========================================================
// PLAYER — Rendering
// =========================================================
function playerRenderLobby() {
  const roomEl = document.getElementById('playerRoomCode');
  if (roomEl) roomEl.textContent = playerState.code || '----';

  const listEl = document.getElementById('playerList');
  const countEl = document.getElementById('playerCount');
  if (listEl) {
    const entries = Object.entries(playerState.players || {});
    if (countEl) countEl.textContent = entries.length;
    listEl.innerHTML = entries.map(([uid, p]) => `
      <li class="lobby-item ${uid === myUid ? 'you' : ''} ${p.online ? '' : 'offline'}">
        <span class="player-name">${escHtml(p.name || '?')}${p.isHost ? ' 👑' : ''}</span>
      </li>
    `).join('');
  }
}

function playerRenderGame() {
  const round = playerState.currentRound;
  if (!round) return;

  // Reset per-round state jika nomor ronde baru
  if (playerState.lastRoundNumber !== round.number) {
    playerState.lastRoundNumber = round.number;
    playerState.clickedThisRound = false;
    playerState.lastCardsKey = null;
  }

  // Prompt
  renderPrompt(document.getElementById('meaning'), round.targetReading, round.targetMeaning);

  // Field (hanya re-render jika kartu berubah)
  const cardsKey = (round.cards || []).join(',');
  if (cardsKey !== playerState.lastCardsKey) {
    playerState.lastCardsKey = cardsKey;
    const fieldEl = document.getElementById('field') || document.getElementById('cardField');
    renderField(fieldEl, round.cards || []);
    wireFieldClicks();
  }

  // Skor
  playerRenderScores();

  // Highlight winner jika ada
  if (round.winner) {
    highlightWinnerCard(round.winner.cardId);
  }
}

function playerRenderScores() {
  const scoreEl = document.getElementById('scores') || document.getElementById('playerScores');
  if (!scoreEl) return;
  renderScores(scoreEl, playerState.players, myUid, {});
}

function playerRenderResult() {
  const listEl = document.getElementById('playerResultList');
  if (!listEl) return;
  const list = Object.entries(playerState.players || {})
    .filter(([_, p]) => !p.isHost)
    .sort((a, b) => (Number(b[1].score) || 0) - (Number(a[1].score) || 0));

  listEl.innerHTML = list.map(([uid, p], i) => {
    const score = Number(p.score) || 0;
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    return `
      <div class="result-row ${uid === myUid ? 'you' : ''} ${score < 0 ? 'negative' : ''}">
        <span class="rank">${medal}</span>
        <span class="name">${escHtml(p.name || '?')}</span>
        <span class="pts ${score < 0 ? 'negative' : ''}">${score}</span>
      </div>
    `;
  }).join('');
}

// =========================================================
// PLAYER — Card click & winner write
// =========================================================
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

  // Validasi lokal: cocokkan prompt dengan data KANJI untuk dapat targetId
  const target = KANJI.find(k =>
    k.meaning === round.targetMeaning && k.reading === round.targetReading
  );

  if (!target || cardId !== target.id) {
    // Salah klik → feedback visual saja
    btn.classList.add('wrong');
    setTimeout(() => btn.classList.remove('wrong'), 400);
    return;
  }

  // Benar → coba tulis winner (race-safe via transaction)
  playerState.clickedThisRound = true;
  try {
    const winnerRef = ref(db, `rooms/${playerState.code}/currentRound/winner`);
    const result = await runTransaction(winnerRef, (cur) => {
      if (cur && cur.uid) return cur; // sudah ada pemenang — abort
      return { uid: myUid, cardId, round: round.number };
    });
    if (result.committed) {
      btn.classList.add('correct');
    }
    // Jika tidak committed: pemain lain menang duluan — winner akan tampil via watch
  } catch (e) {
    console.warn('winner write failed:', e);
    // Kemungkinan permission denied karena winner sudah ditulis pemain lain
  }
}

function highlightWinnerCard(cardId) {
  const fieldEl = document.getElementById('field') || document.getElementById('cardField');
  if (!fieldEl) return;
  fieldEl.querySelectorAll('.card').forEach(card => {
    card.disabled = true;
    if (card.dataset.id === cardId) card.classList.add('correct');
  });
}

// =========================================================
// PLAYER — Leave
// =========================================================
async function playerLeave() {
  if (playerState.antiCheat) playerState.antiCheat.stop();
  playerState.unsub.forEach(fn => fn());
  playerState.unsub = [];

  const code = playerState.code;
  const uid  = playerState.uid;
  playerState.code = null;
  playerState.uid = null;
  playerState.currentRound = null;
  playerState.players = {};

  clearSession();

  if (code && uid) {
    try {
      await remove(ref(db, `rooms/${code}/players/${uid}`));
    } catch {}
  }

  // Kembali ke form join
  location.href = 'play.html?mode=multi';
}

// =========================================================
// INIT — Host
// =========================================================
export async function initHost() {
  await signIn();
  myUid = auth.currentUser.uid;

  // Render book list + wire setup buttons
  hostRenderBookList();

  const btnAll = document.getElementById('btnAll');
  const btnNone = document.getElementById('btnNone');
  const btnCreate = document.getElementById('btnCreateRoom');
  const maxInput = document.getElementById('maxPlayersInput');
  const btnStart = document.getElementById('btnStartGame');
  const btnFinish = document.getElementById('btnFinishGame');
  const btnReview = document.getElementById('btnReviewFlags');
  const btnPlayAgain = document.getElementById('btnPlayAgain');

  if (btnAll) btnAll.onclick = () => {
    document.querySelectorAll('#bookList input[type="checkbox"]').forEach(c => { c.checked = true; });
    hostUpdatePool();
  };
  if (btnNone) btnNone.onclick = () => {
    document.querySelectorAll('#bookList input[type="checkbox"]').forEach(c => { c.checked = false; });
    hostUpdatePool();
  };
  if (btnCreate) btnCreate.onclick = async () => {
    const pool = hostState._pendingPool || [];
    const maxPlayers = Math.max(2, Math.min(15, Number(maxInput?.value) || 8));
    if (pool.length < MIN_POOL) {
      toast(`Pilih minimal ${MIN_POOL} kanji.`);
      return;
    }
    try {
      btnCreate.disabled = true;
      await hostCreateRoom(pool, maxPlayers);
    } catch (e) {
      console.error(e);
      toast(e.message || 'Gagal membuat room.');
      btnCreate.disabled = false;
    }
  };
  if (btnStart) btnStart.onclick = hostStartGame;
  if (btnFinish) btnFinish.onclick = hostFinishGame;
  if (btnReview) btnReview.onclick = hostShowReview;
  if (btnPlayAgain) btnPlayAgain.onclick = hostPlayAgain;

  document.querySelectorAll('[data-disband]').forEach(btn => {
    btn.onclick = () => {
      if (confirm('Bubarkan room? Semua pemain akan dikeluarkan.')) hostDisband();
    };
  });

  // Wire close review dialog
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

  // Coba reconnect via session
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
