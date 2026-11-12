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
// Score rendering (shared host & player)
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
      <span class="kanji">${card.kanji}</span>
    `;
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

  // Generate code yang belum dipakai
  let code = null;
  for (let i = 0; i < 12; i++) {
    const candidate = genRoomCode();
    const snap = await get(ref(db, `rooms/${candidate}/meta`));
    if (!snap.exists()) { code = candidate; break; }
  }
  if (!code) throw new Error('Gagal membuat kode room. Coba lagi.');

  // Bersihkan timer lama
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
  await update(ref(db, `rooms/${code}/meta`), {
    status: 'playing',
    startedAt: serverTimestamp()
  });
  hostState.used = new Set();
  hostState.roundNumber = 0;

  // Show host game screen
  showScreen('screen-host-game');

  // Cleanup listener lama sebelum memasang yang baru.
  if (hostState.unsubRound) {
    hostState.unsubRound();
    hostState.unsubRound = null;
  }

  // Watch current round for winner (host read seluruh currentRound termasuk targetId)
  hostState.unsubRound = onValue(ref(db, `rooms/${code}/currentRound`), async (snap) => {
    const data = snap.val();
    if (!data || !data.number) return;
    if (data.number !== hostState.roundNumber) return;
    if (!data.winner || data.processed) return;

    // winner sekarang berbentuk { uid, cardId }
    const winnerUid = data.winner.uid;
    if (!winnerUid) return;

    // Atomically mark processed to avoid double-scoring
    const res = await runTransaction(ref(db, `rooms/${code}/currentRound`), (cur) => {
      if (!cur || cur.processed || !cur.winner) return; // abort
      return { ...cur, processed: true };
    });
    if (!res.committed) return;

    clearTimeout(hostState.roundTimer);

    // Increment winner score
    await runTransaction(
      ref(db, `rooms/${code}/players/${winnerUid}/score`),
      s => (s || 0) + 1
    );

    // Update host status
    const wsnap = await get(ref(db, `rooms/${code}/players/${winnerUid}`));
    const wname = wsnap.val()?.name || '?';
    const statusEl = document.getElementById('hostStatus');
    if (statusEl) statusEl.textContent = `${wname} menang ronde ini! +1`;

    await delay(NEXT_ROUND_DELAY);
    hostNextRound();
  });

  hostNextRound();
}

async function hostNextRound() {
  clearTimeout(hostState.roundTimer);
  const code = hostState.code;
  const { pool, used } = hostState;

  const remaining = pool.filter(id => !used.has(id));
  if (remaining.length === 0) {
    await update(ref(db, `rooms/${code}/meta`), { status: 'finished' });
    await showHostResult();
    return;
  }

  const targetId = remaining[Math.floor(Math.random() * remaining.length)];
  used.add(targetId);

  const fieldSize = Math.min(FIELD_SIZE, pool.length);
  const others    = pool.filter(id => id !== targetId);
  const distract  = shuffle(others).slice(0, Math.max(0, fieldSize - 1));
  const cards     = shuffle([targetId, ...distract]);

  const target = KANJI.find(k => k.id === targetId);

  hostState.roundNumber++;

  await set(ref(db, `rooms/${code}/currentRound`), {
    number: hostState.roundNumber,
    targetId,
    targetMeaning: target ? target.meaning : '?',
    cards,
    remaining: pool.length - used.size,
    startedAt: serverTimestamp(),
    winner: null,
    processed: false
  });

  // Update host HUD
  const meaningEl = document.getElementById('hostMeaning');
  if (meaningEl) {
    meaningEl.textContent = target ? target.meaning : '?';
    meaningEl.classList.remove('pop');
    void meaningEl.offsetWidth;
    meaningEl.classList.add('pop');
  }
  const remainEl = document.getElementById('hostRemainTag');
  if (remainEl) remainEl.innerHTML = `SISA<br>${pool.length - used.size}`;

  const statusEl = document.getElementById('hostStatus');
  if (statusEl) statusEl.textContent = 'Menunggu pemain klik...';

  // Timeout: lock atomik via runTransaction agar tidak race dengan klik pemain.
  hostState.roundTimer = setTimeout(async () => {
    const res = await runTransaction(ref(db, `rooms/${code}/currentRound`), (cur) => {
      if (!cur || cur.winner || cur.expired) return; // abort
      return { ...cur, expired: true };
    });
    if (!res.committed) return; // sudah ada pemenang, batalkan timeout

    const statusEl2 = document.getElementById('hostStatus');
    if (statusEl2) statusEl2.textContent = 'Tidak ada yang menjawab. Lanjut...';
    await delay(NEXT_ROUND_DELAY);
    hostNextRound();
  }, ROUND_TIMEOUT_MS);
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
  clearTimeout(hostState.roundTimer);

  if (hostState.unsubRound) {
    hostState.unsubRound();
    hostState.unsubRound = null;
  }

  const playersSnap = await get(ref(db, `rooms/${code}/players`));
  const players = playersSnap.val() || {};

  const updates = {};
  Object.keys(players).forEach(pid => {
    updates[`players/${pid}/score`] = 0;
  });
  updates['meta/status'] = 'lobby';
  updates['currentRound'] = null;

  await update(ref(db, `rooms/${code}`), updates);

  hostState.used = new Set();
  hostState.roundNumber = 0;

  // FIX #2: tampilkan kembali pool selector + reset tombol Buat Room
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

  // Baca meta & players secara terpisah (currentRound tidak dibaca di sini)
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
  // Bersihkan listener lobby lama jika ada (mencegah duplikat)
  if (playerState.unsubLobby) {
    playerState.unsubLobby();
    playerState.unsubLobby = null;
  }
  playerState.unsubLobby = onValue(ref(db, `rooms/${code}/players`), (snap) => {
    const players = snap.val() || {};
    onUpdate(players);
  });
}

// =========================================================
// FIX #1: bersihkan semua listener khusus game (bukan lobby/meta)
// =========================================================
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
}

// =========================================================
// FIX #3: saat status kembali ke lobby, bersihkan listener game
// =========================================================
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

// =========================================================
// FIX #2: playerBeginGame memakai cleanup + re-subscribe players
// =========================================================
function playerBeginGame() {
  const code = playerState.code;

  showScreen('screen-game');

  // Bersihkan SEMUA listener game lama (lobby maupun game sebelumnya)
  cleanupPlayerGameListeners();

  // Skor live
  playerState.unsubPlayers = onValue(ref(db, `rooms/${code}/players`), (snap) => {
    const players = snap.val() || {};
    renderScores(document.getElementById('scores'), players, myUid);
  });

  // Round number watcher
  playerState.unsubRoundNumber = onValue(ref(db, `rooms/${code}/currentRound/number`), async (snap) => {
    const number = snap.val();
    if (!number) return;
    if (playerState.currentRound && playerState.currentRound.number === number) return;

    const [cardsSnap, remainingSnap, winnerSnap, meaningSnap] = await Promise.all([
      get(ref(db, `rooms/${code}/currentRound/cards`)),
      get(ref(db, `rooms/${code}/currentRound/remaining`)),
      get(ref(db, `rooms/${code}/currentRound/winner`)),
      get(ref(db, `rooms/${code}/currentRound/targetMeaning`))
    ]);

    const data = {
      number,
      cards: cardsSnap.val() || [],
      remaining: remainingSnap.val() || 0,
      winner: winnerSnap.val(),
      targetMeaning: meaningSnap.val() || '?'
    };
    playerState.currentRound = data;
    renderRound(data);
    if (data.winner) onRoundWon(data);
  });

  // Winner watcher
  playerState.unsubRoundWinner = onValue(ref(db, `rooms/${code}/currentRound/winner`), (snap) => {
    const winner = snap.val();
    if (!winner) return;
    if (!playerState.currentRound) return;
    if (playerState.currentRound.winner) return;

    playerState.currentRound.winner = winner;
    onRoundWon({ ...playerState.currentRound, winner });
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
  // Meaning (dari targetMeaning yang readable; targetId tidak pernah dikirim ke player)
  const meaningEl = document.getElementById('meaning');
  if (meaningEl) {
    meaningEl.textContent = round.targetMeaning || '?';
    meaningEl.classList.remove('pop');
    void meaningEl.offsetWidth;
    meaningEl.classList.add('pop');
  }

  // Remain tag
  const remainEl = document.getElementById('remainTag');
  if (remainEl && typeof round.remaining === 'number') {
    remainEl.innerHTML = `SISA<br>${round.remaining}`;
  }

  // Field
  renderField(document.getElementById('field'), round.cards);

  // Reset click handlers via re-render
  document.querySelectorAll('#field .card').forEach(el => {
    el.addEventListener('click', () => onCardClick(el.dataset.id, el));
  });
}

function onRoundWon(round) {
  document.querySelectorAll('#field .card').forEach(el => { el.style.pointerEvents = 'none'; });

  const winnerUid = round.winner?.uid;
  if (!winnerUid) return;

  get(ref(db, `rooms/${playerState.code}/players/${winnerUid}`)).then(s => {
    const name = s.val()?.name || '?';
    toast(`Ronde dimenangkan ${name}`, winnerUid === myUid ? 'good' : '');
  });

  // Highlight kartu yang benar menggunakan cardId dari winner
  const cardId = round.winner?.cardId;
  if (cardId) {
    const correct = document.querySelector(`#field .card[data-id="${CSS.escape(cardId)}"]`);
    if (correct) correct.classList.add('found');
  }
}

