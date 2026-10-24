
const DB_NAME = 'iceberg_cache';
const DB_VERSION = 1;

const STORES = {
    profile:    'profile',      // { uid, data, updatedAt }
    contacts:   'contacts',     // { uid, list, updatedAt }
    chats:      'chats',        // { uid, list, updatedAt }
    groups:     'groups',       // { uid, list, updatedAt }
    channels:   'channels',     // { uid, list, updatedAt }
    messages:   'messages',     // { chatId, list, updatedAt }
    ecdhKeys:   'ecdhKeys',     // { chatId, publicKey, privateKey, createdAt }
    sedaKeys:   'sedaKeys',     // { chatId, key, encrypted }
    settings:   'settings'      // { uid, theme, autoDeleteHours, ... }
};

let _dbPromise = null;

function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onerror = () => {
            _dbPromise = null;
            reject(req.error || new Error('Не удалось открыть локальный кэш'));
        };
        req.onsuccess = () => {
            const db = req.result;
            db.onversionchange = () => {
                db.close();
                _dbPromise = null;
            };
            resolve(db);
        };
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            for (const name of Object.values(STORES)) {
                if (!db.objectStoreNames.contains(name)) {
                    db.createObjectStore(name, { keyPath: name === 'messages' ? 'chatId' : (name === 'profile' || name === 'settings' ? 'uid' : name === 'ecdhKeys' || name === 'sedaKeys' ? 'chatId' : 'uid') });
                }
            }
        };
    });
    return _dbPromise;
}

async function tx(store, mode, fn) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        let result;
        let request;
        let settled = false;
        const fail = (error) => {
            if (settled) return;
            settled = true;
            reject(error || new Error('Ошибка локального кэша'));
        };

        let transaction;
        try {
            transaction = db.transaction(store, mode);
            request = fn(transaction.objectStore(store));
        } catch (error) {
            fail(error);
            return;
        }

        if (request) {
            request.onsuccess = () => { result = request.result; };
            request.onerror = () => fail(request.error);
        }
        transaction.oncomplete = () => {
            if (settled) return;
            settled = true;
            resolve(result);
        };
        transaction.onerror = () => fail(transaction.error);
        transaction.onabort = () => fail(transaction.error || new Error('Операция кэша отменена'));
    });
}

// ---- Базовые операции ----
export async function cacheGet(store, key) {
    return await tx(store, 'readonly', s => s.get(key));
}

export async function cachePut(store, value) {
    return await tx(store, 'readwrite', s => s.put(value));
}

export async function cacheDelete(store, key) {
    return await tx(store, 'readwrite', s => s.delete(key));
}

export async function cacheClear(store) {
    return await tx(store, 'readwrite', s => s.clear());
}

// ---- Проверка TTL ----
export function isFresh(entry, ttlMs) {
    if (!entry || !entry.updatedAt) return false;
    return Date.now() - entry.updatedAt < ttlMs;
}

// ===================================================================
// ПРОФИЛЬ
// ===================================================================
export async function getCachedProfile(uid) {
    return await cacheGet(STORES.profile, uid);
}

export async function setCachedProfile(uid, data) {
    return await cachePut(STORES.profile, { uid, data, updatedAt: Date.now() });
}

// ===================================================================
// СПИСКИ (чаты / группы / каналы / контакты)
// ===================================================================
export async function getCachedList(store, uid) {
    const entry = await cacheGet(store, uid);
    return entry ? entry.list : null;
}

export async function setCachedList(store, uid, list) {
    return await cachePut(store, { uid, list, updatedAt: Date.now() });
}

export const Lists = {
    getChats:     (uid) => getCachedList(STORES.chats, uid),
    setChats:     (uid, list) => setCachedList(STORES.chats, uid, list),
    getGroups:    (uid) => getCachedList(STORES.groups, uid),
    setGroups:    (uid, list) => setCachedList(STORES.groups, uid, list),
    getChannels:  (uid) => getCachedList(STORES.channels, uid),
    setChannels:  (uid, list) => setCachedList(STORES.channels, uid, list),
    getContacts:  (uid) => getCachedList(STORES.contacts, uid),
    setContacts:  (uid, list) => setCachedList(STORES.contacts, uid, list)
};

// ===================================================================
// СООБЩЕНИЯ (последние 200 на чат)
// ===================================================================
const MAX_CACHED_MESSAGES = 200;

