# ZenithMax V24 — Production Services

V24 adds provider adapters for durable media storage, CDN URLs, email delivery, PostgreSQL state mirroring/recovery, WebRTC TURN configuration, and optional media-processing detection.

## Recommended environment variables

### Database
- `DATABASE_URL` — PostgreSQL connection string.
- `DATABASE_PROVIDER=postgres`

V24 mirrors the ZenithMax JSON state into PostgreSQL and can restore the state when the local database file is missing. The in-memory application model remains backward-compatible with V23.

### Media storage / CDN
- `MEDIA_STORAGE_PROVIDER=s3`
- `S3_BUCKET`
- `S3_REGION`
- `S3_ENDPOINT` (optional for Cloudflare R2, Backblaze B2 S3 API, MinIO, etc.)
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `S3_FORCE_PATH_STYLE=true` when required by the provider
- `MEDIA_CDN_BASE_URL` (recommended public/CDN URL prefix)

Completed resumable video/music uploads are copied to S3-compatible storage when configured. Local storage remains available as a fallback.

### Email
- `EMAIL_PROVIDER=resend`
- `RESEND_API_KEY`
- `RESEND_FROM` — a verified sender such as `ZenithMax <noreply@yourdomain.com>`
- `APP_PUBLIC_URL`

### Payments
- `PAYMENTS_PROVIDER=stripe`
- `STRIPE_SECRET_KEY`
- `STRIPE_PUBLISHABLE_KEY`
- `STRIPE_WEBHOOK_SECRET`

V24 exposes provider readiness; it does not pretend a payment account is connected until these credentials are actually supplied.

### WebRTC
- `TURN_URLS` — comma-separated `turn:` / `turns:` URLs
- `TURN_USERNAME`
- `TURN_CREDENTIAL`
- `STUN_URLS` — optional override

The client receives ICE server configuration from an authenticated endpoint.

### Video processing
- `FFMPEG_PATH` (default `ffmpeg`)
- `FFPROBE_PATH` (default `ffprobe`)

V24 detects whether FFmpeg/FFprobe are installed and exposes that status. Full transcoding/thumbnail pipelines can be attached to the queue later.

## Render notes

Use a managed PostgreSQL provider and object storage/CDN for production durability. A local filesystem alone should not be treated as permanent cloud storage on an ephemeral service.
