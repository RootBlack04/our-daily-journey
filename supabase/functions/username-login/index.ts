import { accountEmail, genericLoginError, normalizeUsername } from '../_shared/validation.js';
import { jsonResponse, preflight, readBody } from '../_shared/http.ts';
import { publicClient, serviceClient } from '../_shared/clients.ts';

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return preflight(request);
  if (request.method !== 'POST') return jsonResponse(request, { error: 'Method not allowed.' }, 405);
  try {
    const body = await readBody(request);
    const username = normalizeUsername(body.username);
    if (typeof body.password !== 'string' || body.password.length < 1 || body.password.length > 128) {
      return jsonResponse(request, { error: genericLoginError() }, 401);
    }

    const service = serviceClient();
    const { data: account, error: lookupError } = await service.from('user_accounts').select('user_id').eq('username', username).maybeSingle();
    if (lookupError) {
      // Do not turn a backend lookup failure into a fake "unknown username" result.
      // Log only a database error code; never log usernames, email addresses, or passwords.
      console.error('username-login mapping lookup failed', { code: lookupError.code ?? 'unknown' });
      return jsonResponse(request, { error: 'Sign-in could not be completed. Check the service setup and try again.' }, 503);
    }
    let email: string;
    if (account?.user_id) {
      const { data: authUser, error: authUserError } = await service.auth.admin.getUserById(account.user_id);
      if (authUserError || !authUser.user?.email) {
        console.error('username-login Auth account lookup failed', { code: authUserError?.code ?? 'missing_email' });
        return jsonResponse(request, { error: 'Sign-in could not be completed. Check the service setup and try again.' }, 503);
      }
      email = authUser.user.email;
    } else {
      // Make unknown usernames follow the same Auth password-check path without revealing mapping existence.
      email = `unknown-${crypto.randomUUID()}@accounts.ourdailyjourney.invalid`;
    }

    const { data, error } = await publicClient().auth.signInWithPassword({ email, password: body.password });
    if (error) {
      console.info('username-login Auth rejected credentials', {
        code: error.code ?? 'unknown',
        status: error.status ?? null,
        mappedAccountFound: Boolean(account?.user_id),
      });
    }
    if (error || !data.session || !account?.user_id) return jsonResponse(request, { error: genericLoginError() }, 401);
    return jsonResponse(request, {
      username,
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in: data.session.expires_in,
      token_type: data.session.token_type,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const status = message.startsWith('Usernames must') || message.startsWith('Enter a valid username') ? 400 : 500;
    return jsonResponse(request, { error: status === 400 ? message : 'Sign-in could not be completed. Try again.' }, status);
  }
});
