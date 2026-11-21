import { getSupabase, isConfigured } from './supabase.js';

const supabase = isConfigured ? getSupabase() : null;
const form = document.querySelector('#auth-form');
const usernameInput = document.querySelector('#username');
const passwordInput = document.querySelector('#password');
const errorEl = document.querySelector('#form-error');
const submit = document.querySelector('#submit-button');
const setupMessage = document.querySelector('#setup-message');

function setupHint() {
  setupMessage.hidden = false;
  setupMessage.innerHTML = '<strong>Sign-in setup is incomplete.</strong> Check the public Supabase settings in <code>js/config.js</code> and confirm the username login Edge Function is deployed. The browser key is public; the service role key belongs only in Supabase server secrets.';
  form.querySelectorAll('input,button').forEach((element) => { element.disabled = true; });
}

if (!isConfigured) setupHint();
else {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) location.replace('./dashboard.html');
  } catch { setupHint(); }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorEl.textContent = '';
  if (!isConfigured) { setupHint(); return; }

  const username = usernameInput.value.trim().toLowerCase();
  const password = passwordInput.value;
  if (!/^[a-z0-9][a-z0-9_-]{2,29}$/.test(username)) {
    errorEl.textContent = 'Use 3–30 characters: lowercase letters, numbers, underscores, or hyphens.';
    usernameInput.focus();
    return;
  }
  if (!password || password.length > 128) {
    errorEl.textContent = 'Enter your password.';
    passwordInput.focus();
    return;
  }

  submit.disabled = true;
  submit.textContent = 'Please wait…';
  try {
    const { data, error } = await supabase.functions.invoke('username-login', { body: { username, password } });
    if (error) {
      if (error.context instanceof Response) {
        const payload = await error.context.clone().json().catch(() => null);
        if (payload?.error === 'Invalid username or password.') throw new Error(payload.error);
      }
      throw new Error('The sign-in service is unavailable. Check the Edge Function deployment and try again.');
    }
    if (!data?.access_token || !data?.refresh_token) throw new Error('Invalid username or password.');
    const { error: sessionError } = await supabase.auth.setSession({ access_token: data.access_token, refresh_token: data.refresh_token });
    if (sessionError) throw new Error('The session could not be started. Try signing in again.');
    passwordInput.value = '';
    location.assign('./dashboard.html');
  } catch (error) {
    errorEl.textContent = error instanceof Error ? error.message : 'Sign-in could not be completed. Try again.';
  } finally {
    submit.disabled = false;
    submit.innerHTML = 'Log in <span aria-hidden="true">↗</span>';
  }
});
