# ZenithMax V28 — Advanced Authentication, Profiles & Downloads

## Authentication
- Logged-out visitors see only the ZenithMax authentication screen.
- Login uses Gmail + password.
- Sign up uses 3 steps: username/Gmail/password; phone + optional profile image; optional artist name.
- Successful sign up/login immediately opens Home.
- Google Sign-In is supported when `GOOGLE_CLIENT_ID` is configured.

## Profiles
- Signup profile-picture upload.
- Existing Profile picture upload/update remains available from Profile.
- Optional musician/artist name is stored on the account.

## Downloads
- Downloads page groups saved items into Movies, Music, Shorts and Videos.
- Direct media URLs can be passed to the browser download flow.
- Provider-hosted embeds such as YouTube are saved to the Downloads library for quick access, but ZenithMax does not bypass provider download restrictions.
