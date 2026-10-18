import { auth, db, SEDA_ACTIVATION_CODE } from './config.js';
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { doc, getDoc, updateDoc, setDoc, collection, query, where, getDocs, serverTimestamp, arrayUnion, limit } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { hash2FACode, sha256Hex } from './crypto.js';

const AUTH_CACHE_KEY = 'iceberg_auth_cache_v1';
const BRUTE_FORCE_KEY = 'iceberg_bruteforce_v1';
const RATE_LIMIT_KEY = 'iceberg_ratelimit_v1';

const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 5 * 60 * 1000;
const CACHE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

export const authState = {
    user: null,
    userData: null,
    pendingUser: null,
    awaitingTwoFactor: false,
    deviceFingerprint: null,
    deviceToken: null,
    currentIP: null,
    loggingIn: false,
    sedaProActivated: false,
    restoredFromCache: false
};

function getBruteForceState() {
    try { return JSON.parse(localStorage.getItem(BRUTE_FORCE_KEY) || '{"attempts":0,"lockedUntil":0}'); }
    catch { return { attempts: 0, lockedUntil: 0 }; }
}

function saveBruteForceState(state) {
    try { localStorage.setItem(BRUTE_FORCE_KEY, JSON.stringify(state)); } catch {}
}

function isLockedOut() {
    const s = getBruteForceState();
    if (s.lockedUntil && s.lockedUntil > Date.now()) return { locked: true, secondsLeft: Math.ceil((s.lockedUntil - Date.now()) / 1000) };
    if (s.lockedUntil && s.lockedUntil <= Date.now()) saveBruteForceState({ attempts: 0, lockedUntil: 0 });
    return { locked: false };
}

function recordFailedAttempt() {
    const s = getBruteForceState();
    s.attempts = (s.attempts || 0) + 1;
    if (s.attempts >= MAX_LOGIN_ATTEMPTS) s.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
    saveBruteForceState(s);
    return s;
}

function resetFailedAttempts() { saveBruteForceState({ attempts: 0, lockedUntil: 0 }); }

function checkRateLimit(key, maxCount, windowMs) {
    try {
        const all = JSON.parse(localStorage.getItem(RATE_LIMIT_KEY) || '{}');
        const now = Date.now();
        const arr = (all[key] || []).filter(t => now - t < windowMs);
        if (arr.length >= maxCount) return false;
        arr.push(now);
        all[key] = arr;
        localStorage.setItem(RATE_LIMIT_KEY, JSON.stringify(all));
        return true;
    } catch { return true; }
}

function isValidEmail(email) { return typeof email === 'string' && email.length >= 5 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function isValidGlobalId(gid) { return typeof gid === 'string' && gid.length === 22 && /^[0-9a-zA-Z]+$/.test(gid); }
function sanitizeIdentifier(raw) { return typeof raw === 'string' ? raw.trim().replace(/\s+/g, '') : ''; }

function saveAuthCache(uid, data) {
    try { localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify({ uid, data, savedAt: Date.now() })); } catch {}
}

function loadAuthCache() {
    try {
        const raw = localStorage.getItem(AUTH_CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed.uid || !parsed.data) return null;
        if (parsed.savedAt && (Date.now() - parsed.savedAt) > CACHE_MAX_AGE) {
            localStorage.removeItem(AUTH_CACHE_KEY); return null;
        }
        return parsed;
    } catch { return null; }
}

function clearAuthCache() { try { localStorage.removeItem(AUTH_CACHE_KEY); } catch {} }