export async function getCachedMessages(chatId) {
    const entry = await cacheGet(STORES.messages, chatId);
    return entry ? entry.list : null;
}

export async function setCachedMessages(chatId, list) {
    const trimmed = list.slice(-MAX_CACHED_MESSAGES);
    return await cachePut(STORES.messages, { chatId, list: trimmed, updatedAt: Date.now() });
}

export async function appendCachedMessage(chatId, msg) {
    const entry = await cacheGet(STORES.messages, chatId);
    const list = entry ? entry.list : [];
    if (!list.find(m => m.id === msg.id)) list.push(msg);
    return await setCachedMessages(chatId, list);
}

export async function updateCachedMessage(chatId, msgId, patch) {
    const entry = await cacheGet(STORES.messages, chatId);
    if (!entry) return;
    const list = entry.list.map(m => m.id === msgId ? { ...m, ...patch } : m);
    return await setCachedMessages(chatId, list);
}

export async function removeCachedMessage(chatId, msgId) {
    const entry = await cacheGet(STORES.messages, chatId);
    if (!entry) return;
    const list = entry.list.filter(m => m.id !== msgId);
    return await setCachedMessages(chatId, list);
}

export async function clearCachedMessages(chatId) {
    return await cacheDelete(STORES.messages, chatId);
}

// ===================================================================
// E2E КЛЮЧИ (ECDH P-256)
// ===================================================================
export async function saveECDHKeys(chatId, publicKey, privateKeyJwk) {
    return await cachePut(STORES.ecdhKeys, {
        chatId,
        publicKey,
        privateKey: privateKeyJwk,
        createdAt: Date.now()
    });
}

export async function getECDHKeys(chatId) {
    return await cacheGet(STORES.ecdhKeys, chatId);
}

export async function deleteECDHKeys(chatId) {
    return await cacheDelete(STORES.ecdhKeys, chatId);
}

// ===================================================================
// SEDA КЛЮЧИ
// ===================================================================
export async function saveSedaKey(chatId, key, encrypted = false, shared = false) {
    return await cachePut(STORES.sedaKeys, {
        chatId, key, encrypted, shared: !!shared,
        savedAt: Date.now()
    });
}

export async function getSedaKey(chatId) {
    const entry = await cacheGet(STORES.sedaKeys, chatId);
    return entry ? entry.key : null;
}

// A key is not considered ready for chat encryption until the peer confirms that
// the same key was derived/decrypted and persisted on the other device.
export async function isSedaKeyShared(chatId) {
    const entry = await cacheGet(STORES.sedaKeys, chatId);
    return entry?.shared === true;
}

export async function markSedaKeyShared(chatId) {
    const entry = await cacheGet(STORES.sedaKeys, chatId);
    if (!entry?.key) return false;
    await cachePut(STORES.sedaKeys, { ...entry, shared: true, sharedAt: Date.now() });
    return true;
}

export async function deleteSedaKey(chatId) {
    return await cacheDelete(STORES.sedaKeys, chatId);
}

// ===================================================================
// НАСТРОЙКИ
// ===================================================================
export async function getCachedSettings(uid) {
    return await cacheGet(STORES.settings, uid);
}

export async function setCachedSettings(uid, settings) {
    return await cachePut(STORES.settings, { uid, ...settings, updatedAt: Date.now() });
}


// Удаляет только загруженные офлайн-данные чатов. Профиль, настройки и
// локальные ключи шифрования сохраняются, чтобы не нарушить вход и E2E.
export async function clearOfflineContent() {
    for (const name of [STORES.contacts, STORES.chats, STORES.groups, STORES.channels, STORES.messages]) {
        await cacheClear(name);
    }
}

// ===================================================================
// ПОЛНАЯ ОЧИСТКА (logout)
// ===================================================================
export async function clearAllCache() {
    for (const name of Object.values(STORES)) {
        await cacheClear(name);
    }
}

// Только для конкретного пользователя (при выходе)
export async function clearUserCache(uid) {
    await cacheDelete(STORES.profile, uid);
    await cacheDelete(STORES.chats, uid);
    await cacheDelete(STORES.groups, uid);
    await cacheDelete(STORES.channels, uid);
    await cacheDelete(STORES.contacts, uid);
    await cacheDelete(STORES.settings, uid);
}
