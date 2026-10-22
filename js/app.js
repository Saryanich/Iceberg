import { APP_LOGO, STICKERS } from './config.js';
 
import {
    authState,
    handleAuthLogin,
    verify2FA,
    cancel2FA,
    login,
    activateSedaPro,
    logout,
    subscribeAuthState,
    startBlockCheck,
    stopBlockCheck,
    collectDeviceInfo
} from './auth.js';

import * as DB from './db.js';

import {
    uiState,
    cleanupChatSubscriptions,
    showToast,
    setTheme,
    loadTheme,
    renderUserProfile,
    loadChats,
    loadContacts,
    loadGroups,
    loadChannels,
    selectChat,
    selectGroup,
    selectChannel,
    closeChat,
    loadMessages,
    flushPendingChatSyncs,
    sendMessage,
    sendSticker,
    sendMediaFile,
    toggleVoiceRecording,
    toggleReaction,
    bindChatLongPress,
    startReply,
    startEdit,
    cancelReply,
    deleteMessage,
    scrollToMessage,
    startSedaChat,
    startSedaHandshakeListener,
    showCurrentSedaKey,
    copySedaKeyToClipboard,
    pasteSedaKeyFromClipboard,
    updateSedaUI,
    openChatWithContact,
    clearChatById,
    deleteChatById,
    clearCurrentChat,
    deleteCurrentChat,
    setAutoDelete,
    openAutoDelete,
    closeAutoDelete,
    switchTab,
    initStickerPicker,
    notifyTyping
} from './ui.js';

import {
    registerServiceWorkers,
    initPushNotifications,
    cleanupPush,
    refreshTokenForUser
} from './push.js';

function initParticles() {
    if (typeof particlesJS === 'undefined') return;
    particlesJS('particles-js', {
        particles: {
            number: { value: 60, density: { enable: true, value_area: 800 } },
            color: { value: '#64B5F6' },
            opacity: { value: 0.4, random: true },
            size: { value: 3, random: true },
            line_linked: {
                enable: true, color: '#64B5F6', opacity: 0.3, distance: 150
            },
            move: {
                enable: true, speed: 1.2, direction: 'none', random: true, out_mode: 'out'
            }
        },
        interactivity: {
            detect_on: 'canvas',
            events: {
                onhover: { enable: true, mode: 'grab' },
                onclick: { enable: true, mode: 'push' }
            },
            modes: {
                grab: { distance: 140, line_linked: { opacity: 0.5 } },
                push: { particles_nb: 3 }
            }
        }
    });
}

let loadingStartedAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
let loadingHideTimer = null;

function showLoading() {
    const screen = document.getElementById('loadingScreen');
    if (!screen) return;
    if (loadingHideTimer) clearTimeout(loadingHideTimer);
    loadingHideTimer = null;
    loadingStartedAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    screen.classList.remove('hidden', 'loading-exit');
}

function hideLoading() {
    const screen = document.getElementById('loadingScreen');
    if (!screen || screen.classList.contains('hidden') || loadingHideTimer) return;
    // Keep the cinematic intro on screen for at least 3 seconds, even on instant restore.
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const elapsed = now - loadingStartedAt;
    const remaining = Math.max(0, 3000 - elapsed);
    loadingHideTimer = setTimeout(() => {
        screen.classList.add('loading-exit');
        // Let the exit animation finish before removing the overlay.
        setTimeout(() => {
            screen.classList.add('hidden');
            screen.classList.remove('loading-exit');
            loadingHideTimer = null;
        }, 850);
    }, remaining);
}

let offlineRetryInProgress = false;

function isConnectionFailure(error) {
    const message = String(error?.message || error || '').toLowerCase();
    return !navigator.onLine || /network|offline|timeout|timed out|unavailable|deadline-exceeded|failed to fetch|fetch failed|connection/.test(message);
}

function showOfflineScreen(message = 'Не удалось связаться с сервисами Айсберга. Проверьте интернет и попробуйте снова.') {
    const loading = document.getElementById('loadingScreen');
    const offline = document.getElementById('offlineScreen');
    const description = document.getElementById('offlineDescription');
    const status = document.getElementById('offlineStatusText');
    if (loading) {
        if (loadingHideTimer) clearTimeout(loadingHideTimer);
        loadingHideTimer = null;
        loading.classList.add('hidden');
        loading.classList.remove('loading-exit');
    }
    if (description) description.textContent = message;
    if (status) status.textContent = navigator.onLine ? 'Сервис не ответил' : 'Интернет недоступен';
    offline?.classList.remove('is-exiting', 'is-checking');
    if (offline) offline.hidden = false;
}

