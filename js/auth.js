// ===================================================================
// js/auth.js — Авторизация
//
//  • Вход по email или Global ID
//  • 2FA через SHA-256
//  • Активация SEDA Pro 3
//  • Моментальный автовход (sync из localStorage → boot → sync с Firestore)
//  • ФИКС: ожидание auth.currentUser перед запросами к Firestore
//  • ФИКС: необязательные update'ы не ломают вход
// ===================================================================

import {
    auth, db, SEDA_ACTIVATION_CODE
} from './config.js';

import {
    signInWithEmailAndPassword,
    signOut,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

import {
    doc, getDoc, updateDoc, setDoc, collection, query, where, getDocs,
    serverTimestamp, arrayUnion
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

import { hash2FACode, sha256Hex } from './crypto.js';

// ===================================================================
// СОСТОЯНИЕ
// ===================================================================
export const authState = {
    user: null,
    userData: null,
    pendingUser: null,
    awaitingTwoFactor: false,
    deviceFingerprint: null,
    currentIP: null,
    loggingIn: false,
    sedaProActivated: false,
    restoredFromCache: false
};

// ===================================================================
// ЛОКАЛЬНЫЙ КЭШ ПРОФИЛЯ ДЛЯ МГНОВЕННОГО АВТОВХОДА
// ===================================================================
const AUTH_CACHE_KEY = 'iceberg_auth_cache_v1';

function saveAuthCache(uid, data) {
    try {
        localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify({
            uid,
            data,
            savedAt: Date.now()
        }));
    } catch {}
}

function loadAuthCache() {
    try {
        const raw = localStorage.getItem(AUTH_CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed.uid || !parsed.data) return null;
        return parsed;
    } catch {
        return null;
    }
}

function clearAuthCache() {
    try { localStorage.removeItem(AUTH_CACHE_KEY); } catch {}
}

// ===================================================================
// ИНФОРМАЦИЯ ОБ УСТРОЙСТВЕ
// ===================================================================
export async function collectDeviceInfo() {
    // Сначала быстро собираем fingerprint (без сети)
    const n = navigator;
    const raw = `${n.userAgent}|${n.language}|${screen.width}x${screen.height}|${n.platform}|${n.hardwareConcurrency || 0}`;
    authState.deviceFingerprint = await sha256Hex(raw);

    // IP — асинхронно, не блокирует
    fetch('https://api.ipify.org?format=json')
        .then(r => r.json())
        .then(d => { authState.currentIP = d.ip; })
        .catch(() => { authState.currentIP = 'unknown'; });

    return {
        ip: authState.currentIP || 'unknown',
        fingerprint: authState.deviceFingerprint
    };
}

// Быстрая синхронная версия (для моментального автовхода)
function collectDeviceInfoSync() {
    const n = navigator;
    const raw = `${n.userAgent}|${n.language}|${screen.width}x${screen.height}|${n.platform}|${n.hardwareConcurrency || 0}`;
    // Простой синхронный хэш (FNV-1a) — не криптостойкий, но уникальный
    let h = 2166136261;
    for (let i = 0; i < raw.length; i++) {
        h ^= raw.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    authState.deviceFingerprint = 'fp_' + (h >>> 0).toString(16);
    return authState.deviceFingerprint;
}

// ===================================================================
// ЖДЁМ УСТАНОВКИ auth.currentUser (защита от гонки)
// ===================================================================
function waitForAuthReady(timeoutMs = 3000) {
    if (auth.currentUser) return Promise.resolve(auth.currentUser);
    return new Promise((resolve) => {
        let done = false;
        const unsub = onAuthStateChanged(auth, (u) => {
            if (done) return;
            done = true;
            unsub();
            resolve(u);
        });
        setTimeout(() => {
            if (done) return;
            done = true;
            try { unsub(); } catch {}
            resolve(auth.currentUser);
        }, timeoutMs);
    });
}

// ===================================================================
// ПРОВЕРКИ (устройство, блокировка)
// ===================================================================
async function isDeviceKnown(uid) {
    try {
        const d = await getDoc(doc(db, 'users', uid));
        const devices = d.data()?.knownDevices || [];
        return devices.some(x => x.fingerprint === authState.deviceFingerprint);
    } catch (e) {
        console.warn('[auth] isDeviceKnown error:', e.message);
        // При ошибке — считаем устройство известным, чтобы не мучить 2FA на каждом входе
        return true;
    }
}

async function isAccountLocked(uid) {
    try {
        const d = await getDoc(doc(db, 'users', uid));
        return d.data()?.accountLocked === true;
    } catch (e) {
        console.warn('[auth] isAccountLocked error:', e.message);
        return false;
    }
}

async function addKnownDevice(uid) {
    try {
        await updateDoc(doc(db, 'users', uid), {
            knownDevices: arrayUnion({
                fingerprint: authState.deviceFingerprint,
                ip: authState.currentIP || 'unknown',
                userAgent: navigator.userAgent,
                addedAt: new Date(),
                lastUsed: new Date()
            })
        });
    } catch (e) {
        console.warn('[auth] addKnownDevice error:', e.message);
    }
}

// ===================================================================
// 2FA
// ===================================================================
async function generate2FACode(uid) {
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    const hash = await hash2FACode(code, uid);
    try {
        await updateDoc(doc(db, 'users', uid), {
            twoFactorCodeHash: hash,
            twoFactorCodeExpires: new Date(Date.now() + 5 * 60 * 1000)
        });
    } catch (e) {
        console.warn('[auth] generate2FACode error:', e.message);
    }
    return code;
}

async function verify2FACode(uid, code) {
    try {
        const d = await getDoc(doc(db, 'users', uid));
        const data = d.data();
        if (!data?.twoFactorCodeHash) return false;
        const exp = data.twoFactorCodeExpires?.toDate?.();
        if (exp && exp < new Date()) return false;
        const entered = await hash2FACode(code, uid);
        return entered === data.twoFactorCodeHash;
    } catch (e) {
        console.warn('[auth] verify2FACode error:', e.message);
        return false;
    }
}

// ===================================================================
// ОСНОВНОЙ ВХОД
// ===================================================================
export async function handleAuthLogin(user, callbacks = {}) {
    const { onSuccess, onNeed2FA, onLocked, onError } = callbacks;

    try {
        // ФИКС: ждём, пока Firebase реально установит currentUser
        await waitForAuthReady();

        // Быстрый путь: если есть локальный кэш — сразу показываем UI
        const cached = loadAuthCache();
        if (cached && cached.uid === user.uid && cached.data) {
            authState.user = user;
            authState.userData = cached.data;
            authState.sedaProActivated = cached.data.sedaProActivated || false;
            authState.restoredFromCache = true;
            onSuccess?.(user, cached.data);

            // Параллельно синхронизируем с сервером
            syncUserFromServer(user.uid).catch(() => {});
            return;
        }

        // Медленный путь: нет кэша — тянем из Firestore
        const ud = await getDoc(doc(db, 'users', user.uid));
        const data = ud.data();

        if (!data) {
            await signOut(auth);
            onError?.('Профиль не найден');
            return;
        }

        if (data.accountLocked) {
            onLocked?.();
            return;
        }

        // Активируем доступ, если ещё не было
        if (!data.icebergAccess) {
            updateDoc(doc(db, 'users', user.uid), {
                icebergAccess: true,
                icebergLastLogin: serverTimestamp()
            }).catch(() => {});
        }

        // Проверяем устройство
        const known = await isDeviceKnown(user.uid);
        if (known) {
            // Обновляем метаданные в фоне — не блокируем вход
            updateDoc(doc(db, 'users', user.uid), {
                online: true,
                lastSeen: serverTimestamp(),
                currentIP: authState.currentIP || 'unknown',
                currentDevice: authState.deviceFingerprint
            }).catch(e => console.warn('[auth] online update skip:', e.message));

            authState.user = user;
            authState.userData = data;
            authState.sedaProActivated = data.sedaProActivated || false;

            saveAuthCache(user.uid, data);
            onSuccess?.(user, data);
        } else {
            // Новое устройство → 2FA
            authState.awaitingTwoFactor = true;
            authState.pendingUser = user;
            const code = await generate2FACode(user.uid);
            console.log('%c[2FA] Код подтверждения:', 'color:#64B5F6;font-weight:bold', code);
            onNeed2FA?.(code);
        }
    } catch (e) {
        console.error('[AUTH] handleAuthLogin error:', e);

        // Fallback: если Firestore недоступен, но кэш есть — пускаем по кэшу
        const cached = loadAuthCache();
        if (cached && cached.uid === user.uid && cached.data) {
            authState.user = user;
            authState.userData = cached.data;
            authState.sedaProActivated = cached.data.sedaProActivated || false;
            authState.restoredFromCache = true;
            onSuccess?.(user, cached.data);
            return;
        }

        onError?.(e.message || 'Ошибка входа');
    }
}

// ===================================================================
// ФОНОВАЯ СИНХРОНИЗАЦИЯ ПОСЛЕ АВТОВХОДА
// ===================================================================
async function syncUserFromServer(uid) {
    try {
        const ud = await getDoc(doc(db, 'users', uid));
        if (!ud.exists()) return;
        const data = ud.data();

        // Если аккаунт заблокирован — выкидываем
        if (data.accountLocked) {
            await signOut(auth);
            window.dispatchEvent(new CustomEvent('iceberg:force-logout', {
                detail: { reason: 'locked' }
            }));
            return;
        }

        authState.userData = data;
        authState.sedaProActivated = data.sedaProActivated || false;
        saveAuthCache(uid, data);

        window.dispatchEvent(new CustomEvent('iceberg:user-data-updated', {
            detail: { data }
        }));

        // Обновляем online в фоне
        updateDoc(doc(db, 'users', uid), {
            online: true,
            lastSeen: serverTimestamp(),
            currentIP: authState.currentIP || 'unknown',
            currentDevice: authState.deviceFingerprint
        }).catch(() => {});
    } catch (e) {
        console.warn('[auth] syncUserFromServer error:', e.message);
    }
}

// ===================================================================
// ПОДТВЕРЖДЕНИЕ 2FA
// ===================================================================
export async function verify2FA(code, trustDevice = false) {
    if (!authState.pendingUser) throw new Error('Нет ожидающего пользователя');
    const user = authState.pendingUser;

    const ok = await verify2FACode(user.uid, code);
    if (!ok) return { success: false, error: 'Неверный или истёкший код' };

    if (trustDevice) await addKnownDevice(user.uid);

    try {
        await updateDoc(doc(db, 'users', user.uid), {
            twoFactorCodeHash: null,
            twoFactorCodeExpires: null,
            online: true,
            lastSeen: serverTimestamp(),
            currentIP: authState.currentIP || 'unknown',
            currentDevice: authState.deviceFingerprint
        });
    } catch (e) {
        console.warn('[auth] verify2FA update error:', e.message);
    }

    authState.awaitingTwoFactor = false;
    authState.user = user;
    authState.pendingUser = null;

    const ud = await getDoc(doc(db, 'users', user.uid));
    authState.userData = ud.data();
    authState.sedaProActivated = authState.userData?.sedaProActivated || false;

    if (authState.userData) saveAuthCache(user.uid, authState.userData);

    return { success: true, user, data: authState.userData };
}

export async function cancel2FA() {
    authState.awaitingTwoFactor = false;
    authState.pendingUser = null;
    try { await signOut(auth); } catch {}
}

// ===================================================================
// ВХОД ПО EMAIL / GLOBAL ID
// ===================================================================
export async function login(identifier, password) {
    if (authState.loggingIn) throw new Error('Вход уже выполняется');
    authState.loggingIn = true;

    try {
        // Синхронный fingerprint — мгновенно
        collectDeviceInfoSync();
        // IP — в фоне
        collectDeviceInfo().catch(() => {});

        let email = identifier.trim();
        if (!email.includes('@')) {
            const q = query(collection(db, 'users'), where('globalId', '==', email));
            const s = await getDocs(q);
            if (s.empty) throw new Error('Global ID не найден');
            email = s.docs[0].data().email;
        }

        const cred = await signInWithEmailAndPassword(auth, email, password);
        return { success: true, user: cred.user };
    } catch (e) {
        let msg = 'Ошибка входа';
        if (e.code === 'auth/wrong-password') msg = 'Неверный пароль';
        else if (e.code === 'auth/user-not-found') msg = 'Пользователь не найден';
        else if (e.code === 'auth/too-many-requests') msg = 'Слишком много попыток. Попробуйте позже';
        else if (e.code === 'auth/invalid-email') msg = 'Неверный email';
        else if (e.code === 'auth/invalid-credential') msg = 'Неверные данные';
        else if (e.message) msg = e.message;
        return { success: false, error: msg };
    } finally {
        authState.loggingIn = false;
    }
}

// ===================================================================
// ГАРАНТИЯ ПРОФИЛЯ (если Firebase Auth есть, а Firestore-документа нет)
// ===================================================================
export async function ensureProfile(user, profileData = {}) {
    const ref = doc(db, 'users', user.uid);
    const d = await getDoc(ref);
    if (d.exists()) return d.data();

    const initial = {
        uid: user.uid,
        email: user.email,
        globalId: profileData.globalId || '',
        nickname: profileData.nickname || user.email.split('@')[0],
        firstName: profileData.firstName || '',
        lastName: profileData.lastName || '',
        mood: '',
        avatar: null,
        chats: [],
        contacts: [],
        groups: [],
        channels: [],
        stories: [],
        knownDevices: [],
        accountLocked: false,
        icebergAccess: true,
        sedaProActivated: false,
        autoDeleteHours: 0,
        createdAt: serverTimestamp()
    };
    await setDoc(ref, initial);
    return initial;
}

// ===================================================================
// АКТИВАЦИЯ SEDA PRO
// ===================================================================
export async function activateSedaPro(inputCode) {
    if (inputCode !== SEDA_ACTIVATION_CODE) {
        return { success: false, error: 'Неверный код активации' };
    }
    if (!authState.user) {
        return { success: false, error: 'Нужно войти в аккаунт' };
    }
    try {
        await updateDoc(doc(db, 'users', authState.user.uid), {
            sedaProActivated: true,
            sedaProActivatedAt: serverTimestamp()
        });
        authState.sedaProActivated = true;
        if (authState.userData) {
            authState.userData.sedaProActivated = true;
            saveAuthCache(authState.user.uid, authState.userData);
        }
        return { success: true };
    } catch (e) {
        return { success: false, error: 'Ошибка сохранения' };
    }
}

// ===================================================================
// ВЫХОД
// ===================================================================
export async function logout() {
    try {
        if (authState.user) {
            updateDoc(doc(db, 'users', authState.user.uid), {
                online: false,
                lastSeen: serverTimestamp()
            }).catch(() => {});
        }
    } catch {}
    clearAuthCache();
    await signOut(auth);
    authState.user = null;
    authState.userData = null;
    authState.sedaProActivated = false;
    authState.restoredFromCache = false;
}

// ===================================================================
// ПОДПИСКА НА СОСТОЯНИЕ
// ===================================================================
export function subscribeAuthState(handler) {
    return onAuthStateChanged(auth, handler);
}

// ===================================================================
// МОМЕНТАЛЬНЫЙ АВТОВХОД
// Вызывается в app.js ДО того, как сработает onAuthStateChanged.
// Возвращает данные из localStorage, если пользователь уже заходил.
// ===================================================================
export function tryInstantRestore() {
    const cached = loadAuthCache();
    if (!cached) return null;

    // Проверяем, что Firebase Auth тоже помнит пользователя
    // (иначе localStorage может остаться от другого аккаунта)
    const fbUser = auth.currentUser;
    if (!fbUser || fbUser.uid !== cached.uid) return null;

    collectDeviceInfoSync();

    authState.user = fbUser;
    authState.userData = cached.data;
    authState.sedaProActivated = cached.data.sedaProActivated || false;
    authState.restoredFromCache = true;

    return cached.data;
}

// ===================================================================
// ФОНОВАЯ ПРОВЕРКА БЛОКИРОВКИ
// ===================================================================
let blockCheckInterval = null;

export function startBlockCheck(uid, onBlocked, intervalMs = 30000) {
    stopBlockCheck();
    blockCheckInterval = setInterval(async () => {
        if (!authState.user || authState.user.uid !== uid) return;
        if (await isAccountLocked(uid)) {
            stopBlockCheck();
            onBlocked?.();
            await logout();
        }
    }, intervalMs);
}

export function stopBlockCheck() {
    if (blockCheckInterval) {
        clearInterval(blockCheckInterval);
        blockCheckInterval = null;
    }
}