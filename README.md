# Our Daily Journey

A private progress dashboard for exactly two people. The project uses vanilla HTML, CSS, and JavaScript, Supabase Auth/Postgres, Supabase Edge Functions, and GitHub Pages.

**This project is connected to an existing Supabase project. Do not create a replacement project or overwrite `js/config.js`.** The Supabase URL and publishable key already present there are public browser configuration. Passwords, account administration, and membership changes are handled on Supabase's server side.

## How username sign-in works

Supabase Auth's password sign-in endpoint expects an email or phone identifier. This app keeps the existing Supabase Auth accounts and provides a secure username front door:

- The administrator's existing Auth account is linked to a username once by the Supabase project owner.
- When the administrator creates a member, a server-side Edge Function creates a Supabase Auth user with a reserved, non-deliverable internal address. The member never enters an email address or phone number.
- A private username mapping connects the public username to the Auth user. The browser never reads the internal Auth email.
- Supabase Auth stores and verifies passwords. The app never stores plaintext passwords or custom password hashes.
- Newly created and reset member accounts must change the temporary password before leaving Settings.

The Auth provider still uses its email/password capability behind the server-side username layer. Keep that provider enabled, but turn off public sign-ups after the administrator is mapped.

## What is included

- Username/password login, persistent Supabase sessions, logout, and protected dashboard access.
- An administrator-only section to create the second account and reset that member's password.
- Strong temporary passwords generated in the administrator's browser, shown once after creation/reset, and cleared from the form. The server validates password strength again.
- A required member password change after creation/reset.
- Private two-person space, manual daily logs, sleep, step counts, learning and movement minutes, tasks, shared notes, weekly/monthly summaries, charts, and streaks.
- RLS on every application table, owner-only log/task/note mutations, and server-checked admin account/membership operations.
- GitHub Pages workflow. It deploys the static website; Edge Functions deploy to Supabase separately.

All step, sleep, learning, and movement values are entered by members. The app does not access Apple Health, GPS, camera, microphone, contacts, photos, or device files. It contains no analytics or visitor profiling.

## 1. Check the existing Supabase project

1. Sign in to the Supabase account that owns the project already configured in this repository.
2. Confirm that the project URL in `js/config.js` matches the project you intend to keep. Do not paste a secret key there. The existing `sb_publishable_...` key is meant for browser use.
3. In **Database → Tables**, check whether the app's core tables exist: `profiles`, `spaces`, `space_members`, `daily_logs`, `daily_tasks`, `shared_notes`, and `invite_tokens`.
4. If these tables do not exist (for example, SQL reports `relation "public.space_members" does not exist`), first apply the complete `supabase/migrations/202611180001_initial_schema.sql` in **SQL Editor → New query**. This creates the app tables and their initial security functions. If the tables already exist, **do not run the initial migration again**; it is not an upgrade migration and could fail or conflict with existing objects.
5. Once all core tables exist, continue to section 2 and apply `supabase/migrations/202611190001_username_admin_auth.sql`.

## 2. Apply the additive username/admin migration

This migration adds username mapping and admin authorization without deleting existing rows.

1. In the Supabase dashboard open **SQL Editor → New query**.
2. Open `supabase/migrations/202611190001_username_admin_auth.sql`, copy its full contents, paste it in the SQL Editor, and run it once.
3. Confirm the migration succeeds. It creates `user_accounts`, `admin_accounts`, and one-time setup state; enables RLS; restricts who can see username mappings; restricts space creation to the admin; and adds the server-only account registration function.
4. In **Database → Tables**, verify RLS is enabled for `user_accounts`, `admin_accounts`, and `account_setup_state` as well as the original app tables.
5. Apply `supabase/migrations/202611190002_edge_function_read_grants.sql` in SQL Editor as well. It grants the server-only Edge Functions read access to the account and membership tables they need. It does not grant browser write access.

Do not delete the original tables, change the ownership triggers, grant public writes, or disable RLS.

## 3. Link the administrator's existing account to a username

Do this as the Supabase project owner in SQL Editor. It is a one-time setup step; the public website does not offer administrator sign-up.

1. In **Authentication → Users**, identify the existing account that should administer the space. Copy its UUID. The email address stays in Supabase Auth and is not entered into the website login.
2. In **SQL Editor**, run this statement with that account's UUID and the username you want. Use 3–30 lowercase letters, numbers, `_`, or `-`:

   ```sql
   select public.bootstrap_initial_admin('EXISTING_AUTH_USER_UUID', 'admin_username');
   ```

3. The result should complete without an error. This function can run only once, is executable only by the database owner or service role, and creates the username mapping plus the admin authorization row.
4. If you do not already have an Auth user, create the initial administrator account in **Authentication → Users** as the project owner, then run the mapping statement above. This owner-only bootstrap is separate from the app's username login. No second user needs an email or phone.