// Один и тот же алгоритм отпечатка используется и при обычном входе,
// и при быстром восстановлении сессии. Раньше здесь использовались два
// разных хеша, поэтому уже сохранённое устройство распознавалось как новое.
function getPersistentDeviceToken() {
    const DEVICE_TOKEN_KEY = 'iceberg_device_token_v1';
    try {
        let token = localStorage.getItem(DEVICE_TOKEN_KEY);
        if (token && /^dev_[a-f0-9]{64}$/.test(token)) return token;

        const bytes = new Uint8Array(32);
        if (globalThis.crypto?.getRandomValues) {
            globalThis.crypto.getRandomValues(bytes);
        } else {
            // Compatibility fallback for older browsers; the token is still persisted locally.
            for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
        }
        token = 'dev_' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
        localStorage.setItem(DEVICE_TOKEN_KEY, token);
        return token;
    } catch {
        // If storage is unavailable, fall back to a stable fingerprint for this session.
        return null;
    }
}

function collectDeviceInfoSync() {
    const n = navigator;
    const raw = `${n.userAgent}|${n.language}|${screen.width}x${screen.height}|${n.platform}|${n.hardwareConcurrency || 0}`;
    let h = 2166136261;
    for (let i = 0; i < raw.length; i++) { h ^= raw.charCodeAt(i); h = Math.imul(h, 16777619); }
    authState.deviceFingerprint = 'fp_' + (h >>> 0).toString(16);
    authState.deviceToken = getPersistentDeviceToken();
    return authState.deviceFingerprint;
}

export async function collectDeviceInfo() {
    collectDeviceInfoSync();
    fetch('https://api.ipify.org?format=json')
        .then(r => r.json())
        .then(d => { authState.currentIP = d.ip || 'unknown'; })
        .catch(() => { authState.currentIP = 'unknown'; });
    return { ip: authState.currentIP || 'unknown', fingerprint: authState.deviceFingerprint };
}

function waitForAuthReady(timeoutMs = 3000) {
    if (auth.currentUser) return Promise.resolve(auth.currentUser);
    return new Promise((resolve) => {
        let done = false;
        const unsub = onAuthStateChanged(auth, (u) => { if (done) return; done = true; unsub(); resolve(u); });
        setTimeout(() => { if (done) return; done = true; try { unsub(); } catch {} resolve(auth.currentUser); }, timeoutMs);
    });
}

async function isDeviceKnown(uid) {
    try {
        const ref = doc(db, 'users', uid);
        const d = await getDoc(ref);
        const devices = d.data()?.trustedDevices || [];
        if (devices.length === 0) return false;

        const token = authState.deviceToken;
        if (token && devices.some(x => x.deviceToken === token)) return true;

        // Backward compatibility: recognize an already trusted device by its old fingerprint,
        // then attach the persistent token to that existing trusted-device record.
        const legacyIndex = devices.findIndex(x => !x.deviceToken && x.fingerprint === authState.deviceFingerprint);
        if (legacyIndex !== -1) {
            if (token) {
                const migrated = devices.map((x, i) => i === legacyIndex ? { ...x, deviceToken: token, lastUsed: new Date() } : x);
                await updateDoc(ref, { trustedDevices: migrated });
            }
            return true;
        }
        return false;
    } catch (e) { return false; }
}

async function isAccountLocked(uid) {
    try {
        const d = await getDoc(doc(db, 'users', uid));
        return d.data()?.accountLocked === true;
    } catch (e) { return false; }
}

async function addKnownDevice(uid) {
    try {
        await updateDoc(doc(db, 'users', uid), {
            trustedDevices: arrayUnion({
                deviceToken: authState.deviceToken || null,
                fingerprint: authState.deviceFingerprint, ip: authState.currentIP || 'unknown',
                userAgent: navigator.userAgent, addedAt: new Date(), lastUsed: new Date()
            })
        });
    } catch (e) {}
}

async function generate2FACode(uid) {
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    const hash = await hash2FACode(code, uid);
    try {
        await updateDoc(doc(db, 'users', uid), {
            twoFactorCodeHash: hash, twoFactorCodePlain: code,
            twoFactorCodeExpires: new Date(Date.now() + 5 * 60 * 1000),
            pendingDeviceInfo: { ip: authState.currentIP || 'unknown', userAgent: navigator.userAgent, requestedAt: new Date() }
        });
    } catch (e) {}
    return code;
}

