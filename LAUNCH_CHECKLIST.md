# ZenithMax — Render launch checklist

## What changed in this release
Data
- All accounts, content and settings are now stored in PostgreSQL as one row per record. Each save writes only what changed, in a single transaction. The old whole-file rewrite and the single-row snapshot are gone.
- On first start, existing data is imported automatically: from the old `db.json` file if the instance has one, otherwise from the earlier PostgreSQL snapshot. Check the logs for `Imported existing ZenithMax data`.
- Pending writes are flushed on shutdown (SIGTERM), so a Render redeploy does not drop the last few changes.
- Without DATABASE_URL, the app keeps the same data in a local JSON file, for development only.

Sessions
- Access tokens last 1 hour (`ACCESS_TOKEN_TTL` to change). Refresh tokens last 30 days (`REFRESH_TOKEN_TTL`).
- The app refreshes silently, so users stay signed in for 30 days of inactivity-free use.
- Refresh tokens cannot be used as access tokens, and access tokens cannot be used to refresh.
- Logout and logout-all still revoke sessions immediately.

Email verification
- When an email provider is configured (`RESEND_API_KEY`, `RESEND_FROM`), new accounts receive a 6-digit code. Codes expire after 30 minutes and lock after 5 wrong attempts.
- Until verified, an account can browse, watch, read and listen, but cannot post, upload, comment, message, call, follow, like, or join entertainment features.
- Google sign-in counts as verified.
- Accounts created before this release are treated as verified.
- Without an email provider, new accounts are verified automatically, so nobody is locked out. Configure Resend before launch.
- The CEO title is granted only after the CEO mailbox is verified, by code or by Google sign-in.

Content
- 10 more starter posts, 5 stories, 2 sound presets and 2 colour effects are seeded.
- A new original starter game, "Trivia Blitz", appears in the Arcade. It is a playable HTML5 quiz with no external resources.

## Before you deploy
1. Run `npm install` locally and commit `package-lock.json`. Without it, Render installs the newest versions on each build.
2. Keep the web service at **one instance**. State is held in memory and written to PostgreSQL by that instance. Two instances would not see each other's changes.
3. Set the secrets from `render.yaml`. JWT_SECRET and REFRESH_SECRET are generated automatically. Also set DATABASE_URL, the S3 variables, and the Resend variables (`EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `RESEND_FROM`, `APP_PUBLIC_URL`).
4. Use a paid PostgreSQL plan. Render's free database expires after 30 days.
5. Configure S3-compatible storage. Without it, uploads are lost on redeploy.
6. Turn off Render auto-deploy for the branch the `grow-shorts` workflow commits to. Each bot commit otherwise restarts the server.
7. After the first deploy, check the logs for the import line (if you have old data) and for `ZenithMax V31.0.0 running`.
8. Sign in once with the CEO Google account, or verify the CEO email by code, to restore the CEO title.
9. Open `/api/release/preflight` as the CEO and resolve any red items.

## Known limits
- Single instance only (see step 2). Scaling out needs a shared state layer or a relational schema for each collection.
- Password reset is not implemented yet. Users who forget a password need an admin path until it is added.
- Tokens are kept in localStorage. A strict Content-Security-Policy would reduce the XSS risk, but the inline onclick handlers need refactoring first.
- Rate limits are in memory, per instance.
- Free web services sleep after inactivity, so the first request after a pause is slow.
- Creator and video content comes from Wikimedia Commons and YouTube. Keep the background Shorts growth throttled, and respect each source's licence and usage policy.
