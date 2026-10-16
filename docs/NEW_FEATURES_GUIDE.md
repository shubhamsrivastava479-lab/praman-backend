# New features — how to use them

## For the company admin (Settings → "Automation & API")
- **Review and alerts**: keep "investigator must sign off" on. Set a *second reviewer* value (cases above it need two different people), ready remarks (one per line), an alert e-mail and the insurer's e-mail, and the WhatsApp thank-you switch. Upload your logo for the PDF cover. Press Save.
- **Checklist**: choose a service, untick optional questions, tick *Mandatory*, add your own questions (up to 15).
- **Your login: two-step code**: Set up → add the key in an authenticator app → enter the 6-digit code.
- **Customer data-deletion requests**: *Erase* removes files and personal details; *Decline* needs a reason.
- **Activity log**: who did what.

## Dashboard
- The 🔔 bell shows AI calls waiting for review, customers who asked for a person, overdue cases, second-review needs, deletion requests.
- *Team*: add an Agent, a Viewer (read-only) or an Insurer (finished reports only; they log in and land on a report list).
- *Performance*: "AI call quality" card (completion rate, call length, wait for sign-off, common flags).

## Reviewing a case
Open the report → pick a ready remark → give the final verdict → Save sign-off. **Download PDF** makes a server PDF with cover and logo; **E-mail PDF** sends it to the insurer (needs mail server, see `.env.example`).

## Customer call page
Options before starting: slower voice, larger text, always-visible typing box, camera/mic test. During the call: Pause, step counter, "Talk to a person" (highlighted when the AI has trouble hearing).

## Executive live call
**Captions** button shows the customer's speech as text with an English translation (not stored).

## Super Admin
AI usage (daily Gemini calls and failures); **Backups** (daily automatic, *Test* and *Restore*). Do one *Test* after R2 is set up.

## Not available yet
Android screen-share app — see `docs/ANDROID_APP.md`. Invoices and payments were not built.

## Screen-share check (claim investigations)
Open a claim case → **🖥️ Screen-share check**. Steps on one screen: open WhatsApp chat or a new Google Meet with the customer (invite message is prepared), start your screen recording, read the consent line, ask the customer to show the listed items (mark Shown / Refused / Not applicable), then upload the recording. It is saved through the existing call-recording upload: consent is required, the file gets a hash, the checklist is added to the report notes and the chain of custody, and anything the customer refused becomes a flag on the case. Not shown for policy verification cases. No extra cost.

## Praman logo
Files in `public/`: `logo.png` (full, with tagline), `logo-compact.png` (icon + name), `logo-mark.png` (icon only), `favicon.png`, `apple-touch-icon.png`. Used on the login and access pages, dashboards, customer pages, PDF report cover and footer, invoices and shared reports. To change the logo later, replace these files (same names).
