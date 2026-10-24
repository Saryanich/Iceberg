// ==================================================================
// sw.js — Основной Service Worker (PWA + офлайн-кэш + уведомления)
//
// ⚠️ ОБЯЗАТЕЛЬНО в корне репозитория (не в js/)
// ==================================================================

const CACHE_NAME = 'iceberg-v2.0.9';
const RUNTIME_CACHE = 'iceberg-runtime-v2.0.9';

// Файлы, которые кэшируем при установке (app shell)
const PRECACHE_URLS = [
    './',
    './index.html',
    './manifest.json',
    './css/style.css',
    './js/config.js',
    './js/crypto.js',
    './js/db.js',
    './js/auth.js',
    './js/ui.js',
    './js/push.js',
    './js/app.js',
    // Cache Firebase SDK modules so the app can boot offline after its first online load.
    'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js',
    'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js',
    'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js',
    'https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js',
    'https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging.js',
    'https://i.ibb.co/8JY0bXs/IMG-0335.jpg'
];

// Домены, которые НЕ кэшируем (Firebase, Firestore, аналитика)
const EXCLUDED_DOMAINS = [
    'firestore.googleapis.com',
    'identitytoolkit.googleapis.com',
    'securetoken.googleapis.com',
    'firebaseinstallations.googleapis.com',
    'fcmregistrations.googleapis.com',
    'firebasestorage.googleapis.com',
    'api.ipify.org'
];

// ===================================================================
// УСТАНОВКА — кэшируем app shell
// ===================================================================
self.addEventListener('install', (event) => {
    console.log('[SW] Установка...');
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                // Кэшируем по одному, чтобы один 404 не сломал всю установку
                return Promise.allSettled(
                    PRECACHE_URLS.map(url =>
                        cache.add(url).catch(err => {
                            console.warn('[SW] Не удалось кэшировать:', url, err);
                        })
                    )
                );
            })
            .then(() => {
                console.log('[SW] Установлен');
                return self.skipWaiting();
            })
    );
});

// ===================================================================
// АКТИВАЦИЯ — удаляем старые кэши
// ===================================================================
self.addEventListener('activate', (event) => {
    console.log('[SW] Активация...');
    event.waitUntil(
        caches.keys()
            .then((cacheNames) => {
                return Promise.all(
                    cacheNames
                        .filter(name => name !== CACHE_NAME && name !== RUNTIME_CACHE)
                        .map(name => {
                            console.log('[SW] Удаляю старый кэш:', name);
                            return caches.delete(name);
                        })
                );
            })
            .then(() => {
                console.log('[SW] Активирован');
                return self.clients.claim();
            })
    );
});

// ===================================================================
// FETCH — стратегии кэширования
// ===================================================================
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // Avoid caching opaque cross-origin responses and never intercept non-HTTP schemes.

    // Не трогаем не-GET
    if (request.method !== 'GET') return;

    // Не трогаем Firebase и сторонние API
    if (EXCLUDED_DOMAINS.some(d => url.hostname.includes(d))) return;

    // Не трогаем chrome-extension:// и т.п.
    if (!url.protocol.startsWith('http')) return;

    // Игнорируем авторизацию (чтобы не кэшировать токены)
    if (url.pathname.includes('/__/auth/')) return;

    // Стратегия: Cache First для статики, Network First для остального
    const isStatic = /\.(css|js|png|jpg|jpeg|svg|webp|ico|woff2?|ttf|eot)$/i.test(url.pathname)
        || url.pathname === '/'
        || url.pathname.endsWith('index.html');

    if (isStatic) {
        // Refresh app shell from the network first when online; use cached files offline.
        // This prevents a permanently cached broken startup script from trapping the user.
        event.respondWith(networkFirst(request));
    } else {
        event.respondWith(networkFirst(request));
    }
});

async function cacheFirst(request) {
    const cached = await caches.match(request);
    if (cached) return cached;

    try {
        const isAppShell = new URL(request.url).origin === self.location.origin
            && (/\\.(?:html|css|js|json)$/i.test(new URL(request.url).pathname) || request.mode === 'navigate');
        const networkRequest = isAppShell ? new Request(request, { cache: 'no-cache' }) : request;
        const response = await fetch(networkRequest);
        if (response && response.ok && response.type !== 'opaque') {
            const cache = await caches.open(RUNTIME_CACHE);
            cache.put(request, response.clone());
        }
        return response;
    } catch (err) {
        // Если сеть упала и кэша нет — пробуем вернуть index.html для SPA
        if (request.mode === 'navigate') {
            const fallback = await caches.match('./index.html');
            if (fallback) return fallback;
        }
        throw err;
    }
}

