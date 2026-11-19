// js/penalty.js
// Modul penalti anti-kecurangan.
//   - PENALTY_PER_FLAG : poin yang dikurangi per pelanggaran
//   - isPenaltyType()  : filter tipe flag kategori curang
//   - applyPenalty()   : transaksi pengurangan skor (race-safe)
//
// Rule yang relevan (database.rules.json):
//   players/$uid/score .write:
//     "auth != null && (auth.uid === hostUid ||
//       (auth.uid === $uid && data.isNumber() && newData.isNumber()
//        && newData.val() < data.val()))"
//   → pemain hanya boleh MENURUNKAN skor dirinya sendiri (penalti).
//   → host boleh menulis skor siapa saja (reset/finish).

import {
  ref,
  runTransaction,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';

export const PENALTY_PER_FLAG = 1;

// Hanya tipe aktif-curang yang memicu penalti.
// tab_hidden/window_blur dikecualikan karena bisa terjadi tanpa niat curang.
const PENALTY_TYPES = new Set([
  'context_menu',
  'copy_attempt',
  'cut_attempt',
  'select_attempt',
  'shortcut_c_in_prompt',
  'shortcut_x_in_prompt',
  'shortcut_a_in_prompt',
  'shortcut_p',
  'shortcut_s',
  'shortcut_u',
  'devtools_f12',
  'devtools_shortcut',
]);

export function isPenaltyType(type) {
  return typeof type === 'string' && PENALTY_TYPES.has(type);
}

export async function applyPenalty(db, code, uid, amount = PENALTY_PER_FLAG) {
  const delta = Math.abs(Number(amount) || 0);
  if (!code || !uid || !delta) return { committed: false, newScore: 0 };

  const scoreRef = ref(db, `rooms/${code}/players/${uid}/score`);
  try {
    const result = await runTransaction(
      scoreRef,
      (cur) => (typeof cur === 'number' ? cur : 0) - delta,
      { applyLocally: false }
    );
    const newScore =
      typeof result.snapshot.val() === 'number' ? result.snapshot.val() : 0;
    return { committed: !!result.committed, newScore };
  } catch (err) {
    console.warn('[penalty] transaction failed:', err);
    return { committed: false, newScore: 0 };
  }
}
