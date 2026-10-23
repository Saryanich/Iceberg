import { db, auth, STICKERS, REACTION_EMOJIS, MAX_MEDIA_SIZE, MAX_PHOTO_DIMENSION, MAX_STORIES, STORY_LIFETIME, RATE_LIMIT, AUTO_DELETE_OPTIONS, THEMES } from './config.js';
import {
    collection, doc, getDoc, setDoc, updateDoc, addDoc, deleteDoc,
    query, where, getDocs, onSnapshot, orderBy, limit, serverTimestamp, Timestamp,
    arrayUnion, arrayRemove, writeBatch, runTransaction
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
 
import {
    generateSedaKey, serializeKey, sedaUltraEncryptWithKey, sedaUltraDecrypt, isSedaUltraPayload,
    icebergBaseEncrypt, icebergBaseDecrypt, isIcebergBasePayload, generateIcebergBaseKey,
    generateECDHKeyPair, exportPublicKey, importPublicKey,
    exportPrivateKey, deriveSharedKey, aesEncrypt, aesDecrypt
} from './crypto.js';

import * as DB from './db.js';
import { authState } from './auth.js';

// Keep text messages comfortably below Firestore's document-size ceiling.
const MAX_MESSAGE_LENGTH = 4000;

export const uiState = {
    currentChat: null,
    currentChatId: null,
    currentGroup: null,
    currentChannel: null,
    messagesUnsub: null,
    chatMetaUnsub: null,
    sedaHandshakeUnsub: null,
    replyTo: null,
    editingMessage: null,
    currentTheme: 'dark',
    autoDeleteHours: 0,
    sedaEnabledForCurrentChat: false,
    currentSedaKey: null,
    typingTimeout: null,
    isSending: false,
    messageTimes: [],
    mediaTimes: [],
    reactionTimes: [],
    processedHandshakes: new Set(),
    stickerPickerOpen: false,
    activeActionBar: null,
    recording: false,
    mediaRecorder: null,
    recordedChunks: [],
    selectedContactsForGroup: new Set(),
    currentStories: [],
    storyViewerIndex: 0,
    pinnedMessageId: null
};

function ensureArray(val) {
    // Firestore может вернуть старые/повреждённые данные; оставляем только объекты записей.
    const values = Array.isArray(val)
        ? val
        : (val && typeof val === 'object' ? Object.values(val) : []);
    return values.filter(item => item !== null && typeof item === 'object' && !Array.isArray(item));
}

const PENDING_CHAT_SYNC_KEY = 'iceberg_pending_direct_chat_sync_v1';
let operationIndicatorSequence = 0;
let messageRenderSequence = 0;

function pendingChatSyncStorageKey() {
    return PENDING_CHAT_SYNC_KEY + '_' + (authState.user?.uid || 'anonymous');
}

function readPendingChatSyncs() {
    try {
        const value = JSON.parse(localStorage.getItem(pendingChatSyncStorageKey()) || '[]');
        return Array.isArray(value) ? value : [];
    } catch { return []; }
}

function queueDirectChatSync(context, previewText) {
    if (!context?.currentChat?.uid || context.currentGroup || context.currentChannel) return null;
    const chat = context.currentChat;
    const entry = {
        id: String(context.chatId) + ':' + Date.now() + ':' + Math.random().toString(36).slice(2, 8),
        chatId: context.chatId,
        previewText: String(previewText || '').slice(0, 120),
        queuedAt: Date.now(),
        currentChat: {
            uid: chat.uid, nickname: chat.nickname || 'Пользователь',
            globalId: chat.globalId || '', avatar: chat.avatar || null,
            mood: chat.mood || null, isSeda: !!chat.isSeda,
            sedaChatId: chat.sedaChatId || null
        }
    };
    const items = readPendingChatSyncs();
    items.push(entry);
    try { localStorage.setItem(pendingChatSyncStorageKey(), JSON.stringify(items.slice(-100))); } catch {}
    return entry.id;
}

function removePendingChatSync(id) {
    if (!id) return;
    try {
        localStorage.setItem(pendingChatSyncStorageKey(), JSON.stringify(
            readPendingChatSyncs().filter(item => item.id !== id)
        ));
    } catch {}
}

let flushingPendingChatSyncs = false;
export async function flushPendingChatSyncs() {
    if (flushingPendingChatSyncs || !navigator.onLine || !authState.user?.uid) return;
    flushingPendingChatSyncs = true;
    try {
        for (const item of readPendingChatSyncs()) {
            if (!navigator.onLine) break;
            const context = {
                chatId: item.chatId,
                currentChat: item.currentChat,
                currentGroup: null,
                currentChannel: null
            };
            const ok = await updateChatLastMessage(item.previewText, context, true);
            if (ok) removePendingChatSync(item.id);
        }
    } finally {
        flushingPendingChatSyncs = false;
    }
}
window.addEventListener('online', () => { flushPendingChatSyncs(); });
window.addEventListener('pageshow', () => { if (navigator.onLine) flushPendingChatSyncs(); });

function showOperationIndicator(chatId, label, kind = 'upload') {
    if (!chatId || uiState.currentChatId !== chatId) return null;
    const area = document.getElementById('messagesArea');
    if (!area) return null;
    const row = document.createElement('div');
    row.className = 'chat-operation-indicator';
    row.dataset.operationId = String(++operationIndicatorSequence);
    row.dataset.chatId = chatId;
    const spinner = document.createElement('span');
    spinner.className = 'chat-operation-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'chat-operation-label';
    text.textContent = label;
    const progress = document.createElement('span');
    progress.className = 'chat-operation-progress';
    progress.textContent = kind === 'upload' ? 'Подготовка…' : '';
    row.append(spinner, text, progress);
    area.appendChild(row);
    area.scrollTop = area.scrollHeight;
    return { row, text, progress, chatId };
}

function updateOperationIndicator(indicator, label, progressText = '') {
    if (!indicator?.row?.isConnected) return;
    indicator.text.textContent = label;
    indicator.progress.textContent = progressText;
}

function removeOperationIndicator(indicator) {
    indicator?.row?.remove();
}

async function renderMessagesSequentially(area, messages, loadVersion, chatId) {
    const renderVersion = ++messageRenderSequence;
    const operationRows = Array.from(area.querySelectorAll('.chat-operation-indicator'));
    area.innerHTML = '';
    for (const row of operationRows) area.appendChild(row);
    for (let i = 0; i < messages.length; i++) {
        if (loadVersion !== messageLoadVersion ||
            renderVersion !== messageRenderSequence ||
            uiState.currentChatId !== chatId) return false;
        area.appendChild(await renderMessage(messages[i]));
        if (i > 0 && i % 8 === 0) {
            await new Promise(resolve => requestAnimationFrame(() => resolve()));
        }
    }
    if (loadVersion === messageLoadVersion && renderVersion === messageRenderSequence &&
        uiState.currentChatId === chatId) {
        bindChatLongPress();
        area.scrollTop = area.scrollHeight;
        return true;
    }
    return false;
}

export function showToast(text, type = 'info', duration = 2500) {
    const c = document.getElementById('toastContainer');
    if (!c) return;
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = text;
    c.appendChild(t);
    setTimeout(() => {
        t.style.transition = 'all .4s';
        t.style.opacity = '0';
        t.style.transform = 'translateY(-20px)';
        setTimeout(() => t.remove(), 400);
    }, duration);
}

function escapeHtml(text) {
    if (!text) return '';
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
}

function formatTime(date) {
    if (!date) return '';
    const now = new Date();
    const md = new Date(date);
    if (md.toDateString() === now.toDateString()) {
        return md.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    if (md.getFullYear() === now.getFullYear()) {
        return md.toLocaleDateString([], { day: 'numeric', month: 'short' });
    }
    return md.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatBytes(bytes) {
    if (!bytes) return '0 Б';
    if (bytes < 1024) return bytes + ' Б';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' КБ';
    return (bytes / 1024 / 1024).toFixed(2) + ' МБ';
}

function checkRateLimit(arr, maxCount, windowMs) {
    const now = Date.now();
    while (arr.length && now - arr[0] > windowMs) arr.shift();
    if (arr.length >= maxCount) {
        showToast('⏱ Слишком быстро', 'error');
        return false;
    }
    arr.push(now);
    return true;
}

export async function compressImage(file, maxBytes = 3 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                let { width, height } = img;
                if (width > MAX_PHOTO_DIMENSION || height > MAX_PHOTO_DIMENSION) {
                    const ratio = Math.min(MAX_PHOTO_DIMENSION / width, MAX_PHOTO_DIMENSION / height);
                    width = Math.floor(width * ratio);
                    height = Math.floor(height * ratio);
                }
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                let quality = 0.85;
                let dataUrl = canvas.toDataURL('image/jpeg', quality);
                while (dataUrl.length * 0.75 > maxBytes && quality > 0.3) {
                    quality -= 0.1;
                    dataUrl = canvas.toDataURL('image/jpeg', quality);
                }
                resolve(dataUrl);
            };
            img.onerror = reject;
            img.src = e.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

export function setTheme(theme) {
    if (!THEMES.includes(theme)) theme = 'dark';
    uiState.currentTheme = theme;
    document.body.className = `theme-${theme}`;
    localStorage.setItem('iceberg_theme', theme);
    document.querySelectorAll('.theme-cell').forEach(el => {
        el.classList.toggle('active', el.dataset.theme === theme);
    });
}

export function loadTheme() {
    const saved = localStorage.getItem('iceberg_theme') || 'dark';
    setTheme(saved);
}

export function renderUserProfile() {
    const d = authState.userData;
    if (!d) return;
    document.getElementById('userName').textContent = d.nickname || 'Пользователь';
    document.getElementById('userMood').textContent = d.mood || 'Нажмите, чтобы изменить профиль';
    const av = document.getElementById('userAvatar');
    if (!av) return;
    av.textContent = '';
    if (d.avatar) {
        const img = document.createElement('img');
        img.src = d.avatar;
        img.alt = 'avatar';
        av.appendChild(img);
    } else {
        av.textContent = (d.nickname || 'U').charAt(0).toUpperCase();
    }
}

export async function loadChats(forceRefresh = false) {
    const uid = authState.user?.uid;
    const c = document.getElementById('chatsList');
    if (!c || !uid) return;

    const rawChats = authState.userData?.chats;
    let chats = ensureArray(rawChats);

    if (!Array.isArray(rawChats) || chats.length !== rawChats.length) {
        console.warn('[loadChats] Некорректная структура chats; повреждённые записи пропущены');
        if (authState.userData) authState.userData.chats = chats;
        // Не затираем валидные записи, если старый формат был объектом.
        try {
            await updateDoc(doc(db, 'users', uid), { chats });
            await DB.Lists.setChats(uid, chats);
        } catch (e) {}
    }

    if (!chats.length || forceRefresh) {
        const cached = await DB.Lists.getChats(uid);
        const cachedArr = ensureArray(cached);
        if (cachedArr.length && !forceRefresh) {
            chats = cachedArr;
        }
    }

    chats = chats.filter(x => x && !x.isChannel);

    if (!chats.length) {
        c.innerHTML = '<div class="empty-state">Нет чатов</div>';
        return;
    }

    const toMillis = value => {
        if (value && typeof value.toMillis === 'function') return value.toMillis();
        if (value && typeof value.toDate === 'function') return value.toDate().getTime();
        const n = value instanceof Date ? value.getTime() : (typeof value === 'number' ? value : Date.parse(value || ''));
        return Number.isFinite(n) ? n : 0;
    };
    const sorted = [...chats].sort((a, b) => {
        const activityDiff = toMillis(b.lastMessageTime) - toMillis(a.lastMessageTime);
        if (activityDiff) return activityDiff;
        return (a.nickname || a.globalId || '').localeCompare(b.nickname || b.globalId || '', 'ru');
    });

    c.innerHTML = '';
    for (const chat of sorted) {
        c.appendChild(renderChatItem(chat));
    }
    await DB.Lists.setChats(uid, chats);
}

function renderChatItem(chat) {
    const div = document.createElement('div');
    div.className = `chat-item ${chat.unread ? 'unread' : ''}`;

    const av = document.createElement('div');
    av.className = 'avatar-small';
    if (chat.avatar) {
        const img = document.createElement('img');
        img.src = chat.avatar;
        av.appendChild(img);
    } else {
        av.textContent = (chat.nickname?.charAt(0) || '👤').toUpperCase();
    }

    const info = document.createElement('div');
    info.className = 'info-small';

    const nameRow = document.createElement('div');
    nameRow.className = 'name-row';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'item-name';
    nameSpan.textContent = chat.nickname || chat.globalId?.substring(0, 12) || 'Пользователь';
    nameRow.appendChild(nameSpan);

    if (chat.mood) {
        const mb = document.createElement('span');
        mb.className = 'mood-badge';
        mb.textContent = chat.mood;
        nameRow.appendChild(mb);
    }

    if (chat.isSeda) {
        const b = document.createElement('span');
        b.style.cssText = 'background:linear-gradient(135deg,#667eea,#764ba2);color:white;padding:1px 6px;border-radius:8px;font-size:9px;';
        b.textContent = '🔮 SEDA';
        nameRow.appendChild(b);
    }

    const sub = document.createElement('div');
    sub.className = 'item-subtitle';
    sub.textContent = chat.lastMessage
        ? chat.lastMessage.substring(0, 40)
        : (chat.isSeda ? '🔒 Зашифрованный чат' : '🔒 Чат');

    info.appendChild(nameRow);
    info.appendChild(sub);

    const actions = document.createElement('div');
    actions.className = 'chat-actions';
    const btnClear = document.createElement('button');
    btnClear.className = 'action-btn warning';
    btnClear.textContent = '🗑';
    btnClear.onclick = (e) => { e.stopPropagation(); clearChatById(chat.uid, chat.sedaChatId || ''); };
    const btnDel = document.createElement('button');
    btnDel.className = 'action-btn danger';
    btnDel.textContent = '❌';
    btnDel.onclick = (e) => { e.stopPropagation(); deleteChatById(chat.uid, chat.sedaChatId || ''); };
    actions.appendChild(btnClear);
    actions.appendChild(btnDel);

    div.appendChild(av);
    div.appendChild(info);
    div.appendChild(actions);

    div.onclick = () => selectChat(chat);
    return div;
}

export async function loadContacts() {
    const contacts = ensureArray(authState.userData?.contacts);
    const c = document.getElementById('contactsList');
    if (!c) return;
    if (!contacts.length) {
        c.innerHTML = '<div class="empty-state">Нет контактов</div>';
        return;
    }
    const sorted = [...contacts].sort((a, b) =>
        (a.nickname || a.globalId || '').localeCompare(b.nickname || b.globalId || '')
    );
    c.innerHTML = '';
    for (const contact of sorted) {
        c.appendChild(renderContactItem(contact));
    }
}

function renderContactItem(contact) {
    const div = document.createElement('div');
    div.className = 'contact-item';

    const av = document.createElement('div');
    av.className = 'avatar-small';
    if (contact.avatar) {
        const img = document.createElement('img');
        img.src = contact.avatar;
        av.appendChild(img);
    } else {
        av.textContent = (contact.nickname?.charAt(0) || '👤').toUpperCase();
    }

    const info = document.createElement('div');
    info.className = 'info-small';
    const nameRow = document.createElement('div');
    nameRow.className = 'name-row';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'item-name';
    nameSpan.textContent = contact.nickname || contact.globalId?.substring(0, 12) || 'Пользователь';
    nameRow.appendChild(nameSpan);
    if (contact.mood) {
        const mb = document.createElement('span');
        mb.className = 'mood-badge';
        mb.textContent = contact.mood;
        nameRow.appendChild(mb);
    }
    const sub = document.createElement('div');
    sub.className = 'item-subtitle';
    sub.textContent = (contact.globalId || '').substring(0, 14) + '...';

    info.appendChild(nameRow);
    info.appendChild(sub);
    div.appendChild(av);
    div.appendChild(info);
    av.style.cursor = 'pointer';
    av.title = 'Посмотреть истории';
    av.onclick = event => {
        event.stopPropagation();
        openUserStories(contact.uid, contact.nickname || contact.globalId || 'Пользователь');
    };
    div.onclick = () => showContactCard(contact);
    return div;
}



// Build a safe contact profile from the public projection rather than reading another
// user's private /users document.
export async function showContactCard(contact) {
    if (!contact?.uid) return;
    let profile = { ...contact };
    try {
        const snap = await getDoc(doc(db, 'public_profiles', contact.uid));
        if (snap.exists()) profile = { ...profile, ...snap.data(), uid: contact.uid };
    } catch (err) {
        console.warn('[Contact card] Public profile unavailable:', err);
    }

    let modal = document.getElementById('contactCardModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'contactCardModal';
        modal.className = 'modal-overlay';
        modal.innerHTML = '<div class="modal-content contact-card-content"></div>';
        modal.addEventListener('click', event => {
            if (event.target === modal) modal.classList.remove('active');
        });
        document.body.appendChild(modal);
    }
    const body = modal.querySelector('.modal-content');
    body.replaceChildren();

    const top = document.createElement('div');
    top.className = 'modal-header';
    const title = document.createElement('h3');
    title.textContent = 'Карточка контакта';
    const close = document.createElement('button');
    close.className = 'close-modal';
    close.type = 'button';
    close.setAttribute('aria-label', 'Закрыть');
    close.textContent = '×';
    close.onclick = () => modal.classList.remove('active');
    top.append(title, close);

    const avatar = document.createElement('button');
    avatar.type = 'button';
    avatar.className = 'contact-card-avatar';
    avatar.setAttribute('aria-label', 'Посмотреть историю пользователя');
    if (profile.avatar) {
        const img = document.createElement('img');
        img.src = profile.avatar;
        img.alt = 'Аватар ' + (profile.nickname || 'пользователя');
        avatar.appendChild(img);
    } else {
        avatar.textContent = (profile.nickname || '👤').charAt(0).toUpperCase();
    }
    avatar.onclick = () => openUserStories(profile.uid, profile.nickname || profile.globalId || 'Пользователь');

    const name = document.createElement('h3');
    name.className = 'contact-card-name';
    name.textContent = profile.nickname || profile.globalId || 'Пользователь';
    const gid = document.createElement('p');
    gid.className = 'contact-card-meta';
    gid.textContent = profile.globalId ? 'Global ID: ' + profile.globalId : 'Global ID не указан';
    const mood = document.createElement('p');
    mood.className = 'contact-card-mood';
    mood.textContent = profile.mood || 'Статус не указан';

    const hint = document.createElement('p');
    hint.className = 'contact-card-hint';
    hint.textContent = 'Нажмите на аватар, чтобы открыть истории, если они есть.';

    const actions = document.createElement('div');
    actions.className = 'contact-card-actions';
    const chatButton = document.createElement('button');
    chatButton.type = 'button';
    chatButton.className = 'btn btn-primary';
    chatButton.textContent = '💬 Создать / открыть чат';
    chatButton.onclick = async () => {
        modal.classList.remove('active');
        await openChatWithContact(profile);
    };
    const sedaButton = document.createElement('button');
    sedaButton.type = 'button';
    sedaButton.className = 'btn btn-secondary';
    sedaButton.textContent = '🔮 Создать SEDA-чат';
    sedaButton.disabled = !authState.sedaProActivated;
    sedaButton.title = sedaButton.disabled ? 'Сначала активируйте SEDA Pro в настройках' : '';
    sedaButton.onclick = async () => {
        if (!authState.sedaProActivated) {
            showToast('Сначала активируйте SEDA Pro в настройках', 'error');
            return;
        }
        modal.classList.remove('active');
        await openChatWithContact(profile);
        await startSedaChat();
    };

    body.append(top, avatar, name, gid, mood, hint, actions);
    actions.append(chatButton, sedaButton);
    modal.classList.add('active');
}

async function pruneExpiredStories(uid) {
    const q = query(
        collection(db, 'user_stories', uid, 'items'),
        where('expiresAt', '<=', Timestamp.fromMillis(Date.now())),
        limit(50)
    );
    const snap = await getDocs(q);
    if (snap.empty) return;
    const batch = writeBatch(db);
    snap.docs.forEach(story => batch.delete(story.ref));
    await batch.commit();
}

async function fetchUserStories(uid) {
    const q = query(
        collection(db, 'user_stories', uid, 'items'),
        where('expiresAt', '>', Timestamp.fromMillis(Date.now())),
        orderBy('expiresAt', 'asc'),
        limit(MAX_STORIES)
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data(), ownerUid: uid }));
}

function renderStoryViewer() {
    const items = uiState.currentStories || [];
    const current = items[uiState.storyViewerIndex];
    const modal = document.getElementById('storyViewerModal');
    if (!current || !modal) {
        modal?.classList.remove('active');
        return;
    }
    const image = document.getElementById('storyImage');
    image.src = current.image;
    image.alt = 'История ' + (current.ownerName || 'пользователя');
    const mine = current.ownerUid === authState.user?.uid;
    document.getElementById('deleteStoryBtn').style.display = mine ? 'block' : 'none';
    const progress = document.getElementById('storyProgress');
    if (progress) {
        progress.replaceChildren();
        items.forEach((item, index) => {
            const bar = document.createElement('div');
            bar.className = 'story-progress-bar';
            const fill = document.createElement('div');
            fill.className = 'story-progress-fill';
            if (index <= uiState.storyViewerIndex) fill.style.width = '100%';
            bar.appendChild(fill);
            progress.appendChild(bar);
        });
    }
    modal.classList.add('active');
}

export async function openUserStories(uid, ownerName = 'Пользователь') {
    if (!uid) return;
    try {
        const items = await fetchUserStories(uid);
        if (!items.length) {
            showToast('У пользователя пока нет активных историй', 'info');
            return;
        }
        uiState.currentStories = items.map(item => ({ ...item, ownerName }));
        uiState.storyViewerIndex = 0;
        renderStoryViewer();
    } catch (err) {
        console.error('[Stories] Не удалось загрузить истории:', err);
        showToast('Не удалось загрузить истории. Проверьте права Firestore.', 'error');
    }
}

export async function loadOwnStories() {
    const list = document.getElementById('myStoriesList');
    if (!list || !authState.user?.uid) return;
    list.replaceChildren();
    let items = [];
    try {
        await pruneExpiredStories(authState.user.uid);
        items = await fetchUserStories(authState.user.uid);
    } catch (err) {
        console.warn('[Stories] Не удалось загрузить свои истории:', err);
        showToast('Не удалось загрузить истории. Обновите Firestore Rules.', 'error');
        return;
    }
    if (!items.length) {
        const empty = document.createElement('p');
        empty.className = 'contact-card-hint';
        empty.textContent = 'Активных историй пока нет.';
        list.appendChild(empty);
        return;
    }
    for (const item of items) {
        const tile = document.createElement('div');
        tile.className = 'own-story-tile';
        const image = document.createElement('img');
        image.src = item.image;
        image.alt = 'Моя история';
        image.onclick = () => {
            uiState.currentStories = items.map(story => ({ ...story, ownerName: authState.userData?.nickname || 'Вы' }));
            uiState.storyViewerIndex = items.findIndex(story => story.id === item.id);
            renderStoryViewer();
        };
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'own-story-delete';
        remove.textContent = '×';
        remove.setAttribute('aria-label', 'Удалить историю');
        remove.onclick = async event => {
            event.stopPropagation();
            if (!confirm('Удалить эту историю?')) return;
            try {
                await deleteDoc(doc(db, 'user_stories', authState.user.uid, 'items', item.id));
                await loadOwnStories();
                showToast('История удалена', 'success');
            } catch (err) {
                showToast('Не удалось удалить историю', 'error');
            }
        };
        tile.append(image, remove);
        list.appendChild(tile);
    }
}

export async function uploadOwnStories(files) {
    if (!authState.user?.uid || !files?.length) return;
    try {
        await pruneExpiredStories(authState.user.uid);
        const current = await fetchUserStories(authState.user.uid);
        const remaining = MAX_STORIES - current.length;
        if (remaining <= 0) {
            showToast('Можно хранить не более 5 активных историй', 'error');
            return;
        }
        const images = Array.from(files).filter(file => file.type.startsWith('image/')).slice(0, remaining);
        if (!images.length) {
            showToast('Выберите изображения', 'error');
            return;
        }
        for (const file of images) {
            const image = await compressImage(file, 400 * 1024);
            await addDoc(collection(db, 'user_stories', authState.user.uid, 'items'), {
                image,
                createdAt: serverTimestamp(),
                expiresAt: Timestamp.fromMillis(Date.now() + STORY_LIFETIME - 60000)
            });
        }
        await loadOwnStories();
        showToast('Истории опубликованы на 24 часа', 'success');
    } catch (err) {
        console.error('[Stories] Upload failed:', err);
        showToast('Не удалось загрузить историю. Проверьте размер изображения и Firestore Rules.', 'error', 4500);
    }
}

export function moveStory(direction) {
    const total = uiState.currentStories?.length || 0;
    if (!total) return;
    uiState.storyViewerIndex = (uiState.storyViewerIndex + direction + total) % total;
    renderStoryViewer();
}

export async function deleteCurrentStory() {
    const item = uiState.currentStories?.[uiState.storyViewerIndex];
    if (!item || item.ownerUid !== authState.user?.uid) return;
    try {
        await deleteDoc(doc(db, 'user_stories', item.ownerUid, 'items', item.id));
        uiState.currentStories.splice(uiState.storyViewerIndex, 1);
        if (!uiState.currentStories.length) {
            document.getElementById('storyViewerModal')?.classList.remove('active');
        } else {
            uiState.storyViewerIndex = Math.min(uiState.storyViewerIndex, uiState.currentStories.length - 1);
            renderStoryViewer();
        }
        await loadOwnStories();
        showToast('История удалена', 'success');
    } catch (err) {
        showToast('Не удалось удалить историю', 'error');
    }
}

export async function loadGroups() {
    const uid = authState.user?.uid;
    const list = document.getElementById('groupsList');
    if (!list) return;
    let groups = ensureArray(authState.userData?.groups);
    if (uid && navigator.onLine) {
        try {
            const snap = await getDocs(query(collection(db, 'groups'), where('memberIds', 'array-contains', uid), limit(100)));
            // When online, trust the authoritative membership query. Merging stale
            // profile copies here would keep removed users seeing a group forever.
            const remoteGroups = snap.docs.map(d => ({ ...d.data(), id: d.id }));
            const remoteIds = new Set(remoteGroups.map(group => group.id));
            // Keep legacy groups only after the server verifies that this user is
            // still a member, or is the legacy creator who can migrate the schema.
            for (const legacy of ensureArray(authState.userData?.groups)) {
                if (!legacy?.id || remoteIds.has(legacy.id)) continue;
                try {
                    const legacySnap = await getDoc(doc(db, 'groups', legacy.id));
                    if (!legacySnap.exists()) continue;
                    const data = legacySnap.data();
                    if (Array.isArray(data.memberIds) && data.memberIds.includes(uid)) {
                        remoteGroups.push({ ...data, id: legacy.id });
                        remoteIds.add(legacy.id);
                    } else if (!Array.isArray(data.memberIds) && data.createdBy === uid) {
                        remoteGroups.push({ ...data, id: legacy.id });
                        remoteIds.add(legacy.id);
                    }
                } catch {
                    // A removed user cannot read the group, so a stale profile item
                    // is deliberately not shown as an active membership.
                }
            }
            groups = remoteGroups;
            if (authState.userData) authState.userData.groups = groups;
            await DB.Lists.setGroups(uid, groups).catch(() => {});
        } catch (err) {
            console.warn('[Groups] Не удалось обновить группы с сервера:', err);
        }
    }
    groups = groups.filter(g => g && g.id);
    if (!groups.length) {
        list.innerHTML = '<div class="empty-state">Нет групп</div>';
        return;
    }
    list.innerHTML = '';
    for (const g of groups) {
        const div = document.createElement('div');
        div.className = 'group-item';

        const av = document.createElement('div');
        av.className = 'avatar-small';
        if (g.avatar) {
            const img = document.createElement('img');
            img.src = g.avatar;
            img.alt = 'Аватар группы';
            av.appendChild(img);
        } else av.textContent = '👥';

        const info = document.createElement('div');
        info.className = 'info-small';
        const nameRow = document.createElement('div');
        nameRow.className = 'name-row';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'item-name';
        nameSpan.textContent = g.name;
        nameRow.appendChild(nameSpan);
        const sub = document.createElement('div');
        sub.className = 'item-subtitle';
        sub.textContent = `${g.memberCount || 0} участников`;

        info.appendChild(nameRow);
        info.appendChild(sub);
        div.appendChild(av);
        div.appendChild(info);
        div.onclick = () => selectGroup(g);
        list.appendChild(div);
    }
}

export async function loadChannels() {
    const uid = authState.user?.uid;
    const list = document.getElementById('channelsList');
    if (!list) return;
    let channels = ensureArray(authState.userData?.channels);
    if (uid && navigator.onLine) {
        try {
            const snap = await getDocs(query(collection(db, 'channels'), where('members', 'array-contains', uid), limit(100)));
            const remoteChannels = snap.docs.map(d => {
                const data = d.data();
                return { ...data, id: d.id, isAdmin: Array.isArray(data.admins) && data.admins.includes(uid) };
            });
            // Server membership is authoritative when online; don't re-add
            // channels from a stale local user profile after a user was removed.
            channels = remoteChannels;
            if (authState.userData) authState.userData.channels = channels;
            await DB.Lists.setChannels(uid, channels).catch(() => {});
        } catch (err) {
            console.warn('[Channels] Не удалось обновить каналы с сервера:', err);
        }
    }
    channels = channels.filter(ch => ch && ch.id);
    if (!channels.length) {
        list.innerHTML = '<div class="empty-state">Нет каналов</div>';
        return;
    }
    list.innerHTML = '';
    for (const ch of channels) {
        const div = document.createElement('div');
        div.className = 'channel-item';

        const av = document.createElement('div');
        av.className = 'avatar-small';
        av.style.background = 'linear-gradient(135deg,#f59e0b,#d97706)';
        if (ch.avatar) {
            const img = document.createElement('img');
            img.src = ch.avatar;
            img.alt = 'Аватар канала';
            av.appendChild(img);
        } else av.textContent = '📢';

        const info = document.createElement('div');
        info.className = 'info-small';
        const nameRow = document.createElement('div');
        nameRow.className = 'name-row';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'item-name';
        nameSpan.textContent = ch.name;
        nameRow.appendChild(nameSpan);
        if (ch.isAdmin) {
            const b = document.createElement('span');
            b.className = 'channel-badge';
            b.textContent = 'АДМИН';
            nameRow.appendChild(b);
        }
        const sub = document.createElement('div');
        sub.className = 'item-subtitle';
        sub.textContent = ch.description || `${ch.memberCount || 0} подписчиков`;

        info.appendChild(nameRow);
        info.appendChild(sub);
        div.appendChild(av);
        div.appendChild(info);
        div.onclick = () => selectChannel(ch);
        list.appendChild(div);
    }
}

// Automatic E2E key agreement for ordinary direct chats; no subscription or confirmation.
const baseHandshakeListeners = new Map();
async function ensureIcebergBaseKey(chatId, peerUid) {
    if (!authState.user?.uid || !chatId || !peerUid || uiState.currentChat?.isSeda) return null;
    let cached = await DB.getSedaKey(chatId);
    const handshakeId = 'base_' + chatId;
    const ref = doc(db, 'seda_handshakes', handshakeId);
    let existing = await getDoc(ref);
    if (existing.exists()) {
        const previous = existing.data();
        const expired = Number(previous.expiresAt) > 0 && Number(previous.expiresAt) <= Date.now();
        // Only the initiator replaces an expired unfinished handshake. This avoids
        // both users deleting/recreating the deterministic document at the same time.
        if (previous.mode === 'iceberg-base'
            && previous.initiator === authState.user.uid
            && expired
            && previous.peerKeyStored !== true) {
            await deleteDoc(ref);
            await DB.deleteECDHKeys(handshakeId);
            await DB.deleteSedaKey(chatId);
            cached = null;
            existing = await getDoc(ref);
        }
    }
    let privJwk, baseKey, pendingHandshake = false;
    if (cached?.startsWith('ICEBERGBASEKEY:')) {
        if (!existing.exists()) {
            if (await DB.isSedaKeyShared(chatId)) {
                if (uiState.currentChatId === chatId) uiState.currentSedaKey = cached;
                return cached;
            }
            // A legacy/local-only Base key was never confirmed by the peer.
            // Discard it and negotiate a fresh shared key instead of silently using it.
            await DB.deleteSedaKey(chatId);
            await DB.deleteECDHKeys(handshakeId);
            cached = null;
            if (uiState.currentChatId === chatId) uiState.currentSedaKey = null;
        } else {
            const status = existing.data();
            if (status.mode === 'iceberg-base' && status.peerKeyStored === true) {
                // Both peers reported the handshake complete; mark older cache entries as shared.
                await DB.markSedaKeyShared(chatId);
                if (status.initiator === authState.user.uid) {
                    await updateDoc(ref, { initiatorAck: true, initiatorAckAt: Date.now() }).catch(() => {});
                }
                if (uiState.currentChatId === chatId) uiState.currentSedaKey = cached;
                return cached;
            }
            if (status.mode !== 'iceberg-base' || status.initiator !== authState.user.uid || status.peer !== peerUid) {
                // The other participant is initiating a fresh exchange. A stale local key must
                // not remain usable while the responder listener installs the new one.
                await DB.deleteSedaKey(chatId);
                if (uiState.currentChatId === chatId) uiState.currentSedaKey = null;
                return null;
            }
        }
    }
        // Resume the pending initiator handshake after reload.
        const saved = await DB.getECDHKeys(handshakeId);
        if (!saved) throw new Error('Нет локального ключа рукопожатия');
        privJwk = saved.privateKey;
        baseKey = cached;
        pendingHandshake = true;
    }
    if (existing.exists()) {
        const data = existing.data();
        if (data.mode !== 'iceberg-base' || data.initiator !== authState.user.uid || data.peer !== peerUid) return null;
        const saved = await DB.getECDHKeys(handshakeId);
        if (!saved) throw new Error('Нет локального ключа рукопожатия');
        privJwk = saved.privateKey;
        baseKey = await DB.getSedaKey(chatId);
        if (!baseKey?.startsWith('ICEBERGBASEKEY:')) return null;
    } else {
        const pair = await generateECDHKeyPair();
        const pub = await exportPublicKey(pair);
        privJwk = await exportPrivateKey(pair);
        baseKey = generateIcebergBaseKey();

        // Two users may open the same empty chat at the same time. Claim the
        // deterministic handshake document transactionally so there is only one
        // initiator and the two sides never overwrite each other's public keys.
        const created = await runTransaction(db, async transaction => {
            const current = await transaction.get(ref);
            if (current.exists()) return false;
            transaction.set(ref, {
                mode: 'iceberg-base', chatId, initiator: authState.user.uid, peer: peerUid,
                initiatorPublicKey: pub, peerPublicKey: null, encryptedBaseKey: null,
                peerKeyStored: false, initiatorAck: false, createdAt: Date.now(),
                expiresAt: Date.now() + 10 * 60 * 1000
            });
            return true;
        });
        if (!created) {
            return null;
        }
        await DB.saveECDHKeys(handshakeId, pub, privJwk);
        await DB.saveSedaKey(chatId, baseKey);
        // The initiator's local key is not usable for sending until the peer
        // confirms that the same key has been decrypted and saved.
        pendingHandshake = true;
    }
    const listenerId = handshakeId + ':' + authState.user.uid;
    if (!baseHandshakeListeners.has(listenerId)) {
        const unsub = onSnapshot(ref, async snap => {
            if (!snap.exists()) {
                try { unsub(); } catch {}
                baseHandshakeListeners.delete(listenerId);
                return;
            }
            const data = snap.data();
            if (data.mode !== 'iceberg-base') return;
            try {
                const privateKey = await crypto.subtle.importKey('jwk', privJwk,
                    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
                if (data.peerKeyStored) {
                    await DB.markSedaKeyShared(chatId);
                    await updateDoc(ref, { initiatorAck: true, initiatorAckAt: Date.now() });
                    if (uiState.currentChatId === chatId) {
                        uiState.currentSedaKey = baseKey;
                        await loadMessages();
                    }
                    try { unsub(); } catch {}
                    baseHandshakeListeners.delete(listenerId);
                    return;
                }
                if (!data.peerPublicKey || data.encryptedBaseKey) return;
                const peerPublic = await importPublicKey(data.peerPublicKey);
                const shared = await deriveSharedKey(privateKey, peerPublic, 'iceberg-base-handshake-v1');
                await updateDoc(ref, { encryptedBaseKey: await aesEncrypt(baseKey, shared), baseKeySentAt: Date.now() });
            } catch (err) {
                console.error('[Iceberg Base initiator]', err);
            }
        }, err => {
            console.error('[Iceberg Base listener]', { code: err?.code || 'unknown', message: err?.message || String(err) });
            try { unsub(); } catch {}
            baseHandshakeListeners.delete(listenerId);
        });
        baseHandshakeListeners.set(listenerId, unsub);
    }
    return pendingHandshake ? null : baseKey;
}


// Ensure the parent document exists: Firestore rules for message subcollections
// must be able to verify membership against messages/{chatId}.
async function ensureMessageThread(chatId, membership) {
    if (!authState.user?.uid || !chatId || !membership) return;
    const threadRef = doc(db, 'messages', chatId);
    const uid = authState.user.uid;
    const isGroup = membership.kind === 'group';
    const isChannel = membership.kind === 'channel';
    const memberIds = Array.from(new Set((membership.memberIds || [uid]).filter(Boolean)));
    if (!memberIds.includes(uid)) memberIds.push(uid);
    const adminIds = Array.from(new Set((membership.adminIds || []).filter(Boolean)));
    const existing = await getDoc(threadRef);

    if (existing.exists()) {
        const oldData = existing.data();
        // Migrate legacy direct-thread parents whose earlier schema omitted participant IDs.
        if (!isGroup && !isChannel
            && (!Array.isArray(oldData.participants) || !oldData.kind)) {
            const participants = Array.from(new Set([uid, ...(membership.participants || [])].filter(Boolean))).sort();
            await updateDoc(threadRef, {
                kind: membership.kind === 'seda' ? 'seda' : 'direct',
                participants,
                updatedAt: serverTimestamp()
            });
        } else if (isGroup && (membership.createdBy === uid || adminIds.includes(uid))) {
            // Synchronize/migrate ACL metadata only if this user is an administrator.
            // Firestore Rules verify these values against the authoritative group.
            await updateDoc(threadRef, {
                kind: 'group',
                resourceId: membership.resourceId,
                createdBy: membership.createdBy || uid,
                memberIds, adminIds,
                updatedAt: serverTimestamp()
            });
        } else if (isChannel && (membership.createdBy === uid || adminIds.includes(uid))) {
            await updateDoc(threadRef, {
                kind: 'channel',
                resourceId: membership.resourceId,
                createdBy: membership.createdBy || uid,
                members: memberIds, admins: adminIds,
                updatedAt: serverTimestamp()
            });
        }
        return;
    }

    const payload = {
        kind: membership.kind || 'direct',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
    };
    if (isGroup) {
        payload.resourceId = membership.resourceId;
        payload.memberIds = memberIds;
        payload.adminIds = adminIds;
        if (membership.createdBy) payload.createdBy = membership.createdBy;
    } else if (isChannel) {
        payload.resourceId = membership.resourceId;
        payload.members = memberIds;
        payload.admins = adminIds;
        if (membership.createdBy) payload.createdBy = membership.createdBy;
    } else {
        payload.participants = Array.from(new Set([uid, ...(membership.participants || [])].filter(Boolean))).sort();
    }
    await setDoc(threadRef, payload);
}

export async function selectChat(chat) {
    if (!chat) return;
    closeCurrentSubscriptions();

    uiState.currentChat = chat;
    uiState.currentGroup = null;
    uiState.currentChannel = null;

    if (chat.isSeda && chat.sedaChatId) {
        uiState.currentChatId = chat.sedaChatId;
        const localSedaKey = authState.sedaProActivated ? await DB.getSedaKey(chat.sedaChatId) : null;
        const localSedaKeyShared = localSedaKey?.startsWith('SEDAKEY:')
            && await DB.isSedaKeyShared(chat.sedaChatId);
        uiState.currentSedaKey = localSedaKeyShared ? localSedaKey : null;
        uiState.sedaEnabledForCurrentChat = !!localSedaKeyShared;
        if (authState.sedaProActivated && !localSedaKeyShared) {
            // The initiator may have opened this chat before the peer responded,
            // then left/reloaded. Resume its pending handshake using the saved private key.
            watchSedaInitiatorHandshake(chat.sedaChatId);
        }
    } else {
        uiState.currentChatId = [authState.user.uid, chat.uid].sort().join('_');
        uiState.sedaEnabledForCurrentChat = false;
        const localBaseKey = await DB.getSedaKey(uiState.currentChatId);
        const localBaseKeyShared = localBaseKey?.startsWith('ICEBERGBASEKEY:')
            && await DB.isSedaKeyShared(uiState.currentChatId);
        uiState.currentSedaKey = localBaseKeyShared ? localBaseKey : null;
        // Validate the shared-key handshake on every open, even if a key exists locally.
        // A locally cached Base key alone does not prove that the peer received it.
        const openingChatId = uiState.currentChatId;
        ensureIcebergBaseKey(openingChatId, chat.uid).then(async key => {
            if (uiState.currentChatId !== openingChatId) return;
            if (key?.startsWith('ICEBERGBASEKEY:')) {
                uiState.currentSedaKey = key;
                const status = document.getElementById('chatStatus');
                if (status) status.textContent = '🔒 Защищённое соединение готово';
                await loadMessages();
                return;
            }
            const status = document.getElementById('chatStatus');
            if (status) status.textContent = '🔒 Устанавливаем защищённое соединение…';
        }).catch(err => {
            console.error('[Iceberg Base handshake]', {
                code: err?.code || 'unknown',
                message: err?.message || String(err),
                chatId: openingChatId
            });
            const status = document.getElementById('chatStatus');
            if (status && uiState.currentChatId === openingChatId) status.textContent = 'Не удалось установить защищённое соединение';
            showToast('Не удалось установить базовое шифрование. Проверьте доступ к Firestore и откройте чат снова.', 'error', 4500);
        });
    }

    renderChatHeader();

    try {
        await ensureMessageThread(uiState.currentChatId, {
            kind: chat.isSeda ? 'seda' : 'direct',
            participants: [chat.uid]
        });
    } catch (err) {
        console.error('[Messages] Не удалось подготовить личный чат:', err);
        showToast('Не удалось подготовить историю чата. Проверьте права Firestore.', 'error', 4000);
    }

    document.getElementById('chatInputArea').style.display = 'flex';
    document.getElementById('clearChatBtn').style.display = 'inline-block';
    document.getElementById('deleteChatBtn').style.display = 'inline-block';
    document.getElementById('groupInfoBtn').style.display = 'none';
    document.getElementById('channelManageBtn').style.display = 'none';

    updateSedaUI();
    moveToChatOnMobile();
    await markChatRead(chat);
    await loadMessages();
    startChatMetaListener(chat);
    setTimeout(() => document.getElementById('messageInput')?.focus(), 100);
}

export async function selectGroup(group) {
    if (!group?.id) return;
    closeCurrentSubscriptions();

    let freshGroup = group;
    try {
        const groupSnap = await getDoc(doc(db, 'groups', group.id));
        if (groupSnap.exists()) {
            freshGroup = { ...group, ...groupSnap.data(), id: group.id };
            // Migrate legacy groups once from creator-controlled metadata to explicit
            // member/admin UID arrays so Firestore Rules can enforce membership correctly.
            if (freshGroup.createdBy === authState.user.uid && !Array.isArray(freshGroup.memberIds)) {
                const oldMembers = Array.isArray(freshGroup.members) ? freshGroup.members : [];
                const memberIds = Array.from(new Set(oldMembers
                    .map(member => typeof member === 'string' ? member : member?.uid)
                    .filter(Boolean)));
                if (!memberIds.includes(authState.user.uid)) memberIds.push(authState.user.uid);
                const adminIds = Array.from(new Set([
                    freshGroup.createdBy,
                    ...(freshGroup.adminIds || []),
                    ...oldMembers.filter(member => member?.role === 'admin').map(member => member.uid)
                ].filter(Boolean)));
                await updateDoc(doc(db, 'groups', group.id), {
                    memberIds, adminIds, memberCount: memberIds.length
                });
                freshGroup = { ...freshGroup, memberIds, adminIds, memberCount: memberIds.length };
            }
        }
    } catch (err) {
        console.warn('[Group] Не удалось обновить данные/участников группы:', err);
    }

    uiState.currentGroup = freshGroup;
    uiState.currentChat = null;
    uiState.currentChannel = null;
    uiState.currentChatId = `group_${freshGroup.id}`;

    const savedKey = await DB.getSedaKey(uiState.currentChatId);
    uiState.sedaEnabledForCurrentChat = !!(savedKey?.startsWith('SEDAKEY:') && authState.sedaProActivated);
    uiState.currentSedaKey = savedKey;

    renderChatHeader();
    try {
        const ids = freshGroup.memberIds || (Array.isArray(freshGroup.members) ? freshGroup.members.map(m => typeof m === 'string' ? m : m?.uid).filter(Boolean) : []);
        await ensureMessageThread(uiState.currentChatId, {
            kind: 'group',
            resourceId: freshGroup.id,
            memberIds: ids,
            adminIds: freshGroup.adminIds || (Array.isArray(freshGroup.members) ? freshGroup.members.filter(m => m?.role === 'admin').map(m => m.uid) : []),
            createdBy: freshGroup.createdBy
        });
    } catch (err) {
        console.error('[Messages] Не удалось подготовить группу:', err);
        showToast('Не удалось подготовить историю группы. Проверьте права Firestore.', 'error', 4000);
    }
    document.getElementById('chatInputArea').style.display = 'flex';
    document.getElementById('groupInfoBtn').style.display = 'inline-block';
    document.getElementById('channelManageBtn').style.display = 'none';
    document.getElementById('clearChatBtn').style.display = 'inline-block';
    document.getElementById('deleteChatBtn').style.display = 'none';

    updateSedaUI();
    moveToChatOnMobile();
    await loadMessages();
    startChatMetaListener();
}

export async function selectChannel(channel) {
    if (!channel) return;
    closeCurrentSubscriptions();

    let freshChannel = channel;
    try {
        const channelSnap = await getDoc(doc(db, 'channels', channel.id));
        if (channelSnap.exists()) {
            const remote = channelSnap.data();
            freshChannel = {
                ...channel,
                ...remote,
                id: channel.id,
                isAdmin: Array.isArray(remote.admins)
                    ? remote.admins.includes(authState.user.uid)
                    : !!channel.isAdmin
            };
        }
    } catch (err) {
        console.warn('[Channel] Не удалось обновить данные канала:', err);
    }

    uiState.currentChannel = freshChannel;
    uiState.currentChat = null;
    uiState.currentGroup = null;
    uiState.currentChatId = `channel_${freshChannel.id}`;
    uiState.sedaEnabledForCurrentChat = false;
    uiState.currentSedaKey = null;

    try {
        const channelMembers = Array.isArray(freshChannel.members) ? freshChannel.members : [authState.user.uid];
        await ensureMessageThread(uiState.currentChatId, {
            kind: 'channel',
            resourceId: freshChannel.id,
            memberIds: channelMembers,
            adminIds: freshChannel.admins || [],
            createdBy: freshChannel.createdBy
        });
    } catch (err) {
        console.error('[Messages] Не удалось подготовить канал:', err);
        showToast('Не удалось подготовить историю канала. Проверьте права Firestore.', 'error', 4000);
    }

    renderChatHeader();
    document.getElementById('groupInfoBtn').style.display = 'none';
    document.getElementById('channelManageBtn').style.display = channel.isAdmin ? 'inline-block' : 'none';
    document.getElementById('clearChatBtn').style.display = channel.isAdmin ? 'inline-block' : 'none';
    document.getElementById('deleteChatBtn').style.display = 'none';

    if (channel.isAdmin) {
        document.getElementById('chatInputArea').style.display = 'flex';
        document.getElementById('messageInput').disabled = false;
        document.getElementById('chatSend').disabled = false;
        document.getElementById('messageInput').placeholder = 'Публикация в канале...';
    } else {
        document.getElementById('chatInputArea').style.display = 'none';
    }

    updateSedaUI();
    moveToChatOnMobile();
    await loadMessages();
}

function renderChatHeader() {
    const c = uiState.currentChat;
    const g = uiState.currentGroup;
    const ch = uiState.currentChannel;

    const nameEl = document.getElementById('chatName');
    const avEl = document.getElementById('chatAvatar');
    const statusEl = document.getElementById('chatStatus');

    avEl.innerHTML = '';

    if (c) {
        nameEl.textContent = (c.isSeda ? '🔮 ' : '') + (c.nickname || c.globalId?.substring(0, 12) || 'Пользователь');
        if (c.avatar) {
            const img = document.createElement('img');
            img.src = c.avatar;
            avEl.appendChild(img);
        } else {
            avEl.textContent = (c.nickname?.charAt(0) || '👤').toUpperCase();
        }
        statusEl.textContent = uiState.sedaEnabledForCurrentChat
            ? '🔮 SEDA Pro активен'
            : (c.mood || '🔒 Личный чат');
    } else if (g) {
        nameEl.textContent = g.name || 'Группа';
        if (g.avatar) {
            const img = document.createElement('img');
            img.src = g.avatar;
            img.alt = 'Аватар группы';
            avEl.appendChild(img);
        } else avEl.textContent = '👥';
        statusEl.textContent = uiState.sedaEnabledForCurrentChat
            ? '🔮 SEDA Pro активен'
            : `👥 ${g.memberCount || g.memberIds?.length || 0} участников`;
    } else if (ch) {
        nameEl.textContent = ch.name || 'Канал';
        if (ch.avatar) {
            const img = document.createElement('img');
            img.src = ch.avatar;
            img.alt = 'Аватар канала';
            avEl.appendChild(img);
        } else avEl.textContent = '📢';
        statusEl.textContent = ch.isAdmin
            ? '👑 Вы администратор'
            : `📢 ${ch.memberCount || ch.members?.length || 0} подписчиков`;
    }
}

function moveToChatOnMobile() {
    if (window.innerWidth <= 768 && window.matchMedia('(orientation:portrait)').matches) {
        document.getElementById('sidebar')?.classList.add('hide-on-mobile');
        document.getElementById('chatScreen')?.classList.add('show-on-mobile');
    }
}

export function closeChat() {
    if (window.innerWidth <= 768 && window.matchMedia('(orientation:portrait)').matches) {
        document.getElementById('sidebar')?.classList.remove('hide-on-mobile');
        document.getElementById('chatScreen')?.classList.remove('show-on-mobile');
    }
    closeCurrentSubscriptions();
    document.getElementById('chatInputArea').style.display = 'none';
    uiState.currentChat = null;
    uiState.currentGroup = null;
    uiState.currentChannel = null;
    uiState.currentChatId = null;
    uiState.sedaEnabledForCurrentChat = false;
    uiState.currentSedaKey = null;
    uiState.replyTo = null;
    ['groupInfoBtn', 'clearChatBtn', 'deleteChatBtn', 'sedaModeBtn', 'sedaKeyBtn', 'channelManageBtn'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    document.getElementById('messagesArea').innerHTML = '<div class="empty-state">Выберите чат</div>';
}

function closeCurrentSubscriptions() {
    if (uiState.messagesUnsub) { try { uiState.messagesUnsub(); } catch {} uiState.messagesUnsub = null; }
    if (uiState.chatMetaUnsub) { try { uiState.chatMetaUnsub(); } catch {} uiState.chatMetaUnsub = null; }
}

// Полная отписка используется только при выходе/смене аккаунта, не при переключении чатов.
export function closeAllSubscriptions() {
    closeCurrentSubscriptions();
    if (uiState.sedaHandshakeUnsub) {
        try { uiState.sedaHandshakeUnsub(); } catch {}
        uiState.sedaHandshakeUnsub = null;
    }
    uiState.processedHandshakes.clear();
}

async function markChatRead(chat) {
    if (!chat) return;
    let chats = ensureArray(authState.userData?.chats);
    let idx = chat.isSeda && chat.sedaChatId
        ? chats.findIndex(c => c.sedaChatId === chat.sedaChatId)
        : chats.findIndex(c => c.uid === chat.uid && !c.isGroup && !c.isSeda);
    if (idx === -1) return;
    if (!chats[idx].unread) return;
    const updated = [...chats];
    updated[idx] = { ...updated[idx], unread: false };
    try {
        await updateDoc(doc(db, 'users', authState.user.uid), { chats: updated });
        authState.userData.chats = updated;
        loadChats();
    } catch {}
}

let messageLoadVersion = 0;

/**
 * Releases Firestore listeners and invalidates in-flight message rendering.
 * Call this when leaving a chat session or signing out.
 */
export function cleanupChatSubscriptions() {
    messageLoadVersion++;
    for (const key of ['messagesUnsub', 'chatMetaUnsub', 'sedaHandshakeUnsub']) {
        const unsubscribe = uiState[key];
        if (typeof unsubscribe === 'function') {
            try { unsubscribe(); } catch (error) {
                console.warn(`[Chat cleanup] Не удалось закрыть подписку ${key}:`, error);
            }
        }
        uiState[key] = null;
    }
    if (uiState.typingTimeout) {
        clearTimeout(uiState.typingTimeout);
        uiState.typingTimeout = null;
    }
}


function cachedTimestampToFirestore(value) {
    if (!value) return null;
    if (typeof value.toMillis === 'function') return value;
    if (typeof value.toDate === 'function') return Timestamp.fromDate(value.toDate());
    if (value instanceof Date) return Timestamp.fromDate(value);
    if (typeof value === 'number' && Number.isFinite(value)) return Timestamp.fromMillis(value);
    if (typeof value.seconds === 'number') {
        return new Timestamp(value.seconds, Number(value.nanoseconds || 0));
    }
    return null;
}

function messageTimestampMillis(message) {
    const value = message?.timestamp;
    if (typeof value?.toMillis === 'function') return value.toMillis();
    if (typeof value?.seconds === 'number') return value.seconds * 1000 + Number(value.nanoseconds || 0) / 1e6;
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return value;
    return 0;
}

async function getHistoryClearedAt(chatId) {
    if (!authState.user?.uid || !chatId) return 0;
    try {
        const snap = await getDoc(doc(db, 'chat_clears', authState.user.uid, 'items', chatId));
        if (!snap.exists()) return 0;
        const value = snap.data().clearedAt;
        if (value && typeof value.toMillis === 'function') return value.toMillis();
        if (value instanceof Date) return value.getTime();
        const n = Number(value);
        return Number.isFinite(n) ? n : 0;
    } catch (err) {
        console.warn('[History] Не удалось прочитать отметку очистки:', err);
        return 0;
    }
}

async function markHistoryCleared(chatId) {
    await setDoc(doc(db, 'chat_clears', authState.user.uid, 'items', chatId), {
        clearedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
    }, { merge: true });
}

export async function loadMessages() {
    if (uiState.messagesUnsub) {
        try { uiState.messagesUnsub(); } catch {}
        uiState.messagesUnsub = null;
    }

    const chatId = uiState.currentChatId;
    const loadVersion = ++messageLoadVersion;
    const area = document.getElementById('messagesArea');
    if (!chatId || !area) return;

    const historyClearedAt = await getHistoryClearedAt(chatId);
    if (loadVersion !== messageLoadVersion || uiState.currentChatId !== chatId) return;

    area.innerHTML = '';
    const loading = showOperationIndicator(chatId, 'Подключаем чат…', 'loading');
    let cachedMessages = [];
    let hasCache = false;

    try {
        const cached = await DB.getCachedMessages(chatId);
        if (loadVersion !== messageLoadVersion || uiState.currentChatId !== chatId) {
            removeOperationIndicator(loading);
            return;
        }
        cachedMessages = (Array.isArray(cached) ? cached : [])
            .filter(message => messageTimestampMillis(message) > historyClearedAt);
        hasCache = cachedMessages.length > 0;
        if (hasCache) {
            const rendered = await renderMessagesSequentially(area, cachedMessages, loadVersion, chatId);
            if (rendered && loading?.row?.isConnected) {
                updateOperationIndicator(loading, 'Синхронизация новых сообщений…', 'Кэш устройства');
                area.appendChild(loading.row);
                area.scrollTop = area.scrollHeight;
            }
        }
    } catch (err) {
        console.warn('[Messages] Локальный кэш недоступен:', err);
    }

    if (loadVersion !== messageLoadVersion || uiState.currentChatId !== chatId) {
        removeOperationIndicator(loading);
        return;
    }

    const mRef = collection(db, 'messages', chatId, 'msgs');
    const lastCached = hasCache ? cachedMessages[cachedMessages.length - 1] : null;
    const cursor = cachedTimestampToFirestore(lastCached?.timestamp);
    const incrementalQuery = !!(hasCache && cursor);
    const messagesQuery = incrementalQuery
        ? query(mRef, where('timestamp', '>=', cursor), orderBy('timestamp', 'desc'), limit(300))
        : query(mRef, orderBy('timestamp', 'desc'), limit(200));
    let firstSnapshot = true;

    uiState.messagesUnsub = onSnapshot(
        messagesQuery,
        async (snap) => {
            if (loadVersion !== messageLoadVersion || uiState.currentChatId !== chatId) return;
            let incoming = [];
            snap.forEach(d => incoming.push({ id: d.id, ...d.data() }));
            incoming.reverse();
            incoming = incoming.filter(message => messageTimestampMillis(message) > historyClearedAt);

            let msgs;
            if (incrementalQuery) {
                const byId = new Map(cachedMessages.map(m => [m.id, m]));
                for (const message of incoming) {
                    byId.set(message.id, { ...(byId.get(message.id) || {}), ...message });
                }
                msgs = Array.from(byId.values()).sort((a, b) => messageTimestampMillis(a) - messageTimestampMillis(b));
                msgs = msgs.slice(-200);
            } else {
                msgs = incoming;
            }

            const currentIds = Array.from(area.querySelectorAll('.message-bubble')).map(el => el.dataset.id);
            const nextIds = msgs.map(m => m.id);
            const sameMessages = currentIds.length === nextIds.length &&
                currentIds.every((id, i) => id === nextIds[i]);

            if (!sameMessages) await renderMessagesSequentially(area, msgs, loadVersion, chatId);
            else bindChatLongPress();

            cachedMessages = msgs;
            if (firstSnapshot) {
                firstSnapshot = false;
                hasCache = hasCache || msgs.length > 0;
                removeOperationIndicator(loading);
                if (!msgs.length && !area.querySelector('.message-bubble')) {
                    area.innerHTML = '<div class="empty-state">Нет сообщений. Напишите первое!</div>';
                }
            }

            try {
                await DB.setCachedMessages(chatId, msgs);
            } catch (err) {
                console.warn('[Messages] Не удалось обновить локальный кэш:', err);
            }
            if (loadVersion === messageLoadVersion && uiState.currentChatId === chatId) {
                markIncomingRead(msgs, chatId);
            }
        },
        (err) => {
            if (loadVersion !== messageLoadVersion || uiState.currentChatId !== chatId) return;
            console.error('[onSnapshot] Ошибка:', err);
            removeOperationIndicator(loading);
            showToast('Не удалось загрузить сообщения. Проверьте соединение или доступ.', 'error', 4000);
            if (!area.querySelector('.message-bubble')) {
                area.innerHTML = '<div class="empty-state">Не удалось загрузить сообщения</div>';
            }
        }
    );
}

async function markIncomingRead(msgs, chatId) {
    if (!authState.user?.uid || !chatId) return;
    try {
        const batch = writeBatch(db);
        let updated = 0;
        for (const m of msgs) {
            if (m.senderId !== authState.user.uid && !m.read) {
                batch.update(doc(db, 'messages', chatId, 'msgs', m.id), {
                    read: true, readAt: Date.now()
                });
                updated++;
            }
        }
        if (updated > 0) await batch.commit();
    } catch (err) {
        console.warn('[Messages] Не удалось отметить сообщения прочитанными:', err);
    }
}

async function renderMessage(msg) {
    const isSent = msg.senderId === authState.user.uid;
    const div = document.createElement('div');
    div.className = `message-bubble ${isSent ? 'message-sent' : 'message-received'}`;
    div.id = `msg-${msg.id}`;
    div.dataset.id = msg.id;

    let displayText = msg.text;
    let isEncrypted = msg.encrypted === true;
    let isDecrypted = false;

    if (isEncrypted && msg.text) {
        if (uiState.currentChat?.isSeda && uiState.currentSedaKey && authState.sedaProActivated && isSedaUltraPayload(msg.text)) {
            const dec = await sedaUltraDecrypt(msg.text, uiState.currentSedaKey);
            if (dec !== null) { displayText = dec; isDecrypted = true; div.classList.add('message-seda'); }
            else { displayText = '[Не удалось расшифровать SEDA Ultra]'; div.classList.add('message-seda'); }
        } else if (!isSedaUltraPayload(msg.text) && uiState.currentSedaKey && isIcebergBasePayload(msg.text)) {
            const dec = await icebergBaseDecrypt(msg.text, uiState.currentSedaKey);
            if (dec !== null) { displayText = dec; isDecrypted = true; }
            else displayText = '[Не удалось расшифровать сообщение Iceberg]';
        } else if (isSedaUltraPayload(msg.text) || isIcebergBasePayload(msg.text)) {
            displayText = '[Зашифровано — ожидается ключ чата]';
            div.classList.add('message-seda');
        }
    }

    let mediaSrc = null;
    if ((msg.type === 'photo' || msg.type === 'video' || msg.type === 'file' || msg.type === 'audio') && msg.media) {
        if (msg.mediaEncrypted && uiState.currentSedaKey) {
            mediaSrc = isSedaUltraPayload(msg.media)
                ? (uiState.currentChat?.isSeda ? await sedaUltraDecrypt(msg.media, uiState.currentSedaKey) : null)
                : await icebergBaseDecrypt(msg.media, uiState.currentSedaKey);
        } else {
            mediaSrc = msg.mediaEncrypted ? null : msg.media;
        }
    }

    if (msg.replyTo) {
        const r = document.createElement('div');
        r.className = 'chat-msg-reply';
        r.textContent = '↩ Ответ на сообщение';
        r.onclick = () => scrollToMessage(msg.replyTo);
        div.appendChild(r);
    }

    if (!isSent && msg.senderName && (uiState.currentGroup || uiState.currentChannel)) {
        const sn = document.createElement('div');
        sn.style.cssText = 'font-size:10px;opacity:0.7;margin-bottom:3px;';
        sn.textContent = msg.senderName;
        div.appendChild(sn);
    }

    if (msg.type === 'sticker') {
        const s = document.createElement('div');
        s.className = 'chat-msg-sticker';
        s.textContent = msg.text;
        div.appendChild(s);
    } else if (msg.type === 'photo' && mediaSrc) {
        const img = document.createElement('img');
        img.className = 'chat-msg-photo';
        img.src = mediaSrc;
        img.onclick = () => window.open(mediaSrc, '_blank');
        div.appendChild(img);
    } else if (msg.type === 'video' && mediaSrc) {
        const v = document.createElement('video');
        v.className = 'chat-msg-video';
        v.src = mediaSrc;
        v.controls = true;
        div.appendChild(v);
    } else if (msg.type === 'audio' && mediaSrc) {
        const a = document.createElement('audio');
        a.className = 'chat-msg-audio';
        a.src = mediaSrc;
        a.controls = true;
        div.appendChild(a);
    } else if (msg.type === 'file' && mediaSrc) {
        const link = document.createElement('a');
        link.className = 'chat-msg-file';
        link.href = mediaSrc;
        link.download = msg.fileName || 'file';
        const icon = document.createElement('div');
        icon.className = 'file-icon';
        icon.textContent = '📄';
        const info = document.createElement('div');
        info.className = 'file-info';
        const n = document.createElement('div');
        n.className = 'file-name';
        n.textContent = msg.fileName || 'Файл';
        const sz = document.createElement('div');
        sz.className = 'file-size';
        sz.textContent = formatBytes(msg.fileSize);
        info.appendChild(n);
        info.appendChild(sz);
        link.appendChild(icon);
        link.appendChild(info);
        div.appendChild(link);
    } else {
        const t = document.createElement('div');
        t.className = 'message-text-content';
        t.textContent = displayText || '';
        div.appendChild(t);
    }

    if (isEncrypted && !isDecrypted) {
        const btn = document.createElement('button');
        btn.className = 'seda-decrypt-btn';
        btn.textContent = '🔑 Вставить ключ';
        btn.onclick = (e) => { e.stopPropagation(); pasteSedaKeyFromClipboard(); };
        div.appendChild(btn);
    }
    if (isDecrypted) {
        const lock = document.createElement('span');
        lock.style.marginLeft = '4px';
        lock.title = 'Расшифровано';
        lock.textContent = '🔓';
        div.appendChild(lock);
    }

    if (msg.reactions && Object.keys(msg.reactions).length) {
        const rw = document.createElement('div');
        rw.className = 'chat-msg-reactions';
        for (const [emoji, users] of Object.entries(msg.reactions)) {
            if (!users || !users.length) continue;
            const mine = users.includes(authState.user.uid);
            const r = document.createElement('span');
            r.className = `chat-reaction ${mine ? 'mine' : ''}`;
            r.textContent = `${emoji} ${users.length}`;
            r.onclick = (e) => toggleReaction(msg.id, emoji, e);
            rw.appendChild(r);
        }
        div.appendChild(rw);
    }

    if (isEncrypted) {
        const badge = document.createElement('div');
        badge.className = 'seda-badge-msg';
        badge.textContent = isSedaUltraPayload(msg.text) ? '🔮 SEDA Pro' : '🔒 Сквозное шифрование';
        div.appendChild(badge);
    }

    const time = document.createElement('div');
    time.className = 'message-time';
    time.textContent = formatTime(msg.timestamp?.toDate?.());
    if (isSent) {
        const s = document.createElement('span');
        s.className = 'message-status';
        s.textContent = msg.read ? '✓✓' : '✓';
        time.appendChild(document.createTextNode(' '));
        time.appendChild(s);
    }
    div.appendChild(time);

    return div;
}

export async function sendMessage() {
    if (uiState.isSending) return;
    const input = document.getElementById('messageInput');
    if (!(input instanceof HTMLTextAreaElement)) return;
    const text = input.value.trim();
    if (!text || !uiState.currentChatId) return;
    if (Array.from(text).length > MAX_MESSAGE_LENGTH) {
        showToast(`Сообщение слишком длинное. Максимум ${MAX_MESSAGE_LENGTH.toLocaleString('ru-RU')} символов`, 'error', 4000);
        return;
    }

    if (uiState.currentChannel && !uiState.currentChannel.isAdmin) {
        showToast('❌ Только администраторы', 'error');
        return;
    }
    if (!checkRateLimit(uiState.messageTimes, RATE_LIMIT.messages.count, RATE_LIMIT.messages.windowMs)) return;

    uiState.isSending = true;
    const chatIdAtSend = uiState.currentChatId;
    const chatContext = {
        chatId: chatIdAtSend,
        currentChat: uiState.currentChat,
        currentGroup: uiState.currentGroup,
        currentChannel: uiState.currentChannel,
        sedaEnabled: uiState.sedaEnabledForCurrentChat,
        sedaKey: uiState.currentSedaKey
    };
    const originalText = text;
    input.value = '';
    input.style.height = 'auto';

    try {
        if (uiState.editingMessage) {
            const editId = uiState.editingMessage;
            uiState.editingMessage = null;
            let editText = originalText;
            if (chatContext.currentChat && !chatContext.currentChat.isSeda) {
                let baseKey = chatContext.sedaKey;
                if (!baseKey?.startsWith('ICEBERGBASEKEY:')) baseKey = await ensureIcebergBaseKey(chatIdAtSend, chatContext.currentChat.uid);
                if (!baseKey?.startsWith('ICEBERGBASEKEY:')) throw new Error('Защищённый ключ чата ещё не готов');
                editText = await icebergBaseEncrypt(originalText, baseKey);
            } else if (chatContext.currentChat?.isSeda && authState.sedaProActivated) {
                if (!chatContext.sedaKey?.startsWith('SEDAKEY:')) {
                    uiState.editingMessage = editId;
                    throw new Error('Ключ SEDA ещё не получен от второго участника');
                }
                editText = await sedaUltraEncryptWithKey(originalText, chatContext.sedaKey);
            }
            await updateDoc(doc(db, 'messages', chatIdAtSend, 'msgs', editId), {
                text: editText,
                edited: true,
                editedAt: serverTimestamp(),
                cryptoVersion: chatContext.currentChat?.isSeda ? (chatContext.sedaEnabled ? 'SEDA_ULTRA_1' : null) : (chatContext.currentChat ? 'ICEBERG_BASE_1' : null)
            });
            document.getElementById('replyPreview')?.classList.add('hidden');
            return;
        }

        let textToSend = originalText;
        let encrypted = false;
        if (chatContext.currentChat && !chatContext.currentChat.isSeda) {
            let baseKey = chatContext.sedaKey;
            if (!baseKey?.startsWith('ICEBERGBASEKEY:')) baseKey = await ensureIcebergBaseKey(chatIdAtSend, chatContext.currentChat.uid);
            if (!baseKey?.startsWith('ICEBERGBASEKEY:')) {
                showToast('Устанавливаем защищённое соединение. Повторите отправку через несколько секунд.', 'info', 4000);
                input.value = originalText;
                return;
            }
            textToSend = await icebergBaseEncrypt(originalText, baseKey);
            encrypted = true;
            chatContext.sedaKey = baseKey;
            if (uiState.currentChatId === chatIdAtSend) uiState.currentSedaKey = baseKey;
        }

        if (chatContext.currentChat?.isSeda && !authState.sedaProActivated) {
            showToast('SEDA-чаты доступны только с активной подпиской', 'error');
            input.value = originalText;
            return;
        }

        if (chatContext.currentChat?.isSeda) {
            const keyStr = chatContext.sedaKey;
            if (!keyStr?.startsWith('SEDAKEY:')) {
                showToast('🔮 Защищённое соединение SEDA ещё устанавливается. Повторите отправку через несколько секунд.', 'info', 4500);
                input.value = originalText;
                return;
            }
            textToSend = await sedaUltraEncryptWithKey(originalText, keyStr);
            encrypted = true;
        }

        const message = {
            text: textToSend,
            senderId: authState.user.uid,
            senderName: authState.userData.nickname,
            timestamp: serverTimestamp(),
            read: false,
            encrypted,
            cryptoVersion: encrypted ? (chatContext.currentChat?.isSeda ? 'SEDA_ULTRA_1' : 'ICEBERG_BASE_1') : null,
            type: 'text',
            replyTo: uiState.replyTo || null,
            reactions: {}
        };

        const pendingSyncId = queueDirectChatSync(chatContext, originalText);
        const writePromise = addDoc(collection(db, 'messages', chatIdAtSend, 'msgs'), message);
        cancelReply();
        if (!navigator.onLine) {
            showToast('Нет сети — сообщение ожидает отправки', 'info', 3500);
        }
        writePromise.then(async () => {
            // The message is persisted. Keep the existing queue entry if metadata
            // synchronization fails so it can be retried without creating duplicates.
            try {
                const ok = await updateChatLastMessage(originalText, chatContext);
                if (ok) removePendingChatSync(pendingSyncId);
                else if (pendingSyncId) {
                    showToast('Сообщение отправлено; обновление списка чатов повторится позже', 'info', 4000);
                }
            } catch (error) {
                console.warn('[Messages] Сообщение сохранено, синхронизация списка чатов ожидает повтора:', error);
                showToast('Сообщение отправлено; обновление списка чатов повторится позже', 'info', 4000);
            }
        }).catch((error) => {
            // A rejected message write must not leave a metadata queue item behind.
            removePendingChatSync(pendingSyncId);
            console.error('[Messages] Не удалось сохранить сообщение:', error);
            if (uiState.currentChatId === chatIdAtSend && input.value.trim() === '') {
                input.value = originalText;
                input.style.height = 'auto';
                input.style.height = Math.min(input.scrollHeight, 90) + 'px';
            }
            showToast('Не удалось отправить сообщение. Проверьте соединение и попробуйте снова', 'error', 4000);
        });
    } catch (e) {
        console.error('Ошибка отправки:', e);
        showToast('❌ Ошибка отправки', 'error');
        input.value = originalText;
    } finally {
        uiState.isSending = false;
    }
}

async function updateChatLastMessage(previewText, context, fromQueue = false) {
    try {
        const chatIdAtSend = context?.chatId;
        const currentChat = context?.currentChat;
        const currentGroup = context?.currentGroup;
        const currentChannel = context?.currentChannel;
        if (!chatIdAtSend || !currentChat) return false;

        if (currentChat) {
            let chats = ensureArray(authState.userData?.chats);
            let idx = currentChat.isSeda && currentChat.sedaChatId
                ? chats.findIndex(c => c.sedaChatId === currentChat.sedaChatId)
                : chats.findIndex(c => c.uid === currentChat.uid && !c.isGroup && !c.isSeda);
            if (idx !== -1) {
                const u = [...chats];
                u[idx] = { ...u[idx], lastMessage: previewText, lastMessageTime: new Date() };
                await updateDoc(doc(db, 'users', authState.user.uid), { chats: u });
                authState.userData.chats = u;
                loadChats();
            }

            if (!currentGroup && !currentChannel && currentChat.uid) {
                const cRef = doc(db, 'users', currentChat.uid);
                const cDoc = await getDoc(cRef);
                if (cDoc.exists()) {
                    const cd = cDoc.data();
                    const cChats = ensureArray(cd.chats);
                    let cIdx = currentChat.isSeda && currentChat.sedaChatId
                        ? cChats.findIndex(c => c.sedaChatId === currentChat.sedaChatId)
                        : cChats.findIndex(c => c.uid === authState.user.uid && !c.isGroup && !c.isSeda);
                    if (cIdx !== -1) {
                        const u = [...cChats];
                        u[cIdx] = { ...u[cIdx], lastMessage: previewText, lastMessageTime: new Date(), unread: true };
                        await updateDoc(cRef, { chats: u });
                    } else {
                        const newChat = {
                            uid: authState.user.uid,
                            globalId: authState.userData.globalId,
                            nickname: authState.userData.nickname,
                            avatar: authState.userData.avatar || null,
                            mood: authState.userData.mood || null,
                            isGroup: false,
                            isSeda: currentChat.isSeda || false,
                            sedaChatId: currentChat.sedaChatId || null,
                            unread: true,
                            lastMessage: previewText,
                            lastMessageTime: new Date()
                        };
                        await updateDoc(cRef, { chats: [...cChats, newChat] });
                    }
                }
            }
        }
        return true;
    } catch (e) {
        console.error('updateChatLastMessage:', e);
        if (!fromQueue && context?.currentChat?.uid && !context.currentGroup && !context.currentChannel) {
            queueDirectChatSync(context, previewText);
        }
        return false;
    }
}

export function initStickerPicker() {
    const p = document.getElementById('stickerPicker');
    if (!p) return;
    p.innerHTML = '';
    for (const s of STICKERS) {
        const el = document.createElement('div');
        el.className = 'sticker-item';
        el.textContent = s;
        el.onclick = () => sendSticker(s);
        p.appendChild(el);
    }
}

export async function sendSticker(sticker) {
    if (!uiState.currentChatId) return;
    if (uiState.currentChannel && !uiState.currentChannel.isAdmin) {
        showToast('❌ Только администраторы', 'error');
        return;
    }
    if (!checkRateLimit(uiState.messageTimes, RATE_LIMIT.messages.count, RATE_LIMIT.messages.windowMs)) return;

    const chatContext = {
        chatId: uiState.currentChatId,
        currentChat: uiState.currentChat,
        currentGroup: uiState.currentGroup,
        currentChannel: uiState.currentChannel
    };
    const sp = document.getElementById('stickerPicker');
    if (sp) sp.classList.remove('show');
    uiState.stickerPickerOpen = false;

    try {
        let text = sticker;
        let encrypted = false;
        if (chatContext.currentChat && !chatContext.currentChat.isSeda) {
            let key = uiState.currentSedaKey;
            if (!key?.startsWith('ICEBERGBASEKEY:')) key = await ensureIcebergBaseKey(chatContext.chatId, chatContext.currentChat.uid);
            if (!key?.startsWith('ICEBERGBASEKEY:')) {
                showToast('Защищённое соединение ещё устанавливается', 'info');
                return;
            }
            text = await icebergBaseEncrypt(sticker, key);
            encrypted = true;
        } else if (chatContext.currentChat?.isSeda) {
            if (!authState.sedaProActivated) return showToast('SEDA-чаты доступны только с активной подпиской', 'error');
            if (!uiState.currentSedaKey?.startsWith('SEDAKEY:')) {
                showToast('Ключ SEDA ещё не получен. Повторите отправку позже.', 'info');
                return;
            }
            text = await sedaUltraEncryptWithKey(sticker, uiState.currentSedaKey);
            encrypted = true;
        }
        const pendingSyncId = queueDirectChatSync(chatContext, sticker);
        const writePromise = addDoc(collection(db, 'messages', chatContext.chatId, 'msgs'), {
            text,
            senderId: authState.user.uid,
            senderName: authState.userData.nickname,
            timestamp: serverTimestamp(),
            read: false,
            encrypted,
            type: 'sticker',
            replyTo: uiState.replyTo || null,
            reactions: {}
        });
        cancelReply();
        if (!navigator.onLine) showToast('Нет сети — стикер ожидает отправки', 'info', 3500);
        writePromise.then(async () => {
            const ok = await updateChatLastMessage(sticker, chatContext);
            if (ok) removePendingChatSync(pendingSyncId);
        }).catch((e) => {
            removePendingChatSync(pendingSyncId);
            console.error('[Sticker] Не удалось сохранить сообщение:', e);
            showToast('Не удалось отправить стикер. Проверьте подключение и права Firestore.', 'error', 4000);
        });
    } catch (e) {
        console.error('[Sticker] Ошибка:', e);
        showToast('Ошибка', 'error');
    }
}

export async function sendMediaFile(input) {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file || !uiState.currentChatId) return;
    const chatContext = {
        chatId: uiState.currentChatId,
        currentChat: uiState.currentChat,
        currentGroup: uiState.currentGroup,
        currentChannel: uiState.currentChannel,
        sedaEnabled: uiState.sedaEnabledForCurrentChat,
        sedaKey: uiState.currentSedaKey
    };
    if (chatContext.currentChannel && !chatContext.currentChannel.isAdmin) {
        showToast('❌ Только администраторы', 'error');
        return;
    }
    if (chatContext.currentChat?.isSeda && !authState.sedaProActivated) {
        showToast('SEDA-чаты доступны только с активной подпиской', 'error');
        return;
    }
    if (chatContext.currentChat?.isSeda && !chatContext.sedaKey?.startsWith('SEDAKEY:')) {
        showToast('Ключ SEDA ещё не получен. Дождитесь установки защищённого соединения.', 'info', 4000);
        return;
    }
    const isImageFile = file.type.startsWith('image/');
    const maxOriginalImageSize = 15 * 1024 * 1024;
    if ((!isImageFile && file.size > MAX_MEDIA_SIZE) ||
        (isImageFile && file.size > maxOriginalImageSize)) {
        const maxSize = isImageFile ? maxOriginalImageSize : MAX_MEDIA_SIZE;
        showToast(`Файл слишком большой (макс ${formatBytes(maxSize)})`, 'error');
        return;
    }
    if (!checkRateLimit(uiState.mediaTimes, RATE_LIMIT.media.count, RATE_LIMIT.media.windowMs)) return;

    const indicator = showOperationIndicator(chatContext.chatId, file.type.startsWith('video/') ? 'Подготовка видео…' : 'Подготовка медиа…');
    try {
        updateOperationIndicator(indicator, 'Читаем файл…', formatBytes(file.size));
        let dataUrl;
        let mediaType;

        if (file.type.startsWith('image/')) {
            dataUrl = await compressImage(file, MAX_MEDIA_SIZE);
            mediaType = 'photo';
        } else {
            dataUrl = await new Promise((res, rej) => {
                const r = new FileReader();
                r.onload = e => res(e.target.result);
                r.onerror = rej;
                r.readAsDataURL(file);
            });
            if (file.type.startsWith('video/')) mediaType = 'video';
            else if (file.type.startsWith('audio/')) mediaType = 'audio';
            else mediaType = 'file';
        }

        updateOperationIndicator(indicator, 'Файл подготовлен', 'Отправляем…');
        let mediaToSend = dataUrl;
        let mediaEncrypted = false;

        if (chatContext.currentChat?.isSeda && !authState.sedaProActivated) {
            throw new Error('SEDA-чаты доступны только с активной подпиской');
        }
        if (chatContext.currentChat && !chatContext.currentChat.isSeda) {
            let keyStr = chatContext.sedaKey;
            if (!keyStr?.startsWith('ICEBERGBASEKEY:')) keyStr = await ensureIcebergBaseKey(chatContext.chatId, chatContext.currentChat.uid);
            if (!keyStr?.startsWith('ICEBERGBASEKEY:')) throw new Error('Защищённое соединение ещё устанавливается');
            mediaToSend = await icebergBaseEncrypt(dataUrl, keyStr);
            mediaEncrypted = true;
            chatContext.sedaKey = keyStr;
            if (uiState.currentChatId === chatContext.chatId) uiState.currentSedaKey = keyStr;
        } else if (chatContext.currentChat?.isSeda && authState.sedaProActivated) {
            const keyStr = chatContext.sedaKey;
            if (!keyStr?.startsWith('SEDAKEY:')) throw new Error('Ключ SEDA ещё не получен');
            mediaToSend = await sedaUltraEncryptWithKey(dataUrl, keyStr);
            mediaEncrypted = true;
        }

        const preview = mediaType === 'photo' ? '📷 Фото'
            : mediaType === 'video' ? '🎥 Видео'
            : mediaType === 'audio' ? '🎵 Аудио'
            : '📄 ' + file.name;
        const pendingSyncId = queueDirectChatSync(chatContext, preview);
        const writePromise = addDoc(collection(db, 'messages', chatContext.chatId, 'msgs'), {
            text: '',
            senderId: authState.user.uid,
            senderName: authState.userData.nickname,
            timestamp: serverTimestamp(),
            read: false,
            encrypted: false,
            mediaEncrypted,
            type: mediaType,
            media: mediaToSend,
            fileName: file.name,
            fileSize: file.size,
            replyTo: uiState.replyTo || null,
            reactions: {}
        });

        cancelReply();
        updateOperationIndicator(indicator, 'Файл добавлен в очередь', navigator.onLine ? 'Ожидание подтверждения…' : 'Ожидание сети…');
        if (!navigator.onLine) {
            updateOperationIndicator(indicator, 'Ожидает подключения', 'Отправится при появлении сети');
        }
        writePromise.then(async () => {
            const ok = await updateChatLastMessage(preview, chatContext);
            if (ok) removePendingChatSync(pendingSyncId);
            removeOperationIndicator(indicator);
        }).catch((e) => {
            removePendingChatSync(pendingSyncId);
            console.error('[Media] Не удалось сохранить сообщение:', e);
            updateOperationIndicator(indicator, 'Файл не отправлен', 'Проверьте соединение и права доступа');
            showToast('Не удалось отправить файл. Проверьте подключение и права Firestore.', 'error', 4000);
            setTimeout(() => removeOperationIndicator(indicator), 3500);
        });
    } catch (e) {
        console.error('sendMediaFile error:', e);
        updateOperationIndicator(indicator, 'Не удалось подготовить файл', 'Попробуйте ещё раз');
        showToast('❌ Ошибка отправки', 'error');
        setTimeout(() => removeOperationIndicator(indicator), 3500);
        return;
    }
}

export async function toggleVoiceRecording() {
    const chatContext = {
        chatId: uiState.currentChatId,
        currentChat: uiState.currentChat,
        currentGroup: uiState.currentGroup,
        currentChannel: uiState.currentChannel,
        sedaEnabled: uiState.sedaEnabledForCurrentChat,
        sedaKey: uiState.currentSedaKey
    };
    if (uiState.currentChannel && !uiState.currentChannel.isAdmin) {
        showToast('❌ Только администраторы', 'error');
        return;
    }
    const btn = document.getElementById('voiceBtn');

    if (uiState.recording) {
        uiState.mediaRecorder?.stop();
        uiState.recording = false;
        btn.classList.remove('recording');
        btn.textContent = '🎤';
        return;
    }

    if (!checkRateLimit(uiState.mediaTimes, RATE_LIMIT.media.count, RATE_LIMIT.media.windowMs)) return;

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        uiState.recordedChunks = [];
        uiState.mediaRecorder = new MediaRecorder(stream);

        uiState.mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) uiState.recordedChunks.push(e.data);
        };

        uiState.mediaRecorder.onstop = async () => {
            stream.getTracks().forEach(t => t.stop());
            if (!uiState.recordedChunks.length) return;
            const blob = new Blob(uiState.recordedChunks, { type: 'audio/webm' });
            if (blob.size > 2 * 1024 * 1024) {
                showToast('Голосовое слишком длинное', 'error');
                return;
            }
            const reader = new FileReader();
            reader.onload = async () => {
                try {
                    let dataUrl = reader.result;
                    let mediaEncrypted = false;
                    if (chatContext.currentChat?.isSeda && !authState.sedaProActivated) {
                        showToast('SEDA-чаты доступны только с активной подпиской', 'error');
                        return;
                    }
                    if (chatContext.currentChat && !chatContext.currentChat.isSeda) {
                        let keyStr = chatContext.sedaKey;
                        if (!keyStr?.startsWith('ICEBERGBASEKEY:')) keyStr = await ensureIcebergBaseKey(chatContext.chatId, chatContext.currentChat.uid);
                        if (!keyStr?.startsWith('ICEBERGBASEKEY:')) throw new Error('Защищённое соединение ещё устанавливается');
                        dataUrl = await icebergBaseEncrypt(dataUrl, keyStr);
                        mediaEncrypted = true;
                        chatContext.sedaKey = keyStr;
                        if (uiState.currentChatId === chatContext.chatId) uiState.currentSedaKey = keyStr;
                    } else if (chatContext.currentChat?.isSeda && authState.sedaProActivated) {
                        const keyStr = chatContext.sedaKey;
                        if (!keyStr?.startsWith('SEDAKEY:')) throw new Error('Ключ SEDA ещё не получен. Запись не отправлена.');
                        dataUrl = await sedaUltraEncryptWithKey(dataUrl, keyStr);
                        mediaEncrypted = true;
                    }
                    const preview = '🎤 Голосовое';
                    const pendingSyncId = queueDirectChatSync(chatContext, preview);
                    const writePromise = addDoc(collection(db, 'messages', chatContext.chatId, 'msgs'), {
                        text: '',
                        senderId: authState.user.uid,
                        senderName: authState.userData.nickname,
                        timestamp: serverTimestamp(),
                        read: false,
                        encrypted: false,
                        mediaEncrypted,
                        type: 'audio',
                        media: dataUrl,
                        fileName: 'voice.webm',
                        fileSize: blob.size,
                        replyTo: uiState.replyTo || null,
                        reactions: {}
                    });
                    cancelReply();
                    if (!navigator.onLine) showToast('Нет сети — голосовое ожидает отправки', 'info', 3500);
                    writePromise.then(async () => {
                        const ok = await updateChatLastMessage(preview, chatContext);
                        if (ok) removePendingChatSync(pendingSyncId);
                    }).catch((e) => {
                        removePendingChatSync(pendingSyncId);
                        console.error('[Voice] Не удалось сохранить сообщение:', e);
                        showToast('Не удалось отправить голосовое. Проверьте подключение и права Firestore.', 'error', 4000);
                    });
                } catch (e) {
                    console.error(e);
                    showToast('❌ Ошибка отправки', 'error');
                }
            };
            reader.readAsDataURL(blob);
        };

        uiState.mediaRecorder.start();
        uiState.recording = true;
        btn.classList.add('recording');
        btn.textContent = '⏹';
        showToast('🎤 Запись...');
    } catch (e) {
        showToast('Нет доступа к микрофону', 'error');
    }
}

