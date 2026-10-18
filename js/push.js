// ===================================================================
// js/push.js — Push-уведомления через Firebase Cloud Messaging
//
//  • Запрос разрешения
//  • Получение FCM-токена
//  • Сохранение токена в Firestore
//  • Foreground-сообщения (показ уведомления только когда вкладка свёрнута)
//  • Ротация токена
// ===================================================================

import { db, auth, getMessagingInstance, VAPID_KEY } from './config.js';
import { doc, updateDoc, arrayUnion, arrayRemove, getDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onMessage } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging.js";

// ===================================================================
// СОСТОЯНИЕ
// ===================================================================
let foregroundUnsub = null;
let currentToken = null;

// ===================================================================
// РЕГИСТРАЦИЯ SERVICE WORKER (два разных SW)
// ===================================================================
export async function registerServiceWorkers() {
    if (!('serviceWorker' in navigator)) {
        console.warn('[SW] Service Worker не поддерживается');
        return { main: null, fcm: null };
    }

    let mainReg = null;
    let fcmReg = null;

    // Регистрируем независимо: отсутствие необязательного sw.js не должно блокировать FCM SW.
    try {
        mainReg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
        console.log('[SW] Основной зарегистрирован:', mainReg.scope);
    } catch (e) {
        console.warn('[SW] Основной SW не зарегистрирован (sw.js отсутствует или недоступен):', e);
    }

    try {
        fcmReg = await navigator.serviceWorker.register('./firebase-messaging-sw.js', { scope: './' });
        console.log('[SW] FCM зарегистрирован:', fcmReg.scope);
    } catch (e) {
        console.warn('[SW] FCM SW не зарегистрирован:', e);
    }

    return { main: mainReg, fcm: fcmReg };
}

// ===================================================================
// ЗАПРОС РАЗРЕШЕНИЯ + ПОЛУЧЕНИЕ ТОКЕНА
// ===================================================================
export async function initPushNotifications() {
    if (!('Notification' in window)) {
        console.warn('[Push] Notification API не поддерживается');
        return { success: false, error: 'not_supported' };
    }

    const messaging = await getMessagingInstance();
    if (!messaging) {
        console.warn('[Push] Messaging недоступен');
        return { success: false, error: 'messaging_unavailable' };
    }

    // Запрос разрешения
    let permission = Notification.permission;
    if (permission === 'default') {
        permission = await Notification.requestPermission();
    }

    if (permission !== 'granted') {
        console.log('[Push] Разрешение не выдано:', permission);
        return { success: false, error: 'permission_denied' };
    }

    // Дайте браузеру время активировать SW: ранний getToken часто падает в PWA/iOS.
    try {
        if (!('serviceWorker' in navigator)) {
            return { success: false, error: 'service_worker_unavailable' };
        }
        await new Promise(resolve => setTimeout(resolve, 3000));
        let registration = await navigator.serviceWorker.getRegistration('./');
        if (!registration) {
            try {
                registration = await navigator.serviceWorker.register('./firebase-messaging-sw.js', { scope: './' });
            } catch (e) {
                console.warn('[Push] Не удалось зарегистрировать FCM SW:', e);
            }
        }
        if (registration) {
            try { await navigator.serviceWorker.ready; } catch {}
        }

        const { getToken } = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging.js");
        let token = null;
        let lastError = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                token = await getToken(messaging, {
                    vapidKey: VAPID_KEY,
                    ...(registration ? { serviceWorkerRegistration: registration } : {})
                });
                if (token) break;
            } catch (e) {
                lastError = e;
                if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        if (!token && lastError) throw lastError;

        if (!token) {
            return { success: false, error: 'no_token' };
        }

        currentToken = token;
        console.log('[Push] Токен получен:', token.substring(0, 20) + '...');

        // Сохраняем токен в Firestore
        if (auth.currentUser) {
            await saveTokenToFirestore(auth.currentUser.uid, token);
        }

        // Слушаем foreground-сообщения
        subscribeForegroundMessages(messaging);

        return { success: true, token };
    } catch (e) {
        console.error('[Push] Ошибка получения токена:', e);
        return { success: false, error: e.message };
    }
}

