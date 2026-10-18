// ===================================================================
// firebase-messaging-sw.js — Service Worker для Firebase Cloud Messaging
//
// ⚠️ ОБЯЗАТЕЛЬНО в корне репозитория (не в js/)
// Этот файл работает в фоне, когда вкладка закрыта.
// ===================================================================

importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

// ---- Конфиг Firebase (копия из config.js, т.к. SW не поддерживает ESM) ----
firebase.initializeApp({
    apiKey: "AIzaSyA6GGJxAiao77U7_9mBUEjftmS_FnSWbIw",
    authDomain: "glob-data.firebaseapp.com",
    projectId: "glob-data",
    storageBucket: "glob-data.firebasestorage.app",
    messagingSenderId: "122757049174",
    appId: "1:122757049174:web:ebb425edd0e1a8ea9a44f7"
});

const messaging = firebase.messaging();

// ===================================================================
// FCM: сообщение пришло, когда вкладка в фоне/закрыта
// ===================================================================
messaging.onBackgroundMessage((payload) => {
    console.log('[SW] Фоновое сообщение:', payload);

    const notificationTitle = payload.notification?.title
        || payload.data?.title
        || 'Айсберг';

    const notificationBody = payload.notification?.body
        || payload.data?.body
        || 'Новое сообщение';

    const icon = payload.notification?.icon
        || 'https://i.ibb.co/8JY0bXs/IMG-0335.jpg';

    const options = {
        body: notificationBody,
        icon,
        badge: icon,
        tag: payload.data?.chatId || 'iceberg_message',
        renotify: true,
        data: {
            chatId: payload.data?.chatId || null,
            senderId: payload.data?.senderId || null,
            url: payload.data?.url || '/',
            click_action: payload.notification?.click_action || '/'
        },
        vibrate: [200, 100, 200],
        requireInteraction: false
    };

    return self.registration.showNotification(notificationTitle, options);
});

// ===================================================================
// Клик по уведомлению → открыть/сфокусировать вкладку
// ===================================================================
self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    const targetUrl = event.notification.data?.url || '/';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then((clientList) => {
                // Ищем уже открытую вкладку с Айсбергом
                for (const client of clientList) {
                    if (client.url.includes(self.location.origin) && 'focus' in client) {
                        return client.focus();
                    }
                }
                // Если не нашли — открываем новую
                if (clients.openWindow) {
                    return clients.openWindow(targetUrl);
                }
            })
    );
});

// ===================================================================
// Установка / активация SW
// ===================================================================
self.addEventListener('install', (event) => {
    console.log('[SW] Установлен');
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('[SW] Активирован');
    event.waitUntil(clients.claim());
});