export async function toggleReaction(msgId, emoji, evt) {
    if (!uiState.currentChatId) return;
    if (!checkRateLimit(uiState.reactionTimes, RATE_LIMIT.reactions.count, RATE_LIMIT.reactions.windowMs)) return;

    try {
        const ref = doc(db, 'messages', uiState.currentChatId, 'msgs', msgId);
        const d = await getDoc(ref);
        if (!d.exists()) return;
        const msg = d.data();
        const reactions = { ...(msg.reactions || {}) };
        const users = reactions[emoji] || [];
        const wasAdding = !users.includes(authState.user.uid);

        if (wasAdding) {
            reactions[emoji] = [...users, authState.user.uid];
            spawnReactionBurst(evt?.currentTarget || document.getElementById('msg-' + msgId), emoji);
        } else {
            reactions[emoji] = users.filter(u => u !== authState.user.uid);
            if (!reactions[emoji].length) delete reactions[emoji];
        }
        await updateDoc(ref, { reactions });
    } catch (e) {
        console.error(e);
    }
}

function spawnReactionBurst(targetEl, emoji) {
    let rect;
    if (targetEl && targetEl.getBoundingClientRect) rect = targetEl.getBoundingClientRect();
    else rect = { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0 };

    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    for (let i = 0; i < 8; i++) {
        const el = document.createElement('span');
        el.className = 'reaction-burst';
        el.textContent = emoji;
        el.style.left = cx + 'px';
        el.style.top = cy + 'px';
        const angle = (Math.PI * 2 * i) / 8 + Math.random() * 0.5;
        const dist = 40 + Math.random() * 50;
        el.style.setProperty('--dx', (Math.cos(angle) * dist).toFixed(1) + 'px');
        el.style.setProperty('--dy', (Math.sin(angle) * dist).toFixed(1) + 'px');
        el.style.setProperty('--rot', (Math.random() * 720 - 360).toFixed(0) + 'deg');
        el.style.animationDelay = (i * 0.02) + 's';
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 1300);
    }
}

