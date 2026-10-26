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
    subscribeDirectChatUpdates,
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
    notifyTyping,
    compressImage,
    showContactCard,
    loadOwnStories,
    uploadOwnStories,
    openUserStories,
    moveStory,
    deleteCurrentStory
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
    window.__icebergStartupResolved = true;
    if (window.__icebergStartupFallback) clearTimeout(window.__icebergStartupFallback);
    const screen = document.getElementById('loadingScreen');
    const offline = document.getElementById('offlineScreen');
    if (offline) offline.hidden = true;
    if (!screen || screen.classList.contains('hidden') || loadingHideTimer) return;
    // Keep the cinematic intro on screen for at least 3 seconds, even on instant restore.
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const elapsed = now - loadingStartedAt;
    const remaining = Math.max(0, 5000 - elapsed);
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

function showOfflineScreen(message = 'Ошибка подключения к серверу, попробуйте позже или проверьте подключение к интернету.') {
    window.__icebergStartupResolved = true;
    if (window.__icebergStartupFallback) clearTimeout(window.__icebergStartupFallback);
    const loading = document.getElementById('loadingScreen');
    const offline = document.getElementById('offlineScreen');
    const description = document.getElementById('offlineDescription');
    if (loading) {
        if (loadingHideTimer) clearTimeout(loadingHideTimer);
        loadingHideTimer = null;
        loading.classList.add('loading-exit');
        setTimeout(() => {
            loading.classList.add('hidden');
            loading.classList.remove('loading-exit');
        }, 850);
    }
    if (description) description.textContent = message;
    offline?.classList.remove('is-leaving', 'is-checking', 'is-visible');
    if (offline) {
        offline.hidden = false;
        requestAnimationFrame(() => offline.classList.add('is-visible'));
    }
}

