// js/penalty.js
// Modul penalti anti-curang.
// Menyediakan helper untuk menerapkan pengurangan poin kepada pemain
// yang terdeteksi melakukan kecurangan. Skor boleh negatif.
//
// Pemakaian dari multi.js:
//   import { applyPenalty, isPenaltyType, PENALTY_PER_FLAG } from './penalty.js';
//   if (isPenaltyType(type)) await applyPenalty(db, code, uid, PENALTY_PER_FLAG);

import { ref, runTransaction } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';

/**
 * Tipe flag yang otomatis memicu penalti -1 poin.
 * Flag di luar daftar ini hanya dicatat sebagai peringatan (tanpa penalti).
 */
export const PENALTY_TYPES = new Set([
  'copy_attempt',
  'cut_attempt',
  'context_menu',
  'devtools_f12',
  'devtools_shortcut',
  'shortcut_c_in_prompt',
  'shortcut_x_in_prompt',
  'shortcut_a_in_prompt',
  'shortcut_p',
  'shortcut_s',
  'shortcut_u',
]);

/** Besar pengurangan poin per flag yang dikenai penalti. */
export const PENALTY_PER_FLAG = 1;

/** Cek apakah tipe flag ini memicu penalti. */
export function isPenaltyType(type) {
  return PENALTY_TYPES.has(type);
}

/**
 * Terapkan penalti ke skor pemain (transaksional, aman untuk konkurensi).
 * Skor boleh turun sampai negatif (0 → -1 → -2 → ...).
 *
 * @param {object} db    - instance Realtime Database
 * @param {string} code  - kode room
 * @param {string} uid   - UID pemain yang dihukum
 * @param {number} [delta=PENALTY_PER_FLAG] - jumlah pengurangan
 * @returns {Promise<{committed:boolean, oldScore:number, newScore:number}>}
 */
export async function applyPenalty(db, code, uid, delta = PENALTY_PER_FLAG) {
  if (!db || !code || !uid) return { committed: false, oldScore: 0, newScore: 0 };
  const amount = Math.max(0, Math.floor(Number(delta) || 0));
  if (amount === 0) return { committed: false, oldScore: 0, newScore: 0 };

  const scoreRef = ref(db, `rooms/${code}/players/${uid}/score`);
  let oldScore = 0;
  const res = await runTransaction(scoreRef, (cur) => {
    oldScore = Number(cur) || 0;
    return oldScore - amount;
  });
  if (!res.committed) return { committed: false, oldScore, newScore: oldScore };
  const newScore = Number(res.snapshot.val()) || 0;
  return { committed: true, oldScore, newScore };
}

/** Format skor untuk tampilan. */
export function formatScore(score) {
  const n = Number(score) || 0;
  return String(n);
}