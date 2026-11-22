# Pagemarks

A small private app for saving web pages (Pagemarks), with folders, tags, notes and a nightly link checker.

- Hosting: GitHub Pages
- Sign-in and storage: Firebase (access is limited to invited accounts by Firestore security rules)
- Link checker: GitHub Actions, `.github/workflows/check-links.yml` and `checker/check-links.mjs`
  - Needs a repository secret named `FIREBASE_SERVICE_ACCOUNT`
  - Logs show totals only
