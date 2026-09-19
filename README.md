# Praman — Real Backend (Multi-tenant)

Every vendor company connects **their own** WhatsApp Business number from
their own dashboard — nobody shares your platform's number. One webhook URL
serves every vendor; Meta tells us which vendor a message belongs to.

## 1. Install & configure

```bash
cd praman-backend
npm install
cp .env.example .env
```

Fill in `.env` — these are **platform-level** settings only, not per-vendor:
- `JWT_SECRET` — any long random string (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
- `WHATSAPP_VERIFY_TOKEN` — any random string. **Every vendor will enter this
  exact same value** into their own Meta app's webhook config later — it
  just proves the endpoint is yours, it carries no vendor identity.
- `GEMINI_API_KEY` — from [Google AI Studio](https://aistudio.google.com/apikey)

## 2. Run it

```bash
npm start
```

## 3. How multi-tenant WhatsApp works

**You (the platform) do NOT need a WhatsApp Business account at all.** Each
vendor brings their own:

1. Vendor signs up, logs in (`/login.html`).
2. Vendor goes to **WhatsApp Connection** in the sidebar and creates their
   own Meta Developer App + WhatsApp product (same steps as before — Meta
   Business Account → developers.facebook.com/apps → Create App → add
   WhatsApp product → API Setup page gives them a token + phone number ID →
   App Settings → Basic gives them the app secret).
3. Vendor pastes their **Access Token**, **Phone Number ID**, and **App
   Secret** into the dashboard form and clicks **Verify & connect** — the
   backend calls Meta to confirm the credentials work, then stores them
   against that vendor's account (`POST /api/whatsapp-accounts`).
4. Vendor copies the **shared webhook URL** shown on that same page (it's
   the same URL for every vendor: `https://YOUR_DOMAIN/webhooks/whatsapp/webhook`)
   and pastes it into **their own** Meta app's webhook config, along with
   the shared `WHATSAPP_VERIFY_TOKEN` value.
5. When a message arrives, Meta's payload includes `phone_number_id` —
   `routes/whatsapp.js` looks up which vendor owns that number, validates
   the signature with **that vendor's** app secret, downloads the media with
   **that vendor's** token, and files the evidence only into **that
   vendor's** cases. Vendors never see each other's data.

A vendor with multiple WhatsApp numbers (e.g. separate numbers per region)
just connects more than one — the case-creation form lets them pick which
connected number a given case's field contact will message.

**24-hour rule still applies per vendor:** each vendor needs their own
approved message template to send the first message; free-form replies only
work within 24h of the participant's last message.

## 4. Media storage — where WhatsApp files, screenshots, and recordings go

By default, evidence files (WhatsApp photos/videos/voice notes) are saved to
**local disk** under `media/`, served at `/media/<filename>`. This is fine
for local testing, but:

- **Most hosting platforms (including Render's free tier) have ephemeral
  disks** — files can be wiped on every redeploy or restart. Fine for a demo,
  not for real evidence you need to keep.
- There's currently **no server-side recording of the live call/screen-share
  itself** — audio/video streams peer-to-peer between agent and participant
  browsers and are never saved to a file. Only the rolling ~4s audio chunks
  used for live captioning pass through the server (and aren't stored, just
  transcribed and discarded). If you need the call recorded end-to-end for
  the case file, that's an additional feature — see "Adding call recording"
  below.

**For real evidence storage, switch to S3-compatible object storage** (this
code already supports it — no extra library needed, uses signed HTTP
requests directly):

```
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com   # example: Cloudflare R2
S3_BUCKET=praman-evidence
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_REGION=auto
S3_PUBLIC_BASE_URL=https://evidence.yourdomain.com   # if you put a CDN/public bucket in front
```

Cloudflare R2 is a good default choice for this use case: S3-compatible API,
no egress fees, cheap storage — good fit for lots of photos/videos that get
viewed occasionally. AWS S3 or Backblaze B2 work identically since they all
speak the same signed-request protocol. Once these env vars are set,
`src/services/storage.js` automatically uploads there instead of local disk
— no other code changes needed.

**Recommended setup for production:**
- WhatsApp evidence (photos, docs, voice notes) → S3/R2, as above.
- Chain-of-custody + case metadata → currently `data/db.json` (fine to start,
  but move to Postgres once you have real volume — see technical spec).

### Adding call recording (not yet built)

If you want the full call (or just the shared screen) saved as a video file
per case, the cleanest approach is to have the **participant's browser**
record the composed stream with `MediaRecorder` and upload the resulting
blob to `POST /api/cases/:id/evidence` (a new endpoint you'd add) when the
call ends — same `storage.saveFile()` function handles it either way. Say
the word and I'll wire this up.

## 5. Deploy

Push to GitHub, deploy on Render/Railway/Fly with the same env vars as your
`.env` (minus any per-vendor WhatsApp values — those are entered by vendors
themselves in the dashboard, not set as server env vars).

## Data Security & Privacy

**What's currently in place:**
- Aadhaar/PAN/DL numbers are used only in-memory for the single verification
  API call. What gets saved to the database is redacted (`••••1234` style) —
  the full number is never stored, logged, or shown to a vendor/agent
  afterward. (Exception: motor-claim evidence photos of documents, e.g. an
  RC or DL uploaded via WhatsApp during a claim investigation, are kept
  un-redacted since the agent needs to read and cross-check those numbers as
  part of the actual fraud investigation — that's a deliberate, narrower
  exception, not a general one.)
- Public, unauthenticated endpoints (the participant verification wizard,
  shared report links) are rate-limited per IP to blunt brute-forcing a case
  ID or share token, and to stop someone running up your Gemini/Gridlines
  bill by hammering the endpoint.
- Every vendor's data is isolated (`vendorId` scoping on every query) —
  vendors and their agents can only ever see their own cases.
- Gemini/Gridlines/storage credentials are never exposed to vendors or
  agents in any API response, error message, or UI.
- Shared report links use long, random, unguessable tokens — not sequential
  IDs.
- Transport is HTTPS end-to-end once deployed on Render (or any host that
  terminates TLS for you).

**What's NOT yet in place — do this before handling real customer data at scale:**
- **Evidence storage**: by default, files sit on local disk, which most
  hosts (Render's free tier included) wipe on redeploy/restart. Connect S3/R2
  from the Super Admin dashboard (Settings → Evidence Storage) before going
  live with real cases.
- **Encryption at rest for uploaded files**: local disk and a plain S3/R2
  bucket are not encrypted by Praman itself. Use a bucket with
  server-side encryption enabled (R2 and S3 both support this as a bucket
  setting) rather than relying on the app layer for it.
- **Formal DPDP Act / IRDAI compliance review**: this codebase gives you the
  technical building blocks (data isolation, redaction, access logging via
  the chain-of-custody trail), but a compliance sign-off — data retention
  periods, a documented consent flow, a data-deletion process on request —
  needs a human (ideally legal counsel) review, not just code.
- **Data retention/deletion**: there's currently no automatic deletion of
  old case data. Decide a retention period and add a scheduled cleanup job
  once you know your compliance requirements.

## Security checklist before going live

- [ ] Lock down `/api/auth/signup` (currently open to anyone) — require an
      invite code or create vendor accounts manually
- [ ] Move media storage to S3/R2 (see above) so evidence survives restarts
- [ ] Move `data/db.json` to a real database once vendor count grows
- [ ] Confirm data residency/retention requirements (India's DPDP Act,
      IRDAI record-keeping norms) — this affects which cloud region you pick
      for both the server and S3 bucket
