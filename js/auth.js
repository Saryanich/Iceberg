import { auth, db, SEDA_ACTIVATION_CODE } from './config.js';
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { doc, getDoc, updateDoc, setDoc, collection, query, where, getDocs, serverTimestamp, arrayUnion, arrayRemove, limit, runTransaction, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
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
    legacyDeviceToken: null,
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
    } catch { return false; }
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

async function updatePublicPresence(uid, online) {
    if (!uid) return;
    await setDoc(doc(db, 'presence', uid), {
        uid,
        online: !!online,
        lastSeen: serverTimestamp(),
        typing: false,
        typingUntil: 0,
        updatedAt: serverTimestamp()
    }, { merge: true });
}

let deviceSessionUnsubscribe = null;
function stopDeviceSessionWatcher() {
    if (deviceSessionUnsubscribe) { try { deviceSessionUnsubscribe(); } catch {} deviceSessionUnsubscribe = null; }
}
function startDeviceSessionWatcher(uid) {
    stopDeviceSessionWatcher();
    const token = authState.deviceToken || getPersistentDeviceToken();
    if (!uid || !token) return;
    deviceSessionUnsubscribe = onSnapshot(doc(db, 'users', uid), async snap => {
        if (!authState.user || authState.user.uid !== uid || !snap.exists()) return;
        const data = snap.data() || {};
        const revoked = (data.revokedDeviceTokens || []).includes(token);
        if (data.accountLocked === true || revoked) {
            stopDeviceSessionWatcher();
            clearAuthCache();
            authState.user = null; authState.userData = null;
            authState.sedaProActivated = false; authState.restoredFromCache = false;
            window.dispatchEvent(new CustomEvent('iceberg:force-logout', {
                detail: { reason: revoked ? 'device-revoked' : 'locked' }
            }));
            try { await signOut(auth); } catch {}
        }
    }, error => console.warn('[Auth] Device session watcher error:', error));
}

// Один и тот же алгоритм отпечатка используется и при обычном входе,
// и при быстром восстановлении сессии. Раньше здесь использовались два
// разных хеша, поэтому уже сохранённое устройство распознавалось как новое.
function getPersistentDeviceToken() {
    const DEVICE_TOKEN_KEY = 'iceberg_device_token_v1';
    const SHARED_TOKEN_KEY = 'itglobal_shared_device_token';
    try {
        let shared = localStorage.getItem(SHARED_TOKEN_KEY);
        let legacy = localStorage.getItem(DEVICE_TOKEN_KEY);
        authState.legacyDeviceToken = legacy && /^dev_[a-f0-9]{64}$/.test(legacy) ? legacy : null;
        if (shared && /^[a-zA-Z0-9_-]{32,128}$/.test(shared)) return shared;

        // Reuse the previous Iceberg token as the ecosystem-wide token when possible,
        // preserving existing trusted-device records without forcing another 2FA.
        if (authState.legacyDeviceToken) {
            localStorage.setItem(SHARED_TOKEN_KEY, authState.legacyDeviceToken);
            return authState.legacyDeviceToken;
        }
        if (!globalThis.crypto?.getRandomValues) return null;
        const randomBytes = new Uint8Array(32);
        globalThis.crypto.getRandomValues(randomBytes);
        shared = Array.from(randomBytes, b => b.toString(16).padStart(2, '0')).join('');
        localStorage.setItem(SHARED_TOKEN_KEY, shared);
        localStorage.setItem(DEVICE_TOKEN_KEY, 'dev_' + shared);
        authState.legacyDeviceToken = 'dev_' + shared;
        return shared;
    } catch {
        return null;
    }
}

