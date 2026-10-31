# Moving Praman to pramanservices.space

1. Render > praman-backend > Settings > Custom Domains > Add `pramanservices.space` and `www.pramanservices.space`.
2. At the domain seller (DNS): `A` record `@` -> the IP Render shows; `CNAME` `www` -> `praman-backend-vtbz.onrender.com`. Remove any other A / AAAA / parking records on `@` and `www`.
3. Wait for "Verified" and the certificate (usually 5-30 min, up to a few hours).
4. Render > Environment: `PUBLIC_BASE_URL=https://pramanservices.space` > Save (the service restarts).
5. Meta > WhatsApp > Configuration: Callback URL `https://pramanservices.space/webhooks/whatsapp/webhook` (same verify token) > Verify and save.
6. Meta app > Settings > Basic: App domains `pramanservices.space`. Website URL on the app / WABA profile: `https://pramanservices.space`.
7. Any API client of an insurer: change the base URL to `https://pramanservices.space/api/v1`.
8. Android app: push the code (GitHub Actions builds the APK) and put the new `praman-call.apk` in `public/downloads/`. The old address keeps working, so links already sent still open.

## Google sign-in
Google Cloud Console > APIs & Services > Credentials > the Web client > Authorised JavaScript origins: add `https://pramanservices.space` and `https://www.pramanservices.space` (keep the old Render address). OAuth consent screen > Authorised domains: add `pramanservices.space`.

## Email (demo form code and alerts)
Set `SMTP_URL` and `MAIL_FROM` on Render. Without them the demo form still works, but the email is not verified with a code. Demo requests are shown to the Super Admin under "Demo requests".

## Login email code, password reset, registration by email
- Every login (vendor, agent, insurer, Super Admin; password or Google) asks for a 6-digit code sent to the person's email, once `SMTP_URL` works. People who use an authenticator app are not asked twice.
- If email stops working and nobody can log in: on Render set `LOGIN_OTP=off`, save, and log in. Turn it back on after fixing email.
- "Forgot password?" on the home page works for every account except the Super Admin (the Super Admin keeps the setup-key reset).
- New firms can register with Google or with their official email (a code confirms the email, and they choose a password).
- The picture code (captcha) is built in. No outside service is needed.
