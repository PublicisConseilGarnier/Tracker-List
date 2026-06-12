/**
 * sync.js — connects the front-end to the backend (shared team state).
 *
 * Drop this file in /public and add ONE line at the end of <body> in index.html:
 *     <script src="/sync.js"></script>
 *
 * It is HTML-agnostic: it auto-detects the localStorage key the app uses by
 * looking for the entry whose JSON contains a `campaigns` array. So it works
 * with any version of the tracker without touching the app code.
 *
 * Optional config (set before this script loads):
 *     <script>window.TRACKER_API = '';            // same-origin by default
 *             window.TRACKER_TOKEN = '';          // must match server SYNC_TOKEN
 *             window.TRACKER_POLL_MS = 20000;     // background pull interval
 *     </script>
 *
 * Behaviour:
 *   - On load: pulls server state; if it differs from local, adopts it and reloads once.
 *   - On every local save: pushes to the server (debounced 1.2s). Last write wins.
 */
(function () {
  var API = (window.TRACKER_API || '') + '/api/state';
  var TOKEN = window.TRACKER_TOKEN || '';
  var POLL_MS = window.TRACKER_POLL_MS || 20000;

  var origSet = localStorage.setItem.bind(localStorage);
  var KEY = findKey();
  var lastSynced = '';
  var timer = null;
  var booting = true;

  function findKey() {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      try {
        var v = JSON.parse(localStorage.getItem(k));
        if (v && Array.isArray(v.campaigns)) return k;
      } catch (e) {}
    }
    return null;
  }

  function authHeaders(extra) {
    var h = extra || {};
    if (TOKEN) h['Authorization'] = 'Bearer ' + TOKEN;
    return h;
  }

  function toast(msg) {
    try {
      var w = document.getElementById('toastWrap');
      if (!w) return;
      var t = document.createElement('div');
      t.className = 'toast';
      t.textContent = msg;
      w.appendChild(t);
      setTimeout(function () { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(function(){ t.remove(); }, 300); }, 2000);
    } catch (e) {}
  }

  async function pull() {
    try {
      var r = await fetch(API, { headers: authHeaders() });
      if (!r.ok) return;
      var j = await r.json();
      if (!j || !j.data || !Array.isArray(j.data.campaigns)) return;
      var incoming = JSON.stringify(j.data);
      if (!KEY) KEY = findKey() || 'garnierTrackerV21';
      var current = localStorage.getItem(KEY);
      if (incoming !== current) {
        lastSynced = incoming;
        origSet(KEY, incoming);       // write WITHOUT triggering a push
        if (!booting) toast('↧ Synced from server');
        // Reload so the running app re-reads the adopted state.
        location.reload();
      } else {
        lastSynced = incoming;
      }
    } catch (e) {
      console.warn('[sync] pull failed:', e.message);
    } finally {
      booting = false;
    }
  }

  async function push(value) {
    try {
      var r = await fetch(API, {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ data: JSON.parse(value) }),
      });
      if (r.ok) { lastSynced = value; toast('↥ Saved to server'); }
      else if (r.status === 401) console.warn('[sync] push unauthorized — check TRACKER_TOKEN vs server SYNC_TOKEN');
    } catch (e) {
      console.warn('[sync] push failed:', e.message);
    }
  }

  // Intercept saves: whenever the app writes its state, mirror it to the server.
  localStorage.setItem = function (k, v) {
    origSet(k, v);
    if (!KEY) {
      try { var val = JSON.parse(v); if (val && Array.isArray(val.campaigns)) KEY = k; } catch (e) {}
    }
    if (k === KEY && v !== lastSynced) {
      clearTimeout(timer);
      timer = setTimeout(function () { push(v); }, 1200);
    }
  };

  // Expose manual controls (handy for a "Sync now" button).
  window.TrackerSync = {
    pull: pull,
    pushNow: function () { if (KEY) push(localStorage.getItem(KEY)); },
    status: function () { return { key: KEY, api: API, tokenSet: !!TOKEN }; },
  };

  // Initial pull, then background polling.
  pull();
  setInterval(pull, POLL_MS);
})();
