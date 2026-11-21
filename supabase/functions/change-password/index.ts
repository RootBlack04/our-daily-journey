import { validatePassword } from '../_shared/validation.js';
import { jsonResponse, preflight, readBody } from '../_shared/http.ts';
import { authenticatedUser, serviceClient } from '../_shared/clients.ts';

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return preflight(request);
  if (request.method !== 'POST') return jsonResponse(request, { error: 'Method not allowed.' }, 405);
  try {
    const { user, error: authError } = await authenticatedUser(request);
    if (!user) return jsonResponse(request, { error: authError ?? 'Authentication required.' }, 401);
    const body = await readBody(request);
    const password = validatePassword(body.password);
    const admin = serviceClient();
    const { data: existingUser, error: getUserError } = await admin.auth.admin.getUserById(user.id);
    if (getUserError || !existingUser.user) return jsonResponse(request, { error: 'The account could not be verified. Sign in again.' }, 401);
    const { error } = await admin.auth.admin.updateUserById(user.id, {
      password,
      app_metadata: { ...existingUser.user.app_metadata, must_change_password: false },
    });
    if (error) return jsonResponse(request, { error: 'The password could not be changed. Try again.' }, 400);
    return jsonResponse(request, { changed: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const validation = message.startsWith('Use 12–128');
    return jsonResponse(request, { error: validation ? message : 'The password could not be changed. Try again.' }, validation ? 400 : 500);
  }
});