async function retryConnection() {
    if (offlineRetryInProgress) return;
    offlineRetryInProgress = true;
    const offline = document.getElementById('offlineScreen');
    const button = document.getElementById('retryConnectionBtn');
    const label = document.getElementById('retryConnectionLabel');
    const status = document.getElementById('offlineStatusText');
    if (button) button.disabled = true;
    if (label) label.textContent = 'Проверяем соединение…';
    if (status) status.textContent = 'Проверяем доступность сервиса';
    offline?.classList.add('is-checking');

    try {
        if (!navigator.onLine) throw new Error('offline');
        // Check the app host without relying on a cached response.
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6500);
        let response;
        try {
            response = await fetch('./manifest.json?connection-check=' + Date.now(), {
                cache: 'no-store',
                signal: controller.signal,
                headers: { 'Cache-Control': 'no-cache' }
            });
        } finally {
            clearTimeout(timeout);
        }
        if (!response.ok) throw new Error('app-host-unavailable');

        if (label) label.textContent = 'Соединение восстановлено';
        if (status) status.textContent = 'Перезапускаем Айсберг';
        offline?.classList.remove('is-checking');
        offline?.classList.add('is-exiting');
        // Give the shutdown transition time to finish before restarting the app.
        await new Promise(resolve => setTimeout(resolve, 460));
        window.location.reload();
    } catch (error) {
        console.warn('[Connection retry] Сервис пока недоступен:', error);
        offline?.classList.remove('is-checking', 'is-exiting');
        if (status) status.textContent = navigator.onLine ? 'Сервис пока недоступен' : 'Интернет по-прежнему недоступен';
        if (label) label.textContent = 'Повторить попытку';
        if (document.getElementById('offlineDescription')) {
            document.getElementById('offlineDescription').textContent = navigator.onLine
                ? 'Сайт доступен не полностью или сервер пока не отвечает. Попробуйте ещё раз чуть позже.'
                : 'Подключение всё ещё отсутствует. Проверьте Wi-Fi или мобильную сеть и повторите попытку.';
        }
    } finally {
        offlineRetryInProgress = false;
        if (button) button.disabled = false;
        if (label && label.textContent === 'Проверяем соединение…') label.textContent = 'Повторить попытку';
    }
}

function showAuthScreen() {
    document.getElementById('authForm').style.display = 'flex';
    document.getElementById('messengerApp').style.display = 'none';
}

function showMessengerScreen() {
    document.getElementById('authForm').style.display = 'none';
    const app = document.getElementById('messengerApp');
    app.style.display = 'flex';
    app.classList.remove('interface-enter');
    // Restart the reveal animation when returning from the loading screen.
    void app.offsetWidth;
    app.classList.add('interface-enter');
    app.addEventListener('animationend', () => app.classList.remove('interface-enter'), { once: true });
}

function show2FAScreen() {
    document.getElementById('twoFactorScreen').classList.add('active');
    document.getElementById('code1')?.focus();
    document.getElementById('newDeviceInfo').textContent =
        `🆕 Новое устройство · IP: ${authState.currentIP || '...'}`;
}

function hide2FAScreen() {
    document.getElementById('twoFactorScreen').classList.remove('active');
    ['code1', 'code2', 'code3', 'code4'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    document.getElementById('trustDevice').checked = false;
}

async function handleLoginClick() {
    const id = document.getElementById('loginIdentifier').value.trim();
    const pw = document.getElementById('loginPassword').value;
    const msg = document.getElementById('authMessage');
    const btn = document.getElementById('btnLogin');

    if (!id || !pw) {
        msg.textContent = 'Заполните поля';
        msg.className = 'message message-error';
        msg.style.display = 'block';
        return;
    }

    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Проверка...';
    }

    msg.textContent = 'Вход...';
    msg.className = 'message message-success';
    msg.style.display = 'block';

    const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('TIMEOUT')), 8000)
    );

    try {
        const res = await Promise.race([
            login(id, pw),
            timeoutPromise
        ]);
        
        if (!res.success) {
            msg.textContent = res.error;
            msg.className = 'message message-error';
            msg.style.display = 'block';
        }
    } catch (e) {
        if (e.message === 'TIMEOUT') {
            msg.textContent = 'Сервер не отвечает. Проверьте интернет.';
            msg.className = 'message message-error';
            msg.style.display = 'block';
        } else {
            msg.textContent = 'Ошибка сети';
            msg.className = 'message message-error';
            msg.style.display = 'block';
        }
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Войти';
        }
    }
}

function setup2FAInputs() {
    for (let i = 1; i <= 4; i++) {
        const el = document.getElementById(`code${i}`);
        if (!el) continue;
        el.addEventListener('input', (e) => {
            e.target.value = e.target.value.replace(/[^0-9]/g, '');
            if (e.target.value.length === 1 && i < 4) {
                document.getElementById(`code${i + 1}`)?.focus();
            }
        });
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace' && !el.value && i > 1) {
                document.getElementById(`code${i - 1}`)?.focus();
            }
            if (e.key === 'Enter') handle2FAVerify();
        });
    }
}

async function handle2FAVerify() {
    const code = ['code1', 'code2', 'code3', 'code4']
        .map(id => document.getElementById(id).value).join('');

    if (code.length !== 4) {
        showToast('Введите 4 цифры', 'error');
        return;
    }

    const trust = document.getElementById('trustDevice').checked;
    const res = await verify2FA(code, trust);

    if (!res.success) {
        showToast(res.error || 'Неверный код', 'error');
        return;
    }

    hide2FAScreen();
    await bootMessenger(res.user, res.data);
    hideLoading();
    showMessengerScreen();
}

async function handle2FACancel() {
    await cancel2FA();
    hide2FAScreen();
    showAuthScreen();
}

async function bootMessenger(user, userData) {
    try {
        authState.user = user;
        if (userData) authState.userData = userData;

        loadTheme();
        initStickerPicker();
        renderUserProfile();
        updateSedaUI();

        uiState.autoDeleteHours = authState.userData?.autoDeleteHours || 0;

        loadChats();
        loadGroups();
        loadChannels();
        loadContacts();
        if (navigator.onLine) flushPendingChatSyncs().catch(e => console.warn('[Offline sync]', e));

        startSedaHandshakeListener();

        startBlockCheck(user.uid, () => {
            showToast('⚠️ Аккаунт заблокирован', 'error', 5000);
            showAuthScreen();
        });

        setTimeout(() => {
            initPushNotifications().catch(e => console.warn('[Push] init error:', e));
            refreshTokenForUser(user.uid).catch(() => {});
        }, 1500);

        localStorage.setItem('iceberg_authenticated', 'true');
    } catch (e) {
        console.error('[bootMessenger] Ошибка:', e);
        showToast('Ошибка загрузки', 'error');
    }
}

