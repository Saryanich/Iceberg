// ===================================================================
// js/crypto.js — Iceberg SEDA Ultra
// Новый формат сообщений: 5 слоёв AES-256-GCM, ключи через HKDF-SHA-256.
// Обмен ключом: ECDH P-256 + HKDF-SHA-256 + AES-256-GCM.
// ===================================================================

// Генерация совместимого контейнера ключа SEDA с CSPRNG.
// Случайная таблица нужна только как стабильный идентификатор/секретный материал;
// фактическое шифрование сообщений выполняет SEDA Ultra (AES-GCM).
export function generateSedaKey() {
    if (!globalThis.crypto?.getRandomValues) {
        throw new Error('Криптографический генератор случайных чисел недоступен');
    }
    const key = {};
    const used = new Set();
    const values = new Uint32Array(128);
    crypto.getRandomValues(values);
    let index = 0;
    for (let i = 32; i < 127; i++) {
        let n;
        let attempts = 0;
        do {
            if (index >= values.length) {
                crypto.getRandomValues(values);
                index = 0;
            }
            n = values[index++] % 1000;
            if (++attempts > 10000) throw new Error('Не удалось сгенерировать ключ SEDA');
        } while (used.has(n));
        used.add(n);
        key[i.toString(2).padStart(8, '0')] = n;
    }
    return key;
}

export function serializeKey(key) {
    const parts = [];
    for (const [bin, num] of Object.entries(key)) parts.push(`${bin}:${num}`);
    return 'SEDAKEY:' + parts.join(',');
}

// ===================================================================
// ЧАСТЬ 2: E2E-шифрование ключа SEDA (ECDH P-256 + AES-256-GCM)
// ===================================================================
const ECDH_PARAMS = { name: 'ECDH', namedCurve: 'P-256' };
const AES_PARAMS  = { name: 'AES-GCM', length: 256 };
const HKDF_SALT   = 'iceberg-seda-v1';

// Генерация пары ключей ECDH
export async function generateECDHKeyPair() {
    return await crypto.subtle.generateKey(ECDH_PARAMS, true, ['deriveKey', 'deriveBits']);
}

// Экспорт публичного ключа в base64 (отправляем через Firestore)
export async function exportPublicKey(keyPair) {
    const raw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
    return bufToBase64(raw);
}

// Импорт публичного ключа собеседника
export async function importPublicKey(base64) {
    const raw = base64ToBuf(base64);
    return await crypto.subtle.importKey('raw', raw, ECDH_PARAMS, true, []);
}

// Экспорт приватного ключа в JWK (храним в IndexedDB)
export async function exportPrivateKey(keyPair) {
    return await crypto.subtle.exportKey('jwk', keyPair.privateKey);
}

// Импорт приватного ключа из JWK
export async function importPrivateKey(jwk) {
    return await crypto.subtle.importKey('jwk', jwk, ECDH_PARAMS, true, ['deriveKey', 'deriveBits']);
}

// Восстановление полного KeyPair
export async function restoreKeyPair(publicBase64, privateJwk) {
    const publicKey = await importPublicKey(publicBase64);
    const privateKey = await importPrivateKey(privateJwk);
    return { publicKey, privateKey };
}

// Деривация общего AES-ключа (ECDH → HKDF → AES-256-GCM)
export async function deriveSharedKey(privateKey, peerPublicKey, salt = HKDF_SALT) {
    // Шаг 1: ECDH-секрет (256 бит)
    const sharedBits = await crypto.subtle.deriveBits(
        { name: 'ECDH', public: peerPublicKey },
        privateKey,
        256
    );
    // Шаг 2: HKDF → AES-256-GCM ключ
    const baseKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
    const enc = new TextEncoder();
    return await crypto.subtle.deriveKey(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: enc.encode(salt),
            info: enc.encode('AES-GCM-KEY')
        },
        baseKey,
        AES_PARAMS,
        false,
        ['encrypt', 'decrypt']
    );
}

// Шифрование строки AES-GCM
// Формат: base64(iv) + '.' + base64(cipher)
export async function aesEncrypt(plainText, aesKey) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const cipher = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        aesKey,
        enc.encode(plainText)
    );
    return bufToBase64(iv) + '.' + bufToBase64(cipher);
}

// Дешифрование AES-GCM
export async function aesDecrypt(payload, aesKey) {
    try {
        const [ivB64, cipherB64] = payload.split('.');
        if (!ivB64 || !cipherB64) return null;
        const iv = base64ToBuf(ivB64);
        const cipher = base64ToBuf(cipherB64);
        const dec = new TextDecoder();
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, cipher);
        return dec.decode(plain);
    } catch (e) {
        console.error('[AES] decrypt error:', e);
        return null;
    }
}

// ===================================================================
// SEDA Ultra v1 — пять слоёв аутентифицированного шифрования.
// ===================================================================
const ULTRA_PREFIX = 'SEDAULTRA1:';
const ULTRA_LAYERS = 5;

