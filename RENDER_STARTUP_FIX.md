# ZenithMax V31.1 — Render startup fix

This ZIP is flattened so `package.json`, `server/`, and `client/` are in the project root.

## Render settings
In the `zenithmax-v29-v6-staging` service, open **Settings → Build & Deploy** and set:

- **Root Directory:** leave empty (do not set it to `src`).
- **Build Command:** `npm install`
- **Start Command:** `npm start`
- **Health Check Path:** `/api/ready`

The included `package.json` uses `node server/server.js`. This project contains `server/server.js`, not `src/server/server.js`, so do not use `node src/server/server.js` as the start command.

If using GitHub, extract this ZIP locally and commit its *contents* to the repository root (do not commit only the ZIP file or place everything inside an extra `src/` folder). In Render, then choose **Manual Deploy → Deploy latest commit**.

## Environment variables
Keep the existing secrets unchanged. Set `DATABASE_URL` to the correct database URL for the environment. For staging, use a staging database; do not point a staging test build at live production data. `YOUTUBE_API_KEY` is optional for YouTube Data API-backed discovery, and it cannot fix a server startup path error.

## Back up before production
Test staging first, and back up the production database before any production deployment. This package does not deploy itself or modify a Render service automatically.