If an existing second member already has an Auth account and data, map that account too instead of creating a duplicate. As the project owner, use its Auth UUID and a unique lowercase username:

```sql
insert into public.user_accounts(user_id, username, created_by)
values ('EXISTING_MEMBER_UUID', 'member_username', 'ADMIN_AUTH_USER_UUID');
update public.profiles set display_name = 'member_username'
where user_id = 'EXISTING_MEMBER_UUID';
```

This preserves the member's existing logs and tasks. If there are already two members in the space, the Admin section will let the administrator reset the mapped member's password, but it will correctly refuse to create a third account.

## 4. Close public account creation and set password policy

1. In Supabase **Authentication → Sign-in / Providers → Email**, leave the email/password provider enabled so Supabase Auth can verify passwords internally.
2. Turn off public email sign-ups. New member accounts are created by the administrator-only Edge Function using Supabase's Auth Admin API, not the public sign-up endpoint.
3. In **Authentication → Security and Protection → Password policy**, set the minimum to 12 characters and require lowercase, uppercase, numbers, and symbols. The Edge Functions enforce the same policy for member creation, resets, and self-service password changes.
4. Do not disable Auth password verification or remove the administrator's existing Auth account.

## 5. Configure and deploy Supabase Edge Functions

GitHub Pages cannot safely create Auth users because it cannot hold a service credential. These four functions must be deployed to the existing Supabase project:

- `username-login`: maps a username to its Auth account, checks the password with Supabase Auth, and returns a session only after a successful check.
- `admin-create-member`: verifies the caller's Auth session and admin record, validates the username/password, creates one Auth user, and adds it to the admin's space if a slot is available.
- `admin-reset-member-password`: lets the admin set a new temporary password only for the other member of the same space.
- `change-password`: lets the signed-in user change only their own password.

The functions read Supabase URL and API keys from the Edge Function environment. Current Supabase projects inject publishable/secret keys there; the code also supports legacy anon/service-role variables. The secret key remains only in Supabase's server environment. Supabase describes `auth.admin.createUser` as a server-only operation and warns never to expose the service-role key in browser code ([Auth Admin API](https://supabase.com/docs/reference/javascript/auth-admin-createuser), [Edge Function secrets](https://supabase.com/docs/guides/functions/secrets)).

### Allow your website origins

The functions check browser origins using the `APP_ORIGINS` environment variable.

1. For local development, include `http://localhost:8000`.
2. For GitHub Pages, include the origin `https://YOUR-GITHUB-NAME.github.io` (no repository path; browser Origin headers contain only scheme, host, and port).
3. In Supabase open **Edge Functions → Secrets** and set `APP_ORIGINS` to a comma-separated value, for example:

   ```text
   http://localhost:8000,https://YOUR-GITHUB-NAME.github.io
   ```

This value is not an API key. Do not add `SUPABASE_SECRET_KEYS`, `SUPABASE_SERVICE_ROLE_KEY`, or any secret to GitHub.

### Deploy the functions

1. Install Node.js 24 or newer and the Supabase CLI. The commands below use `npx` so you do not need to add the CLI to the project dependencies.
2. Open a terminal in this project folder and authenticate the CLI:

   ```powershell
   npx supabase login
   ```

3. Link the folder to the existing project. The project reference is the part before `.supabase.co` in the URL already in `js/config.js`:

   ```powershell
   npx supabase link --project-ref YOUR_PROJECT_REF
   ```

