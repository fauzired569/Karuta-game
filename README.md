# 漢字かるた — Kanji Karuta

🔗 **Demo Online:** https://fauzired569.github.io/Karuta-game/

Game kartu kanji bergaya karuta: cocokkan **arti** dengan **kanji** di lapangan.
Tersedia mode **Solo** (1 pemain vs 3 bot) dan **Multiplayer** (wasit/host memandu ronde
real-time lewat Firebase Realtime Database, pemain saling berebut klik kanji yang benar).

## Menjalankan lokal

Project ini murni static site dengan ES Modules (tanpa bundler). **Wajib di-serve via HTTP**,
karena `file://` tidak akan menjalankan module import.

```bash
# Pilihan 1: npx serve
npx serve .

# Pilihan 2: python
python -m http.server 8000
