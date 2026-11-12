// multi.js — Logika multiplayer: host (wasit) + player, Firebase RTDB v9 modular
import { firebaseConfig } from './firebase-config.js';
import { KANJI, STRUCTURE } from './data.js';
import { buildPool } from './core.js';

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
const ROOM_CODE_CHARS    = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // hindari 0/O/1/I

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

// =========================================================
// Reading lookup yang toleran terhadap variasi field di data.js
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
// Prompt rendering (hiragana + arti)
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

// =========================================================
// Score rendering
// =========================================================
function renderScores(el, players, myUidArg) {
  if (!el) return;
  const list = Object.entries(players || {})
    .filter(([_, p]) => !p.isHost)
    .sort((a, b) => (b[1].score || 0) - (a[1].score || 0));

  el.innerHTML = list.map(([id, p]) => `
    <div class="chip ${id === myUidArg ? 'you' : ''}">
      <span class="cname">${escHtml(p.name || '?')}</span>
      <span class="cpts">${p.score || 0}</span>
    </div>
  `).join('');
}

// =========================================================
// Field rendering
// =========================================================
function renderField(fieldEl, cardIds) {
  if (!fieldEl) {
    console.warn('renderField: field element not found');
    return;
  }
  fieldEl.innerHTML = '';
  (cardIds || []).forEach((id, i) => {
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
  unsubMeta: null
};

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
  hostState.unsubPlayers = hostState.unsubRound = hostState.unsubMeta = null;
  hostState.used = new Set();
  hostState.roundNumber = 0;
}

function hostWatchLobby(onUpdate) {
  const code = hostState.code;
  hostState.unsubPlayers = onValue(ref(db, `rooms/${code}/players`), (snap) => {
    const players = snap.val() || {};
    onUpdate(players);
  });
}

async function hostStartGame() {
  const code = hostState.code;
  if (!code) return;

  await update(ref(db, `rooms/${code}/meta`), {
    status: 'playing',
    startedAt: serverTimestamp()
  });

  hostState.used = new Set();
  hostState.roundNumber = 0;

  showScreen('screen-host-game');

  // Cleanup listener lama
  if (hostState.unsubRound) {
    hostState.unsubRound();
    hostState.unsubRound = null;
  }

  // Winner listener (satu listener untuk semua ronde)
  hostState.unsubRound = onValue(ref(db, `rooms/${code}/currentRound`), async (snap) => {
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

  // Tampilkan picker untuk ronde pertama
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
  // Reset HUD
  renderPrompt(document.getElementById('hostMeaning'), '', 'Pilih kanji di bawah…');
  const remainEl = document.getElementById('hostRemainTag');
  if (remainEl) remainEl.innerHTML = `SISA<br>${hostState.pool.length - hostState.used.size}`;

  renderKanjiPicker();

  const statusEl = document.getElementById('hostStatus');
  if (statusEl) statusEl.textContent = 'Pilih kanji untuk jadi soal…';

  // Pool habis? → selesai
  if (hostState.pool.every(id => hostState.used.has(id))) {
    finishHostGame();
  }
}

async function hostPickKanji(cardId) {
  const code = hostState.code;
  if (!code) return;
  if (hostState.used.has(cardId)) return;
  if (!hostState.pool.includes(cardId)) return;

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

  // Update HUD host (sinkron sebelum await)
  renderPrompt(document.getElementById('hostMeaning'), targetReading, targetMeaning);
  const remainEl = document.getElementById('hostRemainTag');
  if (remainEl) remainEl.innerHTML = `SISA<br>${hostState.pool.length - hostState.used.size}`;

  // Bersihkan picker (sync, cegah double-click)
  const pickerEl = document.getElementById('kanjiPicker');
  if (pickerEl) pickerEl.innerHTML = '';

  const statusEl = document.getElementById('hostStatus');
  if (statusEl) statusEl.textContent = 'Menunggu pemain klik...';

  // Tulis ronde
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
    // Kembalikan state supaya host bisa coba lagi
    hostState.used.delete(cardId);
    hostState.roundNumber--;
    hostReadyForNextPick();
    return;
  }

  // Timeout
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
  clearTimeout(hostState.roundTimer);
  if (hostState.unsubRound) {
    hostState.unsubRound();
    hostState.unsubRound = null;
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

  if (hostState.unsubRound) {
    hostState.unsubRound();
    hostState.unsubRound = null;
  }

  const playersSnap = await get(ref(db, `rooms/${code}/players`));
  const players = playersSnap.val() || {};

  const updates = {};
  Object.keys(players).forEach(pid => { updates[`players/${pid}/score`] = 0; });
  updates['meta/status'] = 'lobby';
  updates['currentRound'] = null;

  await update(ref(db, `rooms/${code}`), updates);

  hostState.used = new Set();
  hostState.roundNumber = 0;

  const poolSection = document.getElementById('poolSection');
  if (poolSection) poolSection.hidden = false;
  const btnCreate = document.getElementById('btnCreateRoom');
  if (btnCreate) {
    btnCreate.disabled = false;
    btnCreate.textContent = 'Buat Room';
  }

  showScreen('screen-host-lobby');
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
  hostUid: null
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
  playerState.name = player
