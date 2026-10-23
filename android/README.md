# Praman Call (Android)

A thin Android app. It opens the same live-call page as the browser (`/live-join.html`) and adds one thing a phone
browser cannot do: **screen sharing**. The screen is captured natively (Android's own permission dialog), sent to the page as
small pictures (about 4 a second), and the page turns them into the video track that replaces the camera, so the
executive's screen and the recording work exactly as for a desktop share.

## Build the APK (no Android Studio needed)
1. Push this folder (`android/`) and `.github/workflows/android.yml` to GitHub.
2. GitHub → **Actions** → **Build Android app** → **Run workflow** (it also runs on every push that changes `android/`).
3. When it is green, open the run → **Artifacts** → download `praman-call-apk` → unzip → `app-debug.apk`.

## Give the app to customers
* Copy `app-debug.apk` to `public/downloads/praman-call.apk`, push. The live-call page then offers the download to Android
  users who open the link in a browser.
* The customer must allow "Install unknown apps" once. For wide use, publish on Google Play (needs a release signing key).

## Settings
The server address is `BASE` in `MainActivity.kt`. Only pages of that site are ever opened.