let initialAuthRouting = true;

function setupAuthState() {
    subscribeAuthState(async (user) => {
        // The initial Firebase restoration is handled by waitForFirebaseAuthAndRoute().
        // Ignore this listener during startup to avoid duplicate device checks / 2FA prompts.
        if (initialAuthRouting) return;
        if (authState.awaitingTwoFactor) return;

        if (user) {
            if (authState.restoredFromCache && authState.user?.uid === user.uid) {
                return;
            }

            await collectDeviceInfo().catch(() => {});

            const loginBtn = document.getElementById('btnLogin');
            const originalText = loginBtn ? loginBtn.textContent : 'Войти';
            if (loginBtn) {
                loginBtn.disabled = true;
                loginBtn.textContent = 'Проверка...';
            }

            const startTime = Date.now();
            let timeoutId = null;

            try {
                const loginPromise = new Promise((resolve, reject) => {
                    timeoutId = setTimeout(() => reject(new Error('Timeout')), 10000);

                    handleAuthLogin(user, {
                        onSuccess: async (u, data) => {
                            clearTimeout(timeoutId);
                            resolve({ type: 'success', user: u, data });
                        },
                        onNeed2FA: () => {
                            clearTimeout(timeoutId);
                            resolve({ type: '2fa' });
                        },
                        onLocked: () => {
                            clearTimeout(timeoutId);
                            resolve({ type: 'locked' });
                        },
                        onError: (msg) => {
                            clearTimeout(timeoutId);
                            resolve({ type: 'error', msg, connectionFailure: isConnectionFailure(msg) });
                        }
                    }).catch(reject);
                });

                const result = await loginPromise;
                
                const elapsed = Date.now() - startTime;
                const minDelay = Math.max(0, 1000 - elapsed);
                if (minDelay > 0) await new Promise(r => setTimeout(r, minDelay));

                if (result.type === 'success') {
                    await bootMessenger(result.user, result.data);
                } else if (result.type === '2fa') {
                    document.getElementById('authMessage').style.display = 'none';
                    showAuthScreen();
                    show2FAScreen();
                } else if (result.type === 'locked') {
                    document.getElementById('loginMode').style.display = 'none';
                    document.getElementById('blockedMode').style.display = 'block';
                    showAuthScreen();
                } else if (result.type === 'error') {
                    if (result.connectionFailure) {
                        showOfflineScreen(result.msg || 'Не удалось связаться с сервисами Айсберга. Проверьте интернет и попробуйте снова.');
                    } else {
                        showAuthScreen();
                        if (result.msg) showToast(result.msg, 'error');
                    }
                }

            } catch (err) {
                console.warn('[Auth] Error or Timeout:', err);
                const elapsed = Date.now() - startTime;
                const minDelay = Math.max(0, 1000 - elapsed);
                if (minDelay > 0) await new Promise(r => setTimeout(r, minDelay));

                showToast('Тайм-аут соединения. Проверьте интернет.', 'error');
                showAuthScreen();
            } finally {
                if (loginBtn) {
                    loginBtn.disabled = false;
                    loginBtn.textContent = originalText;
                }
            }

        } else {
            cleanupPush();
            stopBlockCheck();
            localStorage.removeItem('iceberg_authenticated');
            showAuthScreen();
            document.getElementById('loginIdentifier').value = '';
            document.getElementById('loginPassword').value = '';
        }
    });
}

function setupAuthSyncEvents() {
    window.addEventListener('iceberg:user-data-updated', (e) => {
        const data = e.detail?.data;
        if (!data) return;
        authState.userData = data;
        authState.sedaProActivated = data.sedaProActivated || false;
        renderUserProfile();
        updateSedaUI();
        loadChats();
        loadGroups();
        loadChannels();
        loadContacts();
    });

    window.addEventListener('iceberg:force-logout', (e) => {
        cleanupChatSubscriptions();
        const reason = e.detail?.reason;
        localStorage.removeItem('iceberg_authenticated');
        localStorage.removeItem('iceberg_auth_cache_v1');
        
        showAuthScreen();
        document.getElementById('loginIdentifier').value = '';
        document.getElementById('loginPassword').value = '';
        document.getElementById('authMessage').style.display = 'none';
        
        if (reason !== 'manual') {
            showToast(
                reason === 'locked' ? '🔒 Аккаунт заблокирован' : 'Вы вышли из аккаунта',
                'error'
            );
        }
    });
}

