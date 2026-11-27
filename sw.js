// Opens the app instantly from the phone's copy, and fetches the newest version in the background.
var CACHE = 'myday-v34';
self.addEventListener('install', function (e) { self.skipWaiting(); });
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || /script\.google(usercontent)?\.com$/.test(url.hostname)) return;
  var key = url.origin === location.origin && url.pathname.endsWith('/') || url.pathname.endsWith('/index.html') ? new Request(url.origin + url.pathname.replace(/index\.html$/, '')) : req;
  e.respondWith(caches.open(CACHE).then(function (c) {
    return c.match(key).then(function (hit) {
      var net = fetch(req).then(function (r) { if (r && (r.ok || r.type === 'opaque')) c.put(key, r.clone()); return r; }).catch(function () { return hit; });
      return hit || net;
    });
  }));
});
// A notification from the server (events and reminders), even when the app is closed.
self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { title: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'My day', {
    body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag, icon: 'icon-192.png', badge: 'icon-192.png',
    timestamp: d.ts || Date.now(), data: { url: d.url || './' }
  }));
});
// Tapping a notification opens the app (at the wrap-up, review, packages… when the notification says so).
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || './', what = (String(url).match(/open=(\w+)/) || [])[1] || '';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (ws) {
    for (var i = 0; i < ws.length; i++) if ('focus' in ws[i]) { if (what) ws[i].postMessage({ open: what }); return ws[i].focus(); }
    return self.clients.openWindow(url);
  }));
});