async function onCardClick(cardId, btnEl) {
  const round = playerState.currentRound;
  if (!round || round.winner) return;

  // Safety: jangan proses klik di luar kartu ronde ini
  if (round.cards && !round.cards.includes(cardId)) return;

  try {
    // Klaim winner: hanya boleh berhasil jika cardId === targetId (dicek rules di server).
    const res = await runTransaction(
      ref(db, `rooms/${playerState.code}/currentRound/winner`),
      (cur) => {
        if (cur != null) return; // abort: sudah ada pemenang
        return { uid: myUid, cardId };
      }
    );

    if (res.committed && res.snapshot.val()?.uid === myUid) {
      btnEl.classList.add('found');
      toast('正解! +1 poin', 'good');
    } else if (!res.committed) {
      // Abort: sudah ada pemenang lain
      toast('Terlambat!', 'bad');
    }
  } catch (err) {
    // Rules menolak → cardId bukan targetId → klik salah
    btnEl.classList.add('wrong');
    setTimeout(() => btnEl.classList.remove('wrong'), 500);
  }
}

// =========================================================
// =========================================================
// PUBLIC ENTRYPOINTS
// =========================================================
// =========================================================

/**
 * PLAYER: dipanggil dari play.html (via boot.js)
 * @param {{prefilledRoom?: string|null}} opts
 */
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

  // Back link
  document.querySelectorAll('[data-back]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      location.href = 'play.html';
    });
  });

  codeInput?.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  });

  // Callback update daftar pemain di lobby
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
          // Re-subscribe lobby karena listener game sudah di-cleanup
          playerWatchLobby(lobbyUpdateCallback);
        },
        () => {
          toast('Room telah dibubarkan oleh wasit', 'bad');
          playerState.code = null;
          playerState.name = null;
          playerState.hostUid = null;
          playerState.currentRound = null;
          const codeInput2 = document.getElementById('joinCode');
          if (codeInput2) codeInput2.value = '';
          showScreen('screen-multi-join');
        }
      );
    } catch (err) {
      errEl.textContent = err.message || 'Gagal bergabung.';
    } finally {
      btnJoin.disabled = false;
      btnJoin.textContent = 'Gabung ▸';
    }
  });

  // Result buttons
  $('btnAgain')?.addEventListener('click', () => {
    if (playerState.code) {
      showScreen('screen-multi-lobby');
      playerWatchLobby(lobbyUpdateCallback);
    } else {
      location.href = 'play.html';
    }
  });
  $('btnChange')?.addEventListener('click', () => {
    location.href = 'play.html';
  });
}

