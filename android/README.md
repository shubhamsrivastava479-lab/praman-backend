# Praman (Android app)

The whole Praman website inside an app, for everyone:

* **Customers**: open the app, tap **Join my verification call**, type the mobile number, enter the 6-digit code
  that comes on WhatsApp, and join the call waiting for them. Call links from WhatsApp also open straight in the app.
* **Team** (vendor admin, agent, insurer, viewer, Super Admin): tap **Team login** and log in with email + password
  (+ the email code). After that the app opens the right dashboard directly. Everything works as on the website.

What the app adds to the website:
* screen sharing during a live call (a phone browser cannot do this),
* saving reports and lists (PDF / CSV) to the phone's Downloads,
* choosing files to upload (Excel bulk upload, call recordings, documents),
* asking Android for camera, microphone and location only when a page needs them,
* links to other apps (WhatsApp, maps, email, phone) open in those apps; only Praman pages open inside.

The screens come from the server, so website updates appear in the app at once, without a new APK.
Google sign-in does not work inside apps (Google blocks it); team members who registered with Google use
**Forgot password?** once to set a password.

## Build the APK (no Android Studio needed)
1. Push this folder (`android/`) and `.github/workflows/android.yml` to GitHub.
2. GitHub → **Actions** → **Build Android app** → **Run workflow** (it also runs on every push that changes `android/`).
3. When it is green, open the run → **Artifacts** → download `praman-call-apk` → unzip → `app-debug.apk`.

## Give the app to people
* Copy `app-debug.apk` to `public/downloads/praman-call.apk` and push. Call pages offer it to Android users,
  and it can be shared as `https://pramanservices.space/downloads/praman-call.apk`.
* The phone must allow "Install unknown apps" once. For wide use, publish on Google Play (needs a release signing key
  and a Play developer account).

## WhatsApp code for customers
The code is sent from the firm's own WhatsApp number of the case. Inside WhatsApp's 24-hour window it goes as a
normal message. Outside it, an approved **Authentication** template is needed: create it in Meta WhatsApp Manager
(category Authentication, with a "Copy code" button) and put its name in Settings → "Login code template"
(default name `praman_login_code`).

## Settings
The server address is `BASE` in `MainActivity.kt`. Only pages of that site are ever opened inside the app.
