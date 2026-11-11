// core.js — Logika murni (tanpa DOM, tanpa timer). Bisa di-unit-test.
// Ekspor: shuffle, sample, buildPool, isCorrectClick, randInt, randFloat, rollBotParams.
import { KANJI } from './data.js';

/**
 * Fisher-Yates shuffle. Mengembalikan array baru (tidak mengubah input).
 */
export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Ambil n elemen acak dari arr (tanpa pengembalian).
 * Jika n >= panjang arr, kembalikan salinan teracak dari arr.
 */
export function sample(arr, n) {
  if (n >= arr.length) return shuffle(arr);
  return shuffle(arr).slice(0, n);
}

/**
 * Bangun pool kanji terfilter.
 * @param {string[]} books    - daftar buku; [] = semua buku
 * @param {string[]} chapters - daftar bab;  [] = semua bab
 * @returns {Array}
 */
export function buildPool(books = [], chapters = []) {
  const bookSet = new Set(books || []);
  const chapterSet = new Set(chapters || []);
  return KANJI.filter(
    (k) =>
      (bookSet.size === 0 || bookSet.has(k.book)) &&
      (chapterSet.size === 0 ||
        chapterSet.has(k.chapter) ||                    // plain
        chapterSet.has(`${k.book}::${k.chapter}`))      // prefixed (dari UI)
  );
}

/**
 * Validasi klik: apakah kartu yang diklik adalah target ronde?
 * Dibandingkan lewat id (unik) agar tahan terhadap duplikasi arti.
 */
export function isCorrectClick(clickedCard, targetCard) {
  return !!clickedCard && !!targetCard && clickedCard.id === targetCard.id;
}

/**
 * Integer acak inklusif [min, max].
 */
export function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Float acak [min, max).
 */
export function randFloat(min, max) {
  return Math.random() * (max - min) + min;
}

/**
 * Parameter bot untuk satu ronde.
 * skill        : peluang benar 0,55–0,9
 * reactionTime : 20000–25000 ms (≥ 20 detik)
 */
export function rollBotParams() {
  return {
    skill: randFloat(0.55, 0.9),          // tetap
    reactionTime: randInt(20000, 25000),  // diperlambat: minimal 20 detik
  };
}