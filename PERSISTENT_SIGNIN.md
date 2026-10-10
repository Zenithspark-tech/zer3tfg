# ZenithMax V22.2 — Persistent Sign-in

V22.2 keeps the signed-in session in browser local storage and remembers the signed-in user profile locally. On startup, ZenithMax refreshes the session when the server is reachable. A temporary network/server interruption no longer deletes the saved login.

A saved session is cleared only when the server explicitly returns HTTP 401 for the saved token or when the user taps **Logout**.

The server JWT lifetime was increased from 30 days to 365 days so a returning user is not unexpectedly signed out during ordinary use.

For production, keep `JWT_SECRET` set to a stable secret in Render and use persistent storage for server-side data.
