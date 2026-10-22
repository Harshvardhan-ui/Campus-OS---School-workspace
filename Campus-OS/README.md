# Campus OS — shared school workspace

Campus OS now has a database-backed Phase 1 application: real email/password sign-in, database-enforced Owner / School office / Student roles, a public admissions form, student records, roster import, attendance, class fee plans, fee approval requests, owner-controlled payment status, invoices, and an owner audit view. Student records are not preloaded.

## Project files

- `index.html` contains the private workspace layout, styling, and initial empty-state prototype; the persistence layer replaces its preview renderers when the page starts.
- `public.html` contains the public school website and enquiry form.
- `app-persistence.js` connects sign-in, role-aware views, shared reads/writes, realtime updates, and local read-only demo sessions.
- `campus-config.js` contains browser-safe Supabase project values. It must never contain a service-role key or database password.
- `supabase/migrations/202610190001_campus_schema.sql` defines the tables, helper functions, audit triggers, fee workflows, and row-level security policies.
- `supabase/functions/` contains the trusted account-invitation and public-admission handlers; `supabase/config.toml` controls their local CLI settings.
- `sw.js` caches only the static application shell; `icon.svg` is the app icon.
- `manifest.webmanifest` supplies the installable app's name, start URL, colors, and icon. It is JSON, so comments cannot be added without making it invalid; this file map documents its purpose instead.

Source files include comments for their runtime flow, security boundaries, and data responsibilities. `README.md` and `HOW_TO_RUN.txt` are already explanatory documents rather than source code. JSON is kept valid because its format has no comment syntax.

## Important before using real records

The school must own and configure its Supabase project and hosting account. Localhost preview includes three read-only role demos, whether or not a project is configured; they are not real Supabase accounts and cannot save records. Real sign-in and shared data use the configured Supabase project. Do not enter live student information before the school has checked its database and access rules. The browser uses only Supabase's publishable key; never place the service-role key in this folder.

## Shared data and account roles

The Supabase project is the shared source of truth. A student, office user and owner who sign in to the same deployed app read and write authorized rows from the same Postgres database. A refresh or sign-in from another device fetches the saved database records. Realtime changes refresh open workspaces when the Supabase realtime publication is available. The only browser-local values are the public project connection settings and the authentication session token; student, guardian, enquiry, attendance, fee and school-setting records are not stored in local storage or cached by the service worker.

- **Owner:** school identity, classes and fee structures, user access, audit history, and payment-status decisions.
- **School office:** student entry/import, admissions, attendance, parent fee-contact records, and requests to verify a payment. The database denies office updates to fee payment status.
- **Student:** only the linked student record, that record's attendance, and that student's fee schedule.
- **Public visitors:** can read the public school identity and submit an enquiry. They cannot read admissions or student records. The public form submits through a server-side function with a honeypot and per-IP rate limit.

## Configure the shared backend

1. Create a Supabase project in an appropriate region. Keep the project, domain, source repository and credentials in school-owned accounts. Enable email/password authentication and configure a school-controlled SMTP provider before inviting families or staff. In Authentication → URL Configuration, set the production Site URL and allow the exact local and production redirect URLs used by the app (for example `http://localhost:8000/**` and `https://your-school-domain.example/**`). Supabase invitation redirects must be on this allow-list.
2. In the Supabase SQL Editor, run [`supabase/migrations/202610190001_campus_schema.sql`](./supabase/migrations/202610190001_campus_schema.sql) once. It creates the tables, role policies, audit triggers and owner-only fee functions. Confirm the `public` schema is exposed to the Data API and that `supabase_realtime` is enabled for the listed tables.
3. Create the first Owner user in **Authentication → Users**. Then run this query in SQL Editor after replacing the email and name:

   ```sql
   update public.profiles p
   set role = 'owner', display_name = 'School Owner'
   from auth.users u
   where p.id = u.id and lower(u.email) = lower('owner@your-school.example');
   ```

   The new-user trigger creates a profile as `unassigned`; it deliberately does not trust a role submitted by a browser.
4. Install/link the Supabase CLI and deploy both server-side functions from this folder:

   ```powershell
   supabase login
   supabase link --project-ref YOUR_PROJECT_REF
   supabase secrets set CAMPUS_ALLOWED_ORIGIN=https://your-school-domain.example,http://localhost:8000,http://127.0.0.1:5500 ADMISSION_RATE_SALT=USE_A_LONG_RANDOM_SECRET
   supabase functions deploy submit-admission
   supabase functions deploy invite-campus-user
   ```

   `CAMPUS_ALLOWED_ORIGIN` accepts a comma-separated list of exact origins; include the local preview origin while testing and the production origin for the live site. `submit-admission` permits public submissions, throttles repeated submissions, and keeps its database service key server-side. `invite-campus-user` verifies a signed-in Owner before using the service key. Remove local preview origins from the allow-list before launch if they are no longer needed.
