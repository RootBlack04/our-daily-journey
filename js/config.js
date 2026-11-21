// These two values are public browser configuration. Never put a service role or secret key here.
export const SUPABASE_URL = "https://cgauzzabxtvvsbhybsxg.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable__qtThxNJV6F9tM222Xwztg_up2meXsn";
export const isConfigured = Boolean(
  SUPABASE_URL.trim() && SUPABASE_PUBLISHABLE_KEY.trim(),
);