function bindUIEvents() {
    document.getElementById('retryConnectionBtn')?.addEventListener('click', retryConnection);
    window.addEventListener('online', () => {
        const offline = document.getElementById('offlineScreen');
        const status = document.getElementById('offlineStatusText');
        if (offline && !offline.hidden && status) status.textContent = 'Интернет появился — нажмите «Повторить попытку»';
    });
    document.getElementById('loginPassword')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleLoginClick();
    });

    document.getElementById('btnLogin').onclick = handleLoginClick;

    document.querySelector('#blockedMode .btn-secondary').onclick = () => {
        document.getElementById('loginMode').style.display = 'block';
        document.getElementById('blockedMode').style.display = 'none';
    };

    document.getElementById('btnGlobalId').onclick = () => {
        localStorage.setItem('iceberg_referrer', location.href);
        localStorage.setItem('iceberg_app', 'true');
        location.href = 'https://saryanich.github.io/Global-ID/';
    };

    document.getElementById('disclaimerBlock').onclick = () => {
        window.open('https://saryanich.github.io/TLC-services/', '_blank');
    };

    document.querySelector('#twoFactorScreen .btn-primary').onclick = handle2FAVerify;
    document.querySelector('#twoFactorScreen .btn-secondary').onclick = handle2FACancel;

    document.getElementById('userInfoClicker').onclick = () => {
        const d = authState.userData;
        if (!d) return;
        document.getElementById('profileFirstName').value = d.firstName || '';
        document.getElementById('profileLastName').value = d.lastName || '';
        document.getElementById('profileMood').value = d.mood || '';
        const av = document.getElementById('profileAvatarBig');
        av.innerHTML = '';
        if (d.avatar) {
            const img = document.createElement('img');
            img.src = d.avatar;
            av.appendChild(img);
        } else {
            av.textContent = (d.nickname || 'U').charAt(0).toUpperCase();
        }
        document.getElementById('profileModal').classList.add('active');
    };

    document.getElementById('avatarClicker').onclick = () => {
        document.getElementById('avatarUploadInput').click();
    };

    document.getElementById('avatarUploadInput').onchange = async function () {
        const file = this.files?.[0];
        this.value = '';
        if (!file) return;
        try {
            const { compressImage } = await import('./ui.js');
            const dataUrl = await compressImage(file, 1024 * 1024);
            authState.userData.avatar = dataUrl;

            const av = document.getElementById('profileAvatarBig');
            av.innerHTML = '';
            const img = document.createElement('img');
            img.src = dataUrl;
            av.appendChild(img);

            const { doc, updateDoc } = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
            const { db } = await import('./config.js');
            await updateDoc(doc(db, 'users', authState.user.uid), { avatar: dataUrl });
            await DB.setCachedProfile(authState.user.uid, authState.userData);
            renderUserProfile();
            showToast('✅ Аватар обновлён', 'success');
        } catch (e) {
            showToast('Ошибка загрузки', 'error');
        }
    };

    document.querySelector('#profileModal .btn-primary').onclick = async () => {
        const fn = document.getElementById('profileFirstName').value.trim();
        const ln = document.getElementById('profileLastName').value.trim();
        const mood = document.getElementById('profileMood').value.trim();
        const nick = (fn || ln) ? `${fn} ${ln}`.trim() : (authState.userData.nickname || 'Пользователь');
        try {
            const { doc, updateDoc } = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
            const { db } = await import('./config.js');
            await updateDoc(doc(db, 'users', authState.user.uid), {
                firstName: fn, lastName: ln, mood, nickname: nick,
                avatar: authState.userData.avatar || null
            });
            authState.userData.firstName = fn;
            authState.userData.lastName = ln;
            authState.userData.mood = mood;
            authState.userData.nickname = nick;
            await DB.setCachedProfile(authState.user.uid, authState.userData);
            renderUserProfile();
            showToast('✅ Профиль сохранён', 'success');
            setTimeout(() => {
                document.getElementById('profileModal').classList.remove('active');
            }, 600);
        } catch (e) {
            showToast('Ошибка сохранения', 'error');
        }
    };

    document.getElementById('openSettingsBtn').onclick = () => {
        document.getElementById('settingsModal').classList.add('active');
        updateSedaUI();
        const ad = document.getElementById('autoDeleteValue');
        if (ad) {
            ad.textContent = uiState.autoDeleteHours === 0 ? 'Выкл'
                : uiState.autoDeleteHours === 24 ? '24ч'
                : uiState.autoDeleteHours === 168 ? '7д' : '30д';
        }
        const sb = document.getElementById('sedaStatusBadge');
        if (sb) {
            sb.textContent = authState.sedaProActivated ? '✓ Активирован' : 'Не активирован';
            sb.style.color = authState.sedaProActivated ? 'var(--success)' : 'var(--warning)';
        }
    };

    document.querySelector('#settingsModal .close-modal').onclick = () => {
        document.getElementById('settingsModal').classList.remove('active');
    };
    document.querySelector('#settingsModal .close-settings-btn').onclick = () => {
        document.getElementById('settingsModal').classList.remove('active');
    };

    document.querySelectorAll('.theme-cell').forEach(el => {
        el.onclick = () => setTheme(el.dataset.theme);
    });

    document.getElementById('logoutBtn').onclick = async () => {
        if (confirm('Выйти из аккаунта?')) {
            localStorage.removeItem('iceberg_authenticated');
            await logout();
        }
    };

    document.querySelectorAll('.tab').forEach((tab, i) => {
        const names = ['chats', 'channels', 'groups', 'contacts'];
        tab.onclick = () => switchTab(names[i]);
    });

    document.getElementById('searchInput')?.addEventListener('input', (e) => {
        const term = e.target.value.toLowerCase().trim();
        const active = document.querySelector('.tab-pane.active');
        if (!active) return;

        if (active.id === 'chatsPane') {
            const filtered = (authState.userData.chats || [])
                .filter(c => !c.isChannel)
                .filter(c => (c.nickname || c.globalId || '').toLowerCase().includes(term));
            renderFilteredList('chatsList', filtered, 'chat');
        } else if (active.id === 'contactsPane') {
            const filtered = (authState.userData.contacts || [])
                .filter(c => (c.nickname || c.globalId || '').toLowerCase().includes(term));
            renderFilteredList('contactsList', filtered, 'contact');
        }
    });

    document.getElementById('plusBtn').onclick = (e) => {
        e.stopPropagation();
        document.getElementById('plusMenu').classList.toggle('show');
    };
    document.addEventListener('click', () => {
        document.getElementById('plusMenu').classList.remove('show');
    });

    document.querySelectorAll('.plus-menu-item').forEach((el, i) => {
        const actions = [
            showCreateGroupModal,
            showCreateChannelModal,
            showSearchModal,
            openScanner,
            openStories
        ];
        el.onclick = () => actions[i]?.();
    });

    document.querySelectorAll('.close-modal').forEach(el => {
        el.onclick = () => {
            const modal = el.closest('.modal-overlay');
            if (modal) modal.classList.remove('active');
        };
    });

    document.querySelector('.back-btn').onclick = closeChat;
    document.getElementById('sedaModeBtn').onclick = startSedaChat;
    document.getElementById('sedaKeyBtn').onclick = showCurrentSedaKey;
    document.getElementById('clearChatBtn').onclick = clearCurrentChat;
    document.getElementById('deleteChatBtn').onclick = deleteCurrentChat;
    document.getElementById('groupInfoBtn').onclick = showGroupInfo;
    document.getElementById('channelManageBtn').onclick = () => showToast('В разработке', 'info');

    document.getElementById('chatSend').onclick = sendMessage;
    document.getElementById('messageInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });
    document.getElementById('messageInput').addEventListener('input', (e) => {
        e.target.style.height = 'auto';
        e.target.style.height = Math.min(e.target.scrollHeight, 90) + 'px';
        notifyTyping();
    });

    document.getElementById('stickerBtn').onclick = () => {
        const sp = document.getElementById('stickerPicker');
        uiState.stickerPickerOpen = !uiState.stickerPickerOpen;
        sp.classList.toggle('show', uiState.stickerPickerOpen);
    };
    document.getElementById('attachBtn').onclick = () => {
        document.getElementById('chatMediaInput').click();
    };
    document.getElementById('chatMediaInput').onchange = function () { sendMediaFile(this); };
    document.getElementById('voiceBtn').onclick = toggleVoiceRecording;

    document.querySelector('.reply-preview-close').onclick = cancelReply;

    document.getElementById('openSedaActivation').onclick = () => {
        document.getElementById('settingsModal').classList.remove('active');
        document.getElementById('sedaActivationScreen').classList.add('active');
    };
    document.querySelector('#sedaActivationScreen .btn-seda').onclick = async () => {
        const code = document.getElementById('sedaActivationCode').value.trim();
        if (!code) { showToast('Введите код', 'error'); return; }
        const res = await activateSedaPro(code);
        if (res.success) {
            showToast('✅ SEDA Pro активирован!', 'success');
            document.getElementById('sedaActivationScreen').classList.remove('active');
            document.getElementById('sedaActivationCode').value = '';
            updateSedaUI();
        } else {
            showToast(res.error || 'Ошибка', 'error');
        }
    };
    document.querySelector('#sedaActivationScreen .btn-secondary').onclick = () => {
        document.getElementById('sedaActivationScreen').classList.remove('active');
        document.getElementById('sedaActivationCode').value = '';
    };

    document.querySelector('#sedaKeyScreen .btn-seda').onclick = copySedaKeyToClipboard;
    const keyBtns = document.querySelectorAll('#sedaKeyScreen .btn-secondary');
    keyBtns[0].onclick = pasteSedaKeyFromClipboard;
    keyBtns[1].onclick = () => {
        document.getElementById('sedaKeyScreen').classList.remove('active');
    };

    document.querySelectorAll('#autoDeleteModal .settings-row').forEach((row, i) => {
        const hours = [0, 24, 168, 720][i];
        row.onclick = () => setAutoDelete(hours);
    });

    document.querySelectorAll('#settingsModal .settings-row[data-action]').forEach(row => {
        const action = row.dataset.action;
        if (action === 'autodelete') row.onclick = openAutoDelete;
        else if (action === 'clear-chats') row.onclick = clearAllChats;
        else if (action === 'clear-messages') row.onclick = clearAllMessages;
    });

    window.addEventListener('iceberg:notification-click', (e) => {
        const chatId = e.detail?.chatId;
        if (!chatId) return;
        const chat = (authState.userData?.chats || []).find(c =>
            c.uid === e.detail.senderId || c.sedaChatId === chatId
        );
        if (chat) selectChat(chat);
    });

    window.addEventListener('resize', () => {
        if (window.matchMedia('(orientation:landscape)').matches) {
            document.getElementById('sidebar')?.classList.remove('hide-on-mobile');
            document.getElementById('chatScreen')?.classList.remove('show-on-mobile');
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            cancelReply();
            if (uiState.stickerPickerOpen) {
                document.getElementById('stickerPicker')?.classList.remove('show');
                uiState.stickerPickerOpen = false;
            }
        }
    });

    document.getElementById('searchGlobalIdBtn').onclick = searchByGlobalId;
    document.getElementById('closeScannerBtn').onclick = () => {
        document.getElementById('scannerModal').classList.remove('active');
    };
    document.getElementById('createGroupBtn').onclick = createGroupFromModal;
    document.getElementById('createChannelBtn').onclick = createChannelFromModal;
    document.getElementById('clearGroupBtn').onclick = () => showToast('В разработке', 'info');
    document.getElementById('leaveGroupBtn').onclick = () => showToast('В разработке', 'info');
    document.getElementById('deleteGroupFromListBtn').onclick = () => showToast('В разработке', 'info');
    document.getElementById('closeChannelManageBtn').onclick = () => {
        document.getElementById('channelManageModal').classList.remove('active');
    };
}

