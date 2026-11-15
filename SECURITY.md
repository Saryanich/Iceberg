# Security notes

- Every direct conversation uses SEDA Ultra. There is no Basic/Pro mode or activation gate.
- New direct conversations use the `sedaultra_` thread namespace and one shared chat key established through an ECDH P-256 handshake.
- Direct-message text uses five AES-256-GCM layers.
- Direct-chat attachments use random per-file keys, encrypted metadata, five AES-256-GCM layers and 1 MiB chunks. Ciphertext is uploaded to Firebase Storage; the file key is wrapped by the chat key.
- This project-specific ECDH exchange is **not Signal Protocol**: there is no Double Ratchet, X3DH/PQXDH, signed prekey rotation or authenticated device identity verification. Do not describe it as Signal/WhatsApp-grade.
- Firestore and Firebase Storage security rules are essential. Client-side encryption does not replace server-side authorization.
- The JavaScript client is public by design. Firebase web API keys and VAPID public keys are client configuration, not server secrets.
- Never commit service-account JSON, private signing keys, passwords, refresh tokens or personal data.