5. Open [`campus-config.js`](./campus-config.js) and set the project URL and publishable key shown in Supabase **Project Settings → API**:

   ```js
   window.CAMPUS_CONFIG = {
     supabaseUrl: "https://YOUR_PROJECT_REF.supabase.co",
     publishableKey: "sb_publishable_..."
   };
   ```

   These browser values are public by design. Do not put `service_role`, a database password, or SMTP credentials in this file. Keep the same configuration in every deployment of the website.
6. Deploy the complete `campus-os` folder to the school-owned HTTPS host, with `index.html` at the app root and `public.html` publicly reachable. The school website and workspace live in the same deployment; the public admissions form writes into the same protected database.
7. Sign in as Owner, save school address/contact/invoice information, add **every grade, section and academic year**, and set class fee amounts and late fees. Use **Users & access** to invite office users and students. The new office user opens the secure invitation email, creates a password, then returns to the sign-in page and chooses **School office**. There is no public self-registration. For student invitations, first add the student record and link that exact record; the student also sets a password from the invitation.
8. Verify the first student and enquiry with non-sensitive test data. Then review the owner audit page, office fee-request denial, cross-device refresh, invitation email, backup/restore and invoice printing before moving real records.

## School workflows

- **Admissions:** `public.html` gathers student, grade, guardian, contact, previous school, address and family message. The office opens the student's name to see the full enquiry, changes its stage and saves private office notes.
- **1,000–10,000 students:** use the roster CSV template. The browser validates the preview; the RPC imports the complete roster in one transaction so duplicate IDs roll back the import rather than leave a partial roster. Individual records remain available in the school form.
- **Attendance:** choose a class/section, mark each student, then save the date's register. Only the school team can write attendance.
- **Fees:** the Owner configures grades, sections, annual fee and late fee, then generates each installment for the matching roster. The office logs parent contact, reason, method and promised date and can submit a payment request. Only the Owner can approve and mark an account Paid or change its fee status. Paid accounts have a receipt number and can be opened in a print dialog and saved as PDF. Add school details and invoice wording before issuing receipts.
- **Audit:** the Owner can see actor, timestamp, record and changed field names. The audit table intentionally does not duplicate student/guardian values.

## Invitation troubleshooting

- If the browser says it could not reach `invite-campus-user`, deploy it with `supabase functions deploy invite-campus-user` and check that `CAMPUS_ALLOWED_ORIGIN` includes the exact origin in the browser address bar. Multiple origins are comma-separated, without spaces.
- Add the invitation callback URL to Supabase Authentication → URL Configuration as well. The Edge Function redirects to `/index.html`; an allow-list entry such as `https://your-school-domain.example/**` covers it. Supabase requires redirect targets to be allow-listed. [Supabase redirect URL docs](https://supabase.com/docs/guides/auth/redirect-urls)
- If the function returns an HTTP error, the app now shows its response message. Check Supabase Dashboard → Edge Functions → `invite-campus-user` → Logs for the matching request. Confirm you are signed in with an Owner account and that email delivery is configured.

## Current scope and launch gates

This is a focused school-owned Phase 1 foundation, not a finished all-in-one school ERP. Public content editing is text-based; uploaded photo galleries, attendance-photo OCR, online fee collection, SMS/WhatsApp delivery, parent/sibling accounts, staff/teacher modules, grades/exams, transport, library, 2FA, mobile apps, multi-branch tenancy and automated backup/restore testing still need separately scoped work. For large rosters, a checked CSV export is the recommended starting point; handwriting OCR is not enabled because a misread student or mark can create a dangerous attendance record.

Before a public launch, the school and its chosen deployment partner still need to configure production SMTP and domain allow-lists; establish automated backups and rehearse restore; review data-retention and child-privacy requirements for the school's jurisdiction; test Owner/office/student accounts; verify rate limits, account recovery and emergency access; and conduct a security review. No real school account, database project, cost quote or deployment has been provided or created in this workspace, and no records were sent to Parihar Technologies.

## Local preview

Serve over HTTP rather than opening from `file://` so browser modules and the service worker can load:

```powershell
py -m http.server 8000 --directory outputs/campus-os
```

Open `http://localhost:8000`. The sign-in page offers local demo accounts for Owner, School office and Student on localhost or 127.0.0.1. They are read-only and seed no student records. For shared sign-in and persistent data, use real Supabase accounts. Demo credentials are listed in [`HOW_TO_RUN.txt`](./HOW_TO_RUN.txt).
