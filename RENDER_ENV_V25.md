# Render environment for V25

Required in production:
- `JWT_SECRET` – strong secret, 32+ characters
- `REFRESH_SECRET` – separate strong secret, 32+ characters
- `CEO_EMAILS` – the CEO/admin email(s)
- `DATA_DIR=/var/data` for durable disk-backed state when using Render persistent storage

Recommended production services:
- PostgreSQL: `DATABASE_URL`, `DATABASE_PROVIDER=postgres`
- S3-compatible object storage: `MEDIA_STORAGE_PROVIDER=s3`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, optional `S3_ENDPOINT`, `MEDIA_CDN_BASE_URL`
- Email: `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `RESEND_FROM`, `APP_PUBLIC_URL`
- Payments: `PAYMENTS_PROVIDER=stripe`, `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`
- Calls: `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`
- Optional processing: `FFMPEG_PATH`, `FFPROBE_PATH`
- `RELEASE_CHANNEL=stable`