async function retryConnection(event) {
    event?.preventDefault();
    if (window.__icebergRetryStarted || offlineRetryInProgress) return;
    offlineRetryInProgress = true;
    window.__icebergRetryStarted = true;
    const offline = document.getElementById('offlineScreen');
    const button = document.getElementById('retryConnectionBtn');
    const label = document.getElementById('retryConnectionLabel');
    if (button) button.disabled = true;
    if (label) label.textContent = 'Перезагрузка…';
    offline?.classList.add('is-checking', 'is-leaving');
    const target = new URL(window.location.href);
    target.searchParams.set('retry', String(Date.now()));
    await new Promise(resolve => setTimeout(resolve, 650));
    window.location.replace(target.href);
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

async function syncPublicProfile(user = authState.user, profile = authState.userData) {
    if (!user?.uid || !profile) return;
    const { doc, setDoc, serverTimestamp } =
        await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
    const { db } = await import('./config.js');
    const publicProfile = {
        uid: user.uid,
        globalId: profile.globalId || '',
        nickname: profile.nickname || 'Пользователь',
        avatar: profile.avatar || null,
        mood: profile.mood || '',
        updatedAt: serverTimestamp()
    };
    // Keep this document strictly within the public_profiles Firestore rule schema.
    // merge:true could preserve legacy fields that make the rules reject the write.
    await setDoc(doc(db, 'public_profiles', user.uid), publicProfile);
}

async function bootMessenger(user, userData) {
    try {
        authState.user = user;
        if (userData) authState.userData = userData;
        syncPublicProfile(user, authState.userData).catch(err =>
            console.warn('[Public profile] Не удалось обновить публичный профиль:', err)
        );

        loadTheme();
        initStickerPicker();
        renderUserProfile();
        updateSedaUI();

        uiState.autoDeleteHours = authState.userData?.autoDeleteHours || 0;

        loadChats();
        subscribeDirectChatUpdates();
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
    document.getElementById('retryConnectionBtn')?.addEventListener('click', retryConnection, { passive: false });
    window.addEventListener('online', () => {
        const offline = document.getElementById('offlineScreen');
        const status = document.getElementById('offlineStatusText');
        if (offline && !offline.hidden && status) status.textContent = 'Интернет появился — нажмите «Перезагрузить»';
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

    const openProfileModal = () => {
        const d = authState.userData;
        if (!d) return;
        document.getElementById('profileFirstName').value = d.firstName || '';
        document.getElementById('profileLastName').value = d.lastName || '';
        document.getElementById('profileNickname').value = d.nickname || (d.globalId ? '@' + d.globalId : '');
        document.getElementById('profileMood').value = d.mood || '';
        const av = document.getElementById('profileAvatarBig');
        av.innerHTML = '';
        if (d.avatar) {
            const img = document.createElement('img');
            img.src = d.avatar;
            img.alt = 'Аватар профиля';
            av.appendChild(img);
        } else {
            av.textContent = (d.nickname || d.globalId || 'U').replace(/^@/, '').charAt(0).toUpperCase();
        }
        document.getElementById('avatarCropControls').hidden = true;
        document.getElementById('profileModal')?.classList.add('active');
    };
    document.getElementById('brandProfileBtn')?.addEventListener('click', openProfileModal);

    document.getElementById('userInfoClicker')?.addEventListener('click', openProfileModal);

    document.getElementById('avatarClicker')?.addEventListener('click', () => {
        document.getElementById('avatarUploadInput')?.click();
    });

    let pendingAvatarImage = null;
    let pendingAvatarObjectUrl = null;
    const cropModal = document.getElementById('avatarCropModal');
    const cropStage = document.getElementById('avatarCropStage');
    const cropImage = document.getElementById('avatarCropImage');
    const cropControls = document.getElementById('avatarCropControls');
    let avatarCropState = { zoom: 1, x: 0.5, y: 0.5 };
    let cropPointers = new Map();
    let cropGestureStart = null;

    const getCropDimensions = () => {
        if (!pendingAvatarImage || !cropStage) return null;
        const sw = cropStage.clientWidth, sh = cropStage.clientHeight;
        if (!sw || !sh) return null;
        const base = Math.max(sw / pendingAvatarImage.naturalWidth, sh / pendingAvatarImage.naturalHeight);
        return {
            sw, sh,
            width: pendingAvatarImage.naturalWidth * base * avatarCropState.zoom,
            height: pendingAvatarImage.naturalHeight * base * avatarCropState.zoom
        };
    };

    const updateAvatarCropPreview = () => {
        if (!pendingAvatarImage || !cropStage || !cropImage) return;
        const d = getCropDimensions();
        if (!d) return;
        const maxX = Math.max(0, d.width - d.sw);
        const maxY = Math.max(0, d.height - d.sh);
        avatarCropState.x = maxX ? Math.max(0, Math.min(1, avatarCropState.x)) : 0.5;
        avatarCropState.y = maxY ? Math.max(0, Math.min(1, avatarCropState.y)) : 0.5;
        cropImage.style.width = d.width + 'px';
        cropImage.style.height = d.height + 'px';
        cropImage.style.left = (-maxX * avatarCropState.x) + 'px';
        cropImage.style.top = (-maxY * avatarCropState.y) + 'px';
    };

    const setAvatarCropZoom = (nextZoom, anchorX, anchorY) => {
        const before = getCropDimensions();
        if (!before) return;
        const localX = Math.max(0, Math.min(before.sw, anchorX - cropStage.getBoundingClientRect().left));
        const localY = Math.max(0, Math.min(before.sh, anchorY - cropStage.getBoundingClientRect().top));
        const imageX = localX + Math.max(0, before.width - before.sw) * avatarCropState.x;
        const imageY = localY + Math.max(0, before.height - before.sh) * avatarCropState.y;
        avatarCropState.zoom = Math.max(1, Math.min(4, nextZoom));
        const after = getCropDimensions();
        if (!after) return;
        const maxX = Math.max(0, after.width - after.sw);
        const maxY = Math.max(0, after.height - after.sh);
        avatarCropState.x = maxX ? Math.max(0, Math.min(1, (imageX * (after.width / before.width) - localX) / maxX)) : 0.5;
        avatarCropState.y = maxY ? Math.max(0, Math.min(1, (imageY * (after.height / before.height) - localY) / maxY)) : 0.5;
        updateAvatarCropPreview();
    };

    document.getElementById('avatarUploadInput').onchange = function () {
        const file = this.files?.[0];
        this.value = '';
        if (!file) return;
        if (pendingAvatarObjectUrl) URL.revokeObjectURL(pendingAvatarObjectUrl);
        pendingAvatarObjectUrl = URL.createObjectURL(file);
        const image = new Image();
        image.onload = () => {
            pendingAvatarImage = image;
            avatarCropState = { zoom: 1, x: 0.5, y: 0.5 };
            cropImage.src = pendingAvatarObjectUrl;
            cropModal.hidden = false;
            cropControls.hidden = true;
            requestAnimationFrame(updateAvatarCropPreview);
        };
        image.onerror = () => {
            if (pendingAvatarObjectUrl) URL.revokeObjectURL(pendingAvatarObjectUrl);
            pendingAvatarObjectUrl = null;
            showToast('Не удалось открыть выбранное изображение.', 'error');
        };
        image.src = pendingAvatarObjectUrl;
    };

    cropStage?.addEventListener('pointerdown', event => {
        if (!pendingAvatarImage) return;
        event.preventDefault();
        try { cropStage.setPointerCapture(event.pointerId); } catch (_) {}
        cropPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (cropPointers.size === 1) {
            cropGestureStart = { type: 'pan', x: event.clientX, y: event.clientY, cropX: avatarCropState.x, cropY: avatarCropState.y };
        } else if (cropPointers.size === 2) {
            const pts = [...cropPointers.values()];
            cropGestureStart = { type: 'pinch', distance: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), zoom: avatarCropState.zoom };
        }
    });

    cropStage?.addEventListener('pointermove', event => {
        if (!pendingAvatarImage || !cropPointers.has(event.pointerId)) return;
        event.preventDefault();
        cropPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (cropPointers.size >= 2 && cropGestureStart?.type === 'pinch') {
            const pts = [...cropPointers.values()];
            const distance = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
            setAvatarCropZoom(cropGestureStart.zoom * distance / Math.max(1, cropGestureStart.distance), (pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
            return;
        }
        if (cropGestureStart?.type === 'pan') {
            const d = getCropDimensions();
            if (!d) return;
            const maxX = Math.max(0, d.width - d.sw);
            const maxY = Math.max(0, d.height - d.sh);
            if (maxX) avatarCropState.x = Math.max(0, Math.min(1, cropGestureStart.cropX - (event.clientX - cropGestureStart.x) / maxX));
            if (maxY) avatarCropState.y = Math.max(0, Math.min(1, cropGestureStart.cropY - (event.clientY - cropGestureStart.y) / maxY));
            updateAvatarCropPreview();
        }
    });

    cropStage?.addEventListener('wheel', event => {
        if (!pendingAvatarImage) return;
        event.preventDefault();
        const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
        setAvatarCropZoom(avatarCropState.zoom * factor, event.clientX, event.clientY);
    }, { passive: false });

    const endCropPointer = event => {
        cropPointers.delete(event.pointerId);
        cropGestureStart = null;
        if (cropPointers.size === 1) {
            const [p] = [...cropPointers.values()];
            cropGestureStart = { type: 'pan', x: p.x, y: p.y, cropX: avatarCropState.x, cropY: avatarCropState.y };
        }
    };
    cropStage?.addEventListener('pointerup', endCropPointer);
    cropStage?.addEventListener('pointercancel', endCropPointer);
    cropStage?.addEventListener('lostpointercapture', endCropPointer);

    document.getElementById('cancelAvatarCropBtn')?.addEventListener('click', () => {
        pendingAvatarImage = null;
        cropModal.hidden = true;
    });
    document.getElementById('applyAvatarCropBtn')?.addEventListener('click', async () => {
        if (!pendingAvatarImage) return;
        try {
            // Store a compact JPEG. Large data URLs can exceed Firestore's document limit,
            // especially when both user and public profile documents contain the avatar.
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 384;
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('Canvas недоступен');
            const iw = pendingAvatarImage.naturalWidth, ih = pendingAvatarImage.naturalHeight;
            const side = Math.min(iw, ih) / avatarCropState.zoom;
            const sx = (iw - side) * avatarCropState.x;
            const sy = (ih - side) * avatarCropState.y;
            ctx.drawImage(pendingAvatarImage, sx, sy, side, side, 0, 0, 384, 384);
            let dataUrl = '';
            for (let quality = 0.82; quality >= 0.42; quality -= 0.08) {
                dataUrl = canvas.toDataURL('image/jpeg', quality);
                if (dataUrl.length <= 200000) break;
            }
            if (!dataUrl || dataUrl.length > 220000) {
                // Final fallback for unusually noisy photos; keep the data small enough
                // to coexist with chat/contact metadata in a Firestore user document.
                canvas.width = canvas.height = 256;
                ctx.drawImage(pendingAvatarImage, sx, sy, side, side, 0, 0, 256, 256);
                dataUrl = '';
                for (let quality = 0.58; quality >= 0.30; quality -= 0.07) {
                    dataUrl = canvas.toDataURL('image/jpeg', quality);
                    if (dataUrl.length <= 200000) break;
                }
            }
            if (!dataUrl || dataUrl.length > 220000) throw new Error('Фото не удалось сжать до безопасного размера');

            const { doc, updateDoc, getDoc } = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
            const { db, auth } = await import('./config.js');
            const activeUser = authState.user || auth.currentUser;
            const uid = activeUser?.uid;
            if (!uid) throw new Error('Сессия завершена. Войдите в Айсберг повторно.');
            authState.user = activeUser;
            if (!authState.userData) {
                const existingProfile = await getDoc(doc(db, 'users', uid));
                if (existingProfile.exists()) authState.userData = existingProfile.data();
            }

            await updateDoc(doc(db, 'users', uid), { avatar: dataUrl });
            authState.userData.avatar = dataUrl;

            // Update every avatar presentation immediately, including the large preview
            // inside the profile dialog (it is not part of renderUserProfile's header targets).
            const profileAvatarBig = document.getElementById('profileAvatarBig');
            if (profileAvatarBig) {
                profileAvatarBig.replaceChildren();
                const preview = document.createElement('img');
                preview.src = dataUrl;
                preview.alt = 'Аватар профиля';
                profileAvatarBig.appendChild(preview);
            }
            // The remote save is authoritative. Refresh the UI before optional local cache work.
            pendingAvatarImage = null;
            cropModal.hidden = true;
            renderUserProfile();
            openProfileModal();
            try {
                await DB.setCachedProfile(uid, authState.userData);
            } catch (cacheError) {
                console.warn('[Avatar] Photo saved remotely; local cache unavailable:', cacheError);
            }

            // Public sync is handled separately: a legacy public document must not make
            // a successful private profile save look as if the photo upload failed.
            try {
                await syncPublicProfile();
                showToast('Изображение профиля обновлено.', 'success');
            } catch (publicError) {
                console.warn('[Avatar] Private profile saved, public profile sync failed:', publicError);
                showToast('Фото сохранено. Не удалось обновить его для контактов — попробуйте сохранить профиль ещё раз.', 'warning', 4500);
            }
        } catch (e) {
            console.error('[Avatar crop]', e);
            showToast('Не удалось сохранить изображение профиля.', 'error');
        }
    });

    document.querySelector('#profileModal .btn-primary').onclick = async () => {
        const fn = document.getElementById('profileFirstName').value.trim();
        const ln = document.getElementById('profileLastName').value.trim();
        const mood = document.getElementById('profileMood').value.trim();
        const nickInput = document.getElementById('profileNickname').value.trim();
        const nick = nickInput ? '@' + nickInput.replace(/^@+/, '').trim() : (authState.userData.globalId ? '@' + authState.userData.globalId : '@user');
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
            renderUserProfile();
            try {
                await DB.setCachedProfile(authState.user.uid, authState.userData);
            } catch (cacheError) {
                console.warn('[Profile] Profile saved remotely; local cache unavailable:', cacheError);
            }
            try {
                await syncPublicProfile();
            } catch (publicError) {
                console.warn('[Profile] Public profile sync failed:', publicError);
                showToast('Профиль сохранён, но обновление для контактов не удалось.', 'warning', 4500);
            }
            showToast('✅ Профиль сохранён', 'success');
            setTimeout(() => {
                document.getElementById('profileModal').classList.remove('active');
            }, 600);
        } catch (e) {
            showToast('Ошибка сохранения', 'error');
        }
    };

    const openSettings = () => {
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
    document.getElementById('bottomSettingsBtn')?.addEventListener('click', openSettings);
    document.getElementById('clearOfflineCacheBtn')?.addEventListener('click', async () => {
        const button = document.getElementById('clearOfflineCacheBtn');
        if (!confirm('Удалить загруженные на это устройство чаты, сообщения, группы, каналы и контакты? Данные на сервере останутся без изменений.')) return;
        if (button) { button.disabled = true; button.textContent = 'Очистка…'; }
        try {
            await DB.clearOfflineContent();
            if ('serviceWorker' in navigator) {
                const registration = await navigator.serviceWorker.getRegistration('./').catch(() => null);
                const worker = registration?.active || navigator.serviceWorker.controller;
                worker?.postMessage({ type: 'CLEAR_RUNTIME_CACHE' });
            }
            showToast('Локальный кэш чатов очищен. Данные на сервере не изменены.', 'success');
        } catch (error) {
            console.warn('[Offline cache] Очистка не завершена:', error?.name || 'unknown');
            showToast('Не удалось полностью очистить локальный кэш. Повторите попытку.', 'error');
        } finally {
            if (button) { button.disabled = false; button.textContent = 'Очистить кэш устройства'; }
        }
    });
    document.getElementById('settingsLogoutBtn')?.addEventListener('click', async () => {
        if (confirm('Выйти из аккаунта?')) {
            localStorage.removeItem('iceberg_authenticated');
            await logout();
        }
    });

    document.querySelectorAll('.theme-cell').forEach(el => {
        el.onclick = () => setTheme(el.dataset.theme);
    });

    

    document.querySelectorAll('.bottom-navigation .tab').forEach((tab) => {
        const label = tab.getAttribute('aria-label');
        const names = { 'Чаты': 'chats', 'Каналы': 'channels', 'Контакты': 'contacts' };
        if (names[label]) tab.addEventListener('click', () => switchTab(names[label]));
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

    document.getElementById('headerAddStoryBtn')?.addEventListener('click', async () => {
        document.getElementById('storiesModal').classList.add('active');
        await loadOwnStories();
    });
    const plusButton = document.getElementById('plusBtn');
    const plusMenu = document.getElementById('plusMenu');
    const positionPlusMenu = () => {
        if (!plusButton || !plusMenu) return;
        const rect = plusButton.getBoundingClientRect();
        const width = Math.max(220, Math.min(252, window.innerWidth - 24));
        plusMenu.style.position = 'fixed';
        plusMenu.style.width = width + 'px';
        plusMenu.style.maxWidth = 'calc(100vw - 24px)';
        plusMenu.style.right = 'auto';
        const left = Math.max(12, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 12));
        plusMenu.style.left = left + 'px';
        const menuHeight = plusMenu.scrollHeight || 270;
        let top = rect.top - menuHeight - 10;
        if (top < 12) top = Math.min(window.innerHeight - menuHeight - 12, rect.bottom + 8);
        plusMenu.style.top = Math.max(12, top) + 'px';
    };
    plusButton.onclick = (event) => {
        event.stopPropagation();
        if (plusMenu.classList.contains('show')) {
            plusMenu.classList.remove('show');
            plusButton.setAttribute('aria-expanded', 'false');
        } else {
            positionPlusMenu();
            plusMenu.classList.add('show');
            plusButton.setAttribute('aria-expanded', 'true');
        }
    };
    document.addEventListener('click', () => {
        plusMenu.classList.remove('show');
        plusButton.setAttribute('aria-expanded', 'false');
    });
    window.addEventListener('resize', () => {
        if (plusMenu.classList.contains('show')) positionPlusMenu();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && plusMenu.classList.contains('show')) {
            plusMenu.classList.remove('show');
            plusButton.setAttribute('aria-expanded', 'false');
        }
    });

    document.querySelectorAll('.plus-menu-item').forEach((el, i) => {
        const actions = [
            showSearchModal,
            openScanner,
            showCreateGroupModal,
            showCreateChannelModal
        ];
        el.onclick = (event) => {
            event.stopPropagation();
            document.getElementById('plusMenu').classList.remove('show');
            document.getElementById('plusBtn').setAttribute('aria-expanded', 'false');
            actions[i]?.();
        };
    });
    document.getElementById('profileCreateStoryBtn')?.addEventListener('click', async () => {
        document.getElementById('profileModal').classList.remove('active');
        document.getElementById('storiesModal').classList.add('active');
        await loadOwnStories();
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
    document.getElementById('channelManageBtn').onclick = showChannelSettings;

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

    document.querySelectorAll('#autoDeletePane .settings-row').forEach((row, i) => {
        const hours = [0, 24, 168, 720][i];
        row.onclick = () => setAutoDelete(hours);
    });

    document.getElementById('backFromAutoDeleteBtn')?.addEventListener('click', closeAutoDelete);

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

    document.getElementById('searchGlobalIdBtn').onclick = searchContact;
    document.getElementById('searchGlobalIdInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') searchContact(); });
    document.getElementById('closeScannerBtn').onclick = () => {
        document.getElementById('scannerModal').classList.remove('active');
    };
    document.getElementById('createGroupBtn').onclick = createGroupFromModal;
    document.getElementById('createChannelBtn').onclick = createChannelFromModal;

    document.getElementById('addStoryBtn').onclick = () => document.getElementById('storyUploadInput').click();
    document.getElementById('storyUploadInput').onchange = async function () {
        // Snapshot File objects before clearing the input. On iOS Safari, clearing
        // the input first can empty the live FileList and silently publish nothing.
        const files = Array.from(this.files || []);
        this.value = '';
        if (!files.length) return;
        await uploadOwnStories(files);
    };
    document.getElementById('prevStoryBtn').onclick = () => moveStory(-1);
    document.getElementById('nextStoryBtn').onclick = () => moveStory(1);
    document.getElementById('deleteStoryBtn').onclick = deleteCurrentStory;
    document.getElementById('closeStoryViewerBtn').onclick = () => { document.getElementById('storyViewerModal').classList.remove('active'); };
    document.getElementById('storyViewerModal')?.addEventListener('click', event => { if (event.target.id === 'storyViewerModal') event.currentTarget.classList.remove('active'); });
    document.getElementById('clearGroupBtn').onclick = async () => {
        document.getElementById('groupInfoModal').classList.remove('active');
        await clearCurrentChat();
    };
    document.getElementById('leaveGroupBtn').onclick = leaveCurrentGroup;
    document.getElementById('deleteGroupFromListBtn').onclick = leaveCurrentGroup;
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
        div.onclick = () => type === 'chat' ? selectChat(item) : showContactCard(item);
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

async function openStories() {
    document.getElementById('plusMenu').classList.remove('show');
    document.getElementById('storiesModal').classList.add('active');
    await loadOwnStories();
}

async function searchByNickname(rawValue) {
    const nickname = String(rawValue ?? document.getElementById('searchGlobalIdInput')?.value ?? '')
        .trim().replace(/^@/, '');
    if (!nickname) return showToast('Введите юзернейм или Global ID', 'error');
    try {
        const { collection, query, where, getDocs, limit, doc, updateDoc, arrayUnion } =
            await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
        const { db } = await import('./config.js');
        const exactUsername = '@' + nickname;
        const snap = await getDocs(query(
            collection(db, 'public_profiles'),
            where('nickname', '==', exactUsername),
            limit(5)
        ));
        const profile = snap.docs.find(item => item.id !== authState.user.uid);
        if (!profile) return showToast('Пользователь с таким юзернеймом не найден', 'error');
        const data = profile.data();
        const contact = {
            uid: profile.id,
            globalId: data.globalId || '',
            nickname: data.nickname || '@' + (data.globalId || 'user'),
            avatar: data.avatar || null,
            mood: data.mood || ''
        };
        const contacts = Array.isArray(authState.userData.contacts) ? authState.userData.contacts : [];
        if (!contacts.some(existing => existing.uid === contact.uid)) {
            await updateDoc(doc(db, 'users', authState.user.uid), { contacts: arrayUnion(contact) });
            authState.userData.contacts = [...contacts, contact];
            await DB.Lists.setContacts(authState.user.uid, authState.userData.contacts);
        }
        document.getElementById('searchModal').classList.remove('active');
        await loadContacts();
        await loadChats();
        await openChatWithContact(contact);
    } catch (error) {
        console.error('[Username search]', error);
        showToast(error?.code === 'permission-denied'
            ? 'Поиск по юзернейму запрещён правилами Firestore'
            : 'Не удалось найти пользователя по юзернейму', 'error');
    }
}

async function searchContact() {
    const value = document.getElementById('searchGlobalIdInput')?.value.trim() || '';
    const gid = value.replace(/^@/, '');
    if (/^[0-9a-zA-Z]{22}$/.test(gid)) return searchByGlobalId(gid);
    return searchByNickname(value);
}

async function searchByGlobalId(rawGid) {
    const gid = String(rawGid ?? document.getElementById('searchGlobalIdInput')?.value ?? '').trim().replace(/^@/, '');
    if (!/^[0-9a-zA-Z]{22}$/.test(gid)) {
        return showToast('Введите юзернейм или корректный Global ID из 22 символов', 'error');
    }
    try {
        const { doc, getDoc, updateDoc, arrayUnion } =
            await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
        const { db } = await import('./config.js');
        const globalIdSnap = await getDoc(doc(db, 'global_ids', gid));
        if (!globalIdSnap.exists()) return showToast('Пользователь не найден', 'error');
        const uid = globalIdSnap.data()?.uid;
        if (!uid) return showToast('У записи Global ID отсутствует UID', 'error');
        if (uid === authState.user.uid) return showToast('Это вы', 'error');

        const publicSnap = await getDoc(doc(db, 'public_profiles', uid));
        const publicData = publicSnap.exists() ? publicSnap.data() : {};
        const contact = {
            uid,
            globalId: publicData.globalId || gid,
            nickname: publicData.nickname || '@' + gid,
            avatar: publicData.avatar || null,
            mood: publicData.mood || ''
        };
        const contacts = Array.isArray(authState.userData.contacts) ? authState.userData.contacts : [];
        if (!contacts.some(existing => existing.uid === uid)) {
            await updateDoc(doc(db, 'users', authState.user.uid), { contacts: arrayUnion(contact) });
            authState.userData.contacts = [...contacts, contact];
            await DB.Lists.setContacts(authState.user.uid, authState.userData.contacts);
        }
        document.getElementById('searchModal').classList.remove('active');
        await loadContacts();
        await loadChats();
        showToast(`Контакт найден: ${contact.nickname || contact.globalId}`, 'success');
        await openChatWithContact(contact);
    } catch (error) {
        console.error('[Global ID search]', { code: error?.code || 'unknown', message: error?.message || String(error) });
        showToast(error?.code === 'permission-denied'
            ? 'Нет доступа к публичному профилю. Проверьте Firestore Rules.'
            : 'Не удалось найти пользователя. Проверьте Global ID и подключение.', 'error', 4500);
    }
}

async function createGroupFromModal() {
    const name = document.getElementById('groupName').value.trim();
    if (!name) return showToast('Введите название', 'error');
    try {
        const { addDoc, collection, doc, updateDoc, getDoc, arrayUnion, serverTimestamp } =
            await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
        const { db } = await import('./config.js');

        const members = [
            { uid: authState.user.uid, globalId: authState.userData.globalId, nickname: authState.userData.nickname, role: 'admin' },
            ...Array.from(uiState.selectedContactsForGroup).map(uid => {
                const c = (authState.userData.contacts || []).find(x => x.uid === uid);
                return c ? { uid: c.uid, globalId: c.globalId, nickname: c.nickname, role: 'member' } : null;
            }).filter(Boolean)
        ];

        const memberIds = members.map(member => member.uid);
        const ref = await addDoc(collection(db, 'groups'), {
            name,
            description: '',
            avatar: null,
            createdAt: serverTimestamp(),
            createdBy: authState.user.uid,
            adminIds: [authState.user.uid],
            memberIds,
            members,
            memberCount: members.length,
            lastMessage: '',
            lastMessageTime: null
        });

        // /groups/{id} is the authoritative membership record. Each member's
        // own list is refreshed from that collection, without writing another
        // person's private /users/{uid} document.

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
        const { addDoc, collection, doc, updateDoc, arrayUnion, serverTimestamp } =
            await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
        const { db } = await import('./config.js');

        const ref = await addDoc(collection(db, 'channels'), {
            name,
            description,
            avatar: null,
            createdAt: serverTimestamp(),
            createdBy: authState.user.uid,
            admins: [authState.user.uid],
            members: [authState.user.uid],
            memberCount: 1
        });

        const channelEntry = {
            id: ref.id,
            name,
            description,
            avatar: null,
            createdBy: authState.user.uid,
            admins: [authState.user.uid],
            members: [authState.user.uid],
            isChannel: true,
            isAdmin: true,
            memberCount: 1,
            unread: false,
            lastMessage: '',
            lastMessageTime: null
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
    const selected = uiState.currentGroup;
    if (!selected?.id) return;
    try {
        const { doc, getDoc, updateDoc, deleteDoc, serverTimestamp } =
            await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
        const { db } = await import('./config.js');
        const snap = await getDoc(doc(db, 'groups', selected.id));
        if (!snap.exists()) {
            showToast('Группа больше не существует', 'error');
            return;
        }
        const group = { ...snap.data(), id: selected.id };
        uiState.currentGroup = { ...selected, ...group };
        const uid = authState.user.uid;
        const members = Array.isArray(group.members) ? group.members : [];
        const memberIds = Array.isArray(group.memberIds)
            ? group.memberIds
            : members.map(m => typeof m === 'string' ? m : m?.uid).filter(Boolean);
        const adminIds = Array.isArray(group.adminIds)
            ? group.adminIds
            : members.filter(m => m?.role === 'admin').map(m => m.uid);
        const canManage = group.createdBy === uid || adminIds.includes(uid)
            || members.some(m => m?.uid === uid && m.role === 'admin');

        const modal = document.getElementById('groupInfoModal');
        const content = document.getElementById('groupInfoContent');
        document.getElementById('groupInfoTitle').textContent = group.name || 'Группа';
        content.replaceChildren();

        const head = document.createElement('div');
        head.className = 'group-settings-profile';
        const avatar = document.createElement('div');
        avatar.className = 'group-settings-avatar';
        if (group.avatar) {
            const img = document.createElement('img');
            img.src = group.avatar;
            img.alt = 'Аватар группы';
            avatar.appendChild(img);
        } else avatar.textContent = '👥';
        const name = document.createElement('h3');
        name.textContent = group.name || 'Группа';
        const count = document.createElement('p');
        count.textContent = `${memberIds.length || members.length} участников`;
        head.append(avatar, name, count);
        content.appendChild(head);

        if (canManage) {
            const form = document.createElement('div');
            form.className = 'group-settings-form';
            const nameLabel = document.createElement('label');
            nameLabel.textContent = 'Название';
            const nameInput = document.createElement('input');
            nameInput.maxLength = 80;
            nameInput.value = group.name || '';
            const descriptionLabel = document.createElement('label');
            descriptionLabel.textContent = 'Описание';
            const descriptionInput = document.createElement('textarea');
            descriptionInput.maxLength = 300;
            descriptionInput.rows = 2;
            descriptionInput.value = group.description || '';
            const avatarLabel = document.createElement('label');
            avatarLabel.textContent = 'Аватар группы';
            const avatarInput = document.createElement('input');
            avatarInput.type = 'file';
            avatarInput.accept = 'image/*';
            const save = document.createElement('button');
            save.type = 'button';
            save.className = 'btn btn-primary';
            save.textContent = 'Сохранить изменения';
            save.onclick = async () => {
                const newName = nameInput.value.trim();
                if (!newName) return showToast('Название группы не может быть пустым', 'error');
                try {
                    let newAvatar = group.avatar || null;
                    if (avatarInput.files?.[0]) newAvatar = await compressImage(avatarInput.files[0], 300 * 1024);
                    const patch = { name: newName, description: descriptionInput.value.trim(), avatar: newAvatar };
                    await updateDoc(doc(db, 'groups', selected.id), patch);
                    uiState.currentGroup = { ...uiState.currentGroup, ...patch };
                    if (uiState.currentGroup?.id === selected.id) {
                        document.getElementById('chatName').textContent = newName;
                        const chatAvatar = document.getElementById('chatAvatar');
                        chatAvatar.replaceChildren();
                        if (newAvatar) {
                            const img = document.createElement('img');
                            img.src = newAvatar;
                            img.alt = 'Аватар группы';
                            chatAvatar.appendChild(img);
                        } else chatAvatar.textContent = '👥';
                    }
                    await loadGroups();
                    showToast('Настройки группы сохранены', 'success');
                    await showGroupInfo();
                } catch (err) {
                    console.error('[Group settings] Save failed:', err);
                    showToast('Не удалось сохранить группу. Проверьте права Firestore.', 'error');
                }
            };
            form.append(nameLabel, nameInput, descriptionLabel, descriptionInput, avatarLabel, avatarInput, save);
            content.appendChild(form);
        }

        const membersHeading = document.createElement('h4');
        membersHeading.className = 'settings-section-title';
        membersHeading.textContent = 'Участники';
        content.appendChild(membersHeading);

        const memberList = document.createElement('div');
        memberList.className = 'group-member-list';
        for (const raw of members) {
            const member = typeof raw === 'string' ? { uid: raw } : raw;
            if (!member?.uid) continue;
            const row = document.createElement('div');
            row.className = 'group-member-row';
            const info = document.createElement('div');
            info.className = 'group-member-info';
            const label = document.createElement('strong');
            label.textContent = member.nickname || member.globalId || member.uid;
            const role = document.createElement('span');
            role.textContent = (member.role === 'admin' || adminIds.includes(member.uid)) ? 'Администратор' : 'Участник';
            info.append(label, role);
            row.appendChild(info);
            if (canManage && member.uid !== group.createdBy && member.uid !== uid) {
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'action-btn danger';
                remove.textContent = '−';
                remove.setAttribute('aria-label', 'Удалить участника');
                remove.onclick = async () => {
                    if (!confirm(`Удалить ${member.nickname || 'участника'} из группы?`)) return;
                    try {
                        const nextMembers = members.filter(m => (typeof m === 'string' ? m : m?.uid) !== member.uid);
                        const nextIds = memberIds.filter(id => id !== member.uid);
                        const nextAdmins = adminIds.filter(id => id !== member.uid);
                        await updateDoc(doc(db, 'groups', selected.id), {
                            members: nextMembers, memberIds: nextIds, adminIds: nextAdmins,
                            memberCount: nextIds.length
                        });
                        await updateDoc(doc(db, 'messages', 'group_' + selected.id), {
                            memberIds: nextIds, adminIds: nextAdmins, updatedAt: serverTimestamp()
                        }).catch(() => {});
                        uiState.currentGroup = { ...uiState.currentGroup, members: nextMembers, memberIds: nextIds, adminIds: nextAdmins, memberCount: nextIds.length };
                        await loadGroups();
                        await showGroupInfo();
                        showToast('Участник удалён', 'success');
                    } catch (err) {
                        console.error('[Group member remove]', err);
                        showToast('Не удалось удалить участника. Проверьте права Firestore.', 'error');
                    }
                };
                row.appendChild(remove);
            }
            memberList.appendChild(row);
        }
        content.appendChild(memberList);

        if (canManage) {
            const available = (authState.userData.contacts || []).filter(contact => contact?.uid && !memberIds.includes(contact.uid));
            if (available.length) {
                const addRow = document.createElement('div');
                addRow.className = 'group-add-member';
                const select = document.createElement('select');
                select.setAttribute('aria-label', 'Выберите контакт для добавления');
                for (const contact of available) {
                    const option = document.createElement('option');
                    option.value = contact.uid;
                    option.textContent = contact.nickname || contact.globalId || 'Контакт';
                    select.appendChild(option);
                }
                const add = document.createElement('button');
                add.type = 'button';
                add.className = 'btn btn-secondary';
                add.textContent = 'Добавить';
                add.onclick = async () => {
                    const contact = available.find(item => item.uid === select.value);
                    if (!contact) return;
                    try {
                        const nextMembers = [...members, {
                            uid: contact.uid,
                            globalId: contact.globalId || '',
                            nickname: contact.nickname || contact.globalId || 'Пользователь',
                            role: 'member'
                        }];
                        const nextIds = [...new Set([...memberIds, contact.uid])];
                        await updateDoc(doc(db, 'groups', selected.id), {
                            members: nextMembers, memberIds: nextIds, memberCount: nextIds.length
                        });
                        await updateDoc(doc(db, 'messages', 'group_' + selected.id), {
                            memberIds: nextIds, updatedAt: serverTimestamp()
                        }).catch(() => {});
                        uiState.currentGroup = { ...uiState.currentGroup, members: nextMembers, memberIds: nextIds, memberCount: nextIds.length };
                        await loadGroups();
                        await showGroupInfo();
                        showToast('Участник добавлен', 'success');
                    } catch (err) {
                        console.error('[Group member add]', err);
                        showToast('Не удалось добавить участника. Проверьте права Firestore.', 'error');
                    }
                };
                addRow.append(select, add);
                content.appendChild(addRow);
            }
        }

        document.getElementById('clearGroupBtn').style.display = 'block';
        // Keep one unambiguous leave action instead of showing two identical buttons.
        document.getElementById('leaveGroupBtn').style.display = 'none';
        document.getElementById('deleteGroupFromListBtn').textContent = '🚪 Выйти из группы';
        document.getElementById('deleteGroupFromListBtn').style.display = 'block';
        modal.classList.add('active');
    } catch (err) {
        console.error('[Group settings] Failed to load:', err);
        showToast('Не удалось загрузить настройки группы. Проверьте права Firestore.', 'error');
    }
}

async function leaveCurrentGroup() {
    const selected = uiState.currentGroup;
    if (!selected?.id || !authState.user?.uid) return;
    if (!confirm('Выйти из этой группы?')) return;
    try {
        const { doc, getDoc, updateDoc, deleteDoc, serverTimestamp } =
            await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
        const { db } = await import('./config.js');
        const ref = doc(db, 'groups', selected.id);
        const snap = await getDoc(ref);
        if (!snap.exists()) return;
        const group = snap.data();
        const uid = authState.user.uid;
        const members = (group.members || []).filter(m => (typeof m === 'string' ? m : m?.uid) !== uid);
        const memberIds = (group.memberIds || (group.members || []).map(m => typeof m === 'string' ? m : m?.uid).filter(Boolean)).filter(id => id !== uid);
        let adminIds = (group.adminIds || []).filter(id => id !== uid);
        if (!memberIds.length) {
            // Remove the access-control parent too. Firestore does not cascade-delete
            // the nested message documents, but without this parent they are inaccessible.
            await deleteDoc(doc(db, 'messages', 'group_' + selected.id)).catch(() => {});
            await deleteDoc(ref);
        } else {
            if (!adminIds.length) {
                adminIds = [memberIds[0]];
                const promoted = members.map(m => {
                    if ((typeof m === 'string' ? m : m?.uid) !== memberIds[0]) return m;
                    return typeof m === 'string' ? { uid: m, role: 'admin' } : { ...m, role: 'admin' };
                });
                await updateDoc(ref, { members: promoted, memberIds, adminIds, memberCount: memberIds.length });
                await updateDoc(doc(db, 'messages', 'group_' + selected.id), {
                    members: promoted, memberIds, adminIds, updatedAt: serverTimestamp()
                }).catch(() => {});
            } else {
                await updateDoc(ref, { members, memberIds, adminIds, memberCount: memberIds.length });
                await updateDoc(doc(db, 'messages', 'group_' + selected.id), {
                    members, memberIds, adminIds, updatedAt: serverTimestamp()
                }).catch(() => {});
            }
        }
        authState.userData.groups = (authState.userData.groups || []).filter(g => g.id !== selected.id);
        await updateDoc(doc(db, 'users', uid), { groups: authState.userData.groups });
        await DB.Lists.setGroups(uid, authState.userData.groups);
        document.getElementById('groupInfoModal').classList.remove('active');
        closeChat();
        await loadGroups();
        showToast('Вы вышли из группы', 'success');
    } catch (err) {
        console.error('[Group leave]', err);
        showToast('Не удалось выйти из группы. Проверьте права Firestore.', 'error');
    }
}

async function showChannelSettings() {
    const selected = uiState.currentChannel;
    if (!selected?.id) return;
    try {
        const { doc, getDoc, updateDoc, serverTimestamp } =
            await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
        const { db } = await import('./config.js');
        const snap = await getDoc(doc(db, 'channels', selected.id));
        if (!snap.exists()) return showToast('Канал больше не существует', 'error');
        const channel = { ...selected, ...snap.data(), id: selected.id };
        const uid = authState.user.uid;
        const admins = Array.isArray(channel.admins) ? channel.admins : [];
        const members = Array.isArray(channel.members) ? channel.members : [];
        const canManage = admins.includes(uid) || channel.createdBy === uid;
        if (!canManage) return showToast('Управление каналом доступно только администраторам', 'error');

        uiState.currentChannel = { ...channel, isAdmin: true };
        const modal = document.getElementById('channelManageModal');
        const title = document.getElementById('channelManageTitle');
        const body = document.getElementById('channelManageContent');
        title.textContent = 'Настройки канала';
        body.replaceChildren();

        const avatar = document.createElement('div');
        avatar.className = 'group-settings-avatar';
        if (channel.avatar) {
            const img = document.createElement('img');
            img.src = channel.avatar;
            img.alt = 'Аватар канала';
            avatar.appendChild(img);
        } else avatar.textContent = '📢';
        body.appendChild(avatar);

        const form = document.createElement('div');
        form.className = 'group-settings-form';
        const nameLabel = document.createElement('label');
        nameLabel.textContent = 'Название канала';
        const nameInput = document.createElement('input');
        nameInput.maxLength = 80;
        nameInput.value = channel.name || '';
        const descLabel = document.createElement('label');
        descLabel.textContent = 'Описание';
        const descInput = document.createElement('textarea');
        descInput.rows = 2;
        descInput.maxLength = 300;
        descInput.value = channel.description || '';
        const avatarLabel = document.createElement('label');
        avatarLabel.textContent = 'Аватар канала';
        const avatarInput = document.createElement('input');
        avatarInput.type = 'file';
        avatarInput.accept = 'image/*';
        const save = document.createElement('button');
        save.className = 'btn btn-primary';
        save.type = 'button';
        save.textContent = 'Сохранить изменения';
        save.onclick = async () => {
            const name = nameInput.value.trim();
            if (!name) return showToast('Название канала не может быть пустым', 'error');
            try {
                let avatarUrl = channel.avatar || null;
                if (avatarInput.files?.[0]) avatarUrl = await compressImage(avatarInput.files[0], 300 * 1024);
                const patch = { name, description: descInput.value.trim(), avatar: avatarUrl };
                await updateDoc(doc(db, 'channels', channel.id), patch);
                uiState.currentChannel = { ...uiState.currentChannel, ...patch };
                document.getElementById('chatName').textContent = name;
                const chatAvatar = document.getElementById('chatAvatar');
                chatAvatar.replaceChildren();
                if (avatarUrl) {
                    const img = document.createElement('img');
                    img.src = avatarUrl;
                    img.alt = 'Аватар канала';
                    chatAvatar.appendChild(img);
                } else chatAvatar.textContent = '📢';
                const channelList = (authState.userData.channels || []).map(item => item.id === channel.id ? { ...item, ...patch } : item);
                authState.userData.channels = channelList;
                await updateDoc(doc(db, 'users', uid), { channels: channelList });
                await DB.Lists.setChannels(uid, channelList);
                document.getElementById('chatName').textContent = '📢 ' + name;
                await loadChannels();
                showToast('Настройки канала сохранены', 'success');
                await showChannelSettings();
            } catch (err) {
                console.error('[Channel settings] Save failed:', err);
                showToast('Не удалось сохранить канал. Проверьте права Firestore.', 'error');
            }
        };
        form.append(nameLabel, nameInput, descLabel, descInput, avatarLabel, avatarInput, save);
        body.appendChild(form);

        const heading = document.createElement('h4');
        heading.className = 'settings-section-title';
        heading.textContent = 'Подписчики';
        body.appendChild(heading);
        const memberList = document.createElement('div');
        memberList.className = 'group-member-list';
        for (const memberUid of members) {
            const contact = (authState.userData.contacts || []).find(c => c.uid === memberUid);
            const row = document.createElement('div');
            row.className = 'group-member-row';
            const info = document.createElement('div');
            info.className = 'group-member-info';
            const name = document.createElement('strong');
            name.textContent = contact?.nickname || contact?.globalId || (memberUid === uid ? 'Вы' : 'Участник');
            const role = document.createElement('span');
            role.textContent = admins.includes(memberUid) ? 'Администратор' : 'Подписчик';
            info.append(name, role);
            row.appendChild(info);
            if (memberUid !== channel.createdBy && memberUid !== uid) {
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'action-btn danger';
                remove.textContent = '−';
                remove.setAttribute('aria-label', 'Удалить подписчика');
                remove.onclick = async () => {
                    if (!confirm('Удалить пользователя из канала?')) return;
                    try {
                        const nextMembers = members.filter(id => id !== memberUid);
                        const nextAdmins = admins.filter(id => id !== memberUid);
                        await updateDoc(doc(db, 'channels', channel.id), {
                            members: nextMembers, admins: nextAdmins, memberCount: nextMembers.length
                        });
                        await updateDoc(doc(db, 'messages', 'channel_' + channel.id), {
                            members: nextMembers, admins: nextAdmins, updatedAt: serverTimestamp()
                        }).catch(() => {});
                        await loadChannels();
                        await showChannelSettings();
                        showToast('Подписчик удалён', 'success');
                    } catch (err) {
                        console.error('[Channel member remove]', err);
                        showToast('Не удалось удалить подписчика. Проверьте права Firestore.', 'error');
                    }
                };
                row.appendChild(remove);
            }
            memberList.appendChild(row);
        }
        body.appendChild(memberList);

        const available = (authState.userData.contacts || []).filter(contact => contact?.uid && !members.includes(contact.uid));
        if (available.length) {
            const addRow = document.createElement('div');
            addRow.className = 'group-add-member';
            const select = document.createElement('select');
            select.setAttribute('aria-label', 'Выберите подписчика');
            for (const contact of available) {
                const option = document.createElement('option');
                option.value = contact.uid;
                option.textContent = contact.nickname || contact.globalId || 'Контакт';
                select.appendChild(option);
            }
            const add = document.createElement('button');
            add.className = 'btn btn-secondary';
            add.type = 'button';
            add.textContent = 'Добавить';
            add.onclick = async () => {
                const contact = available.find(item => item.uid === select.value);
                if (!contact) return;
                try {
                    const nextMembers = [...new Set([...members, contact.uid])];
                    await updateDoc(doc(db, 'channels', channel.id), {
                        members: nextMembers, memberCount: nextMembers.length
                    });
                    await updateDoc(doc(db, 'messages', 'channel_' + channel.id), {
                        members: nextMembers, admins, updatedAt: serverTimestamp()
                    }).catch(() => {});
                    await loadChannels();
                    await showChannelSettings();
                    showToast('Подписчик добавлен', 'success');
                } catch (err) {
                    console.error('[Channel member add]', err);
                    showToast('Не удалось добавить подписчика. Проверьте права Firestore.', 'error');
                }
            };
            addRow.append(select, add);
            body.appendChild(addRow);
        }
        modal.classList.add('active');
    } catch (err) {
        console.error('[Channel settings] Failed to load:', err);
        showToast('Не удалось загрузить настройки канала. Проверьте права Firestore.', 'error');
    }
}

async function clearAllChats() {
    if (!authState.user?.uid) return;
    if (!confirm('Убрать все личные чаты из списка и скрыть старую историю только у вас?')) return;
    try {
        const { doc, updateDoc, setDoc, serverTimestamp } =
            await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
        const { db } = await import('./config.js');
        const uid = authState.user.uid;
        const chats = Array.isArray(authState.userData?.chats) ? authState.userData.chats : [];

        for (const chat of chats) {
            if (!chat?.uid) continue;
            const chatId = chat.isSeda && chat.sedaChatId
                ? chat.sedaChatId
                : [uid, chat.uid].sort().join('_');
            await setDoc(doc(db, 'chat_clears', uid, 'items', chatId), {
                clearedAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            }, { merge: true });
            await DB.clearCachedMessages(chatId);
        }

        await updateDoc(doc(db, 'users', uid), { chats: [] });
        authState.userData.chats = [];
        await DB.Lists.setChats(uid, []);
        await loadChats();
        document.getElementById('settingsModal').classList.remove('active');
        if (uiState.currentChatId) await loadMessages();
        showToast('Личные чаты убраны из списка; их старая история скрыта только у вас', 'success', 4500);
    } catch (err) {
        console.error('[Clear all chats]', err);
        showToast('Не удалось очистить список чатов. Проверьте подключение и правила Firestore.', 'error', 4500);
    }
}

async function clearAllMessages() {
    if (!authState.user?.uid) return;
    if (!confirm('Скрыть историю всех чатов, групп и каналов только у вас? У других участников история останется.')) return;
    try {
        const { doc, setDoc, serverTimestamp } =
            await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js");
        const { db } = await import('./config.js');
        const uid = authState.user.uid;
        const chatIds = new Set();

        for (const chat of (authState.userData?.chats || [])) {
            if (!chat?.uid) continue;
            chatIds.add(chat.isSeda && chat.sedaChatId
                ? chat.sedaChatId
                : [uid, chat.uid].sort().join('_'));
        }
        for (const group of (authState.userData?.groups || [])) {
            if (group?.id) chatIds.add('group_' + group.id);
        }
        for (const channel of (authState.userData?.channels || [])) {
            if (channel?.id) chatIds.add('channel_' + channel.id);
        }

        for (const chatId of chatIds) {
            await setDoc(doc(db, 'chat_clears', uid, 'items', chatId), {
                clearedAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            }, { merge: true });
            await DB.clearCachedMessages(chatId);
        }
        if (uiState.currentChatId) await loadMessages();
        document.getElementById('settingsModal').classList.remove('active');
        showToast('История переписок очищена только у вас', 'success', 4000);
    } catch (err) {
        console.error('[Clear all messages]', err);
        showToast('Не удалось очистить историю. Проверьте подключение и правила Firestore.', 'error', 4500);
    }
}

async function waitForFirebaseAuthAndRoute() {
    return new Promise((resolve) => {
        let done = false;

        const timeout = setTimeout(() => {
            if (done) return;
            done = true;
            try { unsub(); } catch {}
            showOfflineScreen('Ошибка подключения к серверу, попробуйте позже или проверьте подключение к интернету.');
            resolve();
        }, 12000);

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
                    if (!navigator.onLine || isConnectionFailure(e)) {
                        showOfflineScreen('Ошибка подключения к серверу, попробуйте позже или проверьте подключение к интернету.');
                    } else {
                        hideLoading();
                        showAuthScreen();
                    }
                    resolve();
                }
            } else {
                if (!navigator.onLine) {
                    showOfflineScreen('Ошибка подключения к серверу, попробуйте позже или проверьте подключение к интернету.');
                } else {
                    hideLoading();
                    showAuthScreen();
                }
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

    // Even in airplane mode, allow Firebase to restore its locally persisted session.
    // handleAuthLogin() can then use the previously cached profile and offline chat data.
    // Allow Firebase Auth to restore its persisted session before treating startup as stalled.
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
