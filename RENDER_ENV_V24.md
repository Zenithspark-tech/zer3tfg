# Render V24 Environment Setup

Required application secrets remain:
- JWT_SECRET
- REFRESH_SECRET
- CEO_EMAILS=zenitholuwambe5@gmail.com

Recommended production services:
- DATABASE_URL
- DATABASE_PROVIDER=postgres
- MEDIA_STORAGE_PROVIDER=s3
- S3_BUCKET
- S3_REGION
- S3_ENDPOINT (when using a non-AWS S3-compatible provider)
- S3_ACCESS_KEY_ID
- S3_SECRET_ACCESS_KEY
- MEDIA_CDN_BASE_URL
- EMAIL_PROVIDER=resend
- RESEND_API_KEY
- RESEND_FROM
- APP_PUBLIC_URL
- PAYMENTS_PROVIDER=stripe
- STRIPE_SECRET_KEY
- STRIPE_PUBLISHABLE_KEY
- STRIPE_WEBHOOK_SECRET
- TURN_URLS
- TURN_USERNAME
- TURN_CREDENTIAL

Do not commit secret values to GitHub. Put them in the deployment platform's environment/secret settings.
