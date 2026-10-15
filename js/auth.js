// ===================================================================
// js/auth.js — Авторизация
//
//  • Вход по email или Global ID
//  • 2FA через SHA-256 (вместо btoa)
//  • Активация SEDA Pro 3 (простая проверка кода)
//  • Автовход через browserLocalPersistence
//  • Защита от блокировки
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

import { hash2FACode, sha256Hex, sedaEncrypt, serializeKey } from './crypto.js';

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
    sedaProActivated: false
};

// ===================================================================
// ИНФОРМАЦИЯ ОБ УСТРОЙСТВЕ
// ===================================================================
export async function collectDeviceInfo() {
    try {
        const r = await fetch('https://api.ipify.org?format=json');
        const d = await r.json();
        authState.currentIP = d.ip;
    } catch {
        authState.currentIP = 'unknown';
    }
    const n = navigator;
    const raw = `${n.userAgent}|${n.language}|${screen.width}x${screen.height}|${n.platform}|${n.hardwareConcurrency || 0}`;
    authState.deviceFingerprint = await sha256Hex(raw);
    return {
        ip: authState.currentIP,
        fingerprint: authState.deviceFingerprint
    };
}

// ===================================================================
// ПРОВЕРКИ (устройство, блокировка)
// ===================================================================
async function isDeviceKnown(uid) {
    try {
        const d = await getDoc(doc(db, 'users', uid));
        const devices = d.data()?.knownDevices || [];
        return devices.some(x => x.fingerprint === authState.deviceFingerprint);
    } catch {
        return false;
    }
}

async function isAccountLocked(uid) {
    try {
        const d = await getDoc(doc(db, 'users', uid));
        return d.data()?.accountLocked === true;
    } catch {
        return false;
    }
}

async function addKnownDevice(uid) {
    await updateDoc(doc(db, 'users', uid), {
        knownDevices: arrayUnion({
            fingerprint: authState.deviceFingerprint,
            ip: authState.currentIP,
            userAgent: navigator.userAgent,
            addedAt: new Date(),
            lastUsed: new Date()
        })
    });
}

// ===================================================================
// 2FA — ГЕНЕРАЦИЯ И ПРОВЕРКА
// ===================================================================
async function generate2FACode(uid) {
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    const hash = await hash2FACode(code, uid);
    await updateDoc(doc(db, 'users', uid), {
        twoFactorCodeHash: hash,
        twoFactorCodeExpires: new Date(Date.now() + 5 * 60 * 1000)
    });
    return code;
}

async function verify2FACode(uid, code) {
    const d = await getDoc(doc(db, 'users', uid));
    const data = d.data();
    if (!data?.twoFactorCodeHash) return false;
    const exp = data.twoFactorCodeExpires?.toDate?.();
    if (exp && exp < new Date()) return false;
    const entered = await hash2FACode(code, uid);
    return entered === data.twoFactorCodeHash;
}

// ===================================================================
// ОСНОВНОЙ ВХОД ПОСЛЕ AUTH
// ===================================================================
export async function handleAuthLogin(user, callbacks = {}) {
    const {
        onSuccess,
        onNeed2FA,
        onLocked,
        onError
    } = callbacks;

    try {
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

        // Активируем доступ к Айсбергу, если ещё не было
        if (!data.icebergAccess) {
            await updateDoc(doc(db, 'users', user.uid), {
                icebergAccess: true,
                icebergLastLogin: serverTimestamp()
            }).catch(() => {});
        }

        // Проверяем, известно ли устройство
        if (await isDeviceKnown(user.uid)) {
            await updateDoc(doc(db, 'users', user.uid), {
                online: true,
                lastSeen: serverTimestamp(),
                currentIP: authState.currentIP,
                currentDevice: authState.deviceFingerprint
            }).catch(() => {});

            authState.user = user;
            authState.userData = data;
            authState.sedaProActivated = data.sedaProActivated || false;
            onSuccess?.(user, data);
        } else {
            // Новое устройство → 2FA
            authState.awaitingTwoFactor = true;
            authState.pendingUser = user;
            const code = await generate2FACode(user.uid);
            // Код выводим только в консоль (в реальном продукте — на email/SMS)
            console.log('%c[2FA] Код подтверждения:', 'color:#64B5F6;font-weight:bold', code);
            onNeed2FA?.(code);
        }
    } catch (e) {
        console.error('[AUTH] handleAuthLogin error:', e);
        onError?.(e.message || 'Ошибка входа');
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

    await updateDoc(doc(db, 'users', user.uid), {
        twoFactorCodeHash: null,
        twoFactorCodeExpires: null,
        online: true,
        lastSeen: serverTimestamp(),
        currentIP: authState.currentIP,
        currentDevice: authState.deviceFingerprint
    });

    authState.awaitingTwoFactor = false;
    authState.user = user;
    authState.pendingUser = null;

    const ud = await getDoc(doc(db, 'users', user.uid));
    authState.userData = ud.data();
    authState.sedaProActivated = authState.userData?.sedaProActivated || false;

    return { success: true, user, data: authState.userData };
}

export async function cancel2FA() {
    authState.awaitingTwoFactor = false;
    authState.pendingUser = null;
    try { await signOut(auth); } catch {}
}

// ===================================================================
// ВХОД ПО EMAIL ИЛИ GLOBAL ID
// ===================================================================
export async function login(identifier, password) {
    if (authState.loggingIn) throw new Error('Вход уже выполняется');
    authState.loggingIn = true;

    try {
        await collectDeviceInfo();

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
        else if (e.message) msg = e.message;
        return { success: false, error: msg };
    } finally {
        authState.loggingIn = false;
    }
}

// ===================================================================
// РЕГИСТРАЦИЯ ПРОФИЛЯ (если Firebase Auth уже создан через Global ID)
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
        if (authState.userData) authState.userData.sedaProActivated = true;
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
            await updateDoc(doc(db, 'users', authState.user.uid), {
                online: false,
                lastSeen: serverTimestamp()
            }).catch(() => {});
        }
    } catch {}
    await signOut(auth);
    authState.user = null;
    authState.userData = null;
    authState.sedaProActivated = false;
}

// ===================================================================
// ПОДПИСКА НА СОСТОЯНИЕ (для автовхода)
// ===================================================================
export function subscribeAuthState(handler) {
    return onAuthStateChanged(auth, handler);
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