function renderFilteredList(containerId, list, type) {
    const c = document.getElementById(containerId);
    if (!c) return;
    if (!list.length) {
        c.innerHTML = '<div class="empty-state">Ничего не найдено</div>';
        return;
    }
    c.innerHTML = '';
    for (const item of list) {
        const div = document.createElement('div');
        div.className = type === 'chat' ? 'chat-item' : 'contact-item';
        const av = document.createElement('div');
        av.className = 'avatar-small';
        av.textContent = (item.nickname?.charAt(0) || '👤').toUpperCase();
        const info = document.createElement('div');
        info.className = 'info-small';
        const n = document.createElement('div');
        n.className = 'item-name';
        n.textContent = item.nickname || item.globalId?.substring(0, 12) || 'Пользователь';
        info.appendChild(n);
        div.appendChild(av);
        div.appendChild(info);
        div.onclick = () => type === 'chat' ? selectChat(item) : openChatWithContact(item);
        c.appendChild(div);
    }
}

function showCreateGroupModal() {
    uiState.selectedContactsForGroup.clear();
    document.getElementById('groupName').value = '';
    renderContactsForGroup('contactsForGroup', uiState.selectedContactsForGroup);
    document.getElementById('createGroupModal').classList.add('active');
    document.getElementById('plusMenu').classList.remove('show');
}