function collectDeviceInfoSync() {
    const n = navigator;
    // Physical-device hint intentionally excludes browser-specific values such as
    // userAgent and language, so Safari/Chrome/Firefox on the same phone can match.
    // This fingerprint is only a convenience hint, NOT cryptographic proof of identity.
    const raw = [
        n.platform || 'unknown-platform',
        `${screen.width}x${screen.height}`,
        `${screen.availWidth}x${screen.availHeight}`,
        n.maxTouchPoints || 0,
        n.hardwareConcurrency || 0,
        n.deviceMemory || 0
    ].join('|');
    let h1 = 2166136261;
    let h2 = 0x9e3779b9;
    for (let i = 0; i < raw.length; i++) {
        const code = raw.charCodeAt(i);
        h1 = Math.imul(h1 ^ code, 16777619);
        h2 = Math.imul(h2 ^ code, 2246822519);
    }
    authState.deviceFingerprint = 'fp2_' + (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
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
        const profile = d.data() || {};
        const devices = profile.trustedDevices || [];
        const token = authState.deviceToken;
        if (token && (profile.revokedDeviceTokens || []).includes(token)) return false;
        if (devices.some(x => x.deviceToken === token)) return true;

        // Migrate this browser's older Iceberg token to the shared IT Global token.
        const oldIndex = authState.legacyDeviceToken ? devices.findIndex(x => x.deviceToken === authState.legacyDeviceToken) : -1;
        if (oldIndex !== -1 && token) {
            const migrated = devices.map((x, i) => i === oldIndex ? { ...x, deviceToken: token, lastUsed: new Date() } : x);
            await updateDoc(ref, { trustedDevices: migrated });
            return true;
        }
        if (devices.length === 0) return false;

        // Browser tokens differ between browser profiles, but the physical-device hint
        // is intentionally browser-independent. Migrate a matching trusted phone to this
        // browser token without prompting for 2FA again.
        const fingerprintIndex = devices.findIndex(x =>
            x.fingerprint === authState.deviceFingerprint
            && x.fingerprintVersion === 2
        );
        if (fingerprintIndex !== -1) {
            const migrated = devices.map((x, i) => i === fingerprintIndex
                ? { ...x, deviceToken: token || x.deviceToken || null, lastUsed: new Date(), fingerprintVersion: 2 }
                : x);
            await updateDoc(ref, { trustedDevices: migrated });
            return true;
        }

        // Older records used browser-specific fingerprints. They cannot be safely
        // migrated automatically across browsers; a successful trusted-device 2FA
        // upgrades the record to the new browser-independent fingerprint.
        const legacyIndex = devices.findIndex(x => !x.deviceToken && x.fingerprint === authState.deviceFingerprint);
        if (legacyIndex !== -1) {
            const migrated = devices.map((x, i) => i === legacyIndex
                ? { ...x, deviceToken: token || null, fingerprint: authState.deviceFingerprint, fingerprintVersion: 2, lastUsed: new Date() }
                : x);
            await updateDoc(ref, { trustedDevices: migrated });
            return true;
        }
        return false;
    } catch (e) { return false; }
}

async function isAccountLocked(uid) {
    try {
        const userRef = doc(db, 'users', uid);
        let d = null;

        // A newly created Firebase Auth user can become visible to the auth observer
        // a moment before the corresponding Firestore profile write is readable.
        // Retry only a missing document; permission/network failures remain fail-closed.
        for (let attempt = 0; attempt < 4; attempt++) {
            d = await getDoc(userRef);
            if (d.exists()) break;
            if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 250));
        }

        // Never treat a profile that remains missing as an unlocked account.
        if (!d?.exists() || d.data()?.accountLocked === true) return true;
        const token = authState.deviceToken || getPersistentDeviceToken();
        return !!token && (d.data()?.revokedDeviceTokens || []).includes(token);
    } catch (e) {
        console.error('[Auth] Could not verify account lock state:', e);
        return true;
    }
}

async function addKnownDevice(uid) {
    try {
        await updateDoc(doc(db, 'users', uid), {
            revokedDeviceTokens: arrayRemove(authState.deviceToken),
            trustedDevices: arrayUnion({
                deviceToken: authState.deviceToken || null,
                fingerprint: authState.deviceFingerprint,
                fingerprintVersion: 2,
                ip: authState.currentIP || 'unknown',
                userAgent: navigator.userAgent,
                addedAt: new Date(),
                lastUsed: new Date()
            })
        });
    } catch (e) {}
}

// Лёгкое обратимое кодирование для отображения кода в Global ID.
// ВАЖНО: это обфускация, а не криптографическая защита; секреты в публичном JS скрыть нельзя.
function encode2FACodeForDisplay(code, uid) {
    const key = `${uid}|iceberg_2fa_display_v1`;
    const encoded = Array.from(String(code), (char, i) =>
        String.fromCharCode(char.charCodeAt(0) ^ key.charCodeAt(i % key.length))
    ).join('');
    return btoa(encoded);
}

