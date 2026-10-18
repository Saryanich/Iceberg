import { db, auth, STICKERS, REACTION_EMOJIS, MAX_MEDIA_SIZE, MAX_PHOTO_DIMENSION, MAX_STORIES, STORY_LIFETIME, RATE_LIMIT, AUTO_DELETE_OPTIONS, THEMES } from './config.js';
import {
    collection, doc, getDoc, setDoc, updateDoc, addDoc, deleteDoc,
    query, where, getDocs, onSnapshot, orderBy, limit, serverTimestamp,
    arrayUnion, arrayRemove, writeBatch
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

import {
    sedaEncrypt, sedaDecrypt, sedaEncryptWithKey, serializeKey, deserializeKey,
    generateECDHKeyPair, exportPublicKey, importPublicKey,
    exportPrivateKey, deriveSharedKey, aesEncrypt, aesDecrypt
} from './crypto.js';

import * as DB from './db.js';
import { authState } from './auth.js';

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
    div.onclick = () => openChatWithContact(contact);
    return div;
}

export async function loadGroups() {
    const groups = ensureArray(authState.userData?.groups);
    const c = document.getElementById('groupsList');
    if (!c) return;
    if (!groups.length) {
        c.innerHTML = '<div class="empty-state">Нет групп</div>';
        return;
    }
    c.innerHTML = '';
    for (const g of groups) {
        const div = document.createElement('div');
        div.className = 'group-item';

        const av = document.createElement('div');
        av.className = 'avatar-small';
        av.textContent = '👥';

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
        c.appendChild(div);
    }
}

export async function loadChannels() {
    const channels = ensureArray(authState.userData?.channels);
    const c = document.getElementById('channelsList');
    if (!c) return;
    if (!channels.length) {
        c.innerHTML = '<div class="empty-state">Нет каналов</div>';
        return;
    }
    c.innerHTML = '';
    for (const ch of channels) {
        const div = document.createElement('div');
        div.className = 'channel-item';

        const av = document.createElement('div');
        av.className = 'avatar-small';
        av.style.background = 'linear-gradient(135deg,#f59e0b,#d97706)';
        av.textContent = '📢';

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
        c.appendChild(div);
    }
}

