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

  // Update HUD host (sync)
  renderPrompt(document.getElementById('hostMeaning'), targetReading, targetMeaning);
  const remainEl = document.getElementById('hostRemainTag');
  if (remainEl) remainEl.innerHTML = `SISA<br>${hostState.pool.length - hostState.used.size}`;

  // Kosongkan picker segera (cegah double-click)
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
  hostUid: null,
  _roundToken: 0
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

  // Skor live
  playerState.unsubPlayers = onValue(ref(db, `rooms/${code}/players`), (snap) => {
    const players = snap.val() || {};
    renderScores(document.getElementById('scores'), players, myUid);
  });

  // Watcher nomor ronde → fetch dengan token & pending state
  playerState.unsubRoundNumber = onValue(ref(db, `rooms/${code}/currentRound/number`), async (snap) => {
    const number = snap.val();
    if (!number) return;
    if (playerState.currentRound?.number === number && !playerState.currentRound?.pending) return;

    const token = ++playerState._roundToken;

    // Kunci klik selama fetch (pending, winner='pending' → truthy)
    playerState.currentRound = {
      number, cards: [], winner: 'pending',
      targetMeaning: '…', targetReading: '', pending: true
    };

    const [cardsSnap, remainingSnap, winnerSnap, meaningSnap, readingSnap] = await Promise.all([
      get(ref(db, `rooms/${code}/currentRound/cards`)).catch(() => null),
      get(ref(db, `rooms/${code}/currentRound/remaining`)).catch(() => null),
      get(ref(db, `rooms/${code}/currentRound/winner`)).catch(() => null),
      get(ref(db, `rooms/${code}/currentRound/targetMeaning`)).catch(() => null),
      get(ref(db, `rooms/${code}/currentRound/targetReading`)).catch(() => null)
    ]);

    // Tolak kalau ada fetch lebih baru (out-of-order)
    if (token !== playerState._roundToken) return;

    const data = {
      number,
      cards: cardsSnap?.val() || [],
      remaining: remainingSnap?.val() || 0,
      winner: winnerSnap?.val() || null,
      targetMeaning: meaningSnap?.val() || '?',
      targetReading: readingSnap?.val() || '',
      pending: false
    };
    playerState.currentRound = data;
    renderRound(data);
    if (data.winner) onRoundWon(data);
  });

  // Winner watcher — abaikan jika pending / sudah ada winner
  playerState.unsubRoundWinner = onValue(ref(db, `rooms/${code}/currentRound/winner`), (snap) => {
    const winner = snap.val();
    if (!winner) return;
    const cur = playerState.currentRound;
    if (!cur || cur.pending) return;
    if (cur.winner) return;

    cur.winner = winner;
    onRoundWon({ ...cur, winner });
  });

  // Host online watcher
  playerState.unsubHostOnline = onValue(
    ref(db, `rooms/${code}/players/${playerState.hostUid}/online`),
    (snap) => {
      if (snap.val() === false) toast('Wasit terputus...', 'bad');
    }
  );
}

async function showPlayerResult() {
  const code = playerState.code;
  const snap = await get(ref(db, `rooms/${code}/players`));
  const players = snap.val() || {};
  const list = Object.entries(players)
    .filter(([_, p]) => !p.isHost)
    .sort((a, b) => (b[1].score || 0) - (a[1].score || 0));

  const el = document.getElementById('resultList');
  if (el) {
    el.innerHTML = list.map(([id, p], i) => `
      <div class="rank-row ${id === myUid ? 'you' : ''}">
        <div class="rank">${i + 1}</div>
        <div class="rname">${escHtml(p.name || '?')}</div>
        <div class="rpts">${p.score || 0}</div>
      </div>
    `).join('');
  }
  showScreen('screen-result');
}

function renderRound(round) {
  if (!round || !Array.isArray(round.cards)) {
    console.warn('renderRound: data ronde tidak valid', round);
    return;
  }

  renderPrompt(
    document.getElementById('meaning'),
    round.targetReading,
    round.targetMeaning
  );

  const remainEl = document.getElementById('remainTag');
  if (remainEl && typeof round.remaining === 'number') {
    remainEl.innerHTML = `SISA<br>${round.remaining}`;
  }

  renderField(document.getElementById('field'), round.cards);
  // Listener klik sudah dipasang via delegation di #field — tidak perlu per-kartu.
}