export function bindChatLongPress() {
    const area = document.getElementById('messagesArea');
    if (!area) return;
    area.querySelectorAll('.message-bubble').forEach(el => {
        if (el.dataset.bound) return;
        el.dataset.bound = '1';

        let pressTimer = null;
        let longPressed = false;
        let startX = 0, startY = 0;

        const start = (e) => {
            longPressed = false;
            if (e.touches) { startX = e.touches[0].clientX; startY = e.touches[0].clientY; }
            el.classList.add('pressing');
            pressTimer = setTimeout(() => {
                longPressed = true;
                el.classList.remove('pressing');
                const id = el.dataset.id;
                if (id) openMessageActionBar(id, el);
            }, 500);
        };
        const cancel = () => {
            el.classList.remove('pressing');
            if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
        };
        const move = (e) => {
            if (e.touches && pressTimer) {
                const dx = Math.abs(e.touches[0].clientX - startX);
                const dy = Math.abs(e.touches[0].clientY - startY);
                if (dx > 8 || dy > 8) cancel();
            }
        };

        el.addEventListener('touchstart', start, { passive: true });
        el.addEventListener('touchend', cancel);
        el.addEventListener('touchmove', move, { passive: true });
        el.addEventListener('touchcancel', cancel);
        el.addEventListener('mousedown', start);
        el.addEventListener('mouseup', cancel);
        el.addEventListener('mouseleave', cancel);
        el.addEventListener('click', (e) => {
            if (longPressed) { e.preventDefault(); e.stopPropagation(); longPressed = false; }
        });
    });
}

