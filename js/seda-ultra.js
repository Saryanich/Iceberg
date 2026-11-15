// SEDA Ultra v1 — isolated crypto module.
// Legacy envelope and key derivation are intentionally preserved for compatibility.

const ULTRA_PREFIX = 'SEDAULTRA1:';
const ULTRA_LAYERS = 5;

function ultraToBase64(value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

function ultraFromBase64(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

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
    return { iv: ultraToBase64(iv), cipher: new Uint8Array(cipher) };
}

async function ultraOpenBytes(cipher, ivBase64, key) {
    const iv = new Uint8Array(ultraFromBase64(ivBase64));
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
    return ULTRA_PREFIX + JSON.stringify({ v: 1, ivs, c: ultraToBase64(payload) });
}

export async function sedaUltraDecrypt(payload, keyStr) {
    try {
        if (typeof payload !== 'string' || !payload.startsWith(ULTRA_PREFIX)) return null;
        const envelope = JSON.parse(payload.slice(ULTRA_PREFIX.length));
        if (envelope?.v !== 1 || !Array.isArray(envelope.ivs) ||
            envelope.ivs.length !== ULTRA_LAYERS || typeof envelope.c !== 'string') return null;
        const keys = await deriveUltraKeys(keyStr);
        let bytes = new Uint8Array(ultraFromBase64(envelope.c));
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
 

export function isSedaChatKey(value) {
    return typeof value === 'string' && value.startsWith('SEDAKEY:');
}

// A comparison code for users to verify out-of-band. It is not an authenticated
// Signal safety number: the legacy handshake still lacks signed device identities.
export async function createSedaMessageKeyCheck(keyStr, uidA, uidB) {
    if (typeof keyStr !== 'string' || !keyStr.startsWith('SEDAKEY:')) {
        throw new Error('Некорректный ключ SEDA');
    }
    const participants = [String(uidA || ''), String(uidB || '')].sort().join('|');
    const input = new TextEncoder().encode('Iceberg SEDA safety number v1|' + participants + '|' + keyStr);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
    return Array.from(digest.subarray(0, 30), byte => String(byte % 10))
        .join('').match(/.{1,5}/g).join(' ');
}
