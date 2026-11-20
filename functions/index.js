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

exports.notifyIcebergDirectMessage = onDocumentCreated(
  {
    document: 'messages/{chatId}/msgs/{messageId}',
    region: 'europe-west1',
    retry: true
  },
  async (event) => {
    const message = event.data?.data();
    const { chatId, messageId } = event.params;
    const senderUid = message?.senderId;

    if (!senderUid || message?.type === 'system') return;

    const threadSnap = await db.doc('messages/' + chatId).get();
    if (!threadSnap.exists) {
      logger.warn('Message has no parent thread', { chatId, messageId });
      return;
    }

    const thread = threadSnap.data() || {};
    if (thread.kind !== 'direct' && thread.kind !== 'seda') return;

    const participants = Array.isArray(thread.participants) ? thread.participants : [];
    if (participants.length !== 2 || !participants.includes(senderUid)) {
      logger.warn('Ignoring message with invalid direct-thread participants', { chatId, messageId });
      return;
    }

    const recipients = participants.filter(uid => uid !== senderUid);
    for (const recipientUid of recipients) {
      const userSnap = await db.doc('users/' + recipientUid).get();
      if (!userSnap.exists) continue;

      const tokens = [...new Set(
        Array.isArray(userSnap.data()?.fcmTokens)
          ? userSnap.data().fcmTokens.filter(token => typeof token === 'string' && token.length > 20)
          : []
      )].slice(0, 100);

      if (!tokens.length) continue;

      const response = await messaging.sendEachForMulticast({
        tokens,
        notification: {
          title: 'Айсберг',
          body: (message.mediaEncrypted === true || message.attachment) ? 'Новое зашифрованное вложение' : 'Новое зашифрованное сообщение'
        },
        data: {
          type: 'ICEBERG_NEW_MESSAGE',
          chatId: String(chatId),
          messageId: String(messageId),
          senderId: String(senderUid),
          url: '/Iceberg/'
        },
        webpush: {
          headers: { Urgency: 'high' },
          fcmOptions: { link: '/Iceberg/' }
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

      logger.info('Encrypted message push dispatched', {
        chatId,
        messageId,
        recipientUid,
        successCount: response.successCount,
        failureCount: response.failureCount
      });
    }
  }
);