function closeActionBar() {
    if (uiState.activeActionBar) { uiState.activeActionBar.remove(); uiState.activeActionBar = null; }
}

async function openMessageActionBar(id, msgEl) {
    closeActionBar();
    try {
        const ref = doc(db, 'messages', uiState.currentChatId, 'msgs', id);
        const d = await getDoc(ref);
        if (!d.exists()) return;
        const m = d.data();
        const isOwn = m.senderId === authState.user.uid;
        const canDelete = isOwn || (uiState.currentChannel && uiState.currentChannel.isAdmin);
        const canEdit = isOwn && m.type === 'text' && !m.deleted;

        const bar = document.createElement('div');
        bar.className = 'msg-action-bar';

        for (const emoji of REACTION_EMOJIS.slice(0, 5)) {
            const btn = document.createElement('button');
            btn.className = 'reaction-btn';
            btn.textContent = emoji;
            btn.onclick = (e) => { e.stopPropagation(); toggleReaction(id, emoji, e); closeActionBar(); };
            bar.appendChild(btn);
        }

        const sep = document.createElement('div');
        sep.className = 'bar-sep';
        bar.appendChild(sep);

        const replyBtn = document.createElement('button');
        replyBtn.className = 'bar-btn';
        replyBtn.textContent = '↩ Ответ';
        replyBtn.onclick = (e) => { e.stopPropagation(); startReply(id, m); closeActionBar(); };
        bar.appendChild(replyBtn);

        const forwardBtn = document.createElement('button');
        forwardBtn.className = 'bar-btn';
        forwardBtn.textContent = '↪ Переслать';
        forwardBtn.onclick = (e) => { e.stopPropagation(); forwardMessage(id, m); closeActionBar(); };
        bar.appendChild(forwardBtn);

        if (canEdit) {
            const editBtn = document.createElement('button');
            editBtn.className = 'bar-btn';
            editBtn.textContent = '✏️';
            editBtn.onclick = (e) => { e.stopPropagation(); startEdit(id, m); closeActionBar(); };
            bar.appendChild(editBtn);
        }
        if (canDelete) {
            const delBtn = document.createElement('button');
            delBtn.className = 'bar-btn danger';
            delBtn.textContent = '🗑';
            delBtn.onclick = (e) => { e.stopPropagation(); closeActionBar(); deleteMessage(id); };
            bar.appendChild(delBtn);
        }

        document.body.appendChild(bar);
        const mr = msgEl.getBoundingClientRect();
        const br = bar.getBoundingClientRect();
        let top = mr.top - br.height - 6;
        if (top < 8) top = mr.bottom + 6;
        let left = mr.left + mr.width / 2 - br.width / 2;
        if (left < 8) left = 8;
        if (left + br.width > innerWidth - 8) left = innerWidth - 8 - br.width;

        bar.style.position = 'fixed';
        bar.style.top = top + 'px';
        bar.style.left = left + 'px';
        uiState.activeActionBar = bar;

        const outside = (e) => {
            if (uiState.activeActionBar && !uiState.activeActionBar.contains(e.target)) {
                closeActionBar();
                document.removeEventListener('mousedown', outside);
                document.removeEventListener('touchstart', outside);
            }
        };
        setTimeout(() => {
            document.addEventListener('mousedown', outside);
            document.addEventListener('touchstart', outside, { passive: true });
        }, 10);
    } catch (e) {
        console.error(e);
    }
}

