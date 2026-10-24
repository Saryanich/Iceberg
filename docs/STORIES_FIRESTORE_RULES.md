# Firebase Rules для историй Iceberg

Текущие правила Firestore уже разрешают читать и создавать документы историй, но запрещают неизвестные подколлекции по умолчанию. Поэтому лайки и просмотры не заработают, пока эти правила не будут добавлены в существующие Firebase Rules.

Добавьте следующий блок **внутрь** существующего блока `match /user_stories/{uid}/items/{storyId}`, рядом с правилами самого документа истории. Он не заменяет остальные правила приложения.

```javascript
function parentStoryActive() {
  return signedIn()
    && exists(/databases/$(database)/documents/user_stories/$(uid)/items/$(storyId))
    && get(/databases/$(database)/documents/user_stories/$(uid)/items/$(storyId)).data.expiresAt is timestamp
    && get(/databases/$(database)/documents/user_stories/$(uid)/items/$(storyId)).data.expiresAt > request.time;
}

match /likes/{viewerUid} {
  allow get, list: if parentStoryActive();
  allow create: if parentStoryActive()
    && request.auth.uid == viewerUid
    && request.resource.data.keys().hasOnly(['uid', 'nickname', 'createdAt'])
    && request.resource.data.uid == request.auth.uid;
  allow delete: if parentStoryActive() && request.auth.uid == viewerUid;
  allow update: if false;
}

match /views/{viewerUid} {
  allow get, list: if parentStoryActive() && request.auth.uid == uid;
  allow create: if parentStoryActive()
    && request.auth.uid == viewerUid
    && request.auth.uid != uid
    && request.resource.data.keys().hasOnly(['uid', 'nickname', 'viewedAt'])
    && request.resource.data.uid == request.auth.uid;
  allow update: if parentStoryActive()
    && request.auth.uid == viewerUid
    && request.auth.uid != uid
    && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['nickname', 'viewedAt'])
    && request.resource.data.uid == request.auth.uid;
  allow delete: if request.auth.uid == uid || request.auth.uid == viewerUid;
}
```

**Важно:** не заменяйте целиком рабочие правила Iceberg этим фрагментом. Сохраните существующие правила чатов, SEDA, Global ID и пользователей. После добавления блока опубликуйте обновлённые правила в Firebase Console.