function renderContactsForGroup(containerId, selectedSet) {
    const c = document.getElementById(containerId);
    if (!c) return;
    const contacts = authState.userData.contacts || [];
    c.innerHTML = '';
    for (const contact of contacts) {
        const d = document.createElement('div');
        d.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px;cursor:pointer;';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = selectedSet.has(contact.uid);
        cb.onchange = () => cb.checked ? selectedSet.add(contact.uid) : selectedSet.delete(contact.uid);
        const av = document.createElement('div');
        av.className = 'avatar-small';
        av.style.cssText = 'width:34px;height:34px;font-size:14px;';
        av.textContent = (contact.nickname?.charAt(0) || '👤').toUpperCase();
        const nm = document.createElement('span');
        nm.textContent = contact.nickname || contact.globalId?.substring(0, 12);
        d.appendChild(cb);
        d.appendChild(av);
        d.appendChild(nm);
        c.appendChild(d);
    }
}

function showCreateChannelModal() {
    document.getElementById('channelName').value = '';
    document.getElementById('channelDescription').value = '';
    document.getElementById('createChannelModal').classList.add('active');
    document.getElementById('plusMenu').classList.remove('show');
}

function showSearchModal() {
    document.getElementById('searchModal').classList.add('active');
    document.getElementById('plusMenu').classList.remove('show');
}

function openScanner() {
    document.getElementById('scannerModal').classList.add('active');
    document.getElementById('plusMenu').classList.remove('show');
    if (typeof Html5Qrcode === 'undefined') {
        showToast('QR-сканер не загружен', 'error');
        return;
    }
    try {
        const h = new Html5Qrcode('qr-reader');
        h.start(
            { facingMode: 'environment' },
            { fps: 10, qrbox: { width: 250, height: 250 } },
            (text) => {
                h.stop().catch(() => {});
                document.getElementById('scannerModal').classList.remove('active');
                document.getElementById('searchGlobalIdInput').value = text.replace('Global ID: ', '');
                searchByGlobalId();
            },
            () => {}
        ).catch(e => console.warn('[QR]', e));
    } catch (e) {
        console.warn('[QR]', e);
    }
}

function openStories() {
    document.getElementById('plusMenu').classList.remove('show');
    document.getElementById('storiesModal').classList.add('active');
}

async function searchByGlobalId() {
    const gid = document.getElementById('searchGlobalIdInput').value.trim();
    if (!gid) return showToast('Введите Global ID', 'error');
    try {
        const { collection, query, where, getDocs, doc, updateDoc, arrayUnion, limit } =
            await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
        const { db } = await import('./config.js');
        const q = query(collection(db, 'users'), where('globalId', '==', gid), limit(1));
        const snap = await getDocs(q);
        if (snap.empty) return showToast('Не найден', 'error');
        const u = snap.docs[0];
        const ud = u.data();
        if (u.id === authState.user.uid) return showToast('Это вы', 'error');

        const contact = {
            uid: u.id, globalId: ud.globalId, nickname: ud.nickname,
            email: ud.email, avatar: ud.avatar || null, mood: ud.mood || null
        };
        if (!(authState.userData.contacts || []).some(c => c.uid === contact.uid)) {
            await updateDoc(doc(db, 'users', authState.user.uid), { contacts: arrayUnion(contact) });
            authState.userData.contacts = [...(authState.userData.contacts || []), contact];
            await DB.Lists.setContacts(authState.user.uid, authState.userData.contacts);
        }
        document.getElementById('searchModal').classList.remove('active');
        loadContacts();
        loadChats();
        showToast(`✅ ${contact.nickname || contact.globalId} добавлен`, 'success');
        await openChatWithContact(contact);
    } catch (e) {
        showToast('Ошибка поиска', 'error');
    }
}

