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

// =============// multi.js — Logika multiplayer: host (wasit) + player, Firebase RTDB v9 modular
//
// Changelog:
//   [+] Anti-cheat integration via './anti-cheat.js'
//   [+] Session reconnect via sessionStorage
//   [+] Flag reporting per-round (ditinjau HOST, bukan auto-kick)
//   [+] Winner race via runTransaction + rule !data.exists()
//   [+] Per-player field shuffle (anti-collusion posisi)
//   [+] PENALTI OTOMATIS: flag kategori curang → −1 poin (skor boleh negatif)
//   [+] Toast peringatan di sisi pemain yang dihukum
//   [~] Sinkronisasi ID screen/element player dengan play.html
//   [~] Guard metaStatus='finished' agar tidak salah tampil di game screen
//   [~] Wire #btnLeaveGame → playerLeave()

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
const SESSION_TTL_MS     = 6 * 60 * 60 * 1000;

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
// Reading lookup
// =========================================================
function getReading(card) {
  if (!card) return '';
  if (typeof card.reading === 'string' && card.reading) return card.reading;
  if (typeof card.yomi    === 'string' && card.yomi)    return card.yomi;
  if (Array.isArray(card.reading) && card.reading.length) return card.reading.join('、');
  return '';
}

// =========================================================
// Render: prompt / scores / field
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
  metaStatus: 'lobby',          // ← baru
  unsub: [],
  antiCheat: null,
};

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
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); }
  catch { return null; }
}

// =========================================================
// Flag reporting + PENALTI
// =========================================================
async function reportPlayerFlag(type, extra = {}) {
  const code = playerState.code;
  const uid  = playerState.uid;
  if (!code || !uid) return;
  const round = Number(extra.round) || playerState.currentRound?.number || 0;
  const key = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  set(ref(db, `rooms/${code}/flags/${uid}/${key}`), {
    type: String(type).slice(0, 64),
    round,
    at: Date.now(),
  }).catch(err => console.warn('flag write failed:', err));

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
// HOST STATE + fungsi host (TIDAK BERUBAH — ringkas di sini)
// =========================================================
// [Untuk menghemat ruang: seluruh fungsi HOST identik dengan versi Anda
//  yang sudah terbukti benar. Yang berubah hanya blok PLAYER di bawah.]

// ... (hostCreateRoom, hostWatchPlayers, hostWatchMeta, hostWatchRound,
//      hostWatchFlags, hostShowLobby, hostShowGame, hostShowResult,
//      hostRenderBookList, hostWireBookEvents, hostUpdatePool, hostRenderLobby,
//      hostKickPlayer, hostStartGame, hostStartTicker, hostRenderPicker,
//      hostStartRound, hostProcessWinner, hostTimeoutRound, hostRenderScores,
//      hostRenderResult, hostFinishGame, hostPlayAgain, hostDisband,
//      hostShowReview, hostRenderFlags) — SAMAKAN dengan versi Anda.

// =========================================================
// PLAYER — Navigation
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
      name, score: 0, isHost: false, online: true, joinedAt: serverTimestamp(),
    });
    await onDisconnect(ref(db, `rooms/${code}/players/${myUid}/online`)).set(false);
  } else {
    await set(ref(db, `rooms/${code}/players/${myUid}/online`), true);
  }

  playerState.code = code;
  playerState.uid = myUid;
  playerState.name = existing?.name || name;
  playerState.isHost = false;
  playerState.metaStatus = meta.status;

  saveSession();

  // Wire tombol Keluar (dulu tidak pernah dipasang)
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