async function verify2FACode(uid, code) {
    try {
        const d = await getDoc(doc(db, 'users', uid));
        const data = d.data();
        if (!data?.twoFactorCodeHash) return false;
        const exp = data.twoFactorCodeExpires?.toDate?.();
        if (exp && exp < new Date()) return false;
        return (await hash2FACode(code, uid)) === data.twoFactorCodeHash;
    } catch (e) { return false; }
}

export async function handleAuthLogin(user, callbacks = {}) {
    const { onSuccess, onNeed2FA, onLocked, onError } = callbacks;
    try {
        await waitForAuthReady();
        const cached = loadAuthCache();
        
        if (cached && cached.uid !== user.uid) {
            clearAuthCache();
        } else if (cached && cached.uid === user.uid && cached.data) {
            authState.user = user; authState.userData = cached.data;
            authState.sedaProActivated = cached.data.sedaProActivated || false;
            authState.restoredFromCache = true;
            onSuccess?.(user, cached.data);
            syncUserFromServer(user.uid).catch(() => {});
            return;
        }

        const ud = await getDoc(doc(db, 'users', user.uid));
        const data = ud.data();

        if (!data) { await signOut(auth); onError?.('Профиль не найден'); return; }
        if (data.accountLocked) { onLocked?.(); return; }

        if (!data.icebergAccess) {
            updateDoc(doc(db, 'users', user.uid), { icebergAccess: true, icebergLastLogin: serverTimestamp() }).catch(() => {});
        }

        const known = await isDeviceKnown(user.uid);
        if (known) {
            updateDoc(doc(db, 'users', user.uid), {
                online: true, lastSeen: serverTimestamp(),
                currentIP: authState.currentIP || 'unknown', currentDevice: authState.deviceFingerprint
            }).catch(() => {});

            authState.user = user; authState.userData = data;
            authState.sedaProActivated = data.sedaProActivated || false;
            saveAuthCache(user.uid, data);
            onSuccess?.(user, data);
        } else {
            authState.awaitingTwoFactor = true;
            authState.pendingUser = user;
            const code = await generate2FACode(user.uid);
            onNeed2FA?.(code);
        }
    } catch (e) {
        const cached = loadAuthCache();
        if (cached && cached.uid === user.uid && cached.data) {
            authState.user = user; authState.userData = cached.data;
            authState.sedaProActivated = cached.data.sedaProActivated || false;
            authState.restoredFromCache = true;
            onSuccess?.(user, cached.data);
            return;
        }
        onError?.(e.message || 'Ошибка входа');
    }
}

async function syncUserFromServer(uid) {
    try {
        const ud = await getDoc(doc(db, 'users', uid));
        if (!ud.exists()) return;
        const data = ud.data();
        if (data.accountLocked) {
            await signOut(auth);
            window.dispatchEvent(new CustomEvent('iceberg:force-logout', { detail: { reason: 'locked' } }));
            return;
        }
        authState.userData = data; authState.sedaProActivated = data.sedaProActivated || false;
        saveAuthCache(uid, data);
        window.dispatchEvent(new CustomEvent('iceberg:user-data-updated', { detail: { data } }));
        updateDoc(doc(db, 'users', uid), {
            online: true, lastSeen: serverTimestamp(),
            currentIP: authState.currentIP || 'unknown', currentDevice: authState.deviceFingerprint
        }).catch(() => {});
    } catch (e) {}
}