4. Deploy each function:

   ```powershell
   npx supabase functions deploy username-login
   npx supabase functions deploy admin-create-member
   npx supabase functions deploy admin-reset-member-password
   npx supabase functions deploy change-password
   ```

   `supabase/config.toml` disables the gateway's legacy JWT precheck so the functions can accept the project's newer publishable key. Each function then checks the actual user session itself; admin functions also check the admin table and space membership. Do not remove these checks. Supabase documents this configuration in its [Edge Function security guide](https://supabase.com/docs/guides/functions/auth).

5. In **Edge Functions**, confirm all four functions show as deployed. The username-login function is public by design, but it returns only generic invalid-login errors. Account creation, reset, and change functions require a valid user session; admin operations also require the server-side admin record.

If you later change the Supabase project, update the function deployment target through `supabase link`; do not replace the project's data or use a different project reference by accident.

## 6. Run and verify the app

Start a local static server from the project folder; opening `index.html` directly as a `file://` URL will not load JavaScript modules:

```powershell
python -m http.server 8000
```

Open `http://localhost:8000/`. The same deployed Edge Functions will accept the local origin only if it is included in `APP_ORIGINS`.

Run the local checks:

```powershell
npm run check
npm test
```

The tests cover input validation, username/password flow contracts, authorization checks, session persistence, RLS contract checks, ownership rules, and the two-member constraint. They do not contact your live Supabase project.

### Two-account live verification

1. Sign in as the administrator using the username mapped in step 3 and the password already associated with that Auth account.
2. If the administrator has no space, open **Settings → Create my space**.
3. Open **Admin** and enter a unique username. Use **Generate** for a strong temporary password or enter your own that meets the displayed rules.
4. Create the account. The temporary password appears only in the one-time success area for the administrator. Copy/share it privately, then hide it. The password is never returned from the server, logged, or saved by the website.
5. Open another browser profile or device. Sign in with the member username and temporary password. The member is required to change that password in Settings before using the rest of the dashboard.
6. Confirm the member can see shared progress, tasks, and notes; can edit/delete only their own logs and tasks; and can change their password without entering email or phone details.
7. As administrator, use **Admin → Reset password**. Confirm it works only for the other member in the same space. The member must change the reset password after signing in.
8. Confirm the Admin form rejects a duplicate username and refuses a third account. Try a wrong password and confirm login gives the same generic message for unknown usernames and incorrect passwords.

For extra RLS verification, use the two-account SQL checks from the migration/setup notes and test a non-member account. Do not test with a service key in the browser; service keys bypass RLS.

## 7. GitHub Pages deployment

The existing workflow `.github/workflows/pages.yml` runs checks and deploys static files from `main`. It does **not** deploy Supabase Edge Functions.

1. Create or sign in to a GitHub account at [github.com](https://github.com/).
2. On GitHub choose **New repository**. Give it a name such as `our-daily-journey`, choose **Private** or **Public**, and create it without a README, license, or `.gitignore` (the project already has these files).
3. Open PowerShell in this project folder. Initialize and push the project, replacing `YOUR-GITHUB-NAME` and `YOUR-REPOSITORY` with the values you chose:

   ```powershell
   git init
   git add .
   git commit -m "Create Our Daily Journey"
   git branch -M main
   git remote add origin https://github.com/YOUR-GITHUB-NAME/YOUR-REPOSITORY.git
   git push -u origin main
   ```

   GitHub may ask you to sign in in a browser. Never commit a Supabase secret key; the browser publishable key in `js/config.js` is public configuration and RLS protects database access.
4. In GitHub open **Settings → Pages** and choose **GitHub Actions** under **Build and deployment → Source**.
5. Check **Actions → Check and deploy to GitHub Pages**. The workflow must pass before deploy.
6. In Supabase **Authentication → URL Configuration**, set the Site URL to your repository's Pages address, such as `https://YOUR-GITHUB-NAME.github.io/YOUR-REPOSITORY/`.
7. Add the appropriate redirect URL for the site if any Supabase email-based administrator recovery flow uses a redirect. The second member does not use email recovery; the administrator resets their password from Admin.
8. Confirm the same site origin is in `APP_ORIGINS` and test username login on the published site.

All local asset links are relative, so the site works under a repository subpath. The site does not need GitHub Secrets. Supabase secrets stay in Supabase.

## Privacy, passwords, and account deletion

- The member-facing site does not request email or phone number. The administrator's pre-existing Auth email remains inside Supabase Auth and is not shown in the app. New member Auth users have a reserved non-deliverable internal address; it is not a contact address.
- Supabase Auth stores/verifies password credentials. `user_accounts` stores usernames and Auth user IDs only; no plaintext password or custom password hash is stored.
- Both members can read shared-space progress. Logs, tasks, and notes can only be changed/deleted by their author. Only the administrator can create/reset the other account.
- Temporary passwords are visible to the administrator once at creation/reset. If hidden or lost, the administrator can set a new temporary password. The previous password is never retrievable.
- To delete a member account, export any data they want to keep, then the Supabase project owner can open **Authentication → Users** and delete that Auth user. Cascades remove that user's profile, logs, tasks, notes, membership, and account mapping. The remaining member becomes space owner. If no members remain, the space is removed.
- Deleting the GitHub repository does not delete Supabase account or database data. Deleting the Supabase project removes the backend and its data.

## Project files

```text
index.html                       Landing page
auth.html                        Username/password login
dashboard.html                   Daily and admin dashboard
preview.html                     Read-only illustrative dashboard preview; no account or database connection
js/config.js                     Existing public Supabase URL/key
js/auth.js                       Username login and session setup
js/dashboard.js                  Shared progress and admin flows
supabase/migrations/             Existing schema + additive username migration
supabase/functions/              Server-side login/admin/password functions
supabase/config.toml             Edge Function gateway settings
tests/                            Local security-contract and validation tests
.github/workflows/pages.yml      Static site checks and deployment
privacy.html                     User-facing privacy notice
```

## Remaining manual work

The repository cannot apply SQL to your Supabase project or deploy Edge Functions without your Supabase CLI login and project-owner access. Complete the ordered steps above: run the additive migration, map the existing admin, set `APP_ORIGINS`, deploy the four functions, verify two accounts, then enable/confirm GitHub Pages. No live account creation is claimed until you complete that verification.