async function createGroupFromModal() {
    const name = document.getElementById('groupName').value.trim();
    if (!name) return showToast('Введите название', 'error');
    try {
        const { addDoc, collection, doc, setDoc, updateDoc, getDoc, arrayUnion, serverTimestamp } =
            await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
        const { db } = await import('./config.js');

        const members = [
            { uid: authState.user.uid, globalId: authState.userData.globalId, nickname: authState.userData.nickname, role: 'admin' },
            ...Array.from(uiState.selectedContactsForGroup).map(uid => {
                const c = (authState.userData.contacts || []).find(x => x.uid === uid);
                return c ? { uid: c.uid, globalId: c.globalId, nickname: c.nickname, role: 'member' } : null;
            }).filter(Boolean)
        ];

        const ref = await addDoc(collection(db, 'groups'), {
            name, createdAt: serverTimestamp(), createdBy: authState.user.uid,
            members, memberCount: members.length
        });

        // Дополнительная ACL-карточка в новой коллекции iceberg.
        // Не меняет старую схему groups/users и не мешает работе старых клиентов.
        await setDoc(doc(db, 'iceberg', 'group_' + ref.id), {
            type: 'group',
            resourceId: ref.id,
            ownerId: authState.user.uid,
            memberUids: members.map(m => m.uid),
            adminUids: [authState.user.uid],
            createdAt: serverTimestamp(),
            schemaVersion: 1
        }).catch(e => console.warn('[Iceberg ACL] Не удалось сохранить ACL группы:', e));

        for (const m of members) {
            const uRef = doc(db, 'users', m.uid);
            await updateDoc(uRef, {
                groups: arrayUnion({ id: ref.id, name, memberCount: members.length, role: m.role })
            }).catch(() => {});
        }

        document.getElementById('createGroupModal').classList.remove('active');
        showToast(`✅ Группа "${name}" создана!`, 'success');

        const ud = await getDoc(doc(db, 'users', authState.user.uid));
        authState.userData.groups = ud.data().groups || [];
        loadGroups();
    } catch (e) {
        showToast('Ошибка создания', 'error');
    }
}

async function createChannelFromModal() {
    const name = document.getElementById('channelName').value.trim();
    const description = document.getElementById('channelDescription').value.trim();
    if (!name) return showToast('Введите название', 'error');
    try {
        const { addDoc, collection, doc, setDoc, updateDoc, arrayUnion, serverTimestamp } =
            await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
        const { db } = await import('./config.js');

        const ref = await addDoc(collection(db, 'channels'), {
            name, description, createdAt: serverTimestamp(), createdBy: authState.user.uid,
            admins: [authState.user.uid], members: [authState.user.uid], memberCount: 1
        });

        // Дополнительная ACL-карточка; старые поля channels/users остаются без изменений.
        await setDoc(doc(db, 'iceberg', 'channel_' + ref.id), {
            type: 'channel',
            resourceId: ref.id,
            ownerId: authState.user.uid,
            memberUids: [authState.user.uid],
            adminUids: [authState.user.uid],
            createdAt: serverTimestamp(),
            schemaVersion: 1
        }).catch(e => console.warn('[Iceberg ACL] Не удалось сохранить ACL канала:', e));

        const channelEntry = {
            id: ref.id, name, description, isAdmin: true,
            memberCount: 1, unread: false, lastMessage: '', lastMessageTime: null
        };

        await updateDoc(doc(db, 'users', authState.user.uid), {
            channels: arrayUnion(channelEntry)
        });

        authState.userData.channels = [...(authState.userData.channels || []), channelEntry];

        document.getElementById('createChannelModal').classList.remove('active');
        loadChannels();
        switchTab('channels');
        showToast(`✅ Канал "${name}" создан!`, 'success');
    } catch (e) {
        showToast('Ошибка создания', 'error');
    }
}

async function showGroupInfo() {
    if (!uiState.currentGroup) return;
    try {
        const { doc, getDoc } = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
        const { db } = await import('./config.js');
        const d = await getDoc(doc(db, 'groups', uiState.currentGroup.id));
        if (!d.exists()) return;
        const g = d.data();

        document.getElementById('groupInfoTitle').textContent = g.name;
        const content = document.getElementById('groupInfoContent');
        content.innerHTML = '';

        const header = document.createElement('div');
        header.style.cssText = 'text-align:center;margin-bottom:16px;';
        const emoji = document.createElement('div');
        emoji.style.fontSize = '56px';
        emoji.textContent = '👥';
        const nameEl = document.createElement('div');
        nameEl.style.cssText = 'font-weight:bold;font-size:18px;color:var(--text-primary);';
        nameEl.textContent = g.name;
        const countEl = document.createElement('div');
        countEl.style.cssText = 'font-size:12px;color:var(--text-secondary);';
        countEl.textContent = `${g.memberCount || g.members?.length || 0} участников`;
        header.appendChild(emoji);
        header.appendChild(nameEl);
        header.appendChild(countEl);
        content.appendChild(header);

        for (const m of (g.members || [])) {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px;border-bottom:1px solid var(--border);';
            const av = document.createElement('div');
            av.className = 'avatar-small';
            av.style.cssText = 'width:36px;height:36px;font-size:14px;';
            av.textContent = (m.nickname || 'U').charAt(0).toUpperCase();
            const info = document.createElement('div');
            info.style.cssText = 'flex:1;';
            const n = document.createElement('div');
            n.style.cssText = 'font-weight:500;color:var(--text-primary);font-size:13px;';
            n.textContent = m.nickname || m.globalId || 'Пользователь';
            const r = document.createElement('div');
            r.style.cssText = 'font-size:10px;color:var(--text-muted);';
            r.textContent = m.role === 'admin' ? '👑 Админ' : '👤 Участник';
            info.appendChild(n);
            info.appendChild(r);
            row.appendChild(av);
            row.appendChild(info);
            content.appendChild(row);
        }
        document.getElementById('groupInfoModal').classList.add('active');
    } catch (e) {
        showToast('Ошибка', 'error');
    }
}

