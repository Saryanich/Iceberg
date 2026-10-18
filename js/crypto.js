// ===================================================================
// js/crypto.js — Шифрование
//
// 1) SEDA Pro 3 — сам алгоритм (ERCC + словарь + бинарь) остаётся
// 2) E2E — ключ SEDA шифруется через ECDH P-256 + AES-256-GCM
// 3) SHA-256 — для хэшей 2FA и других задач
// ===================================================================

// ===================================================================
// ЧАСТЬ 1: SEDA Pro 3
// ===================================================================
const ERCC_FULL = {
    'а':1.24,'б':1.63,'в':1.95,'г':1.08,'д':1.37,'е':1.41,'ж':1.79,'з':1.52,'и':1.86,'й':1.30,
    'к':1.74,'л':1.29,'м':1.57,'н':1.84,'о':1.69,'п':1.15,'р':1.48,'с':1.67,'т':1.20,'у':1.55,
    'ф':1.83,'х':1.91,'ц':1.39,'ч':1.72,'ш':1.53,'щ':1.88,'ъ':1.66,'ы':1.42,'ь':1.35,'э':1.81,
    'ю':1.47,'я':1.90,
    'А':2.246,'Б':2.632,'В':2.951,'Г':2.086,'Д':2.378,'Е':2.413,'Ж':2.799,'З':2.523,'И':2.862,
    'Й':2.308,'К':2.747,'Л':2.291,'М':2.575,'Н':2.841,'О':2.694,'П':2.158,'Р':2.487,'С':2.673,
    'Т':2.201,'У':2.554,'Ф':2.836,'Х':2.917,'Ц':2.394,'Ч':2.729,'Ш':2.531,'Щ':2.886,'Ъ':2.662,
    'Ы':2.429,'Ь':2.354,'Э':2.813,'Ю':2.477,'Я':2.906,
    'a':1.53,'b':1.87,'c':1.42,'d':1.69,'e':1.22,'f':1.77,'g':1.34,'h':1.61,'i':1.80,'j':1.28,
    'k':1.66,'l':1.35,'m':1.90,'n':1.45,'o':1.70,'p':1.19,'q':1.31,'r':1.56,'s':1.77,'t':1.88,
    'u':1.23,'v':1.62,'w':1.25,'x':1.50,'y':1.59,'z':1.74,
    'A':2.437,'B':2.651,'C':2.753,'D':2.191,'E':2.462,'F':2.518,'G':2.834,'H':2.601,'I':2.735,
    'J':2.384,'K':2.689,'L':2.402,'M':2.582,'N':2.793,'O':2.658,'P':2.204,'Q':2.534,'R':2.712,
    'S':2.227,'T':2.578,'U':2.809,'V':2.872,'W':2.475,'X':2.734,'Y':2.563,'Z':2.899,
    '!':24.5783,'"':24.9125,'#':24.3467,'$':24.1890,'%':24.6214,'&':24.8765,"'":24.2349,
    '(':24.7012,')':24.4568,'*':24.9870,'+':24.1123,',':24.5543,'-':24.7891,'.':24.3210,'/':24.6543,
    '0':24.8907,'1':24.0123,'2':24.5432,'3':24.9876,'4':24.1098,'5':24.6789,'6':24.4321,
    '7':24.8765,'8':24.2109,'9':24.7654,
    ':':24.3001,';':24.6002,'<':24.9003,'=':24.1004,'>':24.4005,'?':24.7006,'@':24.0007,
    '[':24.9034,'\\':24.3035,']':24.6036,'^':24.1037,'_':24.4038,'`':24.7039,
    '{':24.7066,'|':24.9067,'}':24.3068,'~':24.6069,' ':99.9999
};

// Обратный словарь с целочисленными ключами (фикс floating point)
const ERCC_REVERSE = {};
for (const [c, v] of Object.entries(ERCC_FULL)) {
    ERCC_REVERSE[Math.round(v * 10000)] = c;
}

function erccEncrypt(text) {
    const out = [];
    for (const c of text) {
        if (ERCC_FULL[c] !== undefined) out.push(Math.round(ERCC_FULL[c] * 10000));
        else out.push(c);
    }
    return out.join(' ');
}

function erccDecrypt(text) {
    const out = [];
    for (const part of text.split(' ')) {
        if (part === '') continue;
        const num = parseInt(part, 10);
        if (!isNaN(num) && ERCC_REVERSE[num] !== undefined) {
            out.push(ERCC_REVERSE[num]);
        } else {
            out.push(part);
        }
    }
    return out.join('');
}

