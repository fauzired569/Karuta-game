// multi.js — Logika multiplayer: host (wasit) + player, Firebase RTDB v9 modular
//
// Changelog vs versi sebelumnya:
//   [+] Anti-cheat integration via './anti-cheat.js' (tab-hidden, copy, dll)
//   [+] Session reconnect via sessionStorage (auto-rejoin setelah refresh)
//   [+] Flag reporting per-round (ditinjau HOST, bukan auto-kick)
//   [+] Winner race + expired handling (no false "wrong" flash)
//   [+] Per-player field shuffle (anti-collusion posisi)
//   [~] Rekonstruksi: onCardClick, playerWatchRound, playerShowResult,
//       playerShowLobby, initPlayer, initHost

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

// Coba beberapa ID screen (fallback kalau play.html beda dengan yang diasumsikan).
// VERIFY: sesuaikan daftar ID di bawah dengan struktur play.html-mu.
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
    .sort((a, b) => (b[1].score || 0) - (a[1].score || 0));

  el.innerHTML = list.map(([id, p]) => {
    const f = flags[id] || {};
    const count = Object.keys(f).length;
    const warn = count > 0
      ? `<span class="warn-badge" title="Aktivitas mencurigakan terdeteksi">⚠ ${count}</span>`
      : '';
    return `
      <div class="chip ${id === myUidArg ? 'you' : ''} ${count > 0 ? 'suspicious' : ''}">
        <span class="cname">${escHtml(p.name || '?')}${warn}</span>
        <span class="cpts">${p.score || 0}</span>
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

  // Per-player shuffle: tiap pemain melihat posisi yang berbeda.
  // Mencegah kolusi posisi & memberi sedikit variasi visual.
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
// Flag reporting (ditinjau host, BUKAN auto-kick)
// =========================================================
function reportPlayerFlag(type, extra = {}) {
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
}

// =========================================================
// =========================================================
// HOST
// =========================================================
// =========================================================
let hostState = {
  code: null,
  uid: null,
  pool: [],
  used: new Set(),
  roundNumber: 0,
  roundTimer: null,
  unsubPlayers: null,
  unsubRound: null,
  unsubMeta: null,
  unsubFlags: null,
  flags: {},
  playersCache: {},
  finished: false,
};

// Callback render lobby disimpan module-level agar hostPlayAgain bisa re-attach.
let hostLobbyRenderFn = null;

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
  hostState.uid  = myUid;
  hostState.pool = selectedIds.slice();

  return code;
}

function clearHostState() {
  clearTimeout(hostState.roundTimer);
  if (hostState.unsubPlayers) hostState.unsubPlayers();
  if (hostState.unsubRound)   hostState.unsubRound();
  if (hostState.unsubMeta)    hostState.unsubMeta();
  if (hostState.unsubFlags)   hostState.unsubFlags();
  hostState.unsubPlayers = hostState.unsubRound = hostState.unsubMeta = hostState.unsubFlags = null;
  hostState.flags = {};
  hostState.playersCache = {};
  hostState.used = new Set();
  hostState.roundNumber = 0;
  hostState.finished = false;
}

function hostWatchLobby(onUpdate) {
  const code = hostState.code;
  if (hostState.unsubPlayers) {
    hostState.unsubPlayers();
    hostState.unsubPlayers = null;
  }
  hostState.unsubPlayers = onValue(ref(db, `rooms/${code}/players`), (snap) => {
    const players = snap.val() || {};
    onUpdate(players);
  });
}

async function hostStartGame() {
  const code = hostState.code;
  if (!code) return;

  hostState.finished = false;

  await update(ref(db, `rooms/${code}/meta`), {
    status: 'playing',
    startedAt: serverTimestamp()
  });

  hostState.used = new Set();
  hostState.roundNumber = 0;
  hostState.flags = {};
  hostState.playersCache = {};

  showScreen('screen-host-game');

  // Ganti listener lobby (yang menulis ke #hostPlayerList tersembunyi)
  // dengan listener skor yang menulis ke #hostScores di layar game.
  if (hostState.unsubPlayers) {
    hostState.unsubPlayers();
    hostState.unsubPlayers = null;
  }
  hostState.unsubPlayers = onValue(ref(db, `rooms/${code}/players`), (snap) => {
    const players = snap.val() || {};
    hostState.playersCache = players;
    renderScores(document.getElementById('hostScores'), players, hostState.uid, hostState.flags);
    renderHostFlags();
  });

  // Flags listener untuk review host
  if (hostState.unsubFlags) {
    hostState.unsubFlags();
    hostState.unsubFlags = null;
  }
  hostState.unsubFlags = onValue(ref(db, `rooms/${code}/flags`), (snap) => {
    hostState.flags = snap.val() || {};
    renderScores(document.getElementById('hostScores'), hostState.playersCache, hostState.uid, hostState.flags);
    renderHostFlags();
  });

  if (hostState.unsubRound) {
    hostState.unsubRound();
    hostState.unsubRound = null;
  }

  // Winner listener (satu listener untuk semua ronde)
  hostState.unsubRound = onValue(ref(db, `rooms/${code}/currentRound`), async (snap) => {
    if (hostState.finished) return;

    const data = snap.val();
    if (!data || !data.number) return;
    if (data.number !== hostState.roundNumber) return;
    if (!data.winner || data.processed) return;

    const winnerUid = data.winner.uid;
    if (!winnerUid) return;

    const res = await runTransaction(ref(db, `rooms/${code}/currentRound`), (cur) => {
      if (!cur || cur.processed || !cur.winner) return;
      return { ...cur, processed: true };
    });
    if (!res.committed) return;

    clearTimeout(hostState.roundTimer);

    // Cek flag: apakah pemenang terdeteksi mencurangi ronde ini?
    const flagsSnap = await get(ref(db, `rooms/${code}/flags/${winnerUid}`));
    const flags = flagsSnap.val() || {};
    const suspicious = Object.values(flags).some(
      f => f.round === hostState.roundNumber &&
           (f.type === 'tab_hidden' || f.type === 'window_blur')
    );

    if (suspicious) {
      const wsnap = await get(ref(db, `rooms/${code}/players/${winnerUid}`));
      const wname = wsnap.val()?.name || '?';
      const statusEl = document.getElementById('hostStatus');
      if (statusEl) statusEl.textContent =
        `⚠ ${wname} terdeteksi pindah tab — poin ronde ini tidak sah.`;
      await delay(NEXT_ROUND_DELAY);
      hostReadyForNextPick();
      return;
    }

    // Guard: pemenang bisa saja sudah keluar/ditendang
    const stillThere = (await get(ref(db, `rooms/${code}/players/${winnerUid}`))).exists();
    if (!stillThere) {
      await delay(NEXT_ROUND_DELAY);
      hostReadyForNextPick();
      return;
    }

    await runTransaction(
      ref(db, `rooms/${code}/players/${winnerUid}/score`),
      s => (s || 0) + 1
    );

    const wsnap = await get(ref(db, `rooms/${code}/players/${winnerUid}`));
    const wname = wsnap.val()?.name || '?';
    const statusEl = document.getElementById('hostStatus');
    if (statusEl) statusEl.textContent = `${wname} menang ronde ini! +1`;

    await delay(NEXT_ROUND_DELAY);
    hostReadyForNextPick();
  });

  hostReadyForNextPick();
}

// -------- FASE PICKER --------

function renderKanjiPicker() {
  const pickerEl = document.getElementById('kanjiPicker');
  if (!pickerEl) return;

  const available = hostState.pool.filter(id => !hostState.used.has(id));

  if (available.length === 0) {
    pickerEl.innerHTML = '<p class="picker-empty">Semua kanji sudah dipakai.</p>';
    return;
  }

  pickerEl.innerHTML = available.map(id => {
    const card = KANJI.find(k => k.id === id);
    if (!card) return '';
    const reading = getReading(card);
    return `
      <button class="kanji-pick-btn" type="button" data-pick="${escHtml(id)}">
        <span class="kp-kanji">${escHtml(card.kanji)}</span>
        ${reading ? `<span class="kp-reading">${escHtml(reading)}</span>` : ''}
        <span class="kp-meaning">${escHtml(card.meaning || '')}</span>
      </button>
    `;
  }).join('');
}

function hostReadyForNextPick() {
  if (hostState.finished) return;

  renderPrompt(document.getElementById('hostMeaning'), '', 'Pilih kanji di bawah…');
  const remainEl = document.getElementById('hostRemainTag');
  if (remainEl) remainEl.innerHTML = `SISA<br>${hostState.pool.length - hostState.used.size}`;

  renderKanjiPicker();

  const statusEl = document.getElementById('hostStatus');
  if (statusEl) statusEl.textContent = 'Pilih kanji untuk jadi soal…';

  if (hostState.pool.every(id => hostState.used.has(id))) {
    finishHostGame();
  }
}

async function hostPickKanji(cardId) {
  const code = hostState.code;
  if (!code) return;
  if (hostState.used.has(cardId)) return;
  if (!hostState.pool.includes(cardId)) return;
  if (hostState.finished) return;

  clearTimeout(hostState.roundTimer);

  hostState.used.add(cardId);
  hostState.roundNumber++;

  const target = KANJI.find(k => k.id === cardId);
  const targetMeaning = target?.meaning || '?';
  const targetReading = getReading(target);

  const fieldSize = Math.min(FIELD_SIZE, hostState.pool.length);
  const others    = hostState.pool.filter(id => id !== cardId);
  const distract  = shuffle(others).slice(0, Math.max(0, fieldSize - 1));
  const cards     = shuffle([cardId, ...distract]);

  renderPrompt(document.getElementById('hostMeaning'), targetReading, targetMeaning);
  const remainEl = document.getElementById('hostRemainTag');
  if (remainEl) remainEl.innerHTML = `SISA<br>${hostState.pool.length - hostState.used.size}`;

  const pickerEl = document.getElementById('kanjiPicker');
  if (pickerEl) pickerEl.innerHTML = '';

  const statusEl = document.getElementById('hostStatus');
  if (statusEl) statusEl.textContent = 'Menunggu pemain klik...';

  try {
    await set(ref(db, `rooms/${code}/currentRound`), {
      number: hostState.roundNumber,
      targetId: cardId,
      targetMeaning,
      targetReading,
      cards,
      remaining: hostState.pool.length - hostState.used.size,
      startedAt: serverTimestamp(),
      winner: null,
      processed: false
    });
  } catch (err) {
    console.error('Gagal menulis soal:', err);
    toast('Gagal menulis soal', 'bad');
    hostState.used.delete(cardId);
    hostState.roundNumber--;
    hostReadyForNextPick();
    return;
  }

  hostState.roundTimer = setTimeout(async () => {
    const res = await runTransaction(ref(db, `rooms/${code}/currentRound`), (cur) => {
      if (!cur || cur.winner || cur.expired) return;
      return { ...cur, expired: true };
    });
    if (!res.committed) return;

    const statusEl2 = document.getElementById('hostStatus');
    if (statusEl2) statusEl2.textContent = 'Tidak ada yang menjawab.';
    await delay(NEXT_ROUND_DELAY);
    hostReadyForNextPick();
  }, ROUND_TIMEOUT_MS);
}

async function finishHostGame() {
  const code = hostState.code;
  if (!code) return;

  if (hostState.finished) {
    await showHostResult();
    return;
  }
  hostState.finished = true;

  clearTimeout(hostState.roundTimer);

  if (hostState.unsubRound) {
    hostState.unsubRound();
    hostState.unsubRound = null;
  }
  if (hostState.unsubPlayers) {
    hostState.unsubPlayers();
    hostState.unsubPlayers = null;
  }

  await update(ref(db, `rooms/${code}/meta`), { status: 'finished' });
  await showHostResult();
}

async function showHostResult() {
  const code = hostState.code;
  const snap = await get(ref(db, `rooms/${code}/players`));
  const players = snap.val() || {};
  const list = Object.entries(players)
    .filter(([_, p]) => !p.isHost)
    .sort((a, b) => (b[1].score || 0) - (a[1].score || 0));

  const el = document.getElementById('hostResultList');
  if (el) {
    el.innerHTML = list.map(([id, p], i) => `
      <div class="rank-row">
        <div class="rank">${i + 1}</div>
        <div class="rname">${escHtml(p.name || '?')}</div>
        <div class="rpts">${p.score || 0}</div>
      </div>
    `).join('');
  }
  showScreen('screen-host-result');
}

async function hostPlayAgain() {
  const code = hostState.code;
  if (!code) return;
  clearTimeout(hostState.roundTimer);
  hostState.finished = false;

  if (hostState.unsubPlayers) {
    hostState.unsubPlayers();
    hostState.unsubPlayers = null;
  }
  if (hostState.unsubRound) {
    hostState.unsubRound();
    hostState.unsubRound = null;
  }
  if (hostState.unsubFlags) {
    hostState.unsubFlags();
    hostState.unsubFlags = null;
  }

  const playersSnap = await get(ref(db, `rooms/${code}/players`));
  const players = playersSnap.val() || {};

  const updates = {};
  Object.keys(players).forEach(pid => { updates[`players/${pid}/score`] = 0; });
  updates['meta/status'] = 'lobby';
  updates['currentRound'] = null;
  updates['flags'] = null;   // reset audit trail untuk game baru

  await update(ref(db, `rooms/${code}`), updates);

  hostState.used = new Set();
  hostState.roundNumber = 0;
  hostState.flags = {};
  hostState.playersCache = {};

  const poolSection = document.getElementById('poolSection');
  if (poolSection) poolSection.hidden = false;
  const btnCreate = document.getElementById('btnCreateRoom');
  if (btnCreate) {
    btnCreate.disabled = false;
    btnCreate.textContent = 'Buat Room';
  }

  showScreen('screen-host-lobby');

  if (hostLobbyRenderFn) {
    hostWatchLobby(hostLobbyRenderFn);
  }
}

async function hostDisbandRoom() {
  const code = hostState.code;
  if (!code) return;
  clearHostState();

  try {
    await remove(ref(db, `rooms/${code}`));
  } catch (err) {
    console.error('Disband gagal:', err);
    throw new Error('Gagal membubarkan room: ' + (err.message || 'unknown'));
  }

  hostState.code = null;
  hostState.uid  = null;
  hostState.pool = [];

  const poolSection = document.getElementById('poolSection');
  if (poolSection) poolSection.hidden = false;
  const roomInfo = document.getElementById('roomInfo');
  if (roomInfo) roomInfo.hidden = true;
  const btnCreate = document.getElementById('btnCreateRoom');
  if (btnCreate) {
    btnCreate.disabled = false;
    btnCreate.textContent = 'Buat Room ▸';
  }
  showScreen('screen-host-setup');
}

async function hostKickPlayer(targetUid) {
  const code = hostState.code;
  if (!code || !targetUid) return;
  if (targetUid === hostState.uid) return;
  await remove(ref(db, `rooms/${code}/players/${targetUid}`));
}

// -------- HOST: render dialog review flags --------

function renderHostFlags() {
  const dialog  = document.getElementById('reviewDialog');
  const content = document.getElementById('reviewContent');
  const btn     = document.getElementById('btnReviewFlags');
  const countEl = document.getElementById('flagCount');
  if (!dialog || !content || !btn || !countEl) return;

  const flags   = hostState.flags || {};
  const players = hostState.playersCache || {};

  let total = 0;
  const rows = [];
  for (const [uid, pl] of Object.entries(players)) {
    if (pl.isHost) continue;
    const f = flags[uid] || {};
    const entries = Object.values(f);
    if (!entries.length) continue;
    total += entries.length;
    const byType = entries.reduce((a, e) => {
      a[e.type] = (a[e.type] || 0) + 1;
      return a;
    }, {});
    const list = Object.entries(byType)
      .map(([t, n]) => `${escHtml(t)} ×${n}`)
      .join('<br>');
    rows.push(`<div class="flag-row">
      <div class="fr-name">${escHtml(pl.name || '?')}</div>
      <div class="fr-detail">${list}</div>
    </div>`);
  }

  countEl.textContent = total;
  btn.hidden = total === 0;

  content.innerHTML = rows.length
    ? rows.join('')
    : '<p class="hint">Belum ada aktivitas mencurigakan.</p>';
}

// =========================================================
// =========================================================
// PLAYER
// =========================================================
// =========================================================
let playerState = {
  code: null,
  uid: null,
  name: null,
  currentRound: null,
  unsubPlayers: null,
  unsubMeta: null,
  unsubLobby: null,
  unsubSelf: null,
  leaving: false,
  unsubRoundNumber: null,
  unsubRoundWinner: null,
  unsubHostOnline: null,
  hostUid: null,
  _roundToken: 0,
  antiCheat: null,
};

async function playerJoinRoom(code, playerName) {
  code = (code || '').trim().toUpperCase();
  playerName = (playerName || '').trim();

  if (!/^[A-Z0-9]{4}$/.test(code)) throw new Error('Kode room harus 4 karakter alfanumerik.');
  if (!playerName) throw new Error('Nama tidak boleh kosong.');
  if (playerName.length > 16) throw new Error('Nama maksimal 16 karakter.');

  await signIn();
  myUid = auth.currentUser.uid;
  playerState.leaving = false;

  const [metaSnap, playersSnap] = await Promise.all([
    get(ref(db, `rooms/${code}/meta`)),
    get(ref(db, `rooms/${code}/players`))
  ]);
  if (!metaSnap.exists()) throw new Error('Kode room tidak ditemukan.');

  const meta = metaSnap.val();
  if (meta.status !== 'lobby') throw new Error('Permainan sudah dimulai atau berakhir.');

  const players = playersSnap.val() || {};
  const count = Object.keys(players).length;
  const roomMax = Math.max(2, Math.min(15, Number(meta.maxPlayers) || MAX_PLAYERS));
  if (count >= roomMax) throw new Error(`Room penuh (maks ${roomMax} pemain).`);

  await set(ref(db, `rooms/${code}/players/${myUid}`), {
    name: playerName,
    score: 0,
    isHost: false,
    online: true,
    joinedAt: serverTimestamp()
  });
  await onDisconnect(ref(db, `rooms/${code}/players/${myUid}/online`)).set(false);

  playerState.code = code;
  playerState.uid  = myUid;
  playerState.name = playerName;
  playerState.hostUid = meta.hostUid;

  saveSession();   // untuk auto-reconnect saat refresh

  return { meta, players };
}

function playerWatchLobby(onUpdate) {
  const code = playerState.code;
  if (playerState.unsubLobby) {
    playerState.unsubLobby();
    playerState.unsubLobby = null;
  }
  playerState.unsubLobby = onValue(ref(db, `rooms/${code}/players`), (snap) => {
    const players = snap.val() || {};
    onUpdate(players);
  });
}

function playerExit(reason) {
  const code = playerState.code;
  const uid  = playerState.uid;
  if (playerState.leaving) return;
  playerState.leaving = true;
  clearSession();

  playerState.unsubSelf?.();   playerState.unsubSelf = null;
  playerState.unsubMeta?.();   playerState.unsubMeta = null;
  playerState.unsubLobby?.();  playerState.unsubLobby = null;
  cleanupPlayerGameListeners();

  if (code && uid) {
    try {
      onDisconnect(ref(db, `rooms/${code}/players/${uid}/online`))
        .cancel().catch(() => {});
    } catch {}
  }

  playerState.code = null;
  playerState.uid  = null;
  playerState.name = null;
  playerState.hostUid = null;
  playerState.currentRound = null;

  toast(
    reason === 'kicked'
      ? 'Kamu dikeluarkan oleh wasit'
      : 'Room telah dibubarkan oleh wasit',
    'bad'
  );

  const codeInput = document.getElementById('joinCode');
  if (codeInput) codeInput.value = '';
  showScreen('screen-multi-join');
}

async function playerLeaveRoom({ silent = false } = {}) {
  const code = playerState.code;
  const uid  = playerState.uid;
  if (!code || !uid) return;
  if (playerState.leaving) return;

  playerState.leaving = true;
  clearSession();
  playerState.unsubSelf?.();   playerState.unsubSelf = null;
  playerState.unsubMeta?.();   playerState.unsubMeta = null;
  playerState.unsubLobby?.();  playerState.unsubLobby = null;
  cleanupPlayerGameListeners();

  try { await onDisconnect(ref(db, `rooms/${code}/players/${uid}/online`)).cancel(); } catch {}
  try { await remove(ref(db, `rooms/${code}/players/${uid}`)); } catch (err) {
    console.warn('Gagal keluar room:', err);
  }

  playerState.code = null;
  playerState.uid  = null;
  playerState.name = null;
  playerState.hostUid = null;
  playerState.currentRound = null;

  if (!silent) {
    toast('Kamu keluar dari room', '');
    const codeInput = document.getElementById('joinCode');
    if (codeInput) codeInput.value = '';
    showScreen('screen-multi-join');
  }
}

function playerWatchSelf() {
  const code = playerState.code;
  const uid  = playerState.uid;
  if (!code || !uid) return;

  if (playerState.unsubSelf) {
    playerState.unsubSelf();
    playerState.unsubSelf = null;
  }

  playerState.unsubSelf = onValue(ref(db, `rooms/${code}/players/${uid}`), async (snap) => {
    if (snap.exists()) return;
    if (playerState.leaving) return;
    if (playerState.code !== code) return;

    let metaExists = true;
    try {
      metaExists = (await get(ref(db, `rooms/${code}/meta`))).exists();
    } catch {}

    if (!metaExists) return;
    playerExit('kicked');
  });
}

function cleanupPlayerGameListeners() {
  playerState.antiCheat?.stop();
  playerState.antiCheat = null;

  playerState.unsubRoundNumber?.();
  playerState.unsubRoundNumber = null;
  playerState.unsubRoundWinner?.();
  playerState.unsubRoundWinner = null;
  playerState.unsubHostOnline?.();
  playerState.unsubHostOnline = null;
  playerState.unsubPlayers?.();
  playerState.unsubPlayers = null;
  playerState.currentRound = null;
  playerState._roundToken = 0;
}

function playerWatchMeta(onStart, onFinish, onLobby, onDisbanded) {
  const code = playerState.code;
  if (playerState.unsubMeta) {
    playerState.unsubMeta();
    playerState.unsubMeta = null;
  }
  playerState.unsubMeta = onValue(ref(db, `rooms/${code}/meta`), (snap) => {
    const meta = snap.val();

    if (!meta) {
      if (playerState.unsubMeta) { playerState.unsubMeta(); playerState.unsubMeta = null; }
      if (playerState.unsubLobby) { playerState.unsubLobby(); playerState.unsubLobby = null; }
      cleanupPlayerGameListeners();
      onDisbanded?.();
      return;
    }

    if (meta.status === 'playing') onStart();
    else if (meta.status === 'finished') onFinish();
    else if (meta.status === 'lobby') {
      cleanupPlayerGameListeners();
      onLobby?.();
    }
  });
}

function playerBeginGame() {
  const code = playerState.code;
  if (!code) return;

  showScreen('screen-game');
  cleanupPlayerGameListeners();

  // Anti-cheat: aktif selama gameplay
  if (!playerState.antiCheat) {
    playerState.antiCheat = createAntiCheat({
      onFlag: (type, extra) => reportPlayerFlag(type, extra),
      getContext: () => ({ round: playerState.currentRound?.number || 0 }),
      isRoundActive: () => !!playerState.currentRound,
    });
  }
  playerState.antiCheat.start();

  // Reset UI ke placeholder
  const meaningEl = document.getElementById('meaning');
  if (meaningEl) {
    meaningEl.innerHTML = `
      <span class="prompt-reading"></span>
      <span class="prompt-meaning">Menunggu wasit memilih soal…</span>
    `;
  }
  const fieldEl = document.getElementById('field');
  if (fieldEl) fieldEl.innerHTML = '';
  const remainEl = document.getElementById('remainTag');
  if (remainEl) remainEl.innerHTML = `SISA<br>–`;

  // Event delegation — pasang SEKALI di #field, tidak pernah lepas walau DOM diganti
  if (fieldEl && fieldEl.dataset.delegated !== '1') {
    fieldEl.dataset.delegated = '1';
    fieldEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.card');
      if (!btn) return;
      onCardClick(btn.dataset.id, btn);
    });
  }

  // Subscribe ke currentRound
  playerWatchRound();
}

// -------- FASE MAIN (player) --------

function playerWatchRound() {
  const code = playerState.code;
  if (!code) return;

  if (playerState.unsubRoundNumber) {
    playerState.unsubRoundNumber();
    playerState.unsubRoundNumber = null;
  }

  playerState.unsubRoundNumber = onValue(ref(db, `rooms/${code}/currentRound`), (snap) => {
    const data = snap.val();
    const meaningEl = document.getElementById('meaning');
    const fieldEl   = document.getElementById('field');
    const remainEl  = document.getElementById('remainTag');

    if (!data || !data.number) {
      playerState.currentRound = null;
      if (meaningEl) meaningEl.innerHTML =
        '<span class="prompt-meaning">Menunggu wasit memilih soal…</span>';
      if (fieldEl) fieldEl.innerHTML = '';
      if (remainEl) remainEl.innerHTML = 'SISA<br>–';
      return;
    }

    const isNewRound = !playerState.currentRound ||
                       playerState.currentRound.number !== data.number;
    playerState.currentRound = data;

    if (isNewRound) {
      // Render prompt + field
      renderPrompt(meaningEl, data.targetReading || '', data.targetMeaning || '?');
      if (remainEl) remainEl.innerHTML = `SISA<br>${data.remaining ?? '–'}`;
      if (fieldEl) {
        fieldEl.innerHTML = '';
        renderField(fieldEl, data.cards || []);
      }
    }

    // Tampilkan state ronde (winner / expired) — disabled semua kartu
    if (fieldEl) {
      const cards = fieldEl.querySelectorAll('.card');

      if (data.winner) {
        cards.forEach(c => {
          c.disabled = true;
          if (c.dataset.id === data.winner.cardId) c.classList.add('correct');
        });
      } else if (data.expired) {
        cards.forEach(c => { c.disabled = true; });
      } else {
        // Reset (misal karena transisi round lama → baru)
        cards.forEach(c => {
          c.disabled = false;
          c.classList.remove('correct', 'wrong');
        });
      }
    }
  });
}

async function onCardClick(cardId, btn) {
  const code = playerState.code;
  if (!code) return;

  const round = playerState.currentRound;
  if (!round || !round.number) return;
  if (round.winner || round.expired) return;
  if (btn.disabled) return;
  if (btn.dataset.submitting === '1') return;

  btn.dataset.submitting = '1';

  try {
    // Coba tulis winner. Berhasil HANYA jika cardId === targetId (dicek rules).
    await set(ref(db, `rooms/${code}/currentRound/winner`), {
      uid: playerState.uid,
      cardId,
      round: round.number,
    });
    // Berhasil: beri feedback, listener akan disable field
    btn.classList.add('correct');
  } catch (err) {
    // Gagal: bisa karena (a) kartu salah, (b) sudah ada pemenang lain,
    // (c) sudah expired, (d) round sudah berubah.
    // Bedakan supaya tidak salah tampilkan "salah" untuk kartu yang benar.
    try {
      const [winnerSnap, expiredSnap, curSnap] = await Promise.all([
        get(ref(db, `rooms/${code}/currentRound/winner`)),
        get(ref(db, `rooms/${code}/currentRound/expired`)),
        get(ref(db, `rooms/${code}/currentRound`)),
      ]);

      const cur = curSnap.val();
      const stillSameRound = cur && cur.number === round.number;
      const alreadyDecided = winnerSnap.exists() ||
                             expiredSnap.val() === true ||
                             !stillSameRound;

      if (!alreadyDecided) {
        // Benar-benar kartu salah — beri feedback "wrong"
        btn.classList.add('wrong');
        btn.disabled = true;
        setTimeout(() => {
          btn.classList.remove('wrong');
          // Jangan re-enable jika ronde sudah selesai
          const r = playerState.currentRound;
          if (r && r.number === round.number && !r.winner && !r.expired) {
            btn.disabled = false;
          }
        }, 600);
      }
      // else: diam — listener yang akan update UI (correct highlight / disable)
    } catch (e) {
      console.warn('post-click check failed:', e);
    }
  } finally {
    delete btn.dataset.submitting;
  }
}

// -------- RESULT & LOBBY (player) --------

async function playerShowResult() {
  const code = playerState.code;
  if (!code) return;

  // Lepas listener game dulu
  cleanupPlayerGameListeners();

  const snap = await get(ref(db, `rooms/${code}/players`));
  const players = snap.val() || {};
  const list = Object.entries(players)
    .filter(([_, p]) => !p.isHost)
    .sort((a, b) => (b[1].score || 0) - (a[1].score || 0));

  // Render ke beberapa target umum (defensif)
  // VERIFY: sesuaikan dengan ID di play.html-mu.
  const targets = ['playerResultList', 'resultList', 'multiResultList'];
  let rendered = false;
  for (const id of targets) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.innerHTML = list.map(([pid, p], i) => {
      const you = pid === playerState.uid ? ' you' : '';
      return `
        <div class="rank-row${you}">
          <div class="rank">${i + 1}</div>
          <div class="rname">${escHtml(p.name || '?')}</div>
          <div class="rpts">${p.score || 0}</div>
        </div>
      `;
    }).join('');
    rendered = true;
  }
  if (!rendered) console.warn('playerShowResult: no result list element found');

  // VERIFY: sesuaikan dengan ID screen di play.html-mu.
  showFirstExistingScreen('screen-result', 'screen-player-result', 'screen-game-result');
}

function playerShowLobby() {
  const code = playerState.code;
  if (!code) return;

  // Render daftar pemain (defensif, multi-ID)
  // VERIFY: sesuaikan ID di bawah dengan play.html-mu.
  const renderInto = (elId) => {
    const el = document.getElementById(elId);
    if (!el) return false;
    playerWatchLobby((players) => {
      const list = Object.entries(players).filter(([_, p]) => !p.isHost);
      el.innerHTML = list.map(([id, p]) => `
        <li class="${id === playerState.uid ? 'you' : ''}">${escHtml(p.name || '?')}</li>
      `).join('');
    });
    return true;
  };
  renderInto('playerLobbyList') || renderInto('lobbyPlayerList');

  // VERIFY: sesuaikan ID screen.
  showFirstExistingScreen('screen-multi-lobby', 'screen-multi-wait', 'screen-lobby');
}

// -------- AUTO-REJOIN --------

async function tryAutoRejoin(prefilledRoom) {
  const saved = readSession();
  if (!saved?.code || !saved?.name) return false;

  if (prefilledRoom && prefilledRoom.toUpperCase() !== saved.code) return false;

  if (Date.now() - (saved.savedAt || 0) > SESSION_TTL_MS) {
    clearSession();
    return false;
  }

  try {
    await signIn();
    const uid = auth.currentUser.uid;

    const [metaSnap, playerSnap] = await Promise.all([
      get(ref(db, `rooms/${saved.code}/meta`)),
      get(ref(db, `rooms/${saved.code}/players/${uid}`)),
    ]);

    if (!metaSnap.exists() || !playerSnap.exists()) {
      clearSession();
      return false;
    }

    const meta = metaSnap.val();
    if (meta.hostUid === uid) {
      // Host punya jalur sendiri (initHost), bukan di sini.
      clearSession();
      return false;
    }

    playerState.code    = saved.code;
    playerState.uid     = uid;
    playerState.name    = saved.name;
    playerState.hostUid = meta.hostUid;
    playerState.leaving = false;

    // Tandai online kembali
    await update(ref(db, `rooms/${saved.code}/players/${uid}`), { online: true });
    await onDisconnect(ref(db, `rooms/${saved.code}/players/${uid}/online`)).set(false);

    // Pasang listener sesuai status
    playerWatchSelf();
    playerWatchMeta(
      () => playerBeginGame(),
      () => playerShowResult(),
      () => playerShowLobby(),
      () => playerExit('disbanded')
    );

    if (meta.status === 'playing') {
      playerBeginGame();
      toast('Berhasil tersambung kembali', 'good');
    } else if (meta.status === 'finished') {
      playerShowResult();
      toast('Kamu kembali — permainan sudah selesai', '');
    } else {
      playerShowLobby();
      toast('Berhasil kembali ke lobby', 'good');
    }
    return true;
  } catch (err) {
    console.warn('auto-rejoin gagal:', err);
    clearSession();
    return false;
  }
}

// =========================================================
// =========================================================
// ENTRY POINTS
// =========================================================
// =========================================================

// -------- HOST ENTRY --------

function renderHostBookList() {
  const el = document.getElementById('bookList');
  if (!el) return;

  el.innerHTML = Object.entries(STRUCTURE).map(([book, chapters]) => `
    <div class="book-item">
      <label class="book-label">
        <input type="checkbox" class="book-check" value="${escHtml(book)}">
        <strong>${escHtml(book)}</strong>
      </label>
      <div class="chapter-list">
        ${chapters.map(ch => `
          <label class="chapter-label">
            <input type="checkbox" class="chapter-check"
                   data-book="${escHtml(book)}" value="${escHtml(ch)}">
            ${escHtml(ch)}
          </label>
        `).join('')}
      </div>
    </div>
  `).join('');

  // Interaksi: book checkbox ↔ chapter checkboxes
  el.querySelectorAll('.book-check').forEach(bookCb => {
    bookCb.addEventListener('change', () => {
      const book = bookCb.value;
      el.querySelectorAll(`.chapter-check[data-book="${CSS.escape(book)}"]`)
        .forEach(chCb => { chCb.checked = bookCb.checked; });
      updateHostPoolInfo();
    });
  });

  el.querySelectorAll('.chapter-check').forEach(chCb => {
    chCb.addEventListener('change', () => {
      const book = chCb.dataset.book;
      const chapters = el.querySelectorAll(`.chapter-check[data-book="${CSS.escape(book)}"]`);
      const allChecked = [...chapters].every(c => c.checked);
      const bookCb = el.querySelector(`.book-check[value="${CSS.escape(book)}"]`);
      if (bookCb) bookCb.checked = allChecked;
      updateHostPoolInfo();
    });
  });
}

function getSelectedFilters() {
  const books = [...document.querySelectorAll('.book-check:checked')].map(cb => cb.value);
  const chapters = [...document.querySelectorAll('.chapter-check:checked')]
    .map(cb => `${cb.dataset.book}::${cb.value}`);
  return { books, chapters };
}

function getSelectedPool() {
  const { books, chapters } = getSelectedFilters();
  if (books.length === 0 && chapters.length === 0) return [];
  return buildPool(books, chapters);
}

function updateHostPoolInfo() {
  const pool = getSelectedPool();
  const infoEl = document.getElementById('poolInfo');
  if (infoEl) infoEl.textContent = `${pool.length} kanji`;
  const btn = document.getElementById('btnCreateRoom');
  if (btn) btn.disabled = pool.length < MIN_POOL;
  return pool;
}

function hostSelectAll(state) {
  document.querySelectorAll('.book-check, .chapter-check')
    .forEach(cb => { cb.checked = state; });
  updateHostPoolInfo();
}

async function hostCreateRoomFlow() {
  const pool = getSelectedPool();
  if (pool.length < MIN_POOL) return;

  const maxPlayersInput = document.getElementById('maxPlayersInput');
  const maxPlayers = Math.max(2, Math.min(15,
    Number(maxPlayersInput?.value) || 8));

  const btn = document.getElementById('btnCreateRoom');
  if (btn) { btn.disabled = true; btn.textContent = 'Membuat…'; }

  try {
    const code = await hostCreateRoom(pool.map(k => k.id), maxPlayers);

    const roomCodeEl = document.getElementById('roomCode');
    if (roomCodeEl) roomCodeEl.textContent = code;
    const roomInfo = document.getElementById('roomInfo');
    if (roomInfo) roomInfo.hidden = false;
    const poolSection = document.getElementById('poolSection');
    if (poolSection) poolSection.hidden = true;

    const hostRoomCode = document.getElementById('hostRoomCode');
    if (hostRoomCode) hostRoomCode.textContent = code;
    const hostMaxPlayers = document.getElementById('hostMaxPlayers');
    if (hostMaxPlayers) hostMaxPlayers.textContent = maxPlayers;

    showScreen('screen-host-lobby');

    hostLobbyRenderFn = (players) => {
      const list = Object.entries(players).filter(([_, p]) => !p.isHost);
      const listEl = document.getElementById('hostPlayerList');
      const countEl = document.getElementById('hostPlayerCount');

      if (countEl) countEl.textContent = list.length;
      if (listEl) {
        listEl.innerHTML = list.map(([id, p]) => `
          <li>
            <span>${escHtml(p.name || '?')}</span>
            <button class="btn-kick" data-kick="${escHtml(id)}" type="button">Keluarkan</button>
          </li>
        `).join('');
        listEl.querySelectorAll('[data-kick]').forEach(kb => {
          kb.addEventListener('click', () => {
            if (confirm('Keluarkan pemain ini?')) hostKickPlayer(kb.dataset.kick);
          });
        });
      }

      const startBtn = document.getElementById('btnStartGame');
      if (startBtn) startBtn.disabled = list.length < 2;
    };
    hostWatchLobby(hostLobbyRenderFn);
  } catch (err) {
    toast(err.message || 'Gagal membuat room', 'bad');
    if (btn) { btn.disabled = false; btn.textContent = 'Buat Room ▸'; }
  }
}

export async function initHost() {
  await signIn();
  myUid = auth.currentUser.uid;

  renderHostBookList();
  updateHostPoolInfo();

  document.getElementById('btnAll')?.addEventListener('click', () => hostSelectAll(true));
  document.getElementById('btnNone')?.addEventListener('click', () => hostSelectAll(false));
  document.getElementById('btnCreateRoom')?.addEventListener('click', hostCreateRoomFlow);

  document.getElementById('btnCopyCode')?.addEventListener('click', () => {
    const code = hostState.code || document.getElementById('roomCode')?.textContent;
    if (!code) return;
    navigator.clipboard?.writeText(code)
      .then(() => toast('Kode disalin', 'good'))
      .catch(() => toast('Gagal menyalin', 'bad'));
  });

  document.getElementById('btnStartGame')?.addEventListener('click', () => {
    if (confirm('Mulai permainan sekarang?')) hostStartGame();
  });

  document.getElementById('btnFinishGame')?.addEventListener('click', () => {
    if (confirm('Akhiri permainan dan tampilkan hasil?')) finishHostGame();
  });

  document.getElementById('btnPlayAgain')?.addEventListener('click', hostPlayAgain);

  // Disband: semua tombol dengan data-disband
  document.querySelectorAll('[data-disband]').forEach(el => {
    el.addEventListener('click', async () => {
      if (!confirm('Bubarkan room? Semua pemain akan dikeluarkan.')) return;
      try { await hostDisbandRoom(); toast('Room dibubarkan', ''); }
      catch (err) { toast(err.message || 'Gagal membubarkan', 'bad'); }
    });
  });

  // Kanji picker (delegation)
  document.getElementById('kanjiPicker')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-pick]');
    if (!btn) return;
    hostPickKanji(btn.dataset.pick);
  });

  // Review dialog
  const reviewBtn = document.getElementById('btnReviewFlags');
  const reviewDlg = document.getElementById('reviewDialog');
  const reviewCls = document.getElementById('btnCloseReview');
  if (reviewBtn && reviewDlg) reviewBtn.addEventListener('click', () => reviewDlg.showModal());
  if (reviewCls && reviewDlg) reviewCls.addEventListener('click', () => reviewDlg.close());
}

// -------- PLAYER ENTRY --------

export async function initPlayer(opts = {}) {
  const prefilled = opts.prefilledRoom?.toUpperCase?.() || null;
  const codeInput = document.getElementById('joinCode');
  if (prefilled && codeInput) codeInput.value = prefilled;

  // Coba reconnect dulu sebelum tampilkan form
  if (await tryAutoRejoin(prefilled)) return;

  // Setup form join
  const joinBtn   = document.getElementById('btnJoin');
  const nameInput = document.getElementById('playerName');

  const doJoin = async () => {
    const code = codeInput?.value;
    const name = nameInput?.value;
    if (joinBtn) { joinBtn.disabled = true; joinBtn.textContent = 'Bergabung…'; }
    try {
      await playerJoinRoom(code, name);

      // Setelah join sukses: pasang listener dan tampilkan lobby
      playerWatchSelf();
      playerWatchMeta(
        () => playerBeginGame(),
        () => playerShowResult(),
        () => playerShowLobby(),
        () => playerExit('disbanded')
      );
      playerShowLobby();
    } catch (err) {
      toast(err.message || 'Gagal bergabung', 'bad');
    } finally {
      if (joinBtn) { joinBtn.disabled = false; joinBtn.textContent = 'Gabung ▸'; }
    }
  };

  joinBtn?.addEventListener('click', doJoin);
  nameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doJoin();
  });
  codeInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') nameInput?.focus();
  });

  // Tombol "Keluar" / "Leave" saat di lobby (defensif — ID bisa beda)
  // VERIFY: sesuaikan dengan tombol leave di play.html-mu.
  document.querySelectorAll('[data-leave]').forEach(el => {
    el.addEventListener('click', () => {
      if (confirm('Keluar dari room?')) playerLeaveRoom();
    });
  });

  // Bersihkan session saat user menutup tab secara eksplisit? Tidak — biarkan
  // session hidup (TTL 6 jam) supaya refresh/crash masih bisa recover.
}
