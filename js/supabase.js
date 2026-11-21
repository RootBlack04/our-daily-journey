import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.1/+esm';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, isConfigured } from './config.js';

let client;
export function getSupabase() {
  if (!isConfigured) throw new Error('Supabase is not configured yet. Add your project URL and publishable key in js/config.js.');
  if (!client) client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    global: { headers: { 'X-Client-Info': 'our-daily-journey-static/1.0' } }
  });
  return client;
}
export { isConfigured };
