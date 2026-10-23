// Pulsante schermo intero: basta includere <script src="fullscreen.js"></script> in una pagina.
(function () {
  if (!document.fullscreenEnabled) return; // es. iPhone: non supportato

  var KEY = 'quizFullscreen';
  var leaving = false;
  window.addEventListener('beforeunload', function () { leaving = true; });

  function get() { try { return sessionStorage.getItem(KEY) === '1'; } catch (e) { return false; } }
  function set(v) { try { sessionStorage.setItem(KEY, v ? '1' : '0'); } catch (e) {} }

  var btn = document.createElement('button');
  btn.id = 'fullscreenBtn';
  btn.type = 'button';
  btn.style.cssText = 'position:fixed; bottom:12px; right:12px; z-index:2147483000; width:44px; height:44px;' +
    'border-radius:50%; border:none; cursor:pointer; background:rgba(0,0,0,.55); color:#fff; font-size:22px; line-height:1;' +
    'display:flex; align-items:center; justify-content:center;';

  function refresh() {
    var on = !!document.fullscreenElement;
    btn.innerText = on ? '✕' : '⛶';
    btn.title = on ? 'Esci da schermo intero' : 'Schermo intero';
  }

  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (document.fullscreenElement) {
      set(false);
      document.exitFullscreen();
    } else {
      set(true);
      document.documentElement.requestFullscreen().catch(function () {});
    }
  });

  document.addEventListener('fullscreenchange', function () {
    refresh();
    // uscito con ESC (non per cambio pagina): non rientrare da solo
    if (!document.fullscreenElement && !leaving) set(false);
  });

  // Cambiando pagina il browser esce da schermo intero: al primo click/tasto si rientra
  function reenter() {
    if (get() && !document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(function () {});
    }
    document.removeEventListener('pointerdown', reenter, true);
    document.removeEventListener('keydown', reenter, true);
  }
  document.addEventListener('pointerdown', reenter, true);
  document.addEventListener('keydown', reenter, true);

  function mount() { document.body.appendChild(btn); refresh(); }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();