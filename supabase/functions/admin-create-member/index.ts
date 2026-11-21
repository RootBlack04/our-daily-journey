import { createClient } from 'npm:@supabase/supabase-js@2.119.1';
import { accountEmail, normalizeUsername, validatePassword } from '../_shared/validation.js';
import { jsonResponse, preflight, readBody, requiredEnv } from '../_shared/http.ts';
import { requireAdministrator } from '../_shared/clients.ts';

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return preflight(request);
  if (request.method !== 'POST') return jsonResponse(request, { error: 'Method not allowed.' }, 405);
  try {
    const { user: administrator, service, error: authError } = await requireAdministrator(request);
    if (authError || !administrator || !service) return jsonResponse(request, { error: authError ?? 'Administrator access is required.' }, 403);
    const body = await readBody(request);
    const username = normalizeUsername(body.username);
    const password = validatePassword(body.password);

    const [{ data: existing }, { data: membership }] = await Promise.all([
      service.from('user_accounts').select('user_id').eq('username', username).maybeSingle(),
      service.from('space_members').select('space_id,role').eq('user_id', administrator.id).maybeSingle(),
    ]);
    if (existing) return jsonResponse(request, { error: 'That username is already in use.' }, 409);
    if (!membership || membership.role !== 'owner') return jsonResponse(request, { error: 'Create your private space before adding a member.' }, 409);

    const { count, error: countError } = await service.from('space_members').select('user_id', { count: 'exact', head: true }).eq('space_id', membership.space_id);
    if (countError) return jsonResponse(request, { error: 'The space membership could not be checked.' }, 500);
    if ((count ?? 0) >= 2) return jsonResponse(request, { error: 'This space already has two members.' }, 409);

    const { data: created, error: createError } = await service.auth.admin.createUser({
      email: accountEmail(username),
      password,
      email_confirm: true,
      user_metadata: { display_name: username },
      app_metadata: { must_change_password: true },
    });
    if (createError || !created.user) {
      const duplicate = /already|exists|registered/i.test(createError?.message ?? '');
      return jsonResponse(request, { error: duplicate ? 'That username is already in use.' : 'The account could not be created. Check the password and try again.' }, duplicate ? 409 : 400);
    }

    const { error: registerError } = await service.rpc('admin_register_member', {
      p_admin_id: administrator.id,
      p_member_id: created.user.id,
      p_username: username,
    });
    if (registerError) {
      await service.auth.admin.deleteUser(created.user.id);
      const capacity = /two members|private space/i.test(registerError.message);
      const duplicate = registerError.code === '23505';
      return jsonResponse(request, { error: capacity ? registerError.message : duplicate ? 'That username is already in use.' : 'The account could not be added to this space.' }, capacity || duplicate ? 409 : 400);
    }
    // Do not return, log, or persist the temporary password.
    return jsonResponse(request, { created: true, username }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const validation = message.startsWith('Usernames must') || message.startsWith('Use 12–128') || message.startsWith('Enter a valid username');
    return jsonResponse(request, { error: validation ? message : 'The account could not be created. Try again.' }, validation ? 400 : 500);
  }
});
