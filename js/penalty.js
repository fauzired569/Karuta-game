// js/penalty.js
// Modul penalti otomatis untuk pelanggaran anti-cheat kategori curang.
// Di-import oleh multi.js: applyPenalty, isPenaltyType, PENALTY_PER_FLAG.

import {
  ref,
  runTransaction,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';

export const PENALTY_PER_FLAG = 1;

// Tipe flag yang dianggap "curang" → otomatis −1 poin.
// Tipe lain (tab_hidden, window_blur, select_attempt) HANYA dilaporkan ke host
// tanpa penalti, karena bisa terjadi tanpa niat curang.
export const PENALTY_TYPES = new Set([
  'copy_attempt',
  'cut_attempt',
  'context_menu',
  'devtools_f12',
  'devtools_shortcut',
  'shortcut_c_in_prompt',
  'shortcut_x_in_prompt',
  'shortcut_u',   // view-source
  'shortcut_s',   // save
  'shortcut_p',   // print
]);

export function isPenaltyType(type) {
  return PENALTY_TYPES.has(String(type || ''));
}

/**
 * Kurangi skor pemain sebanyak `amount` (default PENALTY_PER_FLAG).
 * Menggunakan runTransaction agar aman dari race condition (host juga bisa
 * melakukan operasi skor bersamaan).
 *
 * Rules database.rules.json mengizinkan pemain write score sendiri ASAL
 * newData < data dan keduanya number — penalti selalu menurunkan, jadi aman.
 *
 * @returns {Promise<{ committed: boolean, newScore: number|null }>}
 */
export async function applyPenalty(db, code, uid, amount = PENALTY_PER_FLAG) {
  if (!db || !code || !uid) {
    throw new Error('applyPenalty: argumen tidak lengkap');
  }
  const delta = Math.abs(Number(amount) || 0);
  if (delta <= 0) return { committed: false, newScore: null };

  const scoreRef = ref(db, `rooms/${code}/players/${uid}/score`);
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