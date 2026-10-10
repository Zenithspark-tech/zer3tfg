# ZenithMax V22.3 — Shorts Playback Fix

This release fixes the Shorts playback path by resolving curated Wikimedia Commons files exactly, using a range-aware same-origin media proxy, and adding a client-side direct-source retry.

The app does not bundle the remote videos into the package. Playback remains dependent on the remote source being reachable.