function onRoundWon(round) {
  document.querySelectorAll('#field .card').forEach(el => { el.style.pointerEvents = 'none'; });
  const winnerUid = round.winner?.uid;
  if (!winnerUid) return;

  get(ref(db, `rooms/${playerState.code}/players/${winnerUid}`)).then(s => {
    const name = s.val()?.name || '?';
    toast(`Ronde dimenangkan ${name}`, winnerUid === myUid ? 'good' : '');
  });

  const cardId = round.winner?.cardId;
  if (cardId) {
    const correct = document.querySelector(`#field .card[data-id="${CSS.escape(cardId)}"]`);
    if (correct) correct.classList.add('found');
  }
}

async function onCardClick(cardId, btnEl) {
  const round = playerState.currentRound;
  if (!round || round.pending) return;
  if (round.winner) return;
  if (!Array.isArray(round.cards) || !round.cards.includes(cardId)) return;
  if (round._claiming) return;

  round._claiming = true;
  try {
    const res = await runTransaction(
      ref(db, `rooms/${playerState.code}/currentRound/winner`),
      (cur) => {
        if (cur != null) return;
        return { uid: myUid, cardId };
      }
    );

    if (res.committed && res.snapshot.val()?.uid === myUid) {
      btnEl.classList.add('found');
      toast('正解! +1 poin', 'good');
    } else if (!res.committed) {
      toast('Terlambat!', 'bad');
    }
  } catch (err) {
    btnEl.classList.add('wrong');
    setTimeout(() => btnEl.classList.remove('wrong'), 500);
  } finally {
    round._claiming = false;
  }
}

// =========================================================
// PUBLIC ENTRYPOINTS
// =========================================================
export function initPlayer(opts = {}) {
  const $ = id => document.getElementById(id);

  const codeInput  = $('joinCode');
  const nameInput  = $('joinName');
  const errEl      = $('joinError');
  const btnJoin    = $('btnJoin');

  if (opts.prefilledRoom) {
    codeInput.value = opts.prefilledRoom.toUpperCase();
    nameInput.focus();
  }

  document.querySelectorAll('[data-back]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      location.href = 'play.html';
    });
  });

  codeInput?.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  });

  const lobbyUpdateCallback = (players) => {
    const list  = $('lobbyPlayers');
    const cntEl = $('lobbyCount');
    const entries = Object.entries(players).filter(([_, p]) => !p.isHost);
    if (cntEl) cntEl.textContent = entries.length;
    if (list) {
      list.innerHTML = entries.map(([id, p]) => `
        <li class="${p.online === false ? 'offline' : ''}">
          <span class="dot ${p.online === false ? 'offline' : ''}"></span>
          ${escHtml(p.name || '?')}
        </li>
      `).join('');
    }
  };

  function ensureLeaveButtons() {
    const lobbyScreen = document.getElementById('screen-multi-lobby');
    if (lobbyScreen && !document.getElementById('btnLeaveRoom')) {
      const wrapEl = document.createElement('div');
      wrapEl.className = 'leave-room-wrap';
      const btn = document.createElement('button');
      btn.id = 'btnLeaveRoom';
      btn.type = 'button';
      btn.className = 'btn';
      btn.textContent = 'Keluar Room';
      btn.addEventListener('click', async () => {
        if (!playerState.code) return;
        if (!confirm('Keluar dari room ini?')) return;
        btn.disabled = true;
        try { await playerLeaveRoom(); }
        finally { btn.disabled = false; }
      });
      wrapEl.appendChild(btn);
      (lobbyScreen.querySelector('.wrap') || lobbyScreen).appendChild(wrapEl);
    }

    const gameScreen = document.getElementById('screen-game');
    if (gameScreen && !document.getElementById('btnLeaveGame')) {
      const fab = document.createElement('button');
      fab.id = 'btnLeaveGame';
      fab.type = 'button';
      fab.className = 'btn btn-leave-fab';
      fab.textContent = 'Keluar';
      fab.addEventListener('click', async () => {
        if (!playerState.code) return;
        if (!confirm('Keluar dari room ini? Permainan tetap berjalan.')) return;
        fab.disabled = true;
        try { await playerLeaveRoom(); }
        finally { fab.disabled = false; }
      });
      gameScreen.appendChild(fab);
    }
  }

  btnJoin?.addEventListener('click', async () => {
    errEl.textContent = '';
    btnJoin.disabled = true;
    btnJoin.textContent = 'Menghubungkan...';
    try {
      await playerJoinRoom(codeInput.value, nameInput.value);
      $('lobbyCode').textContent = playerState.code;
      showScreen('screen-multi-lobby');
      playerWatchLobby(lobbyUpdateCallback);

      playerWatchMeta(
        () => playerBeginGame(),
        () => showPlayerResult(),
        () => {
          showScreen('screen-multi-lobby');
          playerWatchLobby(lobbyUpdateCallback);
        },
        () => playerExit('disbanded')
      );

      playerWatchSelf();
      ensureLeaveButtons();
    } catch (err) {
      errEl.textContent = err.message || 'Gagal bergabung.';
    } finally {
      btnJoin.disabled = false;
      btnJoin.textContent = 'Gabung ▸';
    }
  });

  $('btnAgain')?.addEventListener('click', () => {
    if (playerState.code) {
      showScreen('screen-multi-lobby');
      playerWatchLobby(lobbyUpdateCallback);
    } else {
      location.href = 'play.html';
    }
  });
  $('btnChange')?.addEventListener('click', async () => {
    if (playerState.code) await playerLeaveRoom({ silent: true });
    location.href = 'play.html';
  });
}