/**
 * HOST: dipanggil dari host.html
 */
export function initHost() {
  const $ = id => document.getElementById(id);

  const bookListEl  = $('bookList');
  const poolInfoEl  = $('poolInfo');
  const btnCreate   = $('btnCreateRoom');
  const btnStart    = $('btnStartGame');
  const btnAgain    = $('btnPlayAgain');
  const maxPlayersInput  = $('maxPlayersInput');
  const hostMaxPlayersEl = $('hostMaxPlayers');

  // ----- Build book/chapter selector -----
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
      const allChecked = chapters.every(ch =>
        selectedChapters.has(`${book}::${ch}`)
      );
      if (bookCb) bookCb.checked = allChecked;
      if (allChecked) selectedBooks.add(book);
      else selectedBooks.delete(book);
    }
    updatePool();
  });

  // Select all/none
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

  // ----- Create room -----
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

      // Show lobby
      showScreen('screen-host-lobby');

      // Watch lobby
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
              ${escHtml(p.name || '?')}
              <span style="margin-left:auto;font-size:.75rem;color:#9b8460;">
                ${p.online === false ? 'offline' : 'online'}
              </span>
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

  // Copy room code
  $('btnCopyCode')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('roomCode').textContent);
      toast('Kode room disalin', 'good');
    } catch {
      toast('Gagal menyalin', 'bad');
    }
  });

  // ----- Start game -----
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

  // ----- Play again -----
  btnAgain?.addEventListener('click', async () => {
    try {
      await hostPlayAgain();
    } catch (err) {
      toast(err.message || 'Gagal reset', 'bad');
    }
  });

  // ----- Disband room (lobby & result) -----
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
}
