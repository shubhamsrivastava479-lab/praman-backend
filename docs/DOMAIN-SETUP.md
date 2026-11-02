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

## Website pages for Google (SEO)

The public pages are made from `scripts/site-content.js`:
`/` (home), `/instant-checks`, `/industries/<name>`, `/sitemap.xml`, `/robots.txt`.
To change the text, edit `scripts/site-content.js`, then run `node scripts/build-site-pages.js` and push.
App pages (dashboard, admin, customer call links) are blocked for search engines in `robots.txt`.

Google Search Console: add the domain `pramanservices.space`, verify with the DNS TXT record Google gives
(add it at your domain registrar), then in Sitemaps submit `https://pramanservices.space/sitemap.xml`.

## SatyaSakshi Praman consumer app (B2C)

Super Admin → "SatyaSakshi Praman app (B2C)":
1. Choose the WhatsApp number that sends login codes and call links (your own SatyaSakshi number, connected under a vendor account).
2. Set a price (GST included) for each package you want to sell. A package without a price shows "Coming soon".
3. Razorpay: Key ID and Key Secret from Razorpay Dashboard → Account & Settings → API Keys. Add a webhook with the URL shown
   on the card, event `payment.captured`, and paste its secret.
4. Team login: an email and password for the "SatyaSakshi Praman (consumer app)" account. Log in with it on the website to
   review person checks (they arrive as cases, service "Consumer app").
5. Test mode lets you order packages that have no price, for free, while you try the flow.
