# Iceberg release verification checklist

This checklist distinguishes static checks from tests that require a configured Firebase project.

## Automated checks
- [ ] GitHub Actions JavaScript syntax validation passes.
- [ ] No browser-console errors on a clean sign-in and sign-out.
- [ ] No duplicate Firestore listeners after switching chats repeatedly.
- [ ] Message input rejects text longer than 4,000 Unicode code points without clearing the draft.
- [ ] Message write failure does not leave a false chat preview in the pending metadata queue.

## Firebase integration checks
- [ ] Test with two accounts in separate browser profiles.
- [ ] Verify direct messages, groups, channels, reply/edit/delete, reactions, and read receipts.
- [ ] Confirm non-admin channel members cannot publish even when manipulating the client.
- [ ] Confirm Firestore Security Rules enforce membership and roles independently of UI checks.
- [ ] Simulate offline send, reconnect, duplicate delivery, and metadata write denial.
- [ ] Verify each listener is released on chat switch, logout, and account lock.
- [ ] Verify encrypted messages and media decrypt only for authorized participants.
- [ ] Review Firestore indexes and deployed rules in the Firebase Console.

## Release safety
- Do not describe the application as production-certified until integration, authorization, security, and accessibility tests pass against the actual Firebase project.
- Keep secrets and privileged credentials out of client-side configuration. Firebase web configuration is not a substitute for Security Rules.