async function clearAllChats() {
    if (!confirm('Удалить все чаты из списка?')) return;
    const { doc, updateDoc } = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
    const { db } = await import('./config.js');
    await updateDoc(doc(db, 'users', authState.user.uid), { chats: [] });
    authState.userData.chats = [];
    await DB.Lists.setChats(authState.user.uid, []);
    loadChats();
    document.getElementById('settingsModal').classList.remove('active');
    showToast('✅ Чаты удалены', 'success');
}

async function clearAllMessages() {
    if (!confirm('ОЧИСТИТЬ ВСЕ СООБЩЕНИЯ? Это нельзя отменить!')) return;
    try {
        const { collection, getDocs, writeBatch } =
            await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
        const { db } = await import('./config.js');
        const chats = authState.userData.chats || [];
        for (const chat of chats) {
            if (chat.isGroup) continue;
            const chatId = chat.isSeda && chat.sedaChatId
                ? chat.sedaChatId
                : [authState.user.uid, chat.uid].sort().join('_');
            const mRef = collection(db, 'messages', chatId, 'msgs');
            const snap = await getDocs(mRef);
            const batch = writeBatch(db);
            snap.forEach(d => batch.delete(d.ref));
            await batch.commit();
            await DB.deleteSedaKey(chatId);
            await DB.clearCachedMessages(chatId);
        }
        showToast('✅ Очищено', 'success');
        if (uiState.currentChatId) loadMessages();
    } catch (e) {
        showToast('Ошибка', 'error');
    }
}

async function waitForFirebaseAuthAndRoute() {
    return new Promise((resolve) => {
        let done = false;

        const timeout = setTimeout(() => {
            if (done) return;
            done = true;
            try { unsub(); } catch {}
            showOfflineScreen(navigator.onLine
                ? 'Сервисы Айсберга не ответили вовремя. Проверьте подключение и попробуйте снова.'
                : 'Нет подключения к интернету. Когда сеть восстановится, нажмите «Повторить попытку».');
            resolve();
        }, 5000);

        const unsub = subscribeAuthState(async (user) => {
            if (done) return;
            done = true;
            clearTimeout(timeout);
            try { unsub(); } catch {}

            if (user) {
                try {
                    await collectDeviceInfo();
                    await handleAuthLogin(user, {
                        onSuccess: async (u, data) => {
                            await bootMessenger(u, data);
                            hideLoading();
                            showMessengerScreen();
                            resolve();
                        },
                        onNeed2FA: () => {
                            hideLoading();
                            showAuthScreen();
                            show2FAScreen();
                            resolve();
                        },
                        onLocked: () => {
                            hideLoading();
                            document.getElementById('loginMode').style.display = 'none';
                            document.getElementById('blockedMode').style.display = 'block';
                            showAuthScreen();
                            resolve();
                        },
                        onError: (msg) => {
                            if (isConnectionFailure(msg)) {
                                showOfflineScreen(msg || 'Не удалось связаться с сервисами Айсберга. Проверьте интернет и попробуйте снова.');
                            } else {
                                hideLoading();
                                showAuthScreen();
                                if (msg) showToast(msg, 'error');
                            }
                            resolve();
                        }
                    });
                } catch (e) {
                    console.warn('[waitForFirebaseAuthAndRoute] error:', e);
                    hideLoading();
                    showAuthScreen();
                    resolve();
                }
            } else {
                hideLoading();
                showAuthScreen();
                resolve();
            }
        });
    });
}

async function init() {
    loadTheme();
    initParticles();

    registerServiceWorkers().catch(e => console.warn('[SW]', e));

    bindUIEvents();
    setup2FAInputs();
    setupAuthSyncEvents();
    setupAuthState();

    if (!navigator.onLine) {
        // Keep the branded startup screen visible for five seconds before showing offline mode.
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const remaining = Math.max(0, 5000 - (now - loadingStartedAt));
        await new Promise(resolve => setTimeout(resolve, remaining));
        showOfflineScreen('Нет подключения к интернету. Когда сеть восстановится, нажмите «Повторить попытку».');
        initialAuthRouting = false;
        return;
    }

    // Firebase Auth retains the session for automatic sign-in, but the UI is not
    // opened from a local profile cache before the current lock/access state is checked.
    await waitForFirebaseAuthAndRoute();
    initialAuthRouting = false;

    if (localStorage.getItem('iceberg_app') === 'true') {
        localStorage.removeItem('iceberg_app');
        localStorage.removeItem('iceberg_referrer');
        setTimeout(() => {
            const msg = document.getElementById('authMessage');
            if (msg) {
                msg.textContent = '✅ Аккаунт создан! Войдите';
                msg.className = 'message message-success';
                msg.style.display = 'block';
            }
        }, 5500);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

window.__iceberg = {
    authState, uiState, DB,
    logout, login, activateSedaPro
};
