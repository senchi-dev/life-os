// Classic (non-module) script loaded before everything else. If the app has not shown a screen within
// BOOT_GUARD_MS (a module failed to load, or start-up hung), offer a Repair button: it deletes the cached
// app files (Cache Storage) and the service worker, then reloads from the network. Data (IndexedDB queue,
// drafts, snapshot) and the login are left untouched.
(function () {
  var BOOT_GUARD_MS = 12000;
  var root = document.documentElement;

  function repair(btn) {
    btn.disabled = true;
    btn.textContent = 'Repairing…';
    var jobs = [];
    try {
      if (window.caches) jobs.push(caches.keys().then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k); })); }));
      if (navigator.serviceWorker) jobs.push(navigator.serviceWorker.getRegistrations().then(function (rs) { return Promise.all(rs.map(function (r) { return r.unregister(); })); }));
    } catch (e) { /* fall through to reload */ }
    Promise.all(jobs).catch(function () {}).then(function () { location.reload(); });
  }

  function show() {
    if (root.dataset.booted === '1' || document.getElementById('boot-guard')) return;
    var box = document.createElement('div');
    box.id = 'boot-guard';
    box.className = 'boot-guard';
    box.setAttribute('role', 'alert');
    var title = document.createElement('p');
    title.className = 'boot-guard-title';
    title.textContent = 'Life OS is taking too long to start.';
    var text = document.createElement('p');
    text.textContent = 'Repair reloads the app files. Your data and login stay as they are.';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tap primary';
    btn.textContent = 'Repair';
    btn.addEventListener('click', function () { repair(btn); });
    box.appendChild(title);
    box.appendChild(text);
    box.appendChild(btn);
    document.body.appendChild(box);
  }

  setTimeout(show, BOOT_GUARD_MS);
})();