async function deriveUltraKeys(keyStr) {
    if (typeof keyStr !== 'string' || !keyStr.startsWith('SEDAKEY:')) {
        throw new Error('Некорректный ключ SEDA');
    }
    const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(keyStr));
    const material = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
    const salt = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('Iceberg SEDA Ultra v1'));
    const keys = [];
    for (let i = 0; i < ULTRA_LAYERS; i++) {
        keys.push(await crypto.subtle.deriveKey({
            name: 'HKDF', hash: 'SHA-256', salt,
            info: new TextEncoder().encode('Iceberg SEDA Ultra v1 / AES-256-GCM / layer ' + i)
        }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
    }
    return keys;
}

async function ultraSealBytes(bytes, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, bytes);
    return { iv: bufToBase64(iv), cipher: new Uint8Array(cipher) };
}

async function ultraOpenBytes(cipher, ivBase64, key) {
    const iv = new Uint8Array(base64ToBuf(ivBase64));
    if (iv.length !== 12) throw new Error('Некорректный AES-GCM IV');
    return new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, tagLength: 128 }, key, cipher
    ));
}

export async function sedaUltraEncryptWithKey(text, keyStr) {
    const keys = await deriveUltraKeys(keyStr);
    let payload = new TextEncoder().encode(String(text));
    const ivs = [];
    for (const key of keys) {
        const sealed = await ultraSealBytes(payload, key);
        ivs.push(sealed.iv);
        payload = sealed.cipher;
    }
    return ULTRA_PREFIX + JSON.stringify({ v: 1, ivs, c: bufToBase64(payload) });
}

export async function sedaUltraDecrypt(payload, keyStr) {
    try {
        if (typeof payload !== 'string' || !payload.startsWith(ULTRA_PREFIX)) return null;
        const envelope = JSON.parse(payload.slice(ULTRA_PREFIX.length));
        if (envelope?.v !== 1 || !Array.isArray(envelope.ivs) ||
            envelope.ivs.length !== ULTRA_LAYERS || typeof envelope.c !== 'string') return null;
        const keys = await deriveUltraKeys(keyStr);
        let bytes = new Uint8Array(base64ToBuf(envelope.c));
        for (let i = keys.length - 1; i >= 0; i--) {
            bytes = await ultraOpenBytes(bytes, envelope.ivs[i], keys[i]);
        }
        return new TextDecoder().decode(bytes);
    } catch (e) {
        console.error('[SEDA Ultra] decrypt error:', e);
        return null;
    }
}

export function isSedaUltraPayload(payload) {
    return typeof payload === 'string' && payload.startsWith(ULTRA_PREFIX);
}
 
// Базовый режим Iceberg: один AES-256-GCM слой, отдельно от SEDA Ultra.
const BASE_PREFIX = 'ICEBERGBASE1:';

async function deriveBaseKey(keyStr) {
    if (typeof keyStr !== 'string' || !keyStr.startsWith('SEDAKEY:')) throw new Error('Некорректный ключ Iceberg');
    const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(keyStr));
    const material = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
    const salt = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('Iceberg Base Encryption v1'));
    return crypto.subtle.deriveKey({
        name: 'HKDF', hash: 'SHA-256', salt,
        info: new TextEncoder().encode('Iceberg Base / AES-256-GCM / v1')
    }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function icebergBaseEncrypt(text, keyStr) {
    const key = await deriveBaseKey(keyStr);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, new TextEncoder().encode(String(text)));
    return BASE_PREFIX + JSON.stringify({ v: 1, iv: bufToBase64(iv), c: bufToBase64(cipher) });
}

export async function icebergBaseDecrypt(payload, keyStr) {
    try {
        if (typeof payload !== 'string' || !payload.startsWith(BASE_PREFIX)) return null;
        const envelope = JSON.parse(payload.slice(BASE_PREFIX.length));
        if (envelope?.v !== 1 || typeof envelope.iv !== 'string' || typeof envelope.c !== 'string') return null;
        const key = await deriveBaseKey(keyStr);
        const plain = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: new Uint8Array(base64ToBuf(envelope.iv)), tagLength: 128 },
            key, base64ToBuf(envelope.c)
        );
        return new TextDecoder().decode(plain);
    } catch (e) {
        console.error('[Iceberg Base] decrypt error:', e);
        return null;
    }
}

export function isIcebergBasePayload(payload) {
    return typeof payload === 'string' && payload.startsWith(BASE_PREFIX);
}


// ===================================================================
// ЧАСТЬ 3: SHA-256 (для 2FA и хэшей)
// ===================================================================
export async function sha256Hex(text) {
    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
    return Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

// Хэш 2FA-кода (вместо btoa)
export async function hash2FACode(code, uid) {
    return await sha256Hex(`${code}|${uid}|iceberg_2fa_salt_v1`);
}

// ===================================================================
// УТИЛИТЫ base64 / buffer
// ===================================================================
export function bufToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

export function base64ToBuf(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

// ===================================================================
// ГЕНЕРАЦИЯ ID (для чатов, групп, каналов)
// ===================================================================
export function generateId(prefix = '') {
    const rand = crypto.getRandomValues(new Uint8Array(12));
    const hex = Array.from(rand).map(b => b.toString(16).padStart(2, '0')).join('');
    return (prefix ? prefix + '_' : '') + hex;
}