// ===================================================================
// СОХРАНЕНИЕ ТОКЕНА В FIRESTORE
// ===================================================================
async function saveTokenToFirestore(uid, token) {
    try {
        const ref = doc(db, 'users', uid);
        const snap = await getDoc(ref);
        const existing = snap.data()?.fcmTokens || [];

        // Если токен уже есть — не дублируем
        if (existing.includes(token)) return;

        // Убираем старые (оставляем максимум 5 последних)
        const updated = [...existing, token].slice(-5);
        await updateDoc(ref, {
            fcmTokens: updated,
            fcmTokenUpdatedAt: new Date()
        });
        console.log('[Push] Токен сохранён в Firestore');
    } catch (e) {
        console.error('[Push] Ошибка сохранения токена:', e);
    }
}

export async function removeTokenFromFirestore(uid, token) {
    try {
        await updateDoc(doc(db, 'users', uid), {
            fcmTokens: arrayRemove(token)
        });
    } catch (e) {
        console.error('[Push] Ошибка удаления токена:', e);
    }
}

// ===================================================================
// FOREGROUND-СООБЩЕНИЯ
// Показываем уведомление ТОЛЬКО если вкладка свёрнута (Вариант A)
// ===================================================================
function subscribeForegroundMessages(messaging) {
    if (foregroundUnsub) foregroundUnsub();

    foregroundUnsub = onMessage(messaging, (payload) => {
        console.log('[Push] Foreground-сообщение:', payload);

        // Если вкладка активна — не показываем уведомление (вариант A)
        if (document.visibilityState === 'visible') {
            console.log('[Push] Вкладка активна — уведомление пропущено');
            return;
        }

        const title = payload.notification?.title
            || payload.data?.title
            || 'Айсберг';
        const body = payload.notification?.body
            || payload.data?.body
            || 'Новое сообщение';

        showNotification({
            title,
            body,
            chatId: payload.data?.chatId,
            senderId: payload.data?.senderId,
            url: payload.data?.url || './'
        });
    });
}

// ===================================================================
// ПОКАЗ УВЕДОМЛЕНИЯ
// ===================================================================
export async function showNotification({ title, body, chatId, senderId, url }) {
    if (Notification.permission !== 'granted') return;

    const icon = 'https://i.ibb.co/8JY0bXs/IMG-0335.jpg';
    const options = {
        body,
        icon,
        badge: icon,
        tag: chatId || 'iceberg_message',
        renotify: true,
        vibrate: [200, 100, 200],
        data: { chatId, senderId, url: url || './' }
    };

    // Через SW (если доступен) — работает надёжнее
    if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.getRegistration('./');
        if (reg && reg.showNotification) {
            await reg.showNotification(title, options);
            return;
        }
    }

    // Fallback — напрямую
    const n = new Notification(title, options);
    n.onclick = () => {
        window.focus();
        if (url) window.location.href = url;
        n.close();
    };
}

// ===================================================================
// ОТПИСКА
// ===================================================================
export function cleanupPush() {
    if (foregroundUnsub) {
        foregroundUnsub();
        foregroundUnsub = null;
    }
}

// ===================================================================
// ОБНОВЛЕНИЕ ТОКЕНА ПРИ СМЕНЕ ПОЛЬЗОВАТЕЛЯ
// ===================================================================
export async function refreshTokenForUser(uid) {
    const messaging = await getMessagingInstance();
    if (!messaging) return;

    try {
        const { getToken } = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging.js");
        if ('serviceWorker' in navigator) {
            try { await navigator.serviceWorker.ready; } catch {}
        }
        const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration('./') : null;
        const token = await getToken(messaging, {
            vapidKey: VAPID_KEY,
            ...(registration ? { serviceWorkerRegistration: registration } : {})
        });
        if (token && token !== currentToken) {
            currentToken = token;
            await saveTokenToFirestore(uid, token);
        }
    } catch (e) {
        console.warn('[Push] refreshToken error:', e);
    }
}

// ===================================================================
// ПОДПИСКА НА КЛИК ПО УВЕДОМЛЕНИЮ (внутри приложения)
// ===================================================================
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
        const data = event.data || {};
        if (data.type === 'NOTIFICATION_CLICK' && data.chatId) {
            // Навигация — обработаем в app.js
            window.dispatchEvent(new CustomEvent('iceberg:notification-click', { detail: data }));
        }
    });
}