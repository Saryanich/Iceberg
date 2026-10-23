# Firebase Rules and indexes — Iceberg

The Firestore security policy lives in `firestore.rules`. The composite index used to recover direct chats lives in `firestore.indexes.json`; both are configured in `firebase.json`.

## Publish to the Firebase project

From the repository root, after signing in to Firebase CLI with an account allowed to deploy the project:

```bash
firebase deploy --only firestore:rules,firestore:indexes --project glob-data
```

## Access model

- `global_ids/{globalId}` supports exact-document lookup only. Listing and deleting Global ID records are denied.
- `users/{uid}` remains private to its owner and administrators. Client code must not write to another user's profile to synchronize chats.
- Direct-chat preview metadata is stored on the shared `messages/{chatId}` parent, guarded by current thread membership. Participants are used to recover a chat if an old private chat list is missing an entry.
- Channels and groups use `channels` and `groups` as their authoritative membership records. Legacy channel cache entries are re-checked against the server before they are shown online.
- Clearing history uses `chat_clears/{uid}/items/{chatId}` and does not erase another participant's message copy.
- Stories use `user_stories/{uid}/items/{storyId}` and are limited to a maximum 24-hour lifetime.

GitHub Actions checks JavaScript syntax and compiles the rules in the Firestore emulator. These checks do not deploy rules or indexes to the live Firebase project.
