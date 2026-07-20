# Privacy Policy — GoldRush (DRAFT — NOT LEGAL ADVICE, REQUIRES LAWYER REVIEW BEFORE PUBLISHING)

*Last updated: [DATE]*

This is a working draft to review with a qualified lawyer before publishing — not a
finished legal document. Bracketed items marked **[CONFIRM]** need a decision or a fact
check before this goes live.

---

## 1. Who we are

GoldRush (**goldrush.capital**) is operated by COTR Global Group Ltd, a company registered
in the United Kingdom **[CONFIRM: registration number, registered address — needed for a
real policy]**.

For any question about this policy or your personal data, contact:
**support@goldrush.capital**

**[CONFIRM]** Depending on where your users are located and your processing volume, UK
GDPR / EU GDPR may require you to designate a formal representative in the EU (since COTR
is UK-registered but you're based in Slovenia and serving EU users) — flag this specifically
to your lawyer, it's a common gap for UK companies serving EU customers post-Brexit.

## 2. What data we collect

| Data | When | Purpose |
|---|---|---|
| Email address | Waitlist signup | Notify you when GoldRush is available |
| Email address | Account creation (magic-link login) | Authenticate you, no password stored |
| Founder profile answers (expertise, distribution assets, capital availability, team size, geography) | Intake interview | Personalize your opportunity analysis |
| Vertical/business area you request an analysis for | Vertical-request submission | Run the analysis you're paying for |
| Payment details | Checkout | Processed entirely by Stripe — **we never see or store your card number** |

We do not collect health, biometric, or other special-category data. We do not knowingly
collect data from anyone under 18 **[CONFIRM this is actually your policy — if you serve
users under an EU member state's digital-consent age, e.g. under 16 in some countries,
that needs separate handling]**.

## 3. Why we process this data (legal basis)

- **Waitlist email, account email:** your consent (signing up) / contract necessity (to
  provide the service you're logging in for).
- **Founder profile + vertical-request data:** contract necessity — we can't generate your
  analysis without it.
- **Payment data:** contract necessity, handled by Stripe as our payment processor.

## 4. Who else sees your data (sub-processors)

We use the following third-party services to run GoldRush. Each only receives the data it
needs to do its specific job:

| Service | What it does | What it receives |
|---|---|---|
| Supabase | Authentication, database hosting | Your email, founder profile, account activity |
| Stripe | Payment processing | Payment details (never touches our servers) |
| NVIDIA (NIM hosted inference) | Runs the AI models that generate your analysis | Your founder profile + business evidence, as needed to generate output |
| Tavily | Web search used to gather market evidence | Search queries related to your requested vertical (not your personal identity) |
| Railway | Hosts our application servers | Data in transit/at rest as part of normal operation |
| Upstash | Redis caching | Short-lived operational data, not stored long-term |

**[CONFIRM]** Where each of these processors' servers are physically located matters for
international-transfer rules under GDPR (e.g. if NVIDIA's NIM inference runs on US
infrastructure, that's an international transfer needing a safeguard like Standard
Contractual Clauses). Get the actual data-residency info for NIM and Tavily specifically —
these are the two most likely to be US-hosted and least likely to have an EU-specific
data processing agreement already in place.

## 5. How long we keep your data

**[CONFIRM — not yet decided]** Suggested starting points to discuss:
- Waitlist emails you never converted to an account: consider a retention cap (e.g. 12
  months) with an easy unsubscribe.
- Account + founder profile data: kept while your account is active; a defined deletion
  window after account closure (e.g. 30-90 days) is standard practice.
- Payment records: Stripe/accounting-law retention requirements typically apply
  independently of your own policy (often 6-7 years in many jurisdictions for tax purposes)
  — confirm with an accountant, not just a lawyer.

## 6. Your rights

If you're in the UK or EU, you have the right to:
- **Access** the personal data we hold about you
- **Correct** inaccurate data
- **Delete** your data ("right to be forgotten"), subject to legal retention requirements
- **Export** your data in a portable format
- **Object** to certain processing
- **Withdraw consent** at any time (e.g. unsubscribe from the waitlist)

To exercise any of these rights, email **support@goldrush.capital**. We aim to respond
within [30 days — the standard GDPR response window; confirm this matches your actual
operational capacity].

## 7. Cookies

**[CONFIRM]** Document actual cookie/tracking usage once decided — currently the landing
page doesn't appear to set analytics/marketing cookies beyond what's needed for the
waitlist form and Supabase session cookies (strictly necessary, not requiring consent
banners under most interpretations — but confirm with your lawyer, especially if you add
analytics later).

## 8. AI-generated content disclosure

GoldRush uses AI systems to generate business opportunity analyses. See our separate
[AI Disclosure Notice] for details on how AI is used and what that means for the
recommendations you receive **[this is being drafted separately per EU AI Act Art. 50 —
link once ready]**.

## 9. Changes to this policy

We'll update this page when our practices change and note the date at the top. **[CONFIRM]**
Decide whether material changes get an email notice to existing users — common practice
and often expected for anything expanding how data is used.

## 10. Contact

**support@goldrush.capital**

**[CONFIRM]** If you're processing EU users' data at meaningful volume, you may need to
identify a supervisory authority (e.g. the ICO for UK, or an EU lead authority) — ask your
lawyer whether GoldRush's current scale requires this to be stated explicitly.