// =========================================================
// PLAYER — Watchers (DIPERBAIKI)
// =========================================================
function playerWatchRoom() {
  playerState.unsub.forEach(fn => fn());
  playerState.unsub = [];
  const code = playerState.code;

  const metaRef = ref(db, `rooms/${code}/meta`);
  playerState.unsub.push(onValue(metaRef, (snap) => {
    const meta = snap.val();
    if (!meta) {
      toast('Room dibubarkan.');
      playerLeave();
      return;
    }
    playerState.metaStatus = meta.status;
    if (meta.status === 'finished') {
      playerShowResult();
    }
  }));

  const playersRef = ref(db, `rooms/${code}/players`);
  playerState.unsub.push(onValue(playersRef, (snap) => {
    const players = snap.val() || {};
    playerState.players = players;
    if (!players[myUid]) {
      toast('Anda dikeluarkan dari room.');
      playerLeave();
      return;
    }
    if (playerState.currentScreen === 'screen-multi-lobby') playerRenderLobby();
    if (playerState.currentScreen === 'screen-game') playerRenderScores();
  }));

  const roundRef = ref(db, `rooms/${code}/currentRound`);
  playerState.unsub.push(onValue(roundRef, (snap) => {
    const round = snap.val();
    playerState.currentRound = round;
    if (round) {
      if (playerState.metaStatus === 'finished') {
        playerShowResult();
      } else {
        playerShowGame();
        playerRenderGame();
      }
    } else {
      if (playerState.currentScreen === 'screen-game') {
        playerShowLobby();
      }
    }
  }));

  playerShowLobby();
}

// =========================================================
// PLAYER — Screens (DIPERBAIKI)
// =========================================================
function playerShowLobby() {
  playerShowScreen('screen-multi-lobby');
  playerRenderLobby();
}

function playerShowGame() {
  if (playerState.currentScreen !== 'screen-game') {
    playerShowScreen('screen-game');
    playerState.lastCardsKey = null;
  }
}

function playerShowResult() {
  playerShowScreen('screen-result');
  playerRenderResult();
}

// =========================================================
// PLAYER — Rendering (DIPERBAIKI)
// =========================================================
function playerRenderLobby() {
  const roomEl = document.getElementById('lobbyCode');
  if (roomEl) roomEl.textContent = playerState.code || '----';

  const listEl = document.getElementById('lobbyPlayers');
  const countEl = document.getElementById('lobbyCount');
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

  if (playerState.lastRoundNumber !== round.number) {
    playerState.lastRoundNumber = round.number;
    playerState.clickedThisRound = false;
    playerState.lastCardsKey = null;
  }

  renderPrompt(document.getElementById('meaning'), round.targetReading, round.targetMeaning);

  const cardsKey = (round.cards || []).join(',');
  if (cardsKey !== playerState.lastCardsKey) {
    playerState.lastCardsKey = cardsKey;
    const fieldEl = document.getElementById('field') || document.getElementById('cardField');
    renderField(fieldEl, round.cards || []);
    wireFieldClicks();
  }

  playerRenderScores();

  if (round.winner) highlightWinnerCard(round.winner.cardId);
}

function playerRenderScores() {
  const scoreEl = document.getElementById('scores') || document.getElementById('playerScores');
  if (!scoreEl) return;
  renderScores(scoreEl, playerState.players, myUid, {});
}

function playerRenderResult() {
  const listEl = document.getElementById('resultList');
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
      </div>`;
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
    const winnerRef = ref(db, `rooms/${playerState.code}/currentRound/winner`);
    const result = await runTransaction(winnerRef, (cur) => {
      if (cur && cur.uid) return cur;
      return { uid: myUid, cardId, round: round.number };
    });
    if (result.committed) btn.classList.add('correct');
  } catch (e) {
    console.warn('winner write failed:', e);
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
    try { await remove(ref(db, `rooms/${code}/players/${uid}`)); } catch {}
  }

  location.href = 'play.html?mode=multi';
}

// =========================================================
// INIT — Host (identik dengan versi Anda)
// =========================================================
export async function initHost() {
  await signIn();
  myUid = auth.currentUser.uid;

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
  if (btnStart) btnStart.onclick = hostStartGame;
  if (btnFinish) btnFinish.onclick = hostFinishGame;
  if (btnReview) btnReview.onclick = hostShowReview;
  if (btnPlayAgain) btnPlayAgain.onclick = hostPlayAgain;

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