async function networkFirst(request) {
    try {
        const url = new URL(request.url);
        const isAppShell = url.origin === self.location.origin
            && (/\.(?:html|css|js|json)$/i.test(url.pathname) || request.mode === 'navigate');
        const networkRequest = isAppShell ? new Request(request, { cache: 'no-cache' }) : request;
        const response = await fetch(networkRequest);
        if (response && response.ok && response.type !== 'opaque') {
            const cache = await caches.open(RUNTIME_CACHE);
            cache.put(request, response.clone());
        }
        return response;
    } catch (err) {
        const cached = await caches.match(request);
        if (cached) return cached;

        // A retry URL intentionally has a cache-busting query. If the device is
        // offline, still serve the cached app shell instead of the browser error page.
        if (request.mode === 'navigate') {
            const fallback = await caches.match('./index.html') || await caches.match('./');
            if (fallback) return fallback;
        }
        // Missing optional resources should not turn offline mode into a page-wide failure.
        if (request.mode === 'navigate') {
            return new Response('Айсберг доступен в ограниченном офлайн-режиме. Подключитесь к интернету для обновления.', {
                status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
            });
        }
        return new Response('', { status: 504, statusText: 'Offline cache miss' });
    }
}

// ===================================================================
// СООБЩЕНИЯ ОТ ГЛАВНОГО ПОТОКА
// ===================================================================
self.addEventListener('message', (event) => {
    const data = event.data || {};

    if (data.type === 'SKIP_WAITING') {
        self.skipWaiting();
        return;
    }

    if (data.type === 'CLEAR_RUNTIME_CACHE') {
        event.waitUntil(
            caches.keys().then(names => Promise.all(
                names.filter(name => name.startsWith('iceberg-runtime-')).map(name => caches.delete(name))
            ))
        );
        return;
    }

    if (data.type === 'SHOW_NOTIFICATION') {
        const { title, body, icon, tag, data: notifData } = data.payload || {};
        event.waitUntil(
            self.registration.showNotification(title || 'Айсберг', {
                body: body || 'Новое сообщение',
                icon: icon || 'https://i.ibb.co/8JY0bXs/IMG-0335.jpg',
                badge: 'https://i.ibb.co/8JY0bXs/IMG-0335.jpg',
                tag: tag || 'iceberg_message',
                renotify: true,
                vibrate: [200, 100, 200],
                data: notifData || { url: '/' }
            })
        );
        return;
    }
});

// ===================================================================
// КЛИК ПО УВЕДОМЛЕНИЮ
// ===================================================================
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = event.notification.data?.url || '/';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then((clientList) => {
                for (const client of clientList) {
                    if (client.url.includes(self.location.origin) && 'focus' in client) {
                        return client.focus();
                    }
                }
                if (clients.openWindow) {
                    return clients.openWindow(targetUrl);
                }
            })
    );
});

// ===================================================================
// PUSH-СОБЫТИЕ (браузерный Push API, не FCM)
// ===================================================================
self.addEventListener('push', (event) => {
    if (!event.data) return;

    let payload = {};
    try {
        payload = event.data.json();
    } catch {
        payload = { title: 'Айсберг', body: event.data.text() };
    }

    const title = payload.title || payload.notification?.title || 'Айсберг';
    const body = payload.body || payload.notification?.body || 'Новое сообщение';

    event.waitUntil(
        self.registration.showNotification(title, {
            body,
            icon: 'https://i.ibb.co/8JY0bXs/IMG-0335.jpg',
            badge: 'https://i.ibb.co/8JY0bXs/IMG-0335.jpg',
            tag: payload.chatId || 'iceberg_message',
            renotify: true,
            vibrate: [200, 100, 200],
            data: { url: payload.url || '/' }
        })
    );
});

// ===================================================================
// ОБРАБОТКА ОШИБОК
// ===================================================================
self.addEventListener('error', (event) => {
    console.error('[SW] Ошибка:', event.error || event.message);
});

self.addEventListener('unhandledrejection', (event) => {
    console.error('[SW] Unhandled rejection:', event.reason);
});
