# ZenithMax V26.1 — Media Playback Repair

This release fixes the remote media playback path for Home, Discovery and Shorts.

## Sources
- YouTube content is played through the official YouTube IFrame/embed player. ZenithMax does not download or rehost YouTube video files.
- Wikimedia video content uses Wikimedia Commons media URLs and the Commons API, with license/attribution metadata retained.
- A `YOUTUBE_API_KEY` Render environment variable can be supplied to enable dynamic YouTube search results in Home, Discovery, Search, and Shorts.

## Important
Do not attempt to store billions of copied third-party URLs. The service uses paginated discovery and provider APIs instead.

## Environment
`YOUTUBE_API_KEY` — optional; required for live YouTube API discovery. Existing Commons playback does not require it.
