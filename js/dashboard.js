import { getSupabase, isConfigured } from './supabase.js';
import { dateLabel, escapeHtml, localDateForTimezone, relativeTime, safeError, setText, showToast } from './shared.js';

const $ = (selector) => document.querySelector(selector);
const loading = $('#dashboard-loading');
const content = $('#dashboard-content');
const setup = $('#dashboard-setup');
const state = { supabase: null, user: null, profile: null, isAdmin: false, mustChangePassword: false, usernames: {}, profiles: {}, space: null, members: [], logs: [], tasks: [], notes: [], range: 'week', today: '' };
const numberFormat = new Intl.NumberFormat('en-US');
function showSetup() {
  loading.hidden = true; content.hidden = false;
  setup.hidden = false;
  setup.innerHTML = '<strong>Connect your private space.</strong> Add your Supabase project URL and publishable key in <code>js/config.js</code>, then follow the setup steps in <code>README.md</code>. These browser values are public; row level security protects your data.';
}
function toggleLoading(active) { loading.hidden = !active; content.hidden = active; }
async function ensureOk(result) { if (result.error) throw result.error; return result.data; }
async function refresh() {
  const { data: adminFlag, error: adminError } = await state.supabase.rpc('current_user_is_admin');
  if (adminError) throw adminError;
  state.isAdmin = Boolean(adminFlag);
  const { data: profile } = await state.supabase.from('profiles').select('user_id,display_name,timezone').eq('user_id', state.user.id).maybeSingle();
  state.profile = profile || { user_id: state.user.id, display_name: 'Member', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  state.today = localDateForTimezone(new Date(), state.profile.timezone);
  const { data: memberships, error: memberError } = await state.supabase.from('space_members').select('space_id,user_id,role,joined_at').eq('user_id', state.user.id);
  if (memberError) throw memberError;
  state.members = memberships || [];
  await hydrateNames();
  state.space = null; state.logs = []; state.tasks = []; state.notes = [];
  if (state.members.length) {
    const spaceId = state.members[0].space_id;
    const taskDates = [...new Set(state.members.map((member) => localDateForTimezone(new Date(), state.profiles[member.user_id]?.timezone || state.profile.timezone)))];
    const [{ data: space, error: spaceError }, { data: members, error: membersError }, { data: logs, error: logsError }, { data: tasks, error: tasksError }, { data: notes, error: notesError }] = await Promise.all([
      state.supabase.from('spaces').select('id,name,created_by').eq('id', spaceId).single(),
      state.supabase.from('space_members').select('space_id,user_id,role,joined_at').eq('space_id', spaceId),
      state.supabase.from('daily_logs').select('*').eq('space_id', spaceId).gte('log_date', dateOffset(state.today, -370)).order('log_date', { ascending: false }).limit(800),
      state.supabase.from('daily_tasks').select('*').eq('space_id', spaceId).in('task_date', taskDates).order('created_at'),
      state.supabase.from('shared_notes').select('*').eq('space_id', spaceId).order('created_at', { ascending: false }).limit(30)
    ]);
    const queryError = spaceError || membersError || logsError || tasksError || notesError;
    if (queryError) throw queryError;
    state.space = space; state.members = members || []; state.logs = logs || []; state.tasks = tasks || []; state.notes = notes || [];
    // The first hydration happens before the full space membership list is loaded.
    // Re-fetch names now so the partner's username is available to every view.
    await hydrateNames();
  }
  renderAll();
}
async function hydrateNames() {
  const ids = [...new Set([state.user.id, ...state.members.map((member) => member.user_id)])];
  const [{ data: profiles, error: profileError }, { data: accounts, error: accountError }] = await Promise.all([
    state.supabase.from('profiles').select('user_id,display_name,timezone').in('user_id', ids),
    state.supabase.from('user_accounts').select('user_id,username').in('user_id', ids),
  ]);
  if (profileError || accountError) throw profileError || accountError;
  state.profiles = Object.fromEntries((profiles || []).map((profile) => [profile.user_id, profile]));
  state.usernames = Object.fromEntries((accounts || []).map((account) => [account.user_id, account.username]));
}
function dateOffset(date, amount) { const parsed = new Date(`${date}T12:00:00Z`); parsed.setUTCDate(parsed.getUTCDate() + amount); return parsed.toISOString().slice(0, 10); }
function displayName(id) { return state.usernames?.[id] || 'Username not set'; }
function isOwner() { return state.members.some((member) => member.user_id === state.user.id && member.role === 'owner'); }
function renderAll() { setup.hidden = true; renderHeader(); renderToday(); renderTodayStats(); renderTasks(); renderNotes(); renderActivity(); renderSettings(); renderInsights(); renderAdmin(); }
function renderHeader() {
  const username = displayName(state.user.id);
  setText($('#account-name'), username); setText($('#account-menu'), username.slice(0, 1).toUpperCase());
  $('#admin-nav-tab').hidden = !state.isAdmin;
  document.querySelectorAll('.nav-tab').forEach((button) => { if (state.mustChangePassword) button.hidden = button.dataset.view !== 'settings'; else button.hidden = button.dataset.view === 'admin' && !state.isAdmin; });
  $('#password-change-required').hidden = !state.mustChangePassword;
  if (state.mustChangePassword) {
    document.querySelectorAll('.nav-tab').forEach((button) => button.classList.toggle('active', button.dataset.view === 'settings'));
    document.querySelectorAll('.dashboard-view').forEach((view) => { view.hidden = view.id !== 'view-settings'; });
  }
  const formatted = dateLabel(state.today, { weekday: 'long', month: 'long', day: 'numeric' }, state.profile.timezone);
  setText($('#today-date'), formatted.toUpperCase()); setText($('#welcome-title'), state.space ? 'One day at a time.' : `Hello, ${username}.`);
  setText($('#welcome-subtitle'), state.space ? 'A little progress, shared with care.' : state.isAdmin ? 'Create a private space for your daily journey.' : 'Ask your administrator to set up your private space.');
  $('#invite-card').hidden = !state.isAdmin || state.members.length >= 2;
  $('#invite-card .invite-copy strong').textContent = state.space ? 'Your space is ready for one more.' : 'Your private space starts here.';
  $('#invite-card .invite-copy span').textContent = state.space ? 'Create the second member account from Admin.' : 'Create the space, then set up the second member from Admin.';
  $('#create-space-button').textContent = state.space ? 'Manage members' : 'Set up your space';
  $('#member-grid').innerHTML = state.members.map((member, index) => `<div class="member-card"><span class="member-avatar ${index ? 'partner' : ''}">${escapeHtml(displayName(member.user_id).slice(0,1).toUpperCase())}</span><span class="member-info"><strong>${escapeHtml(displayName(member.user_id))}${member.user_id === state.user.id ? ' · You' : ''}</strong><span>${member.role === 'owner' ? 'Administrator' : 'Member'} · Active</span></span><span class="member-progress">${state.logs.filter((log) => log.user_id === member.user_id).length} entries</span></div>`).join('');
}
function renderToday() {
  $('#log-today-button').disabled = !state.space;
  $('#add-task-button').disabled = !state.space;
  $('#note-input').disabled = !state.space;
  $('#note-form').querySelector('button[type="submit"]').disabled = !state.space;
  const myLog = state.logs.find((log) => log.user_id === state.user.id && log.log_date === state.today);
  const summary = $('#log-summary');
  if (myLog) {
    const metrics = metricParts(myLog);
    summary.innerHTML = `<div class="saved-log"><div class="saved-log-date">${escapeHtml(dateLabel(myLog.log_date, { month:'long', day:'numeric' }, state.profile.timezone))} <span class="manual-badge">MANUALLY ENTERED</span></div>${myLog.activity_note ? `<p class="saved-note">${escapeHtml(myLog.activity_note)}</p>` : '<p class="saved-note muted">No note added for this day.</p>'}<div class="activity-metrics">${metrics || 'No activity details recorded'}</div></div>`;
    $('#edit-log-button').setAttribute('aria-label', 'Edit today\'s log'); $('#edit-log-button').textContent = '✎';
  } else {
    summary.innerHTML = '<span class="empty-icon">✳</span><strong>A fresh page</strong><p>Add a little note about how today went.</p><button class="text-button" data-open-log type="button">Add today\'s log <span aria-hidden="true">↗</span></button>';
    $('#edit-log-button').setAttribute('aria-label', 'Add today\'s log'); $('#edit-log-button').textContent = '＋';
  }
}
function renderTodayStats() {
  const container = $('#today-shared-stats');
  container.hidden = !state.space;
  if (!state.space) { container.replaceChildren(); return; }
  const todayLogs = state.logs.filter((log) => log.log_date === state.today);
  const loggedMembers = new Set(todayLogs.map((log) => log.user_id)).size;
  const numericEntries = (key) => todayLogs.filter((log) => log[key] != null).map((log) => Number(log[key]));
  const sleepEntries = numericEntries('sleep_hours');
  const averageSleep = sleepEntries.length ? `${(sleepEntries.reduce((total, value) => total + value, 0) / sleepEntries.length).toFixed(1)}h` : '—';
  const sumValue = (key, suffix = '') => { const values = numericEntries(key); return values.length ? `${numberFormat.format(values.reduce((total, value) => total + value, 0))}${suffix}` : '—'; };
  const cards = [
    ['CHECK-INS · SHARED', `${loggedMembers} / ${state.members.length}`, 'members logged today'],
    ['SLEEP · AVERAGE', averageSleep, sleepEntries.length ? 'across entries today' : 'no sleep entry today'],
    ['STEPS · SHARED', sumValue('step_count'), 'manually entered today'],
    ['LEARNING · SHARED', sumValue('learning_minutes', ' min'), 'combined minutes today'],
    ['MOVEMENT · SHARED', sumValue('workout_minutes', ' min'), 'combined minutes today'],
  ];
  container.innerHTML = cards.map(([label, value, foot]) => `<article class="stat-card"><span class="stat-label">${escapeHtml(label)}</span><div class="stat-value">${escapeHtml(value)}</div><div class="stat-foot">${escapeHtml(foot)}</div></article>`).join('');
}
function metricParts(log) { return [log.sleep_hours != null && `☾ ${Number(log.sleep_hours)}h sleep`, log.step_count != null && `↗ ${numberFormat.format(log.step_count)} steps`, log.learning_minutes != null && `▤ ${log.learning_minutes} min learning`, log.workout_minutes != null && `◌ ${log.workout_minutes} min movement`].filter(Boolean).map((value) => `<span>${escapeHtml(value)}</span>`).join(''); }
function renderTasks() {
  const list = $('#task-list');
  list.innerHTML = state.tasks.map((task) => `<li class="task-row ${task.is_complete ? 'completed' : ''}"><input type="checkbox" data-task-toggle="${task.id}" aria-label="${task.is_complete ? 'Mark incomplete' : 'Mark complete'}: ${escapeHtml(task.title)}" ${task.is_complete ? 'checked' : ''} ${task.user_id === state.user.id ? '' : 'disabled'}><span class="task-title">${escapeHtml(task.title)}</span>${task.user_id !== state.user.id ? `<span class="task-owner">${escapeHtml(displayName(task.user_id))} · ${escapeHtml(dateLabel(task.task_date,{month:'short',day:'numeric'},state.profile.timezone))}</span>` : `<button class="task-delete" data-task-delete="${task.id}" aria-label="Delete task: ${escapeHtml(task.title)}" type="button">×</button>`}</li>`).join('');
  $('#task-empty').classList.toggle('visible', state.tasks.length === 0);
}
function renderNotes() {
  $('#note-count').textContent = String(state.notes.length);
  $('#notes-list').innerHTML = state.notes.map((note) => `<article class="note-entry"><span class="note-entry-avatar">${escapeHtml(displayName(note.user_id).slice(0,1).toUpperCase())}</span><div class="note-entry-body"><div class="note-entry-head"><strong>${escapeHtml(displayName(note.user_id))}</strong><time>${escapeHtml(relativeTime(note.created_at))}</time>${note.user_id === state.user.id ? `<button class="note-delete" type="button" data-note-delete="${note.id}" aria-label="Delete your note">×</button>` : ''}</div><p>${escapeHtml(note.body)}</p></div></article>`).join('');
  $('#notes-empty').classList.toggle('visible', state.notes.length === 0);
}
function renderActivity() {
  const items = state.logs.slice(0, 8);
  $('#activity-list').innerHTML = items.map((log) => `<article class="activity-item"><div class="activity-head"><span class="member-avatar ${log.user_id === state.user.id ? '' : 'partner'}">${escapeHtml(displayName(log.user_id).slice(0,1).toUpperCase())}</span><strong>${escapeHtml(displayName(log.user_id))}</strong><time>${escapeHtml(dateLabel(log.log_date,{month:'short',day:'numeric'},state.profile.timezone))}</time>${log.user_id === state.user.id ? `<button class="activity-edit" data-edit-log="${log.log_date}" aria-label="Edit your log for ${log.log_date}" type="button">Edit</button><button class="task-delete" data-delete-log="${log.log_date}" aria-label="Delete your log for ${log.log_date}" type="button">×</button>` : ''}</div>${log.activity_note ? `<p class="activity-body">${escapeHtml(log.activity_note)}</p>` : ''}${metricParts(log) ? `<div class="activity-metrics">${metricParts(log)}</div>` : ''}</article>`).join('');
  $('#activity-empty').classList.toggle('visible', items.length === 0);
}
function renderSettings() {
  $('#display-name').value = state.profile.display_name || '';
  const timezoneSelect = $('#timezone');
  const zones = [state.profile.timezone, 'UTC', Intl.DateTimeFormat().resolvedOptions().timeZone, 'Africa/Casablanca', 'America/Chicago', 'America/Los_Angeles', 'America/New_York', 'Europe/London', 'Europe/Paris', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Tokyo', 'Australia/Sydney'];
  timezoneSelect.innerHTML = [...new Set(zones)].map((zone) => {
    const label = zone === 'America/Chicago' ? 'Austin, Texas (Central Time)' : zone.replaceAll('_',' ');
    return `<option value="${escapeHtml(zone)}">${escapeHtml(label)}</option>`;
  }).join('');
  timezoneSelect.value = [...timezoneSelect.options].some((option) => option.value === state.profile.timezone) ? state.profile.timezone : 'UTC';
  $('#space-title').textContent = state.space ? state.space.name : 'Create your private space';
  $('#space-description').textContent = state.space ? (state.members.length === 2 ? 'Your two-person space is ready. Both members can see shared progress.' : 'Your space is ready for the administrator to create one member account.') : 'Only the administrator can create the private space and add its second member.';
  const actions = $('#space-actions');
  if (!state.space && state.isAdmin) actions.innerHTML = '<button class="button button-dark button-small" id="settings-create-space" type="button">Create my space</button>';
  else if (state.space && state.members.length < 2 && state.isAdmin) actions.innerHTML = '<p class="field-hint">Create the second account in the Admin section.</p>';
  else if (state.space && state.members.length >= 2) actions.innerHTML = '<p class="field-hint">This space has its two authorized members.</p>';
  else actions.innerHTML = '<p class="field-hint">Ask the administrator to set up the private space.</p>';
}
function renderAdmin() {
  $('#admin-nav-tab').hidden = !state.isAdmin;
  if (!state.isAdmin) $('#view-admin').hidden = true;
  if (!state.isAdmin) return;
  const canCreate = state.space && state.members.length === 1 && isOwner();
  const status = $('#admin-member-status');
  if (!state.space) status.textContent = 'Create your private space in Settings before creating the second account.';
  else if (state.members.length >= 2) status.textContent = 'This space has reached its two-member limit.';
  else status.textContent = 'One member slot is available.';
  $('#create-member-submit').disabled = !canCreate;
  $('#admin-member-list').innerHTML = state.members.length ? state.members.map((member) => {
    const username = displayName(member.user_id);
    const admin = member.user_id === state.user.id;
    return `<article class="admin-member-row"><span class="member-avatar ${admin ? '' : 'partner'}">${escapeHtml(username.slice(0,1).toUpperCase())}</span><span class="member-info"><strong>${escapeHtml(username)}${admin ? ' · You' : ''}</strong><span>${admin ? 'Administrator · Active' : 'Member · Active'}</span></span>${!admin && state.usernames[member.user_id] ? `<button class="button button-outline button-small" type="button" data-reset-member="${escapeHtml(member.user_id)}" data-reset-username="${escapeHtml(username)}">Reset password</button>` : ''}</article>`;
  }).join('') : '<p class="small-empty">No private space exists yet.</p>';
}
function randomTemporaryPassword() {
  const groups = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%*-_'];
  const alphabet = groups.join('');
  const randomIndex = (limit) => crypto.getRandomValues(new Uint32Array(1))[0] % limit;
  const chars = groups.map((group) => group[randomIndex(group.length)]);
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  for (const byte of bytes) chars.push(alphabet[byte % alphabet.length]);
  for (let index = chars.length - 1; index > 0; index--) { const swap = randomIndex(index + 1); [chars[index], chars[swap]] = [chars[swap], chars[index]]; }
  return chars.join('');
}
function validStrongPassword(value) { return value.length >= 12 && value.length <= 128 && /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value) && /[^A-Za-z0-9]/.test(value); }
async function invokeErrorMessage(error, data, fallback) {
  if (typeof data?.error === 'string') return data.error;
  if (error?.context instanceof Response) {
    const payload = await error.context.clone().json().catch(() => null);
    if (typeof payload?.error === 'string') return payload.error;
  }
  return fallback;
}
function clearOneTimeCredentials(container, passwordNode) { passwordNode.textContent = ''; container.hidden = true; }
function periodDates(range) {
  const today = new Date(`${state.today}T12:00:00Z`);
  if (range === 'week') { const weekday = (today.getUTCDay() + 6) % 7; return Array.from({ length: 7 }, (_, index) => dateOffset(state.today, index - weekday)); }
  return Array.from({ length: today.getUTCDate() }, (_, index) => dateOffset(state.today, index + 1 - today.getUTCDate()));
}
function renderInsights() {
  const dates = periodDates(state.range); const logs = state.logs.filter((log) => dates.includes(log.log_date));
  const sum = (key) => logs.reduce((total, log) => total + (Number(log[key]) || 0), 0);
  const mean = (key) => { const values = logs.filter((log) => log[key] != null).map((log) => Number(log[key])); return values.length ? values.reduce((a,b)=>a+b,0)/values.length : null; };
  const values = [
    ['Shared days logged', String(new Set(logs.map((log) => log.log_date)).size), `of ${dates.length} days with at least one check-in`],
    ['Sleep', mean('sleep_hours') == null ? '—' : mean('sleep_hours').toFixed(1), 'hours per logged entry'],
    ['Learning', numberFormat.format(sum('learning_minutes')), 'minutes entered'],
    ['Movement', numberFormat.format(sum('workout_minutes')), 'minutes entered']
  ];
  $('#stats-grid').innerHTML = values.map(([label,value,foot], index) => `<article class="stat-card"><span class="stat-label">${label}</span><div class="stat-value">${value}${index === 1 && value !== '—' ? '<span class="stat-unit">h</span>' : index > 1 ? '<span class="stat-unit">min</span>' : ''}</div><div class="stat-foot">${foot}</div></article>`).join('');
  renderChart(dates);
  const memberIds = [...new Set([state.user.id, ...state.members.map((member) => member.user_id)])];
  $('#streak-content').innerHTML = memberIds.length ? `<div class="streak-list">${memberIds.map((id) => `<div class="streak-row"><span class="member-avatar ${id === state.user.id ? '' : 'partner'}">${escapeHtml(displayName(id).slice(0,1).toUpperCase())}</span><span>${escapeHtml(displayName(id))}${id === state.user.id ? ' · You' : ''}</span><strong class="streak-value">${streakFor(id)} ${streakFor(id) === 1 ? 'day' : 'days'}</strong></div>`).join('')}</div>` : '<p class="streak-empty">Create a space and log a day to begin a streak.</p>';
}
function renderChart(dates) {
  const memberCount = state.members.length;
  const counts = dates.map((date) => new Set(state.logs.filter((log) => log.log_date === date).map((log) => log.user_id)).size);
  if (!state.space || counts.every((value) => value === 0)) { $('#progress-chart').innerHTML = '<p class="streak-empty">Once either of you logs a day, your shared rhythm will appear here.</p>'; return; }
  const descriptions = dates.map((date, index) => `${dateLabel(date, { weekday: 'long', month: 'short', day: 'numeric' }, state.profile.timezone)}: ${counts[index]} of ${memberCount} members logged`).join('; ');
  const columns = dates.map((date, index) => {
    const day = state.range === 'week' ? dateLabel(date, { weekday: 'narrow' }, state.profile.timezone) : (new Date(`${date}T12:00:00Z`).getUTCDate() % 5 === 1 ? String(new Date(`${date}T12:00:00Z`).getUTCDate()) : '');
    const height = memberCount ? (counts[index] / memberCount) * 100 : 0;
    return `<div class="shared-chart-column" aria-hidden="true"><span class="shared-chart-count">${counts[index]}</span><div class="shared-chart-track"><i class="shared-chart-bar" style="height:${height}%"></i></div><span class="shared-chart-label">${escapeHtml(day)}</span></div>`;
  }).join('');
  $('#progress-chart').innerHTML = `<div class="shared-chart-scroll"><div class="shared-chart" role="img" aria-label="Shared daily check-ins this ${state.range}. ${escapeHtml(descriptions)}">${columns}</div></div><div class="shared-chart-legend"><span>0</span><span>1 member</span><span>${memberCount} members</span></div>`;
}
function streakFor(userId) { const days = new Set(state.logs.filter((log) => log.user_id === userId).map((log) => log.log_date)); let count = 0, cursor = state.today; if (!days.has(cursor)) cursor = dateOffset(cursor, -1); while (days.has(cursor) && count < 366) { count++; cursor = dateOffset(cursor, -1); } return count; }
function openDialog(id) { const dialog = $(`#${id}`); if (dialog && !dialog.open) dialog.showModal(); }
function closeDialog(event) { const dialog = event.target.closest('dialog'); if (dialog?.open) dialog.close(); }
function populateLogForm(date = state.today) { const existing = state.logs.find((log) => log.user_id === state.user.id && log.log_date === date); $('#log-date').min = dateOffset(state.today, -370); $('#log-date').max = state.today; $('#log-date').value = date; $('#log-modal-title').textContent = existing ? 'Edit your daily log' : 'Your daily log'; $('#delete-log-button').hidden = !existing; $('#log-activity').value = existing?.activity_note || ''; $('#log-sleep').value = existing?.sleep_hours ?? ''; $('#log-steps').value = existing?.step_count ?? ''; $('#log-learning').value = existing?.learning_minutes ?? ''; $('#log-workout').value = existing?.workout_minutes ?? ''; $('#log-error').textContent = ''; openDialog('log-modal'); }
function bindEvents() {
  document.querySelectorAll('.nav-tab').forEach((button) => button.addEventListener('click', () => {
    if (button.dataset.view === 'admin' && !state.isAdmin) return;
    document.querySelectorAll('.nav-tab').forEach((item) => item.classList.toggle('active', item === button));
    document.querySelectorAll('.dashboard-view').forEach((view) => { view.hidden = view.id !== `view-${button.dataset.view}`; });
    $('#dashboard-nav').classList.remove('open'); $('#mobile-nav-toggle').setAttribute('aria-expanded', 'false');
  }));
  $('#mobile-nav-toggle').addEventListener('click', () => { const open = $('.dashboard-nav').classList.toggle('open'); $('#mobile-nav-toggle').setAttribute('aria-expanded', String(open)); });
  $('#account-menu').addEventListener('click', () => { $('#account-menu-panel').hidden = !$('#account-menu-panel').hidden; });
  $('#sign-out').addEventListener('click', async () => { await state.supabase.auth.signOut(); location.assign('./index.html'); });
  $('#log-today-button').addEventListener('click', populateLogForm); $('#edit-log-button').addEventListener('click', populateLogForm); document.addEventListener('click', (event) => { if (event.target.closest('[data-open-log]')) populateLogForm(); if (event.target.closest('[data-close-dialog]')) closeDialog(event); });
  $('#log-date').addEventListener('change', () => populateLogForm($('#log-date').value));
  $('#log-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const error = $('#log-error'); error.textContent = '';
    const fields = [['sleep_hours','#log-sleep',0,24],['step_count','#log-steps',0,200000],['learning_minutes','#log-learning',0,1440],['workout_minutes','#log-workout',0,1440]];
    const selectedDate = $('#log-date').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedDate) || selectedDate > state.today || selectedDate < dateOffset(state.today, -370)) { error.textContent = 'Choose a date within the past year, up to today.'; $('#log-date').focus(); return; }
    const payload = { space_id: state.members[0]?.space_id, user_id: state.user.id, log_date: selectedDate, activity_note: $('#log-activity').value.trim() };
    for (const [key, selector, min, max] of fields) { const raw = $(selector).value.trim(); if (raw === '') { payload[key] = null; continue; } const value = Number(raw); if (!Number.isFinite(value) || value < min || value > max || (key !== 'sleep_hours' && !Number.isInteger(value))) { error.textContent = `Enter a valid ${key.replaceAll('_',' ')} value.`; $(selector).focus(); return; } payload[key] = value; }
    if (!payload.space_id) { error.textContent = 'Create or join a space before saving a log.'; return; }
    try { await ensureOk(await state.supabase.from('daily_logs').upsert(payload,{onConflict:'user_id,log_date'})); $('#log-modal').close(); showToast('Your log is saved.'); await refresh(); } catch (problem) { error.textContent = safeError(problem); }
  });
  $('#activity-list').addEventListener('click', async (event) => {
    const editDate = event.target.dataset.editLog;
    if (editDate) { populateLogForm(editDate); return; }
    const deleteDate = event.target.dataset.deleteLog;
    if (!deleteDate) return;
    try { await ensureOk(await state.supabase.from('daily_logs').delete().eq('user_id', state.user.id).eq('log_date', deleteDate)); showToast('Log deleted.'); await refresh(); }
    catch (problem) { showToast(safeError(problem), 'error'); }
  });
  $('#delete-log-button').addEventListener('click', async () => {
    const date = $('#log-date').value;
    try { await ensureOk(await state.supabase.from('daily_logs').delete().eq('user_id', state.user.id).eq('log_date', date)); $('#log-modal').close(); showToast('Log deleted.'); await refresh(); }
    catch (problem) { $('#log-error').textContent = safeError(problem); }
  });
  $('#add-task-button').addEventListener('click', () => { $('#task-title').value=''; $('#task-error').textContent=''; openDialog('task-modal'); });
  $('#task-form').addEventListener('submit', async (event) => { event.preventDefault(); const title=$('#task-title').value.trim(); if (!title || title.length>160) { $('#task-error').textContent='Add a task with up to 160 characters.'; return; } try { await ensureOk(await state.supabase.from('daily_tasks').insert({space_id:state.members[0]?.space_id,user_id:state.user.id,task_date:state.today,title})); $('#task-modal').close(); showToast('Task added.'); await refresh(); } catch(problem) { $('#task-error').textContent=safeError(problem); } });
  $('#task-list').addEventListener('change', async (event) => { const id=event.target.dataset.taskToggle; if (!id) return; const task=state.tasks.find((item)=>item.id===id); if (!task || task.user_id!==state.user.id) return; try { await ensureOk(await state.supabase.from('daily_tasks').update({is_complete:event.target.checked}).eq('id',id)); await refresh(); } catch(problem) { showToast(safeError(problem),'error'); await refresh(); } });
  $('#task-list').addEventListener('click', async (event) => { const id=event.target.dataset.taskDelete; if (!id) return; try { await ensureOk(await state.supabase.from('daily_tasks').delete().eq('id',id)); showToast('Task removed.'); await refresh(); } catch(problem) { showToast(safeError(problem),'error'); } });
  $('#note-input').addEventListener('input', () => { $('#note-counter').textContent=`${$('#note-input').value.length} / 500`; });
  $('#note-form').addEventListener('submit', async (event) => { event.preventDefault(); const body=$('#note-input').value.trim(); if (!body || body.length>500) { showToast('Write a note with up to 500 characters.','error'); return; } if (!state.space) { showToast('Create or join a space first.','error'); return; } try { await ensureOk(await state.supabase.from('shared_notes').insert({space_id:state.space.id,user_id:state.user.id,body})); $('#note-input').value=''; $('#note-counter').textContent='0 / 500'; showToast('Note shared.'); await refresh(); } catch(problem) { showToast(safeError(problem),'error'); } });
  $('#notes-list').addEventListener('click', async (event) => { const id=event.target.dataset.noteDelete; if (!id) return; try { await ensureOk(await state.supabase.from('shared_notes').delete().eq('id',id)); await refresh(); } catch(problem) { showToast(safeError(problem),'error'); } });
  $('#profile-form').addEventListener('submit', async (event) => { event.preventDefault(); const display_name=$('#display-name').value.trim(); const timezone=$('#timezone').value; if (!display_name || display_name.length>60) { showToast('Choose a name up to 60 characters.','error'); return; } try { await ensureOk(await state.supabase.from('profiles').update({display_name,timezone}).eq('user_id',state.user.id)); showToast('Profile updated.'); await refresh(); } catch(problem) { showToast(safeError(problem),'error'); } });
  $('#create-space-button').addEventListener('click', () => state.space ? document.querySelector('.nav-tab[data-view="admin"]')?.click() : createSpace());
  $('#space-actions').addEventListener('click', (event) => { if (event.target.id === 'settings-create-space') createSpace(); });
  $('#change-password-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const error = $('#change-password-error'); error.textContent = '';
    const password = $('#new-password').value, confirmation = $('#confirm-new-password').value;
    if (!validStrongPassword(password)) { error.textContent = 'Use 12–128 characters with lowercase and uppercase letters, a number, and a symbol.'; return; }
    if (password !== confirmation) { error.textContent = 'Those passwords do not match.'; return; }
    try {
      const { data, error: invokeError } = await state.supabase.functions.invoke('change-password', { body: { password } });
      if (invokeError) throw new Error(await invokeErrorMessage(invokeError, data, 'The password could not be changed.'));
      const { data: refreshed, error: refreshError } = await state.supabase.auth.refreshSession();
      if (refreshError) throw new Error('Password changed, but the session needs a fresh sign-in. Log in again with your new password.');
      state.user = refreshed.session.user; state.mustChangePassword = Boolean(state.user.app_metadata?.must_change_password);
      $('#change-password-form').reset(); renderHeader(); showToast('Your password has been changed.');
    } catch (problem) { error.textContent = problem instanceof Error ? problem.message : 'The password could not be changed.'; }
  });
  $('#generate-member-password').addEventListener('click', () => { const generated = randomTemporaryPassword(); $('#member-temp-password').value = generated; $('#member-confirm-password').value = generated; });
  $('#create-member-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const error = $('#create-member-error'); error.textContent = '';
    const username = $('#member-username').value.trim().toLowerCase();
    const password = $('#member-temp-password').value; const confirmation = $('#member-confirm-password').value;
    if (!/^[a-z0-9][a-z0-9_-]{2,29}$/.test(username)) { error.textContent = 'Use 3–30 characters: lowercase letters, numbers, underscores, or hyphens.'; return; }
    if (!validStrongPassword(password)) { error.textContent = 'Use 12–128 characters with lowercase and uppercase letters, a number, and a symbol.'; return; }
    if (password !== confirmation) { error.textContent = 'Those passwords do not match.'; return; }
    const button = $('#create-member-submit'); button.disabled = true; button.textContent = 'Creating account…';
    try {
      const { data, error: invokeError } = await state.supabase.functions.invoke('admin-create-member', { body: { username, password } });
      if (invokeError || !data?.created) throw new Error(await invokeErrorMessage(invokeError, data, 'The account could not be created.'));
      await refresh(); $('#create-member-form').reset();
      $('#created-username').textContent = username; $('#created-password').textContent = password; $('#created-credentials').hidden = false;
      showToast('The member account is ready. Share the temporary password privately.');
    } catch (problem) { error.textContent = problem instanceof Error ? problem.message : 'The account could not be created.'; }
    finally { button.disabled = !state.space || state.members.length >= 2; button.textContent = 'Create member account'; }
  });
  $('#copy-created-password').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#created-password').textContent); showToast('Temporary password copied.'); } catch { showToast('Select and copy the temporary password shown above.', 'error'); } });
  $('#dismiss-created-password').addEventListener('click', () => clearOneTimeCredentials($('#created-credentials'), $('#created-password')));
  $('#admin-member-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-reset-member]'); if (!button) return;
    $('#reset-member-form').hidden = false; $('#reset-member-form').reset(); $('#reset-member-id').value = button.dataset.resetMember;
    $('#reset-member-name').textContent = button.dataset.resetUsername; $('#reset-member-error').textContent = ''; $('#reset-credentials').hidden = true;
  });
  $('#generate-reset-password').addEventListener('click', () => { const generated = randomTemporaryPassword(); $('#reset-temp-password').value = generated; $('#reset-confirm-password').value = generated; });
  $('#reset-member-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const error = $('#reset-member-error'); error.textContent = '';
    const password = $('#reset-temp-password').value, confirmation = $('#reset-confirm-password').value;
    if (!validStrongPassword(password)) { error.textContent = 'Use 12–128 characters with lowercase and uppercase letters, a number, and a symbol.'; return; }
    if (password !== confirmation) { error.textContent = 'Those passwords do not match.'; return; }
    try {
      const { data, error: invokeError } = await state.supabase.functions.invoke('admin-reset-member-password', { body: { member_id: $('#reset-member-id').value, password } });
      if (invokeError || !data?.reset) throw new Error(await invokeErrorMessage(invokeError, data, 'The password could not be reset.'));
      $('#reset-result-username').textContent = data.username; $('#reset-result-password').textContent = password; $('#reset-credentials').hidden = false;
      $('#reset-temp-password').value = ''; $('#reset-confirm-password').value = ''; showToast('A new temporary password is ready to share.');
    } catch (problem) { error.textContent = problem instanceof Error ? problem.message : 'The password could not be reset.'; }
  });
  $('#copy-reset-password').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#reset-result-password').textContent); showToast('Temporary password copied.'); } catch { showToast('Select and copy the temporary password shown above.', 'error'); } });
  $('#dismiss-reset-password').addEventListener('click', () => clearOneTimeCredentials($('#reset-credentials'), $('#reset-result-password')));
  document.querySelectorAll('.range-button').forEach((button) => button.addEventListener('click', () => { state.range=button.dataset.range; document.querySelectorAll('.range-button').forEach((item)=>item.classList.toggle('active',item===button)); renderInsights(); }));
}
async function createSpace() { try { await ensureOk(await state.supabase.rpc('create_space',{p_name:'Our space'})); showToast('Your private space is ready.'); await refresh(); } catch(problem) { showToast(safeError(problem),'error'); } }

if (!isConfigured) showSetup();
else {
  try {
    state.supabase=getSupabase();
    const {data:{session}}=await state.supabase.auth.getSession();
    if (!session) { location.replace('./auth.html'); }
    else {
      state.user=session.user; state.mustChangePassword=Boolean(session.user.app_metadata?.must_change_password); bindEvents(); toggleLoading(true); await refresh(); toggleLoading(false);
      state.supabase.auth.onAuthStateChange((event) => { if (event==='SIGNED_OUT') location.assign('./index.html'); });
    }
  } catch(problem) { toggleLoading(false); setup.hidden=false; setup.innerHTML=`<strong>We could not load your space.</strong> ${escapeHtml(safeError(problem))} <button class="text-button" id="retry-load" type="button">Try again</button>`; $('#retry-load')?.addEventListener('click',async()=>{toggleLoading(true);try{await refresh();toggleLoading(false)}catch(e){toggleLoading(false);showToast(safeError(e),'error')}}); }
}
