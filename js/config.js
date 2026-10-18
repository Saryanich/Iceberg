// ===================================================================
// js/config.js — Конфигурация, Firebase, константы
// ===================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, browserLocalPersistence, setPersistence } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getMessaging, isSupported as fcmIsSupported } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

// ---- Firebase config ----
export const firebaseConfig = {
    apiKey: "AIzaSyA6GGJxAiao77U7_9mBUEjftmS_FnSWbIw",
    authDomain: "glob-data.firebaseapp.com",
    projectId: "glob-data",
    storageBucket: "glob-data.firebasestorage.app",
    messagingSenderId: "122757049174",
    appId: "1:122757049174:web:ebb425edd0e1a8ea9a44f7"
};

// ---- VAPID-ключ (Web Push) ----
export const VAPID_KEY = "BEnmpa3bvi8ihRD7Vbaame6WVnbApKK-r8Yldae15gv_G5onvwaZo5Z-u0Sjd-COfyp_kvjPel77D_OL77I1SMg";

// ---- Инициализация ----
export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

// ---- Персистентность авторизации (автовход) ----
setPersistence(auth, browserLocalPersistence).catch(console.error);

// ---- Messaging (инициализируется лениво, чтобы не падать в Safari) ----
let _messaging = null;
export async function getMessagingInstance() {
    if (_messaging) return _messaging;
    try {
        if (await fcmIsSupported()) {
            _messaging = getMessaging(app);
            return _messaging;
        }
    } catch (e) {
        console.warn("[FCM] Messaging не поддерживается:", e);
    }
    return null;
}

// ===================================================================
// КОНСТАНТЫ
// ===================================================================
export const APP_VERSION = "2.0.0";
export const APP_NAME = "Айсберг";
export const APP_LOGO = "https://i.ibb.co/8JY0bXs/IMG-0335.jpg";
export const SEDA_ACTIVATION_CODE = "2762263385798";

export const STICKERS = [
    '🐱','🐶','🐼','🦊','🐻','🐨','🐸','🐷','🐵','🦁','🐯','🐮','🐰','🐹','🐭','🐿️','🦔','🦇','🐺','🦝',
    '🍕','🍔','🍟','🌮','🍿','🍩','🍪','🍰','🍫','🍭',
    '⚽','🏀','🎮','🎯','🎲','🎸','🎧','📚','✏️','💡',
    '❤️','💚','💙','💜','🧡','💛','⭐','✨','🔥','💧',
    '😀','😂','🤣','😍','😎','🤔','😴','🥳','😭','😡',
    '👍','👎','👏','🙏','💪','🤝','✌️','🤞','👋','🫡'
];

export const REACTION_EMOJIS = ['👍','❤️','😂','🔥','😮','😢','🙏','🎉'];

export const MAX_MEDIA_SIZE = 700 * 1024; // 700 КиБ: запас на base64 и поля документа Firestore (лимит документа 1 МиБ)
export const MAX_PHOTO_DIMENSION = 1600;
export const MAX_STORIES = 5;
export const STORY_LIFETIME = 24 * 60 * 60 * 1000; // 24 часа

export const RATE_LIMIT = {
    messages: { count: 8, windowMs: 3000 },   // 8 сообщений за 3 сек
    media:    { count: 3, windowMs: 3000 },   // 3 медиа за 3 сек
    reactions:{ count: 15, windowMs: 5000 }
};

export const CACHE_TTL = {
    profile:  30 * 60 * 1000,     // профиль — 30 минут
    contacts: 10 * 60 * 1000,     // контакты — 10 минут
    chats:    2  * 60 * 1000,     // список чатов — 2 минуты
    messages: 5  * 60 * 1000      // сообщения чата — 5 минут
};

export const THEMES = ['dark','light','rose','blue'];
export const AUTO_DELETE_OPTIONS = [
    { hours: 0,   label: 'Выключено' },
    { hours: 24,  label: '24 часа' },
    { hours: 168, label: '7 дней' },
    { hours: 720, label: '30 дней' }
];