// boot.js — entry point untuk play.html
// Routing: ?mode=solo | ?mode=multi | ?room=XXXX | (tanpa param → pemilih mode)

const params = new URLSearchParams(location.search);
const mode = params.get('mode');
const room = params.get('room');

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(el => {
    el.classList.toggle('active', el.id === id);
  });
}

(async function boot() {
  if (mode === 'solo') {
    showScreen('screen-setup');
    await import('./solo.js'); // top-level auto-run
    return;
  }

  if (mode === 'multi' || room) {
    showScreen('screen-multi-join');
    const { initPlayer } = await import('./multi.js');
    if (room) {
      document.getElementById('joinCode').value = room.toUpperCase();
    }
    initPlayer({ prefilledRoom: room });
    return;
  }

  // Pemilih mode
  showScreen('screen-mode');
  document.querySelectorAll('[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      location.href = `play.html?mode=${btn.dataset.mode}`;
    });
  });
})();