import { createClient } from 'npm:@supabase/supabase-js@2.119.1';
import { bearerToken, requiredEnv } from './http.ts';

function apiKey(modernName: string, legacyName: string): string {
  const modern = Deno.env.get(modernName);
  if (modern) {
    try {
      const keys = JSON.parse(modern) as Record<string, string>;
      if (typeof keys.default === 'string' && keys.default) return keys.default;
    } catch {
      if (modern.startsWith('sb_publishable_') || modern.startsWith('sb_secret_')) return modern;
    }
  }
  return requiredEnv(legacyName);
}

export function publicClient() {
  return createClient(requiredEnv('SUPABASE_URL'), apiKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export function serviceClient() {
  return createClient(requiredEnv('SUPABASE_URL'), apiKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export async function authenticatedUser(request: Request) {
  const token = bearerToken(request);
  if (!token) return { user: null, error: 'Authentication required.' };
  const { data, error } = await publicClient().auth.getUser(token);
  if (error || !data.user) return { user: null, error: 'Your session is invalid or has expired.' };
  return { user: data.user, error: null };
}

export async function requireAdministrator(request: Request) {
  const auth = await authenticatedUser(request);
  if (!auth.user) return { user: null, service: null, error: auth.error };
  const service = serviceClient();
  const { data, error } = await service.from('admin_accounts').select('user_id').eq('user_id', auth.user.id).maybeSingle();
  if (error || !data) return { user: null, service: null, error: 'Administrator access is required.' };
  return { user: auth.user, service, error: null };
}