export async function selectChat(chat) {
    if (!chat) return;
    closeCurrentSubscriptions();

    uiState.currentChat = chat;
    uiState.currentGroup = null;
    uiState.currentChannel = null;

    if (chat.isSeda && chat.sedaChatId) {
        uiState.currentChatId = chat.sedaChatId;
        uiState.sedaEnabledForCurrentChat = true;
        uiState.currentSedaKey = await DB.getSedaKey(chat.sedaChatId);
    } else {
        uiState.currentChatId = [authState.user.uid, chat.uid].sort().join('_');
        const savedKey = await DB.getSedaKey(uiState.currentChatId);
        if (savedKey && authState.sedaProActivated) {
            uiState.sedaEnabledForCurrentChat = true;
            uiState.currentSedaKey = savedKey;
        } else {
            uiState.sedaEnabledForCurrentChat = false;
            uiState.currentSedaKey = null;
        }
    }

    renderChatHeader();

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
    if (!group) return;
    closeCurrentSubscriptions();

    uiState.currentGroup = group;
    uiState.currentChat = null;
    uiState.currentChannel = null;
    uiState.currentChatId = `group_${group.id}`;

    const savedKey = await DB.getSedaKey(uiState.currentChatId);
    uiState.sedaEnabledForCurrentChat = !!(savedKey && authState.sedaProActivated);
    uiState.currentSedaKey = savedKey;

    renderChatHeader();
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

    uiState.currentChannel = channel;
    uiState.currentChat = null;
    uiState.currentGroup = null;
    uiState.currentChatId = `channel_${channel.id}`;
    uiState.sedaEnabledForCurrentChat = false;
    uiState.currentSedaKey = null;

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
        nameEl.textContent = g.name;
        avEl.textContent = '👥';
        statusEl.textContent = uiState.sedaEnabledForCurrentChat
            ? '🔮 SEDA Pro активен'
            : `👥 ${g.memberCount || 0} участников`;
    } else if (ch) {
        nameEl.textContent = '📢 ' + ch.name;
        avEl.textContent = '📢';
        statusEl.textContent = ch.isAdmin
            ? '👑 Вы администратор'
            : `📢 ${ch.memberCount || 0} подписчиков`;
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

export async function loadMessages() {
    if (uiState.messagesUnsub) {
        try { uiState.messagesUnsub(); } catch {}
        uiState.messagesUnsub = null;
    }

    const chatId = uiState.currentChatId;
    const loadVersion = ++messageLoadVersion;
    const area = document.getElementById('messagesArea');
    if (!chatId || !area) return;

    area.innerHTML = '<div class="empty-state">Загрузка сообщений...</div>';

    // Кэш ускоряет интерфейс, но его сбой не должен блокировать загрузку из Firestore.
    try {
        const cached = await DB.getCachedMessages(chatId);
        if (loadVersion !== messageLoadVersion || uiState.currentChatId !== chatId) return;
        if (cached && cached.length) {
            area.innerHTML = '';
            for (const msg of cached) area.appendChild(renderMessage(msg));
            area.scrollTop = area.scrollHeight;
            bindChatLongPress();
        }
    } catch (err) {
        console.warn('[Messages] Не удалось прочитать локальный кэш:', err);
    }

    if (loadVersion !== messageLoadVersion || uiState.currentChatId !== chatId) return;

    const mRef = collection(db, 'messages', chatId, 'msgs');
    uiState.messagesUnsub = onSnapshot(
        query(mRef, orderBy('timestamp', 'asc'), limit(300)),
        async (snap) => {
            if (loadVersion !== messageLoadVersion || uiState.currentChatId !== chatId) return;
            const msgs = [];
            snap.forEach(d => msgs.push({ id: d.id, ...d.data() }));

            area.innerHTML = '';
            if (!msgs.length) {
                area.innerHTML = '<div class="empty-state">Нет сообщений. Напишите первое!</div>';
            } else {
                for (const msg of msgs) area.appendChild(renderMessage(msg));
                area.scrollTop = area.scrollHeight;
                bindChatLongPress();
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
            showToast('Не удалось загрузить сообщения. Проверьте соединение или доступ.', 'error', 4000);
            if (!area.childElementCount) area.innerHTML = '<div class="empty-state">Не удалось загрузить сообщения</div>';
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

function renderMessage(msg) {
    const isSent = msg.senderId === authState.user.uid;
    const div = document.createElement('div');
    div.className = `message-bubble ${isSent ? 'message-sent' : 'message-received'}`;
    div.id = `msg-${msg.id}`;
    div.dataset.id = msg.id;

    let displayText = msg.text;
    let isEncrypted = msg.encrypted === true;
    let isDecrypted = false;

    if (isEncrypted && msg.text) {
        if (uiState.currentSedaKey) {
            const dec = sedaDecrypt(msg.text, uiState.currentSedaKey);
            if (dec !== null) {
                displayText = dec;
                isDecrypted = true;
                div.classList.add('message-seda');
            } else {
                displayText = '[Зашифровано SEDA Pro]';
                div.classList.add('message-seda');
            }
        } else {
            displayText = '[Зашифровано SEDA Pro]';
            div.classList.add('message-seda');
        }
    }

    let mediaSrc = null;
    if ((msg.type === 'photo' || msg.type === 'video' || msg.type === 'file' || msg.type === 'audio') && msg.media) {
        if (msg.mediaEncrypted && uiState.currentSedaKey) {
            mediaSrc = sedaDecrypt(msg.media, uiState.currentSedaKey);
        } else {
            mediaSrc = msg.media;
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
        badge.textContent = '🔮 SEDA Pro';
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
    const text = input.value.trim();
    if (!text || !uiState.currentChatId) return;

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
            if (chatContext.sedaEnabled && chatContext.sedaKey) {
                editText = sedaEncryptWithKey(originalText, chatContext.sedaKey);
            }
            await updateDoc(doc(db, 'messages', chatIdAtSend, 'msgs', editId), {
                text: editText,
                edited: true,
                editedAt: serverTimestamp()
            });
            document.getElementById('replyPreview')?.classList.add('hidden');
            return;
        }

        let textToSend = originalText;
        let encrypted = false;

        if (chatContext.sedaEnabled && authState.sedaProActivated) {
            let keyStr = chatContext.sedaKey;
            if (!keyStr) {
                const r = sedaEncrypt(originalText);
                textToSend = r.encrypted;
                await DB.saveSedaKey(chatIdAtSend, r.key);
                chatContext.sedaKey = r.key;
                if (uiState.currentChatId === chatIdAtSend) uiState.currentSedaKey = r.key;
            } else {
                textToSend = sedaEncryptWithKey(originalText, keyStr);
            }
            encrypted = true;
        }

        const message = {
            text: textToSend,
            senderId: authState.user.uid,
            senderName: authState.userData.nickname,
            timestamp: serverTimestamp(),
            read: false,
            encrypted,
            type: 'text',
            replyTo: uiState.replyTo || null,
            reactions: {}
        };

        await addDoc(collection(db, 'messages', chatIdAtSend, 'msgs'), message);
        cancelReply();
        await updateChatLastMessage(originalText, chatContext);
    } catch (e) {
        console.error('Ошибка отправки:', e);
        showToast('❌ Ошибка отправки', 'error');
        input.value = originalText;
    } finally {
        uiState.isSending = false;
    }
}

async function updateChatLastMessage(previewText, context) {
    try {
        const chatIdAtSend = context?.chatId;
        const currentChat = context?.currentChat;
        const currentGroup = context?.currentGroup;
        const currentChannel = context?.currentChannel;
        if (!chatIdAtSend || !currentChat) return;

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
    } catch (e) {
        console.error('updateChatLastMessage:', e);
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

    const sp = document.getElementById('stickerPicker');
    if (sp) sp.classList.remove('show');
    uiState.stickerPickerOpen = false;

    try {
        await addDoc(collection(db, 'messages', uiState.currentChatId, 'msgs'), {
            text: sticker,
            senderId: authState.user.uid,
            senderName: authState.userData.nickname,
            timestamp: serverTimestamp(),
            read: false,
            encrypted: false,
            type: 'sticker',
            replyTo: uiState.replyTo || null,
            reactions: {}
        });
        cancelReply();
        await updateChatLastMessage(sticker);
    } catch (e) {
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
    if (file.size > MAX_MEDIA_SIZE) {
        showToast(`Файл слишком большой (макс ${formatBytes(MAX_MEDIA_SIZE)})`, 'error');
        return;
    }
    if (!checkRateLimit(uiState.mediaTimes, RATE_LIMIT.media.count, RATE_LIMIT.media.windowMs)) return;

    try {
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

        let mediaToSend = dataUrl;
        let mediaEncrypted = false;

        if (chatContext.sedaEnabled && authState.sedaProActivated) {
            let keyStr = chatContext.sedaKey;
            if (!keyStr) {
                const r = sedaEncrypt('init');
                await DB.saveSedaKey(chatContext.chatId, r.key);
                keyStr = r.key;
                chatContext.sedaKey = r.key;
                if (uiState.currentChatId === chatContext.chatId) uiState.currentSedaKey = r.key;
            }
            mediaToSend = sedaEncryptWithKey(dataUrl, keyStr);
            mediaEncrypted = true;
        }

        await addDoc(collection(db, 'messages', chatContext.chatId, 'msgs'), {
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
        const preview = mediaType === 'photo' ? '📷 Фото'
            : mediaType === 'video' ? '🎥 Видео'
            : mediaType === 'audio' ? '🎵 Аудио'
            : '📄 ' + file.name;
        await updateChatLastMessage(preview, chatContext);
    } catch (e) {
        console.error('sendMediaFile error:', e);
        showToast('❌ Ошибка отправки', 'error');
    }
}

export async function toggleVoiceRecording() {
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
                    if (uiState.sedaEnabledForCurrentChat && authState.sedaProActivated) {
                        let keyStr = uiState.currentSedaKey;
                        if (!keyStr) {
                            const r = sedaEncrypt('init');
                            await DB.saveSedaKey(uiState.currentChatId, r.key);
                            keyStr = r.key;
                        }
                        dataUrl = sedaEncryptWithKey(dataUrl, keyStr);
                        mediaEncrypted = true;
                    }
                    await addDoc(collection(db, 'messages', uiState.currentChatId, 'msgs'), {
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
                    await updateChatLastMessage('🎤 Голосовое');
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

export function startEdit(id, msgData) {
    uiState.editingMessage = id;
    let displayText = msgData.text;
    if (msgData.encrypted && uiState.currentSedaKey) {
        const dec = sedaDecrypt(msgData.text, uiState.currentSedaKey);
        if (dec !== null) displayText = dec;
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

    if (await DB.getSedaKey(sedaChatId)) {
        showToast('🔮 SEDA-чат уже существует', 'info');
        await openSedaChat(peerUid, sedaChatId);
        return;
    }

    showToast('🔮 Создание SEDA-чата...', 'info');

    const keyPair = await generateECDHKeyPair();
    const pubBase64 = await exportPublicKey(keyPair);
    const privJwk = await exportPrivateKey(keyPair);
    await DB.saveECDHKeys(sedaChatId, pubBase64, privJwk);

    const sedaResult = sedaEncrypt('init_' + Date.now());
    const sedaKey = sedaResult.key;

    const handshakeRef = doc(db, 'seda_handshakes', sedaChatId);
    await setDoc(handshakeRef, {
        initiator: authState.user.uid,
        peer: peerUid,
        initiatorPublicKey: pubBase64,
        peerPublicKey: null,
        encryptedSedaKey: null,
        createdAt: Date.now(),
        expiresAt: Date.now() + 5 * 60 * 1000
    });

    let unsub = null;
    let resolved = false;
    unsub = onSnapshot(handshakeRef, async (snap) => {
        if (resolved) return;
        if (!snap.exists()) return;
        const data = snap.data();
        if (data.peerPublicKey && data.encryptedSedaKey) {
            resolved = true;
            if (unsub) unsub();

            const peerPub = await importPublicKey(data.peerPublicKey);
            const priv = await DB.getECDHKeys(sedaChatId);
            if (!priv) return;

            const privateKey = await crypto.subtle.importKey(
                'jwk', priv.privateKey,
                { name: 'ECDH', namedCurve: 'P-256' },
                true, ['deriveKey', 'deriveBits']
            );
            const sharedKey = await deriveSharedKey(privateKey, peerPub);
            const decryptedSedaKey = await aesDecrypt(data.encryptedSedaKey, sharedKey);
            if (decryptedSedaKey) {
                await DB.saveSedaKey(sedaChatId, decryptedSedaKey);
                // Сохраняем зашифрованный ECDH-handshake в Firestore как резервную копию ключа.
                // Удалять документ сразу нельзя: ключ иначе останется только в IndexedDB инициатора.
                await updateDoc(handshakeRef, {
                    initiatorAck: true,
                    initiatorAckAt: Date.now(),
                    completed: true,
                    expiresAt: null
                }).catch(e => console.warn('[SEDA] Не удалось подтвердить handshake:', e));
                showToast('✅ SEDA-чат установлен!', 'success');
            }
        }
    });

    await DB.saveSedaKey(sedaChatId, sedaKey);

    setTimeout(async () => {
        try {
            const s = await getDoc(handshakeRef);
            if (s.exists() && !s.data().peerPublicKey) {
                await deleteDoc(handshakeRef);
            }
        } catch {}
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
            // Инициатор подтвердил, что получил и сохранил ключ. Оставляем документ в Firestore
            // (в нём только зашифрованный ключ), но отмечаем handshake завершённым.
            if (data.initiatorAck === true && data.completed !== true) {
                await updateDoc(d.ref, { completed: true, completedAt: Date.now() }).catch(() => {});
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

                const sedaResult = sedaEncrypt('init_' + Date.now());
                const mySedaKey = sedaResult.key;
                const encryptedMyKey = await aesEncrypt(mySedaKey, sharedKey);

                await updateDoc(d.ref, {
                    peerPublicKey: myPub,
                    encryptedSedaKey: encryptedMyKey,
                    respondedAt: Date.now(),
                    peerKeyStored: true
                });

                await DB.saveSedaKey(d.id, mySedaKey);

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
        await DB.saveSedaKey(uiState.currentChatId, txt);
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
    if (uiState.chatMetaUnsub) uiState.chatMetaUnsub();
    if (!chat || !chat.uid || chat.isSeda) return;

    uiState.chatMetaUnsub = onSnapshot(doc(db, 'users', chat.uid), (snap) => {
        if (!snap.exists()) return;
        const d = snap.data();
        const statusEl = document.getElementById('chatStatus');
        if (!statusEl) return;

        if (d.typing && d.typingUntil > Date.now()) {
            statusEl.textContent = 'печатает...';
            return;
        }
        if (d.online) {
            statusEl.textContent = 'в сети';
        } else if (d.lastSeen) {
            const t = d.lastSeen.toDate?.();
            statusEl.textContent = 'был(а) ' + (t ? formatTime(t) : '');
        }
    });
}

export async function notifyTyping() {
    if (!uiState.currentChat || !uiState.currentChat.uid) return;
    if (uiState.typingTimeout) clearTimeout(uiState.typingTimeout);
    try {
        await updateDoc(doc(db, 'users', authState.user.uid), {
            typing: true,
            typingUntil: Date.now() + 2000
        }).catch(() => {});
        uiState.typingTimeout = setTimeout(() => {
            updateDoc(doc(db, 'users', authState.user.uid), {
                typing: false,
                typingUntil: 0
            }).catch(() => {});
        }, 2000);
    } catch {}
}

export async function clearChatById(uid, sedaChatId) {
    const chatId = sedaChatId ? sedaChatId : [authState.user.uid, uid].sort().join('_');
    if (!confirm('Очистить историю?')) return;
    try {
        const mRef = collection(db, 'messages', chatId, 'msgs');
        const snap = await getDocs(mRef);
        const batch = writeBatch(db);
        snap.forEach(d => batch.delete(d.ref));
        await batch.commit();
        await DB.deleteSedaKey(chatId);
        await DB.clearCachedMessages(chatId);
        showToast('✅ Очищено', 'success');
    } catch (e) {
        showToast('Ошибка', 'error');
    }
}

export async function deleteChatById(uid, sedaChatId) {
    if (!confirm('Удалить чат?')) return;
    let chats = ensureArray(authState.userData.chats).filter(c => {
        if (sedaChatId && c.sedaChatId === sedaChatId) return false;
        if (!sedaChatId && c.uid === uid && !c.isGroup && !c.isSeda) return false;
        return true;
    });
    await updateDoc(doc(db, 'users', authState.user.uid), { chats });
    authState.userData.chats = chats;
    await DB.Lists.setChats(authState.user.uid, chats);
    loadChats();
    showToast('Чат удалён', 'success');
}

export async function clearCurrentChat() {
    if (!uiState.currentChatId) return;
    await clearChatById(
        uiState.currentChat?.uid || '',
        uiState.currentChat?.sedaChatId || ''
    );
}

export async function deleteCurrentChat() {
    if (!uiState.currentChat) return;
    await deleteChatById(uiState.currentChat.uid, uiState.currentChat.sedaChatId || '');
    closeChat();
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
            if (!uiState.currentChatId) return;
            try {
                const mRef = collection(db, 'messages', uiState.currentChatId, 'msgs');
                const cutoff = new Date(Date.now() - uiState.autoDeleteHours * 3600000);
                const snap = await getDocs(query(mRef, orderBy('timestamp', 'asc')));
                const batch = writeBatch(db);
                let count = 0;
                snap.forEach(d => {
                    const ts = d.data().timestamp?.toDate?.();
                    if (ts && ts < cutoff) { batch.delete(d.ref); count++; }
                });
                if (count > 0) await batch.commit();
            } catch {}
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