// Генерация SEDA-ключа: формат оставлен совместимым со старыми ключами.
// Используем CSPRNG вместо Math.random(), чтобы новые таблицы подстановки
// нельзя было предсказать по состоянию обычного генератора случайных чисел.
export function generateSedaKey() {
    if (!globalThis.crypto?.getRandomValues) {
        throw new Error('Криптографический генератор случайных чисел недоступен');
    }

    const key = {};
    const used = new Set();
    const values = new Uint32Array(128);
    crypto.getRandomValues(values);

    for (let i = 32; i < 127; i++) {
        let n;
        let attempts = 0;
        do {
            if (attempts >= 128) {
                crypto.getRandomValues(values);
                attempts = 0;
            }
            n = values[attempts++] % 1000;
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

export function deserializeKey(str) {
    if (!str || !str.startsWith('SEDAKEY:')) return null;
    const out = {};
    for (const part of str.substring(8).split(',')) {
        const [bin, num] = part.split(':');
        if (bin && num !== undefined) out[num.trim()] = bin.trim();
    }
    return out;
}

function asciiToNumbers(text, keyMap) {
    const out = [];
    for (const c of text) {
        const code = c.charCodeAt(0);
        if (code >= 32 && code < 127) {
            const bin = code.toString(2).padStart(8, '0');
            out.push(keyMap[bin] !== undefined ? keyMap[bin] : c);
        } else {
            out.push(c);
        }
    }
    return out.join(' ');
}

function numbersToAscii(text, reverseMap) {
    const out = [];
    for (const numStr of text.split(' ')) {
        const ns = numStr.trim();
        if (reverseMap[ns] !== undefined) {
            const bin = reverseMap[ns];
            if (bin.length === 8 && /^[01]+$/.test(bin)) {
                out.push(String.fromCharCode(parseInt(bin, 2)));
            } else {
                out.push(numStr);
            }
        } else {
            out.push(numStr);
        }
    }
    return out.join('');
}

function asciiBinaryEncrypt(text) {
    const out = [];
    for (const c of text) {
        const code = c.charCodeAt(0);
        if (code < 127) out.push(code.toString(2).padStart(8, '0'));
        else out.push(c);
    }
    return out.join(' ');
}

function asciiBinaryDecrypt(text) {
    let payload = text.trim();
    // Если строка без пробелов и это чистый бинарь — разбить по 8 бит
    if (!payload.includes(' ') && payload.length > 8 && /^[01]+$/.test(payload)) {
        const arr = [];
        for (let i = 0; i < payload.length; i += 8) arr.push(payload.substring(i, i + 8));
        payload = arr.join(' ');
    }
    const out = [];
    for (const bin of payload.split(' ')) {
        if (bin.length === 8 && /^[01]+$/.test(bin)) {
            out.push(String.fromCharCode(parseInt(bin, 2)));
        } else {
            out.push(bin);
        }
    }
    return out.join('');
}

// ---- Публичное API SEDA ----

// Шифрование с автогенерацией нового ключа
export function sedaEncrypt(text) {
    const l1 = erccEncrypt(text);
    const key = generateSedaKey();
    const l2 = asciiToNumbers(l1, key);
    const l3 = asciiBinaryEncrypt(l2);
    return { encrypted: l3, key: serializeKey(key) };
}

// Дешифрование
export function sedaDecrypt(encrypted, keyStr) {
    try {
        const l2 = asciiBinaryDecrypt(encrypted);
        const reverseMap = deserializeKey(keyStr);
        if (!reverseMap) return null;
        const l1 = numbersToAscii(l2, reverseMap);
        return erccDecrypt(l1);
    } catch (e) {
        console.error('[SEDA] decrypt error:', e);
        return null;
    }
}

// Шифрование с уже существующим ключом (для сообщений)
export function sedaEncryptWithKey(text, keyStr) {
    const reverseMap = deserializeKey(keyStr);
    if (!reverseMap) return sedaEncrypt(text).encrypted;
    // Обратный словарь: { число → 8-битная строка }
    const forward = {};
    for (const [numStr, binStr] of Object.entries(reverseMap)) {
        forward[binStr] = parseInt(numStr, 10);
    }
    const l1 = erccEncrypt(text);
    const l2 = asciiToNumbers(l1, forward);
    return asciiBinaryEncrypt(l2);
}

// ===================================================================
// SEDA ULTRA v1 — дополнительный формат для новых сообщений.
// Пять последовательных AES-256-GCM слоёв с отдельными ключами HKDF-SHA-256.
// Старые SEDA Pro сообщения и ключи остаются поддержанными.
// Важно: безопасность зависит также от защиты устройства и обмена ключами.
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
            name: 'HKDF',
            hash: 'SHA-256',
            salt,
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
    const encoder = new TextEncoder();
    let payload = encoder.encode(String(text));
    const ivs = [];
    for (const key of keys) {
        const sealed = await ultraSealBytes(payload, key);
        ivs.push(sealed.iv);
        payload = sealed.cipher;
    }
    // Base64 выполняется только один раз на финальном ciphertext — важно для медиа.
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