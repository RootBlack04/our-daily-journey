import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { dateLabel, localDateForTimezone, safeError } from '../js/shared.js';
import { accountEmail, normalizeUsername, validatePassword } from '../supabase/functions/_shared/validation.js';

const schema = await readFile(new URL('../supabase/migrations/202611180001_initial_schema.sql', import.meta.url), 'utf8');
const usernameSql = await readFile(new URL('../supabase/migrations/202611190001_username_admin_auth.sql', import.meta.url), 'utf8');
const edgeGrantSql = await readFile(new URL('../supabase/migrations/202611190002_edge_function_read_grants.sql', import.meta.url), 'utf8');
const auth = await readFile(new URL('../js/auth.js', import.meta.url), 'utf8');
const dashboard = await readFile(new URL('../js/dashboard.js', import.meta.url), 'utf8');
const config = await readFile(new URL('../js/config.js', import.meta.url), 'utf8');
const usernameLogin = await readFile(new URL('../supabase/functions/username-login/index.ts', import.meta.url), 'utf8');
const createMember = await readFile(new URL('../supabase/functions/admin-create-member/index.ts', import.meta.url), 'utf8');
const resetPassword = await readFile(new URL('../supabase/functions/admin-reset-member-password/index.ts', import.meta.url), 'utf8');
const changePassword = await readFile(new URL('../supabase/functions/change-password/index.ts', import.meta.url), 'utf8');

