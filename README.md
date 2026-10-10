# ZenithMax V30 — Colorful Founder Edition

ZenithMax V28 is the advanced social/video/creator build.

## V28 highlights
- Full authentication gate: the app opens on Login/Sign up when no session exists.
- Multi-step sign up: Username → Gmail + password → phone + optional profile picture → optional artist name.
- Account profile pictures, including signup upload and profile replacement.
- Optional Google Sign-In through Google Identity Services. Configure `GOOGLE_CLIENT_ID` in Render.
- Downloads library for Movies, Music, Shorts and Videos, with direct-download support where the media source permits it. Provider-hosted embeds remain subject to the provider's own download rules.
- Existing messaging, voice notes, groups and browser voice/video calling retained.
- Existing Shorts and long-form discovery systems retained and presented as ZenithMax-native experiences.

## Render environment
Keep your existing secrets. Optional Google Sign-In:

`GOOGLE_CLIENT_ID=<your Google OAuth web client id>`

Do not commit OAuth secrets or JWT/refresh secrets to GitHub.

## Important
ZenithMax uses original ZenithMax UI and integrations. It does not copy proprietary source code, protected branding, or private APIs from YouTube, WhatsApp, TikTok or Netflix. Those services are used only as product-pattern references; video/movie/media availability must respect each provider's permissions and licenses.


## V30 visual upgrade
- Colorful responsive home hero and experience gallery for Social, Shorts, Music, Games, Discover and Creator Studio.
- Founder spotlight on Home and redesigned About the Founder biography featuring the portrait provided by the project owner.
- Optimized founder portrait is stored in `client/images/zenith-spark-founder.webp`.
- New service-worker cache name and cache-busted CSS/JS URLs ensure the updated design is fetched.
- Existing login/session APIs, user state, upload system and the V29 V6 entertainment endpoints are preserved.

## Local test
```bash
npm install
npm run check
npm run test:entertainment
npm start
```


## V31 — Cool Founder App Icon
- Replaced the PWA icon set with a polished burgundy, gold, purple and cyan ZenithMax founder design based on the provided portrait.
- Updated `client/icon-192.png`, `client/icon-512.png`, `client/favicon.png`, and SVG fallback.
- Added the full-resolution master artwork at `client/zenithmax-app-icon-master.png`.
- Updated web-app manifest metadata and service-worker cache version so browsers can fetch the new icon.
- Existing account, upload, database, and entertainment functionality remains unchanged by this icon-only update.

After deploying, installed PWAs may need to be reopened or reinstalled to refresh their launcher icon; browser favicon caches can also take time to update.