export async function verify2FA(code, trustDevice = false) {
    if (!authState.pendingUser) throw new Error('Нет ожидающего пользователя');
    if (!/^\d{4}$/.test(code)) return { success: false, error: 'Код должен быть из 4 цифр' };
    if (!checkRateLimit('2fa', 5, 5 * 60 * 1000)) return { success: false, error: 'Слишком много попыток. Подождите 5 минут' };

    const user = authState.pendingUser;
    if (!await verify2FACode(user.uid, code)) return { success: false, error: 'Неверный или истёкший код' };

    if (trustDevice) await addKnownDevice(user.uid);

    try {
        await updateDoc(doc(db, 'users', user.uid), {
            twoFactorCodeHash: null, twoFactorCodePlain: null, twoFactorCodeExpires: null, pendingDeviceInfo: null,
            online: true, lastSeen: serverTimestamp(),
            currentIP: authState.currentIP || 'unknown', currentDevice: authState.deviceFingerprint
        });
    } catch (e) {}

    authState.awaitingTwoFactor = false; authState.user = user; authState.pendingUser = null;
    const ud = await getDoc(doc(db, 'users', user.uid));
    authState.userData = ud.data(); authState.sedaProActivated = authState.userData?.sedaProActivated || false;
    if (authState.userData) saveAuthCache(user.uid, authState.userData);
    resetFailedAttempts();
    return { success: true, user, data: authState.userData };
}

export async function cancel2FA() {
    authState.awaitingTwoFactor = false; authState.pendingUser = null;
    try { await signOut(auth); } catch {}
}

// ===================================================================
// ВХОД (С ЗАЩИТОЙ ОТ ЗАВИСАНИЯ FIRESTORE)
// ===================================================================
export async function login(identifier, password) {
    if (authState.loggingIn) return { success: false, error: 'Вход уже выполняется. Подождите...' };
    
    const lock = isLockedOut();
    if (lock.locked) return { success: false, error: `Слишком много неудачных попыток. Подожди ${lock.secondsLeft} сек.` };
    if (!checkRateLimit('login', 10, 60 * 1000)) return { success: false, error: 'Слишком часто. Подожди минуту' };

    const cleanIdentifier = sanitizeIdentifier(identifier);
    if (!cleanIdentifier || !password) return { success: false, error: 'Заполните все поля' };
    if (password.length < 6) return { success: false, error: 'Пароль минимум 6 символов' };

    authState.loggingIn = true;

    try {
        collectDeviceInfoSync();
        collectDeviceInfo().catch(() => {});
        let email = cleanIdentifier;

        if (!cleanIdentifier.includes('@')) {
            if (!isValidGlobalId(cleanIdentifier)) { recordFailedAttempt(); return { success: false, error: 'Неверный формат Global ID' }; }
            let foundEmail = null;

            // Оборачиваем поиск в Firestore в таймаут 6 секунд
            const searchPromise = (async () => {
                try {
                    const gidDoc = await getDoc(doc(db, 'global_ids', cleanIdentifier));
                    if (gidDoc.exists()) return gidDoc.data().email;
                } catch (e) {}

                try {
                    const q = query(collection(db, 'users'), where('globalId', '==', cleanIdentifier), limit(1));
                    const snap = await getDocs(q);
                    if (!snap.empty) return snap.docs[0].data().email;
                } catch (e) {}
                return null;
            })();

            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 6000));

            try {
                foundEmail = await Promise.race([searchPromise, timeoutPromise]);
            } catch (err) {
                if (err.message === 'timeout') {
                    recordFailedAttempt();
                    return { success: false, error: 'Сервер не отвечает. Проверьте интернет.' };
                }
            }

            if (!foundEmail) { recordFailedAttempt(); return { success: false, error: 'Global ID не найден' }; }
            email = foundEmail;
        } else {
            if (!isValidEmail(cleanIdentifier)) { recordFailedAttempt(); return { success: false, error: 'Неверный формат email' }; }
        }

        const cred = await signInWithEmailAndPassword(auth, email, password);
        resetFailedAttempts();
        return { success: true, user: cred.user };
    } catch (e) {
        let msg = 'Ошибка входа';
        if (e.code === 'auth/wrong-password') { msg = 'Неверный пароль'; recordFailedAttempt(); }
        else if (e.code === 'auth/user-not-found') { msg = 'Пользователь не найден'; recordFailedAttempt(); }
        else if (e.code === 'auth/too-many-requests') { msg = 'Слишком много попыток.'; }
        else if (e.code === 'auth/invalid-email') { msg = 'Неверный email'; recordFailedAttempt(); }
        else if (e.code === 'auth/invalid-credential') { msg = 'Неверные данные'; recordFailedAttempt(); }
        else if (e.message) msg = e.message;
        return { success: false, error: msg };
    } finally {
        authState.loggingIn = false;
    }
}

