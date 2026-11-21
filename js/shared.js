export function showToast(message, kind = 'success') {
  const region = document.querySelector('#toast-region');
  if (!region) return;
  const toast = document.createElement('div'); toast.className = `toast ${kind === 'error' ? 'error' : ''}`; toast.textContent = message; region.append(toast);
  window.setTimeout(() => toast.remove(), 4200);
}
export function setText(element, value) { if (element) element.textContent = value ?? ''; }
export function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
export function safeError(error) {
  const message = String(error?.message || 'Something went wrong. Please try again.');
  if (/JWT|token|apikey|api key|authorization|password|secret/i.test(message)) return 'We could not complete that request. Check your account and project setup, then try again.';
  return message.length > 220 ? 'We could not complete that request. Please try again.' : message;
}
export function localDateForTimezone(date = new Date(), timezone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date); }
  catch { return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date); }
}
export function dateLabel(date, options = { weekday: 'long', month: 'long', day: 'numeric' }, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  // The date already represents the member's timezone-local calendar day.
  return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
}
export function relativeTime(value) {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
