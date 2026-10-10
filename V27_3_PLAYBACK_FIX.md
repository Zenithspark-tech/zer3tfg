# ZenithMax V27.3 — Playback and 2-second demo fix

## Exact cause found
The deployed feed shown in the user screenshot is using the old V26.1 starter-video records. The V26.1 seed code hard-coded starter durations to either 5 seconds or **2 seconds**, and those records were backed by remote Wikimedia demo URLs. That is why every visible card could show a black player, `REMOTE DEMO`, `AUDIO`, and `2s`.

The same records also carried Wikimedia metadata that contained HTML markup, which was displayed as literal text in the card source metadata.

## V27.3 repair
- Uses the known-playable curated YouTube catalog for the first Home/Discovery videos.
- YouTube items use the official YouTube embed player and real catalog durations.
- Migrates existing starter records to the new catalog on the next server start.
- Marks obsolete old starter records as removed so they no longer dominate Home/Discovery/Trending.
- Removes HTML markup from source-credit metadata.
- Keeps long-form external catalog support.
- Bumps the service-worker cache to V27.3.
- Keeps 2 MB resumable upload chunks.

## Deployment
1. Replace the GitHub repository contents with this package.
2. Commit and push.
3. In Render, deploy the new commit.
4. After Render reports Live, hard-refresh the browser once.
5. Confirm the UI shows `V27.3` behavior and that the first cards show YouTube thumbnails/players rather than `REMOTE DEMO`.