export async function ensureProfile(user, profileData = {}) {
    const ref = doc(db, 'users', user.uid);
    const d = await getDoc(ref);
    if (d.exists()) return d.data();
    const globalId = profileData.globalId || '';
    const initial = {
        uid: user.uid, email: user.email, globalId, nickname: profileData.nickname || user.email.split('@')[0],
        firstName: '', lastName: '', mood: '', avatar: null,
        chats: [], contacts: [], groups: [], channels: [], stories: [], trustedDevices: [],
        accountLocked: false, icebergAccess: true, sedaProActivated: false, autoDeleteHours: 0, createdAt: serverTimestamp()
    };
    await setDoc(ref, initial);
    if (globalId) {
        try { await setDoc(doc(db, 'global_ids', globalId), { uid: user.uid, email: user.email, createdAt: serverTimestamp() }); } catch {}
    }
    return initial;
}

export async function activateSedaPro(inputCode) {
    if (!inputCode || typeof inputCode !== 'string' || inputCode.length > 50) return { success: false, error: 'Введите код' };
    if (!checkRateLimit('sedaActivate', 5, 60 * 1000)) return { success: false, error: 'Слишком много попыток.' };
    if (inputCode !== SEDA_ACTIVATION_CODE) return { success: false, error: 'Неверный код активации' };
    if (!authState.user) return { success: false, error: 'Нужно войти в аккаунт' };
    try {
        await updateDoc(doc(db, 'users', authState.user.uid), { sedaProActivated: true, sedaProActivatedAt: serverTimestamp() });
        authState.sedaProActivated = true;
        if (authState.userData) { authState.userData.sedaProActivated = true; saveAuthCache(authState.user.uid, authState.userData); }
        return { success: true };
    } catch (e) { return { success: false, error: 'Ошибка сохранения' }; }
}

export async function logout() {
    try { 
        if (authState.user) {
            updateDoc(doc(db, 'users', authState.user.uid), { online: false, lastSeen: serverTimestamp() }).catch(() => {}); 
        }
    } catch {}
    
    clearAuthCache();
    authState.user = null; 
    authState.userData = null; 
    authState.sedaProActivated = false; 
    authState.restoredFromCache = false;
    authState.awaitingTwoFactor = false;
    authState.pendingUser = null;

    window.dispatchEvent(new CustomEvent('iceberg:force-logout', { detail: { reason: 'manual' } }));

    await signOut(auth);
}

export function subscribeAuthState(handler) { return onAuthStateChanged(auth, handler); }

export function tryInstantRestore() {
    const cached = loadAuthCache();
    if (!cached) return null;
    const fbUser = auth.currentUser;
    if (!fbUser || fbUser.uid !== cached.uid) { if (fbUser && cached.uid !== fbUser.uid) clearAuthCache(); return null; }
    collectDeviceInfoSync();
    authState.user = fbUser; authState.userData = cached.data;
    authState.sedaProActivated = cached.data.sedaProActivated || false; authState.restoredFromCache = true;
    return cached.data;
}

let blockCheckInterval = null;
export function startBlockCheck(uid, onBlocked, intervalMs = 30000) {
    stopBlockCheck();
    blockCheckInterval = setInterval(async () => {
        if (!authState.user || authState.user.uid !== uid) return;
        if (await isAccountLocked(uid)) { stopBlockCheck(); onBlocked?.(); await logout(); }
    }, intervalMs);
}

export function stopBlockCheck() { if (blockCheckInterval) { clearInterval(blockCheckInterval); blockCheckInterval = null; } }