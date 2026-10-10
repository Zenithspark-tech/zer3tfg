# ZenithMax V23 — Production Hardening

V23 keeps the ZenithMax V22.7 creator ecosystem and responsive UI while adding a stronger operational foundation.

## Included
- Atomic database writes: JSON data is written to a temporary file and renamed into place to reduce corruption risk from interrupted writes.
- Session versioning: access and refresh tokens carry a session version; server-side revocation can invalidate all active sessions for an account.
- Persistent refresh tokens: the browser stores a refresh token and automatically refreshes an access token after a temporary expiry/invalid-session response.
- Server logout: signing out revokes the current account's session version so the old token cannot be reused.
- Request security: request IDs, `X-Content-Type-Options`, frame protection, referrer policy, and a restrictive permissions policy.
- Rate limiting: general API and stricter authentication rate limits are applied per source IP in the running service.
- Health endpoints: `/api/health` for service metrics and `/api/ready` for deployment readiness checks.
- Feature metadata: `/api/meta` exposes the V23 feature set and supported long-video duration range without secrets.
- Audit logging: administrative and account security actions can be recorded for review.
- Admin system view: service version, memory, uptime, audit counts, and recent backup information.
- Admin database backups: CEO/admin accounts can create a rolling set of recent `db-*.json` backups under `DATA_DIR/backups`.
- Existing resumable uploads, remote media proxies, Shorts playback, long-form video, social feed, Stories, messaging, groups, WebRTC calls, creator ecosystem, follower rankings, CEO recognition, playlists, games, music, moderation, demo monetization, and responsive design remain included.

## Important production integrations still required
V23 is production-hardened but it does not magically provide third-party infrastructure credentials. Before a large public launch, connect durable object storage/CDN for uploads, a managed database, TURN servers/realtime infrastructure for reliable calling, an approved email/identity provider for account recovery, and a compliant payment provider for real creator payouts.

## Render
The blueprint uses `npm install` and `npm start`. Set a strong `JWT_SECRET` in production and set `REFRESH_SECRET` to a separate strong secret when desired. The recommended health-check path is `/api/ready`.
