// SEDA Offline Delivery v1.
// The server stores public device keys and encrypted message envelopes only.
// Private ECDH keys stay in this browser's IndexedDB and are never uploaded.
import { db } from './config.js';
import * as DB from './db.js';
import {
    generateECDHKeyPair, exportPublicKey, exportPrivateKey, importPublicKey,
    importPrivateKey, deriveSharedKey, aesEncrypt, aesDecrypt,
    generateSedaKey, serializeKey, generateId
} from './crypto.js';
import { sedaUltraEncryptWithKey, sedaUltraDecrypt } from './seda-ultra.js';
import {
    collection, doc, getDocs, setDoc, serverTimestamp, limit
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

const DEVICE_STORAGE_PREFIX = 'iceberg_device_id_v1_';
const TEXT_PREFIX = 'SEDAOFFLINE1:';
const KEY_PREFIX = 'SEDAKEYENV1:';
const MAX_DEVICES_PER_USER = 20;

function getDeviceId(uid) {
    const storageKey = DEVICE_STORAGE_PREFIX + uid;
    try {
        let id = localStorage.getItem(storageKey);
        if (!id) {
            id = generateId('device');
            localStorage.setItem(storageKey, id);
        }
        return id;
    } catch (error) {
        throw new Error('Не удалось сохранить идентификатор устройства. Разрешите локальное хранилище Iceberg.');
    }
}

export async function getLocalDeviceIdentity(uid, register = true) {
    if (!uid) throw new Error('Нет пользователя для SEDA');
    const deviceId = getDeviceId(uid);
    let identity = await DB.getDeviceIdentity(deviceId);

    if (identity && identity.uid !== uid) {
        await DB.deleteDeviceIdentity(deviceId);
        identity = null;
    }

    if (!identity?.privateKey || !identity.publicKey) {
        const pair = await generateECDHKeyPair();
        const publicKey = await exportPublicKey(pair);
        const privateKey = await exportPrivateKey(pair);
        await DB.saveDeviceIdentity(deviceId, uid, publicKey, privateKey);
        identity = { deviceId, uid, publicKey, privateKey };
    }

    if (register) {
        await setDoc(
            doc(db, 'public_profiles', uid, 'devices', deviceId),
            {
                uid,
                deviceId,
                publicKey: identity.publicKey,
                algorithm: 'ECDH-P256-HKDF-SHA256',
                version: 1,
                updatedAt: serverTimestamp()
            },
            { merge: true }
        );
    }

    return {
        ...identity,
        privateKeyObject: await importPrivateKey(identity.privateKey)
    };
}

async function listRegisteredDevices(uid) {
    const snapshot = await getDocs(collection(db, 'public_profiles', uid, 'devices'));
    const records = [];
    snapshot.forEach(item => {
        const value = item.data();
        if (value?.uid === uid && value.deviceId === item.id
            && value.algorithm === 'ECDH-P256-HKDF-SHA256'
            && value.version === 1 && typeof value.publicKey === 'string') {
            records.push({
                uid,
                deviceId: item.id,
                publicKey: value.publicKey
            });
        }
    });
    return records.slice(0, MAX_DEVICES_PER_USER);
}

export async function createOfflineMessageKey(chatId, messageId, senderUid, recipientUid) {
    if (!chatId || !messageId || !senderUid || !recipientUid || senderUid === recipientUid) {
        throw new Error('Некорректные участники личного чата');
    }

    const local = await getLocalDeviceIdentity(senderUid, true);
    const [senderDevices, recipientDevices] = await Promise.all([
        listRegisteredDevices(senderUid),
        listRegisteredDevices(recipientUid)
    ]);

    // Include the current device even when its just-created public-key write has not
    // reached the server yet. Other devices are included for multi-device delivery.
    const targets = new Map();
    for (const item of [...senderDevices, ...recipientDevices]) {
        targets.set(item.uid + ':' + item.deviceId, item);
    }
    targets.set(senderUid + ':' + local.deviceId, {
        uid: senderUid, deviceId: local.deviceId, publicKey: local.publicKey
    });

    if (!recipientDevices.length) {
        throw new Error('У собеседника ещё нет зарегистрированного ключа устройства. Ему нужно хотя бы один раз открыть обновлённый Iceberg с интернетом.');
    }

    const messageKey = serializeKey(generateSedaKey());
    const envelopes = [];

    for (const target of targets.values()) {
        const ephemeral = await generateECDHKeyPair();
        const ephemeralPublicKey = await exportPublicKey(ephemeral);
        const peerPublicKey = await importPublicKey(target.publicKey);
        const salt = [
            'Iceberg SEDA offline envelope v1',
            chatId,
            messageId,
            target.uid,
            target.deviceId
        ].join('|');
        const wrappingKey = await deriveSharedKey(ephemeral.privateKey, peerPublicKey, salt);
        const wrappedKey = await aesEncrypt(messageKey, wrappingKey);
        envelopes.push({
            uid: target.uid,
            deviceId: target.deviceId,
            ephemeralPublicKey,
            wrappedKey
        });
    }

    return { messageKey, envelopes };
}

export async function encryptOfflineText(chatId, messageId, senderUid, recipientUid, plaintext) {
    const context = await createOfflineMessageKey(chatId, messageId, senderUid, recipientUid);
    const ciphertext = await sedaUltraEncryptWithKey(String(plaintext), context.messageKey);
    const payload = TEXT_PREFIX + JSON.stringify({
        v: 1,
        ciphertext,
        envelopes: context.envelopes
    });
    return { payload, messageKey: context.messageKey };
}

export async function encodeOfflineKeyEnvelope(envelopes) {
    return KEY_PREFIX + JSON.stringify({ v: 1, envelopes });
}

function parseOfflineEnvelope(payload) {
    if (typeof payload !== 'string') return null;
    if (payload.startsWith(TEXT_PREFIX)) {
        const data = JSON.parse(payload.slice(TEXT_PREFIX.length));
        return data?.v === 1 && typeof data.ciphertext === 'string' && Array.isArray(data.envelopes)
            ? { ciphertext: data.ciphertext, envelopes: data.envelopes }
            : null;
    }
    if (payload.startsWith(KEY_PREFIX)) {
        const data = JSON.parse(payload.slice(KEY_PREFIX.length));
        return data?.v === 1 && Array.isArray(data.envelopes)
            ? { ciphertext: null, envelopes: data.envelopes }
            : null;
    }
    return null;
}

export async function decryptOfflineMessage(chatId, messageId, payload, uid) {
    const parsed = parseOfflineEnvelope(payload);
    if (!parsed) return null;

    const deviceId = getDeviceId(uid);
    const target = parsed.envelopes.find(item => item?.uid === uid && item?.deviceId === deviceId);
    if (!target || typeof target.ephemeralPublicKey !== 'string' || typeof target.wrappedKey !== 'string') {
        return null;
    }

    const identity = await DB.getDeviceIdentity(deviceId);
    if (!identity?.privateKey || identity.uid !== uid) return null;

    const privateKey = await importPrivateKey(identity.privateKey);
    const ephemeralPublicKey = await importPublicKey(target.ephemeralPublicKey);
    const salt = [
        'Iceberg SEDA offline envelope v1',
        chatId,
        messageId,
        uid,
        deviceId
    ].join('|');
    const wrappingKey = await deriveSharedKey(privateKey, ephemeralPublicKey, salt);
    const messageKey = await aesDecrypt(target.wrappedKey, wrappingKey);
    if (!messageKey?.startsWith('SEDAKEY:')) return null;

    const text = parsed.ciphertext ? await sedaUltraDecrypt(parsed.ciphertext, messageKey) : null;
    if (parsed.ciphertext && text === null) return null;
    return { messageKey, text };
}

export function isOfflineTextPayload(value) {
    return typeof value === 'string' && value.startsWith(TEXT_PREFIX);
}

export function isOfflineKeyEnvelope(value) {
    return typeof value === 'string' && value.startsWith(KEY_PREFIX);
}

// Register this browser's public key at startup. The private key remains local.
export async function registerOfflineDevice(uid) {
    return await getLocalDeviceIdentity(uid, true);
}
