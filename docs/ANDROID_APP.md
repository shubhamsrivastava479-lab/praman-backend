# Android screen-share app — plan and status

**Status: NOT BUILT. Nothing in this document has been tested.** An Android app needs Android Studio,
a real phone and a Google Play account. None of that exists in the environment where this server code was
written, so only the server side was prepared. This file tells a developer exactly what to build.

## Why an app is needed

On a phone, Chrome and Safari cannot share the *screen* (`getDisplayMedia` is not available on mobile
browsers). The web page `live-join.html` therefore hides its "Share screen" button on phones. Screen sharing is
only useful to the firm when the customer must show something on their own phone, for example the WhatsApp
chat search for the claim investigation. A small Android app can do it with Android's MediaProjection.

The customer's *camera and voice* already work in the browser. The app is only needed for screen sharing.

## What the app does

1. Opens from the same link the customer already receives (`/live-join.html?t=<token>`), using an Android
   App Link, or lets the customer paste the link/token.
2. Asks for consent (what is shared, that the call is recorded) and Android's own screen-capture prompt.
3. Joins the **same call room** as the web page, so the firm's executive page (`live.html`) needs no change.
4. Sends the screen video (and the microphone) to the executive over WebRTC. Stops when the customer taps Stop
   or the executive ends the call.

## What the server already provides (nothing new is needed)

| Need | Existing piece |
|---|---|
| Room join | Socket.IO event `live-join` with `{ token }` (customer role). Acknowledgement `{ ok: true, role, peers }` or `{ error }`. |
| Network servers (TURN) | `GET /api/live/join/<token>/ice` returns `{ iceServers: [...] }`. |
| Signalling | Socket.IO `live-signal` with `{ sdp }` or `{ candidate }`. The customer side **creates the offer** when the executive joins (`live-peer` event with `event: 'joined'`) or sends `live-cmd` `{ type: 'reoffer' }`. |
| Status for the executive | Socket.IO `live-state` with `{ location, facing, sharing, language, at }`. Send `sharing: true` while sharing. |
| Consent and device record | `POST /api/live/join/<token>/joined` with the customer's consent, location and device details (see `public/live-join.html`). Call it once after joining. |
| Recording | Done in the executive's browser (it records the customer's video and both voices). Nothing to do in the app. |

The messages are exactly the ones used in `public/live-join.html` — read `startOffer()` and the
`live-signal` handler there; the app must behave the same way.

## Suggested build

- Kotlin, minSdk 26, `io.getstream:stream-webrtc-android` (maintained WebRTC build) and `io.socket:socket.io-client`.
- A foreground service of type `mediaProjection` (required by Android 10+), with a visible notification.
- `MediaProjectionManager.createScreenCaptureIntent()` → `ScreenCapturerAndroid` → `VideoTrack`; plus an audio track from the microphone.
- Permissions: `RECORD_AUDIO`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PROJECTION`, `POST_NOTIFICATIONS`, `INTERNET`.
- One screen, big buttons, Hindi + English text; same wording as the web page.

## Rules to respect (Google Play and privacy)

- Show a clear in-app disclosure *before* the screen-capture prompt: what is captured, who sees it, that it is recorded.
- Never capture in the background without the visible notification.
- Do not collect anything except what the call needs. Link to `/privacy.html` from the app.
- Play Store listing needs a privacy policy URL and the "screen capture" declaration.

## How to test (on a real phone — cannot be done without one)

1. Start a live call from the dashboard; copy the customer link.
2. Open it in the app on an Android phone on mobile data (not the office Wi-Fi) and on Wi-Fi.
3. Check: executive sees the phone screen within ~5 seconds; voice works both ways; stopping on the phone
   shows `sharing: false` on the executive page; ending from the executive closes the app session.
4. Repeat with the app in the background (WhatsApp open) — this is the real use case.
5. Test on at least Android 10, 12 and 14 (permissions differ).

## Effort (honest estimate)

A developer who has used WebRTC on Android: about 1–2 weeks for a working app, plus Play Store review.
Without WebRTC experience, plan for 3–4 weeks.

## Until then

Executives can ask the customer to **send screenshots on WhatsApp** (the AI call already does this for the
chat-search step), or run the live call from a laptop browser where screen sharing works.