test('all application tables have row level security enabled', () => {
  const tables = ['profiles', 'spaces', 'space_members', 'daily_logs', 'daily_tasks', 'shared_notes', 'invite_tokens'];
  for (const table of tables) assert.match(schema, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
  for (const table of ['user_accounts', 'admin_accounts', 'account_setup_state']) assert.match(usernameSql, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
});

test('membership mutations are only through authenticated server functions', () => {
  assert.match(schema, /revoke all on function public\.create_space\(text\) from public, anon/i);
  assert.match(schema, /grant execute on function public\.create_space\(text\) to authenticated/i);
  assert.match(usernameSql, /revoke all on function public\.admin_register_member\(uuid, uuid, text\) from public, anon, authenticated/i);
  assert.match(usernameSql, /grant execute on function public\.admin_register_member\(uuid, uuid, text\) to service_role/i);
  assert.doesNotMatch(schema, /create policy[^;]+on public\.(?:spaces|space_members)[^;]+for\s+(?:insert|update|delete)/i);
  assert.match(usernameSql, /for update of s[\s\S]*?count\(\*\)[\s\S]*?>= 2/i);
});

test('Edge Functions have explicit read-only table grants for their service-role lookups', () => {
  assert.match(edgeGrantSql, /grant select on public\.user_accounts, public\.admin_accounts, public\.space_members to service_role/i);
  assert.doesNotMatch(edgeGrantSql, /grant\s+(?:all|insert|update|delete)/i);
  assert.match(usernameSql, /grant execute on function public\.admin_register_member\(uuid, uuid, text\) to service_role/i);
});

test('invite secrets are hashed, expiring, single use, and replacement links invalidate old ones', () => {
  assert.match(schema, /extensions\.digest\(v_token, 'sha256'\)/i);
  assert.match(schema, /expires_at <= now\(\)/i);
  assert.match(schema, /consumed_at is not null/i);
  assert.match(schema, /creating a replacement link invalidates/i);
  assert.match(schema, /update public\.invite_tokens set expires_at = now\(\)/i);
  assert.match(schema, /now\(\) \+ interval '7 days'/i);
});

test('owner and space identity are immutable on personal records', () => {
  assert.match(schema, /new\.user_id is distinct from old\.user_id or new\.space_id is distinct from old\.space_id/i);
  for (const table of ['daily_logs', 'daily_tasks', 'shared_notes']) assert.match(schema, new RegExp(`create trigger ${table}_membership before insert or update on public\\.${table}`, 'i'));
  assert.match(schema, /create policy "Users delete own logs"[\s\S]*?using \(user_id = \(select auth\.uid\(\)\)\)/i);
});

test('the browser has only a public key and login uses username without email sign-up', () => {
  assert.match(config, /SUPABASE_PUBLISHABLE_KEY\s*=/);
  assert.doesNotMatch(config + auth + dashboard, /service_role|secret_key/i);
  assert.match(auth, /functions\.invoke\('username-login'/);
  assert.match(auth, /auth\.setSession/);
  assert.doesNotMatch(auth, /signUp|signInWithPassword|email\.value|resetPasswordForEmail/i);
});

test('date-only labels stay stable and local day conversion respects timezone', () => {
  assert.equal(dateLabel('2026-01-01', { weekday: 'long', month: 'long', day: 'numeric' }, 'Pacific/Kiritimati'), 'Thursday, January 1');
  assert.equal(localDateForTimezone(new Date('2026-01-01T01:00:00Z'), 'America/Los_Angeles'), '2025-12-31');
});

test('auth errors do not reveal key or token values', () => {
  assert.equal(safeError(new Error('invalid JWT eyJhbGciOiJIUzI1NiJ9')), 'We could not complete that request. Check your account and project setup, then try again.');
});

test('local page links and module imports point to files that exist', async () => {
  for (const page of ['index.html', 'auth.html', 'dashboard.html', 'preview.html', 'privacy.html']) {
    const html = await readFile(new URL(`../${page}`, import.meta.url), 'utf8');
    const links = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((match) => match[1]);
    for (const href of links) {
      if (/^(?:https?:|mailto:|#|\?)/i.test(href)) continue;
      const path = href.split(/[?#]/, 1)[0];
      if (path) await access(new URL(`../${path.replace(/^\.\//, '')}`, import.meta.url));
    }
  }
  for (const modulePath of ['js/auth.js', 'js/dashboard.js', 'js/shared.js', 'js/supabase.js']) {
    const source = await readFile(new URL(`../${modulePath}`, import.meta.url), 'utf8');
    for (const [, specifier] of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const target = new URL(specifier, new URL(`../${modulePath}`, import.meta.url));
      await access(target);
    }
  }
});

test('all dashboard navigation tabs have a matching view', async () => {
  const html = await readFile(new URL('../dashboard.html', import.meta.url), 'utf8');
  for (const view of ['today', 'insights', 'settings', 'admin']) {
    assert.match(html, new RegExp(`data-view="${view}"`));
    assert.match(html, new RegExp(`id="view-${view}"`));
  }
});

test('the public preview is clearly illustrative, interactive, and disconnected from Supabase', async () => {
  const preview = await readFile(new URL('../preview.html', import.meta.url), 'utf8');
  assert.match(preview, /illustrative data only/i);
  assert.match(preview, /rootblack/);
  assert.match(preview, />Apex</);
  assert.match(preview, /data-range="month"/);
  assert.match(preview, /demo-tasks input/);
  assert.doesNotMatch(preview, /supabase\.co|createClient\(|functions\.invoke/);
  const script = preview.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'preview interaction script exists');
  assert.doesNotThrow(() => new Function(script), 'preview script parses');
});

test('server-side username and password validation reject invalid values', () => {
  assert.equal(normalizeUsername('  Sam_Journey '), 'sam_journey');
  assert.throws(() => normalizeUsername('a@b.com'));
  assert.throws(() => normalizeUsername('ab'));
  assert.equal(accountEmail('Sam_Journey'), 'sam_journey@accounts.ourdailyjourney.invalid');
  assert.equal(validatePassword('GoodPassword7!'), 'GoodPassword7!');
  for (const value of ['short1!', 'alllowercase123!', 'ALLUPPERCASE123!']) assert.throws(() => validatePassword(value));
});

test('account creation requires an administrator, checks duplicates, and never returns/logs a password', () => {
  assert.ok(createMember.indexOf('requireAdministrator(request)') < createMember.indexOf('auth.admin.createUser'));
  assert.match(createMember, /from\('user_accounts'\)\.select\('user_id'\)\.eq\('username', username\)/);
  assert.match(createMember, /rpc\('admin_register_member'/);
  assert.match(createMember, /auth\.admin\.deleteUser\(created\.user\.id\)/);
  assert.match(createMember, /Do not return, log, or persist the temporary password/i);
  assert.doesNotMatch(createMember, /console\.(?:log|info|debug)\s*\(/);
  assert.match(usernameSql, /username text not null unique/i);
  assert.match(usernameSql, /initial_admin_assigned = false/i);
});

test('username login rejects bad passwords generically and returns tokens only after Auth succeeds', async () => {
  assert.match(usernameLogin, /error: lookupError[\s\S]*?if \(lookupError\)[\s\S]*?503/);
  assert.match(usernameLogin, /mappedAccountFound: Boolean\(account\?\.user_id\)/);
  assert.doesNotMatch(usernameLogin, /console\.(?:log|info|debug|error)\([^\n]*(?:username|email|password)\s*[,}]/i);
  assert.match(usernameLogin, /signInWithPassword\(\{ email, password: body\.password \}\)/);
  assert.match(usernameLogin, /genericLoginError\(\)/);
  assert.ok(usernameLogin.indexOf('if (error || !data.session') < usernameLogin.indexOf('access_token: data.session.access_token'));
  assert.match(await readFile(new URL('../js/supabase.js', import.meta.url), 'utf8'), /persistSession: true/);
});

test('only the authenticated user can change their own password; admin reset is limited to the other space member', () => {
  assert.match(changePassword, /authenticatedUser\(request\)/);
  assert.match(changePassword, /updateUserById\(user\.id, \{[\s\S]*?password,[\s\S]*?must_change_password: false/);
  assert.doesNotMatch(changePassword, /body\.user_id/);
  assert.match(resetPassword, /requireAdministrator\(request\)/);
  assert.match(resetPassword, /memberMembership\.space_id !== adminMembership\.space_id/);
  assert.match(resetPassword, /\|\| isAdmin/);
  assert.match(resetPassword, /updateUserById\(memberId, \{[\s\S]*?password,[\s\S]*?must_change_password: true/);
});

test('member usernames are readable only by the account owner or their shared-space peer', () => {
  assert.match(usernameSql, /create policy "Members can read usernames in their space"[\s\S]*?public\.is_space_peer\(user_accounts\.user_id\)/i);
  assert.match(usernameSql, /revoke all on public\.user_accounts, public\.admin_accounts, public\.account_setup_state from anon, authenticated/i);
  assert.match(usernameSql, /grant select \(user_id, username, created_at\) on public\.user_accounts to authenticated/i);
});

test('dashboard hydrates both usernames after loading the full space membership list', () => {
  const membersAssignment = dashboard.indexOf('state.space = space; state.members = members || []');
  const nameHydration = dashboard.indexOf('await hydrateNames();', membersAssignment);
  const renderAfterHydration = dashboard.indexOf('renderAll();', membersAssignment);
  assert.ok(membersAssignment >= 0 && nameHydration > membersAssignment && renderAfterHydration > nameHydration);
});

test('settings offers Austin, Texas using its daylight-saving-aware IANA timezone', () => {
  assert.match(dashboard, /'America\/Chicago'/);
  assert.match(dashboard, /Austin, Texas \(Central Time\)/);
});

test('shared dashboard stats aggregate both members while streaks stay personal', () => {
  assert.match(dashboard, /const logs = state\.logs\.filter\(\(log\) => dates\.includes\(log\.log_date\)\)/);
  assert.match(dashboard, /new Set\(state\.logs\.filter\(\(log\) => log\.log_date === date\)\.map\(\(log\) => log\.user_id\)\)\.size/);
  assert.match(dashboard, /state\.logs\.filter\(\(log\) => log\.user_id === userId\)/);
});

