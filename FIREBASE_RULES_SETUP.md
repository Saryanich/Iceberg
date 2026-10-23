# Firebase Rules — публикация

Iceberg keeps its Firestore Security Rules in the repository-root file firestore.rules.

## Publish the rules

1. Open the Firebase Console for project glob-data.
2. Open Firestore Database → Rules.
3. Replace the editor contents with the complete contents of firestore.rules from this repository's main branch.
4. Click Publish and wait for Firebase to confirm the deployment.
5. Test with two separate accounts: direct chat and Base encryption, SEDA handshake, a group with a removed member, channel membership, contact discovery, stories, and history clearing.

The GitHub workflow .github/workflows/firestore-rules.yml compiles the rules in the Firestore Emulator on changes. A successful workflow validates rules syntax/compilation; it does not deploy the rules to the live Firebase project and does not replace two-account integration tests.

## Important behavior

- Clearing history stores a per-user cutoff and clears that user's local cache. It does not delete the other participant's copy of messages.
- Base and SEDA key handshakes require authenticated access to the corresponding seda_handshakes document.
- Public contact lookup uses global_ids and public_profiles; private users documents are not listed by ordinary clients.
- Stories are stored under user_stories/{uid}/items/{storyId} and expire after 24 hours.