export function startReply(id, msgData) {
    uiState.replyTo = id;
    const rp = document.getElementById('replyPreview');
    const rt = document.getElementById('replyPreviewText');
    if (!rp || !rt) return;
    const sender = msgData.senderId === authState.user.uid ? 'Вы' : (msgData.senderName || 'Собеседник');
    let preview = '';
    if (msgData.type === 'sticker') preview = msgData.text;
    else if (msgData.type === 'photo') preview = '📷 Фото';
    else if (msgData.type === 'video') preview = '🎥 Видео';
    else if (msgData.type === 'audio') preview = '🎤 Голосовое';
    else if (msgData.type === 'file') preview = '📄 ' + msgData.fileName;
    else preview = (msgData.text || '').substring(0, 40);

    rt.textContent = `↩ ${sender}: ${preview}`;
    rp.classList.remove('hidden');
    document.getElementById('messageInput')?.focus();
}

export async function startEdit(id, msgData) {
    uiState.editingMessage = id;
    let displayText = msgData.text;
    if (msgData.encrypted && uiState.currentSedaKey && authState.sedaProActivated) {
        displayText = isSedaUltraPayload(msgData.text)
            ? (uiState.currentChat?.isSeda
                ? await sedaUltraDecrypt(msgData.text, uiState.currentSedaKey) ?? '[Не удалось расшифровать SEDA Ultra]'
                : '[SEDA Ultra доступен только в SEDA-чатах]')
            : await icebergBaseDecrypt(msgData.text, uiState.currentSedaKey) ?? '[Не удалось расшифровать сообщение Iceberg]';
    }
    const input = document.getElementById('messageInput');
    input.value = displayText;
    input.focus();
    const rp = document.getElementById('replyPreview');
    const rt = document.getElementById('replyPreviewText');
    if (rp && rt) {
        rt.textContent = '✏️ Редактирование';
        rp.classList.remove('hidden');
    }
}