async function generate2FACode(uid) {
    const range = 9000;
    const ceiling = Math.floor(0x100000000 / range) * range;
    const values = new Uint32Array(1);
    let value;
    do {
        crypto.getRandomValues(values);
        value = values[0];
    } while (value >= ceiling);
    const code = String(1000 + (value % range));
    const hash = await hash2FACode(code, uid);
    // Do not swallow persistence errors: showing a code that was not saved creates a broken flow.
    await updateDoc(doc(db, 'users', uid), {
        twoFactorCodeHash: hash,
        twoFactorCodeEncrypted: encode2FACodeForDisplay(code, uid),
        twoFactorCodeExpires: new Date(Date.now() + 5 * 60 * 1000),
        pendingDeviceInfo: { ip: authState.currentIP || 'unknown', userAgent: navigator.userAgent, requestedAt: new Date() }
    });
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
        }
        // A local cache is for offline rendering only, never proof that an account is unlocked.
        // When online, always verify the current server-side account state before opening the app.

        const ud = await getDoc(doc(db, 'users', user.uid));
        const data = ud.data();

        if (!data) { await signOut(auth); onError?.('Профиль не найден'); return; }
        if (data.accountLocked) { onLocked?.(); return; }

        if (data.icebergAccess === false) {
            await signOut(auth);
            onError?.('Доступ к Айсбергу для этого аккаунта отключён.');
            return;
        }
        updateDoc(doc(db, 'users', user.uid), { icebergLastLogin: serverTimestamp() }).catch(() => {});

        const known = await isDeviceKnown(user.uid);
        if (known) {
            updateDoc(doc(db, 'users', user.uid), {
                online: true, lastSeen: serverTimestamp(),
                currentIP: authState.currentIP || 'unknown', currentDevice: authState.deviceFingerprint
            }).catch(() => {});
            updatePublicPresence(user.uid, true).catch(error =>
                console.warn('[Presence] Не удалось включить статус:', error)
            );

            authState.user = user; authState.userData = data;
            authState.sedaProActivated = data.sedaProActivated || false;
            startDeviceSessionWatcher(user.uid);
            saveAuthCache(user.uid, data);
            onSuccess?.(user, data);
        } else {
            authState.awaitingTwoFactor = true;
            authState.pendingUser = user;
            const code = await generate2FACode(user.uid);
            onNeed2FA?.(code);
        }
    } catch (e) {
        // Only permit cached rendering when the browser explicitly reports offline.
        // Permission errors, missing documents and other online failures must not bypass checks.
        const cached = !navigator.onLine ? loadAuthCache() : null;
        if (cached && cached.uid === user.uid && cached.data) {
            authState.user = user;
            authState.userData = cached.data;
            authState.sedaProActivated = cached.data.sedaProActivated || false;
            authState.restoredFromCache = true;
            onSuccess?.(user, cached.data);
            return;
        }
        onError?.(!navigator.onLine ? 'Нет подключения. Попробуйте снова после восстановления интернета.' : (e.message || 'Ошибка входа'));
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
        updatePublicPresence(uid, true).catch(error =>
            console.warn('[Presence] Не удалось обновить статус:', error)
        );
    } catch (e) {}
}

