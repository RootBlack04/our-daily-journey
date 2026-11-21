export function normalizeUsername(value) {
  if (typeof value !== 'string') throw new Error('Enter a valid username.');
  const username = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{2,29}$/.test(username)) throw new Error('Usernames must be 3–30 characters and use lowercase letters, numbers, underscores, or hyphens.');
  return username;
}

export function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128 ||
      !/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/[0-9]/.test(value) || !/[^A-Za-z0-9]/.test(value)) {
    throw new Error('Use 12–128 characters with at least one lowercase letter, uppercase letter, number, and symbol.');
  }
  return value;
}

export function accountEmail(username) {
  return `${normalizeUsername(username)}@accounts.ourdailyjourney.invalid`;
}

export function genericLoginError() {
  return 'Invalid username or password.';
}
