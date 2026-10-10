# ZenithMax V25.0 Release Candidate

V25 is the release-readiness build based on V24 production services.

## Included
- Production preflight endpoint: `/api/release/preflight`
- Release manifest endpoint: `/api/release/manifest`
- Runtime metrics endpoint: `/api/admin/metrics`
- Safer schema migration: a database backup is created before an older schema is upgraded
- Persistent refresh-token storage on the client
- Installable PWA shell with offline static-shell fallback
- Responsive web UI from V22.6 and all prior feature systems
- V24 production-service adapters: S3-compatible storage, PostgreSQL state mirror/recovery, email, payments, TURN, and media-processing detection
- V23 security hardening, session revocation, rate limiting, request IDs, audit logs, and backups
- V22.7 creator ecosystem, rankings, CEO recognition, Shorts, long videos, social feed, Stories, music, games, messaging and calls

## Important production notes
V25 does not invent provider credentials or claim third-party infrastructure is live. Configure real credentials in Render before public launch.

For Android, the PWA can be installed from a supported browser. A signed Play Store AAB still requires an Android packaging/signing workflow outside this web bundle.