export async function verify2FA(code, trustDevice = false) {
    if (!authState.pendingUser) throw new Error('Нет ожидающего пользователя');
    if (!/^\d{4}$/.test(code)) return { success: false, error: 'Код должен быть из 4 цифр' };
    if (!checkRateLimit('2fa', 5, 5 * 60 * 1000)) return { success: false, error: 'Слишком много попыток. Подождите 5 минут' };

    const user = authState.pendingUser;
    const userRef = doc(db, 'users', user.uid);
    let verification;
    try {
        // Consume the code atomically so two simultaneous requests cannot both use it.
        verification = await runTransaction(db, async (transaction) => {
            const snap = await transaction.get(userRef);
            if (!snap.exists()) return { success: false, error: 'Профиль не найден' };
            const data = snap.data();
            if (data.accountLocked === true) return { success: false, error: 'Аккаунт заблокирован' };
            const expires = data.twoFactorCodeExpires?.toDate?.() || null;
            if (!data.twoFactorCodeHash || (expires && expires < new Date())) {
                return { success: false, error: 'Код отсутствует или истёк. Запросите новый.' };
            }
            if ((await hash2FACode(code, user.uid)) !== data.twoFactorCodeHash) {
                return { success: false, error: 'Неверный или истёкший код' };
            }
            transaction.update(userRef, {
                twoFactorCodeHash: null, twoFactorCodeEncrypted: null, twoFactorCodePlain: null,
                twoFactorCodeExpires: null, pendingDeviceInfo: null,
                online: true, lastSeen: serverTimestamp(),
                currentIP: authState.currentIP || 'unknown',
                currentDevice: authState.deviceFingerprint
            });
            return { success: true };
        });
    } catch (error) {
        console.error('[2FA] Не удалось проверить код:', error);
        return { success: false, error: 'Не удалось проверить код. Проверьте соединение и повторите попытку.' };
    }

    if (!verification.success) return verification;
    if (trustDevice) await addKnownDevice(user.uid);

    authState.awaitingTwoFactor = false;
    authState.user = user;
    authState.pendingUser = null;
    startDeviceSessionWatcher(user.uid);
    const ud = await getDoc(userRef);
    authState.userData = ud.data();
    authState.sedaProActivated = authState.userData?.sedaProActivated || false;
    if (authState.userData) saveAuthCache(user.uid, authState.userData);
    updatePublicPresence(user.uid, true).catch(error =>
        console.warn('[Presence] Не удалось включить статус после 2FA:', error)
    );
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
    let timeoutId;
    try {
        collectDeviceInfoSync();
        collectDeviceInfo().catch(() => {});
        let email = cleanIdentifier;

        if (!cleanIdentifier.includes('@')) {
            const globalId = cleanIdentifier;
            if (!isValidGlobalId(globalId)) {
                recordFailedAttempt();
                return { success: false, error: 'Global ID должен содержать 22 латинские буквы или цифры' };
            }

            // Read only the exact Global ID document before Firebase Auth sign-in.
            // Listing /users is deliberately forbidden by Firestore Rules.
            let gidDoc;
            try {
                gidDoc = await Promise.race([
                    getDoc(doc(db, 'global_ids', globalId)),
                    new Promise((_, reject) => {
                        timeoutId = setTimeout(() => reject(new Error('GLOBAL_ID_LOOKUP_TIMEOUT')), 8000);
                    })
                ]);
            } catch (e) {
                if (e.message === 'GLOBAL_ID_LOOKUP_TIMEOUT') {
                    return { success: false, error: 'Поиск Global ID не отвечает. Проверьте интернет и правила Firestore для global_ids.' };
                }
                throw e;
            }
            if (gidDoc?.exists()) {
                const data = gidDoc.data();
                if (typeof data.email === 'string' && data.email.includes('@')) email = data.email.trim();
            }
            if (email === globalId) {
                recordFailedAttempt();
                return { success: false, error: 'Global ID не найден или Firebase Rules запрещают его поиск. Разрешите get для global_ids/{globalId} до входа.' };
            }
        } else if (!isValidEmail(cleanIdentifier)) {
            recordFailedAttempt();
            return { success: false, error: 'Неверный формат email' };
        }

        const cred = await signInWithEmailAndPassword(auth, email, password);
        resetFailedAttempts();
        return { success: true, user: cred.user };
    } catch (e) {
        let msg = 'Ошибка входа';
        if (e.code === 'auth/wrong-password') { msg = 'Неверный пароль'; recordFailedAttempt(); }
        else if (e.code === 'auth/user-not-found') { msg = 'Пользователь не найден'; recordFailedAttempt(); }
        else if (e.code === 'auth/too-many-requests') { msg = 'Слишком много попыток. Попробуйте позже.'; }
        else if (e.code === 'auth/invalid-email') { msg = 'Неверный email'; recordFailedAttempt(); }
        else if (e.code === 'auth/invalid-credential') { msg = 'Неверный Global ID/email или пароль'; recordFailedAttempt(); }
        else if (e.code === 'permission-denied' || e.code === 'firestore/permission-denied') {
            msg = 'Firebase Rules запрещают поиск Global ID. Разрешите чтение документа global_ids/{globalId} до входа.';
        } else if (e.message) msg = e.message;
        return { success: false, error: msg };
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
        authState.loggingIn = false;
    }
}

export async function ensureProfile(user, profileData = {}) {
    const ref = doc(db, 'users', user.uid);
    const d = await getDoc(ref);
    if (d.exists()) return d.data();
    const globalId = profileData.globalId || '';
    const initial = {
        uid: user.uid, role: 'user', email: user.email, globalId, nickname: profileData.nickname || '@' + globalId,
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
    stopDeviceSessionWatcher();
    try { 
        if (authState.user) {
            const uid = authState.user.uid;
            updateDoc(doc(db, 'users', uid), { online: false, lastSeen: serverTimestamp() }).catch(() => {});
            await updatePublicPresence(uid, false).catch(error =>
                console.warn('[Presence] Не удалось выключить статус:', error)
            );
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
    startDeviceSessionWatcher(fbUser.uid);
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
