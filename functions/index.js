const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const logger = require('firebase-functions/logger');

initializeApp();
const db = getFirestore();
const messaging = getMessaging();

const INVALID_TOKEN_CODES = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered'
]);
const DISPATCH_LEASE_MS = 120000;

function memberUids(data, fields, senderUid) {
  const found = new Set();
  for (const field of fields) {
    const values = Array.isArray(data?.[field]) ? data[field] : [];
    for (const value of values) {
      const uid = typeof value === 'string' ? value : value?.uid;
      if (typeof uid === 'string' && uid && uid !== senderUid) found.add(uid);
    }
  }
  if (typeof data?.createdBy === 'string' && data.createdBy !== senderUid) {
    found.add(data.createdBy);
  }
  return [...found];
}

async function getRecipientUids(thread, senderUid) {
  if (thread.kind === 'direct' || thread.kind === 'seda') {
    const participants = Array.isArray(thread.participants) ? thread.participants : [];
    if (participants.length !== 2 || !participants.includes(senderUid)) return [];
    return participants.filter(uid => uid !== senderUid);
  }

  if (thread.kind === 'group' && thread.resourceId) {
    const groupSnap = await db.doc('groups/' + thread.resourceId).get();
    if (!groupSnap.exists) return [];
    return memberUids(groupSnap.data(), ['memberIds', 'members', 'adminIds'], senderUid);
  }

  if (thread.kind === 'channel' && thread.resourceId) {
    const channelSnap = await db.doc('channels/' + thread.resourceId).get();
    if (!channelSnap.exists) return [];
    return memberUids(channelSnap.data(), ['memberIds', 'members', 'admins'], senderUid);
  }

  return [];
}

async function claimDispatch(messageId, recipientUid) {
  const id = messageId + '_' + recipientUid;
  const ref = db.doc('push_dispatches/' + id);
  const now = Date.now();
  return await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    const previous = snapshot.exists ? snapshot.data() : null;
    if (previous?.status === 'sent' || previous?.status === 'no-tokens') return null;
    const leaseUntil = Number(previous?.leaseUntilMillis || 0);
    if (previous?.status === 'sending' && leaseUntil > now) return null;

    transaction.set(ref, {
      messageId,
      recipientUid,
      status: 'sending',
      attempts: Number(previous?.attempts || 0) + 1,
      leaseUntilMillis: now + DISPATCH_LEASE_MS,
      updatedAt: FieldValue.serverTimestamp()
    });
    return ref;
  });
}

async function sendRecipientNotification(messageId, chatId, senderUid, recipientUid, message) {
  const dispatchRef = await claimDispatch(messageId, recipientUid);
  if (!dispatchRef) return;

  try {
    const userSnap = await db.doc('users/' + recipientUid).get();
    if (!userSnap.exists) {
      await dispatchRef.update({
        status: 'no-tokens',
        leaseUntilMillis: 0,
        updatedAt: FieldValue.serverTimestamp()
      });
      return;
    }

    const tokens = [...new Set(
      Array.isArray(userSnap.data()?.fcmTokens)
        ? userSnap.data().fcmTokens.filter(token => typeof token === 'string' && token.length > 20)
        : []
    )].slice(0, 100);

    if (!tokens.length) {
      await dispatchRef.update({
        status: 'no-tokens',
        leaseUntilMillis: 0,
        updatedAt: FieldValue.serverTimestamp()
      });
      return;
    }

    const isAttachment = message.mediaEncrypted === true || !!message.attachment
      || ['photo', 'video', 'audio', 'file'].includes(message.type);
    const response = await messaging.sendEachForMulticast({
      tokens,
      notification: {
        title: 'Айсберг',
        body: isAttachment ? 'Новое зашифрованное вложение' : 'Новое зашифрованное сообщение'
      },
      data: {
        type: 'ICEBERG_NEW_MESSAGE',
        chatId: String(chatId),
        messageId: String(messageId),
        senderId: String(senderUid),
        url: 'https://saryanich.github.io/Iceberg/'
      },
      webpush: {
        headers: { Urgency: 'high' },
        notification: { tag: 'iceberg-' + messageId },
        fcmOptions: { link: 'https://saryanich.github.io/Iceberg/' }
      }
    });

    const invalidTokens = [];
    response.responses.forEach((result, index) => {
      if (!result.success && INVALID_TOKEN_CODES.has(result.error?.code)) {
        invalidTokens.push(tokens[index]);
      }
    });

    if (invalidTokens.length) {
      await db.doc('users/' + recipientUid).update({
        fcmTokens: FieldValue.arrayRemove(...invalidTokens)
      }).catch(error => logger.warn('Could not prune invalid FCM tokens', {
        recipientUid,
        error: error.message
      }));
    }

    if (response.successCount === 0 && response.failureCount > 0
        && invalidTokens.length !== response.failureCount) {
      throw new Error('All FCM deliveries failed for recipient ' + recipientUid);
    }

    await dispatchRef.update({
      status: 'sent',
      successCount: response.successCount,
      failureCount: response.failureCount,
      leaseUntilMillis: 0,
      sentAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
  } catch (error) {
    await dispatchRef.update({
      status: 'pending',
      leaseUntilMillis: 0,
      lastError: String(error?.message || error).slice(0, 500),
      updatedAt: FieldValue.serverTimestamp()
    }).catch(updateError => logger.error('Could not release FCM dispatch lease', updateError));
    throw error;
  }
}

exports.notifyIcebergMessage = onDocumentCreated(
  {
    document: 'messages/{chatId}/msgs/{messageId}',
    retry: true
  },
  async event => {
    const message = event.data?.data();
    const { chatId, messageId } = event.params;
    const senderUid = message?.senderId;
    if (!senderUid || message?.type === 'system') return;

    const threadSnap = await db.doc('messages/' + chatId).get();
    if (!threadSnap.exists) {
      logger.warn('Message has no parent thread', { chatId, messageId });
      return;
    }

    const recipients = await getRecipientUids(threadSnap.data() || {}, senderUid);
    if (!recipients.length) {
      logger.warn('No valid recipients for message', { chatId, messageId });
      return;
    }

    for (const recipientUid of recipients) {
      await sendRecipientNotification(messageId, chatId, senderUid, recipientUid, message);
    }

    logger.info('Encrypted message notifications processed', {
      chatId,
      messageId,
      recipientCount: recipients.length,
      cryptoVersion: message.cryptoVersion || 'legacy'
    });
  }
);