export async function forwardMessage(id, msgData) {
    const target = prompt('Введите Global ID получателя:');
    if (!target) return;
    try {
        const ref = doc(db, 'global_ids', target);
        const snap = await getDoc(ref);
        if (!snap.exists()) { showToast('Получатель не найден', 'error'); return; }
        const targetUid = snap.data().uid;
        const targetChatId = [authState.user.uid, targetUid].sort().join('_');
        await addDoc(collection(db, 'messages', targetChatId, 'msgs'), {
            ...msgData,
            senderId: authState.user.uid,
            senderName: authState.userData.nickname,
            timestamp: serverTimestamp(),
            read: false,
            reactions: {},
            replyTo: null,
            forwarded: true
        });
        showToast('✅ Переслано', 'success');
    } catch (e) {
        showToast('Ошибка пересылки', 'error');
    }
}

export function cancelReply() {
    uiState.replyTo = null;
    uiState.editingMessage = null;
    const rp = document.getElementById('replyPreview');
    if (rp) rp.classList.add('hidden');
    const input = document.getElementById('messageInput');
    if (input) input.value = '';
}

export async function deleteMessage(id) {
    if (!confirm('Удалить сообщение?')) return;
    try {
        const ref = doc(db, 'messages', uiState.currentChatId, 'msgs', id);
        const d = await getDoc(ref);
        if (!d.exists()) return;
        const m = d.data();
        const isOwn = m.senderId === authState.user.uid;
        const isChannelAdmin = uiState.currentChannel && uiState.currentChannel.isAdmin;
        if (!isOwn && !isChannelAdmin) {
            showToast('❌ Нет прав', 'error');
            return;
        }
        await updateDoc(ref, {
            text: '🗑 Удалено',
            deleted: true,
            media: '',
            type: 'text',
            encrypted: false
        });
    } catch (e) {
        showToast('Ошибка', 'error');
    }
}

