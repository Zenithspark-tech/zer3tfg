# ZenithMax V21 Communication

This upgrade adds a WhatsApp-like communication feature set without copying proprietary WhatsApp code or UI.

## Included
- Phone number registration and contact discovery.
- Phone-number normalization with +234 as the default country code for local 0-prefixed numbers.
- Phone discovery can be toggled off from Profile.
- Direct text chat.
- Group chats (free-build limit: 8 members).
- Image, video and audio attachments in chats.
- Browser-recorded voice notes using MediaRecorder.
- One-to-one internet voice calls.
- One-to-one internet video calls.
- Group internet voice/video calls (host/star WebRTC topology, up to 8 participants in the free build).
- REST polling signaling plus WebRTC ICE/STUN.
- Incoming-call prompts while a signed-in user is browsing ZenithMax.

## Important calling limitation
These are browser-to-browser internet calls to ZenithMax users. They are not calls to ordinary mobile/landline phone numbers over the cellular/PSTN network.

For production-scale calling, add a TURN server, durable realtime signaling (WebSocket/WebRTC signaling service), rate limiting, abuse/report tools, call history, and stronger persistent storage.
