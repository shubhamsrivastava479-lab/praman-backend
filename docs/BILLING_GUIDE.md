# Billing guide (per case, subscription, or both)

All prices are set by Super Admin and can change any time. Nothing is fixed in the software.

## Where
- **Super Admin → 💰 Billing** (`/billing-admin.html`): firms and plans, invoices, payments, your invoice details, price calculator.
- **Company admin → Settings → Billing**: sees own plan, this month so far, invoices (PDF), amount due. Agents / viewers / insurers cannot see it.

## First-time setup
1. Billing page → *Your invoice details*: company name, GSTIN, state, bank / UPI, invoice prefix. Save.
2. *Firms & their plans* → **Set plan** for each firm: choose a model and fill prices.
3. After a month ends, drafts appear by themselves (or press *Make drafts*). Check, add a credit/charge if needed, **Issue**.
4. When money arrives: open the invoice → *Record a payment*.

## Models
| Model | What the firm pays each month |
|---|---|
| Pay per case | cases x price of each service (the "price per case" of the plan screen), optional minimum monthly charge |
| Subscription | fixed fee; cases included (empty = unlimited); extra cases at "price per extra case" |
| Subscription + per case | fee + (optional) included cases + every other case at its per-case price |

Extra options per firm: discount %, GST %, payment terms, billing start date, **free trial until** a date, count a case when *created* or *completed*, and **pause new cases after N days overdue**.

## Rules
- A case is billed once. When an invoice is issued its cases are stamped; cancelling the invoice frees them.
- *Waive* a case (test / duplicate / goodwill) with `POST /api/super-admin/billing/cases/:id/waive` before it is invoiced; after that use a credit adjustment.
- Months follow India time. GST: same state as you = CGST+SGST, otherwise IGST.
- Invoice numbers: `PRM/2026-27/0001` (new series every April).
- Issued invoices cannot be edited. Use *Cancel* (only if no payment) or a credit on the next invoice.
- Overdue invoices: firm gets a reminder in the bell (weekly). Optional pause on new cases.
- E-mail: with `SMTP_URL` set, issuing sends the PDF to the firm.
- Payments are recorded by hand. Online payment (Razorpay etc.) can be added later.

## Prepaid wallet
- Super Admin → Billing → **Wallets**: balances, "top-up requests waiting", add money, adjust (with reason), refund a charge, ledger.
- Turn it on per firm in **Set plan**: choose model *Prepaid wallet* (each report is deducted at the firm's price per case), or keep any other model and just tick *Wallet is on* so paid ID checks are deducted.
- **ID checks** (driving licence, Aadhaar send-OTP, Aadhaar verify-OTP, PAN) are deducted at the prices in *Your invoice details → Default price of each ID check*, or the firm's own price. If the provider call fails, the money is given back automatically. A price of 0 means free.
- GST % of the firm is added on every deduction (shown separately in the ledger CSV).
- A report is deducted when the case is *created* or *completed* (setting in the plan). Cases that cannot be paid wait and are paid as soon as money is added. New cases are refused when the balance is too low (the plan can allow a small negative balance; a free-trial date skips charging).
- Firm side: Settings → Wallet shows balance, prices, this month's spend, ledger (CSV), and "I have paid" (amount + UTR). Super Admin confirms with one click and the money is added.
- Low-balance alert goes to the bell at the amount you set.
- Keep your prices above your real cost per call. Ask your CA how GST is to be handled on advance top-ups; the ledger CSV has price, GST and total for every deduction.