export function initHost() {
  const $ = id => document.getElementById(id);

  const bookListEl  = $('bookList');
  const poolInfoEl  = $('poolInfo');
  const btnCreate   = $('btnCreateRoom');
  const btnStart    = $('btnStartGame');
  const btnAgain    = $('btnPlayAgain');
  const maxPlayersInput  = $('maxPlayersInput');
  const hostMaxPlayersEl = $('hostMaxPlayers');

  const selectedBooks    = new Set();
  const selectedChapters = new Set();

  function updatePool() {
    const pool = buildPool([...selectedBooks], [...selectedChapters]);
    poolInfoEl.textContent = `${pool.length} kanji`;
    btnCreate.disabled = pool.length < MIN_POOL;
    if (pool.length > 0 && pool.length < MIN_POOL) {
      poolInfoEl.textContent += ` (min ${MIN_POOL})`;
    }
    return pool;
  }

  Object.entries(STRUCTURE).forEach(([book, chapters]) => {
    const bookDiv = document.createElement('div');
    bookDiv.className = 'book';
    bookDiv.innerHTML = `
      <div class="book-head">
        <input type="checkbox" data-book="${book}">
        <span>${book}</span>
        <span class="cnt">${chapters.length} bab</span>
      </div>
      <div class="chapters"></div>
    `;
    const chaptersEl = bookDiv.querySelector('.chapters');
    chapters.forEach(ch => {
      const lbl = document.createElement('label');
      lbl.className = 'chk';
      lbl.innerHTML = `
        <input type="checkbox" data-chapter="${book}::${ch}">
        <span>${ch}</span>
      `;
      chaptersEl.appendChild(lbl);
    });
    bookListEl.appendChild(bookDiv);
  });

  bookListEl.addEventListener('change', (e) => {
    const t = e.target;
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
      const [book] = key.split('::');
      const bookCb = bookListEl.querySelector(`[data-book="${CSS.escape(book)}"]`);
      const chapters = STRUCTURE[book] || [];
      const allChecked = chapters.every(ch => selectedChapters.has(`${book}::${ch}`));
      if (bookCb) bookCb.checked = allChecked;
      if (allChecked) selectedBooks.add(book);
      else selectedBooks.delete(book);
    }
    updatePool();
  });

  $('btnAll')?.addEventListener('click', () => {
    bookListEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.checked = true;
      if (cb.dataset.book) selectedBooks.add(cb.dataset.book);
      if (cb.dataset.chapter) selectedChapters.add(cb.dataset.chapter);
    });
    updatePool();
  });
  $('btnNone')?.addEventListener('click', () => {
    bookListEl.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
    selectedBooks.clear();
    selectedChapters.clear();
    updatePool();
  });

  updatePool();

  btnCreate?.addEventListener('click', async () => {
    btnCreate.disabled = true;
    btnCreate.textContent = 'Membuat room...';
    try {
      const pool = buildPool([...selectedBooks], [...selectedChapters]);
      const ids = pool.map(k => k.id);
      const rawMax = parseInt(maxPlayersInput?.value, 10);
      const maxP = Number.isFinite(rawMax) ? Math.max(2, Math.min(15, rawMax)) : 8;
      const code = await hostCreateRoom(ids, maxP);

      $('roomCode').textContent = code;
      if (hostMaxPlayersEl) hostMaxPlayersEl.textContent = maxP;
      $('roomInfo').hidden = false;
      $('hostRoomCode').textContent = code;
      $('poolSection').hidden = true;

      showScreen('screen-host-lobby');

      let playerCount = 0;
      hostWatchLobby((players) => {
        const entries = Object.entries(players).filter(([_, p]) => !p.isHost);
        playerCount = entries.filter(([_, p]) => p.online !== false).length;
        btnStart.disabled = playerCount < 2;
        btnStart.textContent = playerCount < 2
          ? `Mulai (butuh ≥2, saat ini ${playerCount}) ▸`
          : `Mulai (${playerCount} pemain) ▸`;

        const listEl = $('hostPlayerList');
        if (listEl) {
          listEl.innerHTML = entries.map(([id, p]) => `
            <li class="${p.online === false ? 'offline' : ''}">
              <span class="dot ${p.online === false ? 'offline' : ''}"></span>
              <span class="pname">${escHtml(p.name || '?')}</span>
              <span class="pstate">${p.online === false ? 'offline' : 'online'}</span>
              <button class="btn kick-btn" type="button" data-kick="${id}">Tendang</button>
            </li>
          `).join('');
        }
        const cntEl = $('hostPlayerCount');
        if (cntEl) cntEl.textContent = playerCount;
      });
    } catch (err) {
      toast(err.message || 'Gagal membuat room', 'bad');
      btnCreate.disabled = false;
      btnCreate.textContent = 'Buat Room';
    }
  });

  $('btnCopyCode')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('roomCode').textContent);
      toast('Kode room disalin', 'good');
    } catch {
      toast('Gagal menyalin', 'bad');
    }
  });

  btnStart?.addEventListener('click', async () => {
    if (btnStart.disabled) return;
    btnStart.disabled = true;
    try {
      await hostStartGame();
    } catch (err) {
      toast(err.message || 'Gagal memulai', 'bad');
      btnStart.disabled = false;
    }
  });

  btnAgain?.addEventListener('click', async () => {
    try {
      await hostPlayAgain();
    } catch (err) {
      toast(err.message || 'Gagal reset', 'bad');
    }
  });

  document.querySelectorAll('[data-disband]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!hostState.code) return;
      if (!confirm('Bubarkan room ini? Semua pemain akan dikeluarkan.')) return;
      btn.disabled = true;
      try {
        await hostDisbandRoom();
        toast('Room dibubarkan', 'good');
      } catch (err) {
        toast(err.message || 'Gagal membubarkan', 'bad');
      } finally {
        btn.disabled = false;
      }
    });
  });

  document.getElementById('hostPlayerList')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-kick]');
    if (!btn) return;
    const uid   = btn.dataset.kick;
    const pname = btn.closest('li')?.querySelector('.pname')?.textContent?.trim() || 'pemain';
    if (!confirm(`Keluarkan ${pname} dari room?`)) return;
    btn.disabled = true;
    try {
      await hostKickPlayer(uid);
      toast(`${pname} dikeluarkan`, 'good');
    } catch (err) {
      toast(err.message || 'Gagal mengeluarkan pemain', 'bad');
      btn.disabled = false;
    }
  });

  // Picker kanji (host memilih soal) — event delegation
  document.getElementById('kanjiPicker')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-pick]');
    if (!btn || btn.disabled) return;
    hostPickKanji(btn.dataset.pick);
  });
}
