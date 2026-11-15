# Security policy

## Reporting vulnerabilities
Please do not publish exploit details, authentication tokens, private keys, personal data, or message contents in public issues. Report vulnerabilities privately to the repository maintainer with the affected component, reproduction steps, impact, and a safe proof of concept.

## Public source code
Iceberg is a browser application and its client-side source is public by design. Minification or obfuscation cannot make browser code secret. Firebase Web API keys and VAPID public keys are client configuration, not server credentials. Never commit Firebase Admin SDK service-account JSON, private signing keys, passwords, refresh tokens, private user data, or production exports.

## Cryptography status
- SEDA Ultra v1 has been moved into `js/seda-ultra.js`; its existing payload prefix and key derivation are preserved for compatibility.
- SEDA Ultra v1 currently applies five sequential AES-256-GCM layers. Layer count is not a substitute for a reviewed end-to-end protocol.
- The current ECDH P-256 handshake is not Signal Protocol. It does not yet authenticate peer identity using signed prekeys, and it does not implement Double Ratchet, post-compromise security, or PQXDH.
- Any safety/comparison number must be compared through an independent trusted channel. It does not authenticate the existing handshake by itself.
- C2A is a reversible file container/checksum format, not encryption. SEDA encryption must protect its contents independently.
- Legacy `ICEBERGBASE1:` and `SEDAULTRA1:` messages must remain decryptable during migration.

Do not claim WhatsApp/Signal-equivalent security until a reviewed Signal Protocol implementation and device identity verification have been integrated and tested.

## Firebase deployment
Client code cannot replace Firestore or Firebase Storage Security Rules. Rules must restrict reads and writes to authenticated thread participants, validate message ownership and schema, and deny public access. Enable Firebase App Check and monitor abuse/quotas. Storage rules must be deployed separately before any encrypted-attachment upload feature is enabled.

## Repository settings
Enable secret scanning, push protection, Dependabot alerts, and private vulnerability reporting in GitHub repository settings. GitHub Actions workflows in this repository do not automatically enable account-level security settings or branch protection.
