# Moving Praman to pramanservices.space

1. Render > praman-backend > Settings > Custom Domains > Add `pramanservices.space` and `www.pramanservices.space`.
2. At the domain seller (DNS): `A` record `@` -> the IP Render shows; `CNAME` `www` -> `praman-backend-vtbz.onrender.com`. Remove any other A / AAAA / parking records on `@` and `www`.
3. Wait for "Verified" and the certificate (usually 5-30 min, up to a few hours).
4. Render > Environment: `PUBLIC_BASE_URL=https://pramanservices.space` > Save (the service restarts).
5. Meta > WhatsApp > Configuration: Callback URL `https://pramanservices.space/webhooks/whatsapp/webhook` (same verify token) > Verify and save.
6. Meta app > Settings > Basic: App domains `pramanservices.space`. Website URL on the app / WABA profile: `https://pramanservices.space`.
7. Any API client of an insurer: change the base URL to `https://pramanservices.space/api/v1`.
8. Android app: push the code (GitHub Actions builds the APK) and put the new `praman-call.apk` in `public/downloads/`. The old address keeps working, so links already sent still open.
