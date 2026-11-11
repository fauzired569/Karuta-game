// firebase-config.js
// ⚠️ File ini HANYA berisi objek konfigurasi Firebase.
// JANGAN menambahkan import SDK (firebase/app, firebase/auth, firebase/database, dll),
// JANGAN memanggil initializeApp(), getAnalytics(), atau side-effect lainnya di sini.
// Inisialisasi app/auth/db sepenuhnya menjadi tanggung jawab multi.js (initFirebase()).
// Tujuan: menghindari bare specifier error di browser dan mencegah duplicate-app.

export const firebaseConfig = {
  apiKey: "AIzaSyCD1wxxQuAf0p5oKEpqQMXhrWQSPTL8U4c",
  authDomain: "karuta-game-84e15.firebaseapp.com",
  projectId: "karuta-game-84e15",
  storageBucket: "karuta-game-84e15.firebasestorage.app",
  messagingSenderId: "121379125530",
  appId: "1:121379125530:web:874dc74eecf8f335fe14a3",
  measurementId: "G-XTN0WF01JY"
};

export default firebaseConfig;