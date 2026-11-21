import { validatePassword } from '../_shared/validation.js';
import { jsonResponse, preflight, readBody } from '../_shared/http.ts';
import { requireAdministrator, serviceClient } from '../_shared/clients.ts';

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return preflight(request);
  if (request.method !== 'POST') return jsonResponse(request, { error: 'Method not allowed.' }, 405);
  try {
    const { user: administrator, service, error: authError } = await requireAdministrator(request);
    if (authError || !administrator || !service) return jsonResponse(request, { error: authError ?? 'Administrator access is required.' }, 403);
    const body = await readBody(request);
    const memberId = typeof body.member_id === 'string' ? body.member_id : '';
    const password = validatePassword(body.password);
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(memberId) || memberId === administrator.id) {
      return jsonResponse(request, { error: 'Choose a valid member account.' }, 400);
    }
    const [{ data: adminMembership }, { data: memberMembership }, { data: isAdmin }] = await Promise.all([
      service.from('space_members').select('space_id,role').eq('user_id', administrator.id).maybeSingle(),
      service.from('space_members').select('space_id,user_id').eq('user_id', memberId).maybeSingle(),
      service.from('admin_accounts').select('user_id').eq('user_id', memberId).maybeSingle(),
    ]);
    if (!adminMembership || adminMembership.role !== 'owner' || !memberMembership || memberMembership.space_id !== adminMembership.space_id || isAdmin) {
      return jsonResponse(request, { error: 'You can only reset the password of the other member in your space.' }, 403);
    }
    const adminClient = serviceClient();
    const { data: existingUser, error: getUserError } = await adminClient.auth.admin.getUserById(memberId);
    if (getUserError || !existingUser.user) return jsonResponse(request, { error: 'The member account could not be found.' }, 404);
    const { error } = await adminClient.auth.admin.updateUserById(memberId, {
      password,
      app_metadata: { ...existingUser.user.app_metadata, must_change_password: true },
    });
    if (error) return jsonResponse(request, { error: 'The temporary password could not be set. Try again.' }, 400);
    const { data: account } = await service.from('user_accounts').select('username').eq('user_id', memberId).maybeSingle();
    return jsonResponse(request, { reset: true, username: account?.username ?? 'member' });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const validation = message.startsWith('Use 12–128');
    return jsonResponse(request, { error: validation ? message : 'The password could not be reset. Try again.' }, validation ? 400 : 500);
  }
});