export function scrollToMessage(id) {
    const el = document.getElementById('msg-' + id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.style.boxShadow = '0 0 0 3px var(--accent)';
    setTimeout(() => { el.style.boxShadow = ''; }, 1200);
}

const sedaInitiatorListeners = new Map();

function watchSedaInitiatorHandshake(sedaChatId) {
    if (!sedaChatId || sedaInitiatorListeners.has(sedaChatId)) return;
    const ref = doc(db, 'seda_handshakes', sedaChatId);
    let unsub = () => {};
    let processing = false;
    let resolved = false;

    unsub = onSnapshot(ref, async snap => {
        if (!snap.exists()) {
            try { unsub(); } catch {}
            sedaInitiatorListeners.delete(sedaChatId);
            return;
        }
        const data = snap.data();
        if (data.initiator !== authState.user?.uid
            || !data.peerPublicKey
            || !data.encryptedSedaKey
            || processing
            || resolved) return;

        processing = true;
        try {
            // Restore the initiator's saved private key after a page reload instead
            // of creating a new key that can no longer decrypt the peer's response.
            const saved = await DB.getECDHKeys(sedaChatId);
            if (!saved?.privateKey) throw new Error('Не найден локальный ключ SEDA');
            const privateKey = await crypto.subtle.importKey(
                'jwk', saved.privateKey,
                { name: 'ECDH', namedCurve: 'P-256' },
                true, ['deriveKey', 'deriveBits']
            );
            const peerPublic = await importPublicKey(data.peerPublicKey);
            const sharedKey = await deriveSharedKey(privateKey, peerPublic);
            const key = await aesDecrypt(data.encryptedSedaKey, sharedKey);
            if (!key?.startsWith('SEDAKEY:')) throw new Error('Не удалось расшифровать ключ SEDA');

            await DB.saveSedaKey(sedaChatId, key);
            await DB.markSedaKeyShared(sedaChatId);
            if (uiState.currentChatId === sedaChatId) {
                uiState.currentSedaKey = key;
                uiState.sedaEnabledForCurrentChat = !!authState.sedaProActivated;
                updateSedaUI();
                await loadMessages();
            }
            await updateDoc(ref, {
                initiatorAck: true,
                initiatorAckAt: Date.now(),
                completed: true,
                expiresAt: null
            }).catch(err => console.warn('[SEDA] Не удалось подтвердить рукопожатие:', err));

            resolved = true;
            showToast('✅ SEDA-чат установлен!', 'success');
            try { unsub(); } catch {}
            sedaInitiatorListeners.delete(sedaChatId);
        } catch (err) {
            console.error('[SEDA initiator] Не удалось восстановить ключ:', err);
            showToast('Не удалось завершить SEDA-шифрование. Откройте чат ещё раз и проверьте соединение.', 'error', 4500);
        } finally {
            processing = false;
        }
    }, err => {
        console.error('[SEDA initiator listener]', { code: err?.code || 'unknown', message: err?.message || String(err) });
        try { unsub(); } catch {}
        sedaInitiatorListeners.delete(sedaChatId);
    });

    sedaInitiatorListeners.set(sedaChatId, unsub);
}

export async function startSedaChat() {
    if (!authState.sedaProActivated) {
        showToast('⚠️ SEDA Pro не активирован', 'error');
        return;
    }
    if (!uiState.currentChat || !uiState.currentChat.uid || uiState.currentChat.isSeda) {
        showToast('Откройте обычный чат с контактом', 'error');
        return;
    }

    const peerUid = uiState.currentChat.uid;
    const baseChatId = [authState.user.uid, peerUid].sort().join('_');
    const sedaChatId = 'seda_' + baseChatId;

    const localSedaKey = await DB.getSedaKey(sedaChatId);
    const localSedaKeyShared = localSedaKey?.startsWith('SEDAKEY:')
        && await DB.isSedaKeyShared(sedaChatId);
    if (localSedaKeyShared) {
        showToast('🔮 SEDA-чат уже существует', 'info');
        await openSedaChat(peerUid, sedaChatId);
        return;
    }

    showToast('🔮 Создание SEDA-чата...', 'info');

    const handshakeRef = doc(db, 'seda_handshakes', sedaChatId);
    const previousHandshake = await getDoc(handshakeRef);
    if (previousHandshake.exists()) {
        const previous = previousHandshake.data();
        const expired = Number(previous.expiresAt) > 0 && Number(previous.expiresAt) <= Date.now();
        if (!expired || previous.initiator !== authState.user.uid) {
            showToast(expired
                ? 'Предыдущий запрос SEDA истёк. Попросите инициатора создать новый.'
                : 'Рукопожатие SEDA уже выполняется. Подождите несколько секунд.',
                'info', 4500);
            return;
        }
        await deleteDoc(handshakeRef);
        await DB.deleteECDHKeys(sedaChatId);
    }

    // Generate/store a new private key only after we know no active handshake exists.
    const keyPair = await generateECDHKeyPair();
    const pubBase64 = await exportPublicKey(keyPair);
    const privJwk = await exportPrivateKey(keyPair);
    await DB.saveECDHKeys(sedaChatId, pubBase64, privJwk);

    await setDoc(handshakeRef, {
        initiator: authState.user.uid,
        peer: peerUid,
        initiatorPublicKey: pubBase64,
        peerPublicKey: null,
        encryptedSedaKey: null,
        createdAt: Date.now(),
        expiresAt: Date.now() + 5 * 60 * 1000
    });

    watchSedaInitiatorHandshake(sedaChatId);

    setTimeout(async () => {
        try {
            const snapshot = await getDoc(handshakeRef);
            if (!snapshot.exists()) return;
            const data = snapshot.data();
            if (data.initiator === authState.user?.uid
                && Number(data.expiresAt) > 0
                && Number(data.expiresAt) <= Date.now()) {
                await deleteDoc(handshakeRef);
                await DB.deleteECDHKeys(sedaChatId);
                await DB.deleteSedaKey(sedaChatId);
            }
        } catch (err) {
            console.warn('[SEDA] Не удалось очистить истёкшее рукопожатие:', err);
        }
    }, 5 * 60 * 1000);

    await openSedaChat(peerUid, sedaChatId);
}

async function openSedaChat(peerUid, sedaChatId) {
    const contact = ensureArray(authState.userData.contacts).find(c => c.uid === peerUid)
        || ensureArray(authState.userData.chats).find(c => c.uid === peerUid && !c.isGroup);

    if (!contact) { showToast('Контакт не найден', 'error'); return; }

    let chats = ensureArray(authState.userData.chats);
    let sedaChat = chats.find(c => c.sedaChatId === sedaChatId);

    if (!sedaChat) {
        sedaChat = {
            uid: peerUid,
            globalId: contact.globalId || '',
            nickname: contact.nickname || '',
            avatar: contact.avatar || null,
            mood: contact.mood || null,
            isGroup: false,
            isSeda: true,
            sedaChatId,
            unread: false,
            lastMessage: '🔮 SEDA-чат',
            lastMessageTime: new Date()
        };
        chats = [...chats, sedaChat];
        authState.userData.chats = chats;
        await updateDoc(doc(db, 'users', authState.user.uid), { chats }).catch(() => {});
        await DB.Lists.setChats(authState.user.uid, chats);
    }

    uiState.sedaEnabledForCurrentChat = true;
    uiState.currentSedaKey = await DB.getSedaKey(sedaChatId);
    await selectChat(sedaChat);
    loadChats();
}

export function startSedaHandshakeListener() {
    if (uiState.sedaHandshakeUnsub) uiState.sedaHandshakeUnsub();
    if (!authState.user) return;

    const q = query(collection(db, 'seda_handshakes'), where('peer', '==', authState.user.uid));
    uiState.sedaHandshakeUnsub = onSnapshot(q, async (snap) => {
        for (const d of snap.docs) {
            const data = d.data();
            if (data.mode === 'iceberg-base') {
                const sharedLocalBaseKey = await DB.isSedaKeyShared(data.chatId);
                if (data.initiatorAck === true && sharedLocalBaseKey) {
                    await deleteDoc(d.ref).catch(() => {});
                    continue;
                }
                if (Number(data.expiresAt) > 0 && Number(data.expiresAt) <= Date.now()
                    && data.peerKeyStored !== true) {
                    // Let the original initiator replace expired unfinished Base attempts.
                    continue;
                }
                if (!data.initiatorPublicKey) continue;
                if (data.peerPublicKey && data.encryptedBaseKey
                    && (!data.peerKeyStored || !sharedLocalBaseKey)
                    && !uiState.processedHandshakes.has(d.id)) {
                    uiState.processedHandshakes.add(d.id);
                    try {
                        const savedPair = await DB.getECDHKeys(d.id);
                        if (!savedPair) throw new Error('Нет локального приватного ключа');
                        const privateKey = await crypto.subtle.importKey('jwk', savedPair.privateKey,
                            { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
                        const initiatorPublic = await importPublicKey(data.initiatorPublicKey);
                        const shared = await deriveSharedKey(privateKey, initiatorPublic, 'iceberg-base-handshake-v1');
                        const key = await aesDecrypt(data.encryptedBaseKey, shared);
                        if (!key?.startsWith('ICEBERGBASEKEY:')) throw new Error('Неверный базовый ключ');
                        await DB.saveSedaKey(data.chatId, key);
                        await DB.markSedaKeyShared(data.chatId);
                        await updateDoc(d.ref, { peerKeyStored: true, peerKeyStoredAt: Date.now() });
                        if (uiState.currentChatId === data.chatId) {
                            uiState.currentSedaKey = key;
                            await loadMessages();
                        }
                    } catch (err) { console.error('[Iceberg Base responder]', err); uiState.processedHandshakes.delete(d.id); }
                    continue;
                }
                if (!data.peerPublicKey && !uiState.processedHandshakes.has(d.id)) {
                    uiState.processedHandshakes.add(d.id);
                    try {
                        const pair = await generateECDHKeyPair();
                        const pub = await exportPublicKey(pair);
                        const priv = await exportPrivateKey(pair);
                        await DB.saveECDHKeys(d.id, pub, priv);
                        await updateDoc(d.ref, { peerPublicKey: pub, peerRespondedAt: Date.now() });
                        uiState.processedHandshakes.delete(d.id);
                    } catch (err) { console.error('[Iceberg Base responder setup]', err); uiState.processedHandshakes.delete(d.id); }
                }
                continue;
            }
            // Recover older/incomplete SEDA handshakes where the peer public key was
            // published but the local IndexedDB write did not finish before a reload.
            const localSedaShared = await DB.isSedaKeyShared(d.id);
            if (data.initiatorPublicKey && data.peerPublicKey && data.encryptedSedaKey
                && (data.peerKeyStored !== true || !localSedaShared)
                && !uiState.processedHandshakes.has(d.id)) {
                uiState.processedHandshakes.add(d.id);
                try {
                    const saved = await DB.getECDHKeys(d.id);
                    if (!saved?.privateKey) throw new Error('Нет сохранённого ключа для восстановления SEDA');
                    const privateKey = await crypto.subtle.importKey(
                        'jwk', saved.privateKey,
                        { name: 'ECDH', namedCurve: 'P-256' },
                        true, ['deriveKey', 'deriveBits']
                    );
                    const initiatorPublic = await importPublicKey(data.initiatorPublicKey);
                    const shared = await deriveSharedKey(privateKey, initiatorPublic);
                    const recoveredKey = await aesDecrypt(data.encryptedSedaKey, shared);
                    if (!recoveredKey?.startsWith('SEDAKEY:')) throw new Error('Некорректный восстановленный ключ SEDA');
                    await DB.saveSedaKey(d.id, recoveredKey);
                    await DB.markSedaKeyShared(d.id);
                    await updateDoc(d.ref, { peerKeyStored: true, peerKeyStoredAt: Date.now() });

                    if (uiState.currentChatId === d.id) {
                        uiState.currentSedaKey = recoveredKey;
                        uiState.sedaEnabledForCurrentChat = !!authState.sedaProActivated;
                        updateSedaUI();
                        await loadMessages();
                    }
                    const initiatorContact = ensureArray(authState.userData?.contacts)
                        .find(contact => contact.uid === data.initiator);
                    if (initiatorContact) {
                        const chats = ensureArray(authState.userData?.chats);
                        if (!chats.some(chat => chat.sedaChatId === d.id)) {
                            const nextChats = [...chats, {
                                uid: data.initiator,
                                globalId: initiatorContact.globalId || '',
                                nickname: initiatorContact.nickname || '',
                                avatar: initiatorContact.avatar || null,
                                mood: initiatorContact.mood || null,
                                isGroup: false,
                                isSeda: true,
                                sedaChatId: d.id,
                                unread: true,
                                lastMessage: '🔮 SEDA-чат восстановлен',
                                lastMessageTime: new Date()
                            }];
                            authState.userData.chats = nextChats;
                            await updateDoc(doc(db, 'users', authState.user.uid), { chats: nextChats });
                            await DB.Lists.setChats(authState.user.uid, nextChats);
                            loadChats();
                        }
                    }
                    showToast('🔮 Ключ SEDA восстановлен', 'success');
                } catch (err) {
                    console.error('[SEDA recovery]', err);
                    uiState.processedHandshakes.delete(d.id);
                }
                continue;
            }

            // The initiator may acknowledge immediately; only delete after recovery checks above.
            if (data.initiatorAck === true && data.mode !== 'iceberg-base') {
                await deleteDoc(d.ref).catch(err => console.warn('[SEDA] Не удалось удалить рукопожатие:', err));
                continue;
            }
            if (data.completed === true || uiState.processedHandshakes.has(d.id)) continue;
            if (!data.initiatorPublicKey || data.peerPublicKey) continue;

            uiState.processedHandshakes.add(d.id);

            try {
                const keyPair = await generateECDHKeyPair();
                const myPub = await exportPublicKey(keyPair);
                const myPrivJwk = await exportPrivateKey(keyPair);
                await DB.saveECDHKeys(d.id, myPub, myPrivJwk);

                const peerPub = await importPublicKey(data.initiatorPublicKey);
                const sharedKey = await deriveSharedKey(keyPair.privateKey, peerPub);

                const mySedaKey = serializeKey(generateSedaKey());
                const encryptedMyKey = await aesEncrypt(mySedaKey, sharedKey);

                // Persist the exchanged key locally before telling the initiator it is stored.
                // This keeps a fast acknowledgement/reload from deleting the only recovery copy.
                await DB.saveSedaKey(d.id, mySedaKey);
                await DB.markSedaKeyShared(d.id);
                await updateDoc(d.ref, {
                    peerPublicKey: myPub,
                    encryptedSedaKey: encryptedMyKey,
                    respondedAt: Date.now(),
                    peerKeyStored: true,
                    peerKeyStoredAt: Date.now()
                });

                const initiatorUid = data.initiator;
                const contact = ensureArray(authState.userData.contacts).find(c => c.uid === initiatorUid);
                if (contact) {
                    let chats = ensureArray(authState.userData.chats);
                    if (!chats.find(c => c.sedaChatId === d.id)) {
                        chats = [...chats, {
                            uid: initiatorUid,
                            globalId: contact.globalId || '',
                            nickname: contact.nickname || '',
                            avatar: contact.avatar || null,
                            isGroup: false,
                            isSeda: true,
                            sedaChatId: d.id,
                            unread: true,
                            lastMessage: '🔮 SEDA-чат создан',
                            lastMessageTime: new Date()
                        }];
                        authState.userData.chats = chats;
                        await updateDoc(doc(db, 'users', authState.user.uid), { chats }).catch(() => {});
                        loadChats();
                    }
                }
                showToast('🔮 Получен SEDA-чат', 'success');
            } catch (e) {
                console.error('[SEDA handshake]', e);
                uiState.processedHandshakes.delete(d.id);
            }
        }
    }, (err) => {
        if (err.code === 'permission-denied') {
            console.warn('[SEDA handshake] Ожидание прав доступа. Игнорируем...');
        } else {
            console.error('[SEDA handshake]', err);
        }
    });
}

export async function showCurrentSedaKey() {
    if (!uiState.sedaEnabledForCurrentChat || !uiState.currentChatId) {
        showToast('Откройте SEDA-чат', 'error');
        return;
    }
    const k = await DB.getSedaKey(uiState.currentChatId);
    if (!k) { showToast('Ключ не найден', 'error'); return; }
    document.getElementById('sedaKeyDisplay').textContent = k;
    document.getElementById('sedaKeyScreen').classList.add('active');
}

export async function pasteSedaKeyFromClipboard() {
    try {
        const txt = await navigator.clipboard.readText();
        if (!txt || !txt.startsWith('SEDAKEY:')) {
            showToast('❌ Нет ключа в буфере', 'error');
            return;
        }
        if (!uiState.currentChatId) return;
        await DB.saveSedaKey(uiState.currentChatId, txt, false, true);
        uiState.currentSedaKey = txt;
        uiState.sedaEnabledForCurrentChat = true;
        showToast('✅ Ключ вставлен!', 'success');
        loadMessages();
    } catch (e) {
        showToast('❌ Не удалось прочитать буфер', 'error');
    }
}

export function copySedaKeyToClipboard() {
    const k = document.getElementById('sedaKeyDisplay').textContent;
    if (!k) return;
    navigator.clipboard.writeText(k)
        .then(() => showToast('✅ Скопировано', 'success'))
        .catch(() => showToast('❌ Ошибка', 'error'));
}

export function updateSedaUI() {
    const sm = document.getElementById('sedaModeBtn');
    const sk = document.getElementById('sedaKeyBtn');

    if (sm) {
        const showSedaMode = authState.sedaProActivated
            && uiState.currentChatId
            && uiState.currentChat
            && !uiState.currentChat.isSeda
            && !uiState.currentChannel;
        sm.style.display = showSedaMode ? 'inline-block' : 'none';
    }
    if (sk) {
        const showSedaKey = authState.sedaProActivated
            && uiState.sedaEnabledForCurrentChat
            && uiState.currentChatId;
        sk.style.display = showSedaKey ? 'inline-block' : 'none';
    }
}

function startChatMetaListener(chat) {
    if (uiState.chatMetaUnsub) {
        try { uiState.chatMetaUnsub(); } catch {}
        uiState.chatMetaUnsub = null;
    }
    if (!chat || !chat.uid || chat.isSeda) return;

    // Presence is intentionally separate from the private /users document.
    uiState.chatMetaUnsub = onSnapshot(doc(db, 'presence', chat.uid), (snap) => {
        if (!snap.exists()) {
            const statusEl = document.getElementById('chatStatus');
            if (statusEl) statusEl.textContent = chat.mood || '🔒 Личный чат';
            return;
        }
        const data = snap.data();
        const statusEl = document.getElementById('chatStatus');
        if (!statusEl || uiState.currentChat?.uid !== chat.uid) return;

        if (data.typing && data.typingUntil > Date.now()) {
            statusEl.textContent = 'печатает…';
            return;
        }
        if (data.online) {
            statusEl.textContent = 'в сети';
        } else if (data.lastSeen) {
            const time = data.lastSeen.toDate?.();
            statusEl.textContent = 'был(а) ' + (time ? formatTime(time) : '');
        } else {
            statusEl.textContent = chat.mood || 'не в сети';
        }
    }, error => {
        console.warn('[Presence] Не удалось загрузить статус собеседника:', error);
    });
}

export async function notifyTyping() {
    if (!uiState.currentChat || !uiState.currentChat.uid) return;
    if (uiState.typingTimeout) clearTimeout(uiState.typingTimeout);
    try {
        const typingUntil = Date.now() + 2000;
        await Promise.all([
            updateDoc(doc(db, 'users', authState.user.uid), {
                typing: true,
                typingUntil
            }).catch(() => {}),
            setDoc(doc(db, 'presence', authState.user.uid), {
                uid: authState.user.uid,
                typing: true,
                typingUntil,
                updatedAt: serverTimestamp()
            }, { merge: true }).catch(() => {})
        ]);
        uiState.typingTimeout = setTimeout(() => {
            updateDoc(doc(db, 'users', authState.user.uid), {
                typing: false,
                typingUntil: 0
            }).catch(() => {});
            setDoc(doc(db, 'presence', authState.user.uid), {
                uid: authState.user.uid,
                typing: false,
                typingUntil: 0,
                updatedAt: serverTimestamp()
            }, { merge: true }).catch(() => {});
        }, 2000);
    } catch {}
}

export async function clearChatById(uid, sedaChatId, explicitChatId = '', kind = 'chat') {
    // History clearing is per-user: never try to delete messages sent by the other participant.
    const chatId = explicitChatId || (sedaChatId ? sedaChatId : [authState.user.uid, uid].sort().join('_'));
    if (!chatId || !authState.user?.uid) return;
    if (!confirm('Очистить историю только у вас? У других участников она останется.')) return;
    try {
        await markHistoryCleared(chatId);
        await DB.clearCachedMessages(chatId);
        if (uiState.currentChatId === chatId) {
            if (uiState.messagesUnsub) { try { uiState.messagesUnsub(); } catch {} uiState.messagesUnsub = null; }
            ++messageLoadVersion;
            const area = document.getElementById('messagesArea');
            if (area) area.innerHTML = '<div class="empty-state">История очищена. Новые сообщения появятся здесь.</div>';
            await loadMessages();
        }
        const contextKind = uiState.currentChannel && uiState.currentChatId === chatId
            ? 'канала'
            : uiState.currentGroup && uiState.currentChatId === chatId
                ? 'группы'
                : (kind === 'channel' ? 'канала' : kind === 'group' ? 'группы' : 'чата');
        showToast(`История ${contextKind} очищена`, 'success');
    } catch (e) {
        console.error('[Chat clear] Не удалось очистить историю:', e);
        showToast('Не удалось очистить историю. Проверьте доступ к Firestore и повторите попытку.', 'error');
    }
}

export async function deleteChatById(uid, sedaChatId) {
    if (!confirm('Удалить чат из списка и скрыть его старую историю только у вас?')) return false;
    try {
        const chatId = sedaChatId || [authState.user.uid, uid].sort().join('_');
        await markHistoryCleared(chatId);
        await DB.clearCachedMessages(chatId);
        const chats = ensureArray(authState.userData.chats).filter(c => {
            if (sedaChatId && c.sedaChatId === sedaChatId) return false;
            if (!sedaChatId && c.uid === uid && !c.isGroup && !c.isSeda) return false;
            return true;
        });
        await updateDoc(doc(db, 'users', authState.user.uid), { chats });
        authState.userData.chats = chats;
        await DB.Lists.setChats(authState.user.uid, chats);
        if (uiState.currentChatId === chatId) closeChat();
        loadChats();
        showToast('Чат удалён из списка. Старая история скрыта у вас.', 'success');
        return true;
    } catch (e) {
        console.error('[Chat delete] Не удалось удалить чат:', e);
        showToast('Не удалось удалить чат. Проверьте права доступа и повторите попытку.', 'error');
        return false;
    }
}

export async function clearCurrentChat() {
    if (!uiState.currentChatId || !authState.user?.uid) return;
    // Clearing is a personal history marker. Channel admins do not get to erase
    // history for everyone, and ordinary members can clear their own view too.
    const kind = uiState.currentChannel ? 'channel' : uiState.currentGroup ? 'group' : 'chat';
    await clearChatById(
        uiState.currentChat?.uid || '',
        uiState.currentChat?.sedaChatId || '',
        uiState.currentChatId,
        kind
    );
}

export async function deleteCurrentChat() {
    if (!uiState.currentChat) return;
    const deleted = await deleteChatById(uiState.currentChat.uid, uiState.currentChat.sedaChatId || '');
    if (deleted) closeChat();
}

export async function openChatWithContact(contact) {
    if (!contact || !contact.uid) return;
    let chats = ensureArray(authState.userData?.chats);
    let chat = chats.find(c => c.uid === contact.uid && !c.isGroup && !c.isSeda);
    if (!chat) {
        chat = {
            uid: contact.uid,
            globalId: contact.globalId || '',
            nickname: contact.nickname || '',
            email: contact.email || '',
            avatar: contact.avatar || null,
            mood: contact.mood || null,
            isGroup: false,
            unread: false,
            lastMessage: '',
            lastMessageTime: null
        };
        chats = [...chats, chat];
        try {
            await updateDoc(doc(db, 'users', authState.user.uid), { chats });
            authState.userData.chats = chats;
        } catch {}
    }
    await selectChat(chat);
    loadChats();
    switchTab('chats');
}

export function switchTab(tab) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

    const tabs = document.querySelectorAll('.tab');
    const map = { chats: 0, channels: 1, groups: 2, contacts: 3 };
    const idx = map[tab];
    if (idx !== undefined && tabs[idx]) tabs[idx].classList.add('active');

    const pane = document.getElementById(tab + 'Pane');
    if (pane) pane.classList.add('active');

    if (tab === 'chats') loadChats();
    else if (tab === 'channels') loadChannels();
    else if (tab === 'groups') loadGroups();
    else if (tab === 'contacts') loadContacts();
}

let autoDeleteInterval = null;

export async function setAutoDelete(hours) {
    uiState.autoDeleteHours = hours;
    await updateDoc(doc(db, 'users', authState.user.uid), { autoDeleteHours: hours });
    if (authState.userData) authState.userData.autoDeleteHours = hours;
    closeAutoDelete();
    applyAutoDelete();
    showToast('✅ Автоудаление: ' + (hours === 0 ? 'выкл' : hours + 'ч'), 'success');
}

export function applyAutoDelete() {
    if (autoDeleteInterval) clearInterval(autoDeleteInterval);
    if (uiState.autoDeleteHours > 0) {
        autoDeleteInterval = setInterval(async () => {
            const chatId = uiState.currentChatId;
            const uid = authState.user?.uid;
            if (!chatId || !uid) return;
            try {
                // Auto-delete is a per-user history window. Never attempt to erase
                // messages authored by other participants or fail an entire batch.
                const cutoffMs = Date.now() - uiState.autoDeleteHours * 3600000;
                const previousCutoff = await getHistoryClearedAt(chatId);
                if (cutoffMs <= previousCutoff) return;
                await setDoc(doc(db, 'chat_clears', uid, 'items', chatId), {
                    clearedAt: Timestamp.fromMillis(cutoffMs),
                    updatedAt: serverTimestamp()
                }, { merge: true });
                await DB.clearCachedMessages(chatId);
                if (uiState.currentChatId === chatId) await loadMessages();
            } catch (err) {
                console.warn('[Auto-delete] Не удалось обновить окно истории:', err);
            }
        }, 60000);
    }
}

export function openAutoDelete() {
    for (const opt of AUTO_DELETE_OPTIONS) {
        const el = document.getElementById('ad-' + opt.hours);
        if (el) el.textContent = uiState.autoDeleteHours === opt.hours ? '✓' : '';
    }
    document.getElementById('autoDeleteModal').classList.add('active');
}

export function closeAutoDelete() {
    document.getElementById('autoDeleteModal').classList.remove('active');
}

export {
    escapeHtml, formatTime, formatBytes, closeActionBar,
    loadMessages as reloadMessages
};
