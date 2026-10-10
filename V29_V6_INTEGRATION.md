# ZenithMax V29 — V6 Dynamic Entertainment Integration

This package is built on the ZenithMax V28 source package found in the project library. It adds the V6 entertainment features directly to the existing application rather than using a second auth/database stack.

## What is connected
- Existing ZenithMax JWT authentication (`auth` middleware) and existing user IDs/accounts.
- Existing JSON data store in `DATA_DIR/db.json`; additions are new arrays/collections and are also included in the existing PostgreSQL state mirror when configured.
- Additive schema upgrade to 29. Existing user, content, profile, session version, download, chat, and upload collections are retained.
- Entertainment XP and a separate XP leaderboard, capped at 100 XP per user per UTC day. It does not overwrite follower-based creator rank values.
- Challenges (create, accept, complete), notifications for challenge updates, and deduplicated awards for launched games/content playback.
- Public/private watch parties using direct HTTP(S) browser-playable video URLs, host-controlled synchronized playback, polling-based participant chat, invite codes for private rooms, and host-only ending.
- Creator Battles and scheduled community tournaments with entries, optional media URLs, vote totals, one entry and one vote per member, and no self-voting.
- Responsive UI navigation, home-page promotion, Entertainment Hub and leaderboard.

## Important current limitations
- V6 is now connected to the **V28 source package**. If the live Render deployment has changed since that ZIP, deploy only after comparing it with the actual latest repository.
- Watch party playback synchronization is best-effort polling (about every three seconds), not WebRTC broadcast. Direct URLs must be playable in each member's browser and must be shared with proper permission.
- Private party invite code is shown once on creation; the server stores only its SHA-256 hash. If it is lost, create a new private room.
- Tournaments support scheduled start/end windows, entries and votes, but not knockout brackets, automated game score verification, prize payments, or a formal dispute process.
- Arcade XP is earned from opening an existing ZenithMax game, not from verified in-game performance. Game score integration would require each game to report a signed/validated result.
- XP is a recreational progression metric; it does not award money or establish payment eligibility.

## Local test
1. Extract this ZIP.
2. Install dependencies with `npm install`.
3. Run `npm run check` and `npm run test:entertainment` (the latter runs dependency-free route tests).
4. Start using `npm start` and open `http://localhost:3000`.
5. Log in using an existing account or create a test account. The existing auth flow is reused.

The local app uses its configured `DATA_DIR` (default `./data`), so it does not touch a production database when run on your own computer.

## Before updating Render
The included `render.yaml` names a separate `zenithmax-v29-v6-staging` service intentionally; use a copy of data and storage configuration for staging.

1. Download a backup from Production Center or create a Render disk/database backup.
2. Confirm the production `DATA_DIR` persistent disk setting is unchanged and `JWT_SECRET` / `REFRESH_SECRET` are preserved.
3. Check whether the production package matches V28. If it is newer/different, merge these changes into that exact source instead of replacing it with this archive.
4. Deploy the package to a staging service using a **copy** of the production data first; test login, uploads, videos, messages, game launch, private invite code, room chat/playback, entry submission, vote restrictions, notifications, and database persistence.
5. Only replace the production service after staging succeeds. The first state load adds the new collection arrays and writes the schema 29 marker; it does not recreate accounts.

## Security notes
- Invite codes are random and stored as SHA-256 hashes.
- Submitted URLs must use HTTP or HTTPS. URL validation cannot verify the licensing or safety of the remote media itself.
- Existing app-wide API rate limiting, auth checks, validation and error handling remain in effect.
