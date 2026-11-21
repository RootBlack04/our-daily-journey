-- Our Daily Journey: private two-person spaces.
-- Run in the Supabase SQL editor as the project owner. Never expose service_role credentials.
begin;

create extension if not exists pgcrypto with schema extensions;

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Member' check (char_length(display_name) between 1 and 60),
  timezone text not null default 'UTC' check (char_length(timezone) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.spaces (
  id uuid primary key default extensions.gen_random_uuid(),
  created_by uuid references auth.users(id) on delete set null,
  name text not null default 'Our space' check (char_length(name) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.space_members (
  space_id uuid not null references public.spaces(id) on delete cascade,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (space_id, user_id)
);

create table public.daily_logs (
  id uuid primary key default extensions.gen_random_uuid(),
  space_id uuid not null references public.spaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  log_date date not null,
  activity_note text not null default '' check (char_length(activity_note) <= 1000),
  sleep_hours numeric(4,2) check (sleep_hours is null or sleep_hours between 0 and 24),
  step_count integer check (step_count is null or step_count between 0 and 200000),
  learning_minutes integer check (learning_minutes is null or learning_minutes between 0 and 1440),
  workout_minutes integer check (workout_minutes is null or workout_minutes between 0 and 1440),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, log_date)
);

create table public.daily_tasks (
  id uuid primary key default extensions.gen_random_uuid(),
  space_id uuid not null references public.spaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  task_date date not null,
  title text not null check (char_length(title) between 1 and 160),
  is_complete boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.shared_notes (
  id uuid primary key default extensions.gen_random_uuid(),
  space_id uuid not null references public.spaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.invite_tokens (
  id uuid primary key default extensions.gen_random_uuid(),
  space_id uuid not null references public.spaces(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check ((consumed_at is null) = (consumed_by is null))
);

create index profiles_user_id_idx on public.profiles(user_id);
create index space_members_user_id_idx on public.space_members(user_id);
create index daily_logs_space_date_idx on public.daily_logs(space_id, log_date desc);
create index daily_logs_user_date_idx on public.daily_logs(user_id, log_date desc);
create index daily_tasks_space_date_idx on public.daily_tasks(space_id, task_date desc);
create index daily_tasks_user_date_idx on public.daily_tasks(user_id, task_date desc);
create index shared_notes_space_created_idx on public.shared_notes(space_id, created_at desc);
create index invite_tokens_space_idx on public.invite_tokens(space_id);

create function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end;
$$;

create trigger profiles_updated_at before update on public.profiles for each row execute function public.set_updated_at();
create trigger spaces_updated_at before update on public.spaces for each row execute function public.set_updated_at();
create trigger daily_logs_updated_at before update on public.daily_logs for each row execute function public.set_updated_at();
create trigger daily_tasks_updated_at before update on public.daily_tasks for each row execute function public.set_updated_at();
create trigger shared_notes_updated_at before update on public.shared_notes for each row execute function public.set_updated_at();

create function public.create_profile_for_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(user_id, display_name)
  values (new.id, coalesce(nullif(left(trim(new.raw_user_meta_data ->> 'display_name'), 60), ''), 'Member'))
  on conflict (user_id) do nothing;
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.create_profile_for_new_user();

-- Trigger enforces correct space and immutable ownership for client writes.
create function public.enforce_record_membership()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.user_id is distinct from old.user_id or new.space_id is distinct from old.space_id) then
    raise exception 'Record ownership cannot be changed' using errcode = '42501';
  end if;
  if not exists (select 1 from public.space_members m where m.space_id = new.space_id and m.user_id = auth.uid()) then
    raise exception 'You are not a member of this space' using errcode = '42501';
  end if;
  if new.user_id is distinct from auth.uid() then
    raise exception 'You can only create your own records' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger daily_logs_membership before insert or update on public.daily_logs for each row execute function public.enforce_record_membership();
create trigger daily_tasks_membership before insert or update on public.daily_tasks for each row execute function public.enforce_record_membership();
create trigger shared_notes_membership before insert or update on public.shared_notes for each row execute function public.enforce_record_membership();

-- Keep a surviving member able to manage the space after the other account is deleted.
create function public.handle_space_member_departure()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_remaining uuid;
begin
  if not exists (select 1 from public.spaces where id = old.space_id) then return old; end if;
  select user_id into v_remaining from public.space_members where space_id = old.space_id order by joined_at limit 1;
  if v_remaining is null then
    delete from public.spaces where id = old.space_id;
  else
    update public.space_members set role = 'owner' where space_id = old.space_id and user_id = v_remaining;
  end if;
  return old;
end;
$$;
create trigger space_member_departure after delete on public.space_members for each row execute function public.handle_space_member_departure();

alter table public.profiles enable row level security;
alter table public.spaces enable row level security;
alter table public.space_members enable row level security;
alter table public.daily_logs enable row level security;
alter table public.daily_tasks enable row level security;
alter table public.shared_notes enable row level security;
alter table public.invite_tokens enable row level security;

-- SECURITY DEFINER membership helpers avoid recursive RLS policy evaluation.
-- They always inspect only the signed-in caller's membership and cannot be used as membership oracles.
create function public.is_space_member(p_space_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.space_members m where m.space_id = p_space_id and m.user_id = auth.uid())
$$;
create function public.is_space_peer(p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.space_members mine join public.space_members peer on mine.space_id = peer.space_id where mine.user_id = auth.uid() and peer.user_id = p_user_id)
$$;
revoke all on function public.is_space_member(uuid) from public, anon;
revoke all on function public.is_space_peer(uuid) from public, anon;
grant execute on function public.is_space_member(uuid) to authenticated;
grant execute on function public.is_space_peer(uuid) to authenticated;

create policy "Profiles readable by self or space member" on public.profiles for select to authenticated
using (user_id = (select auth.uid()) or public.is_space_peer(profiles.user_id));
create policy "Users update own profile" on public.profiles for update to authenticated
using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "Members read their spaces" on public.spaces for select to authenticated
using (public.is_space_member(spaces.id));
-- No client INSERT/UPDATE/DELETE policies for spaces or space_members. RPCs below own those changes.

create policy "Members read memberships in own space" on public.space_members for select to authenticated
using (public.is_space_member(space_members.space_id));

create policy "Space members read logs" on public.daily_logs for select to authenticated
using (public.is_space_member(daily_logs.space_id));
create policy "Users insert own logs" on public.daily_logs for insert to authenticated
with check (user_id = (select auth.uid()) and public.is_space_member(daily_logs.space_id));
create policy "Users update own logs" on public.daily_logs for update to authenticated
using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Users delete own logs" on public.daily_logs for delete to authenticated using (user_id = (select auth.uid()));

create policy "Space members read tasks" on public.daily_tasks for select to authenticated
using (public.is_space_member(daily_tasks.space_id));
create policy "Users insert own tasks" on public.daily_tasks for insert to authenticated
with check (user_id = (select auth.uid()) and public.is_space_member(daily_tasks.space_id));
create policy "Users update own tasks" on public.daily_tasks for update to authenticated
using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Users delete own tasks" on public.daily_tasks for delete to authenticated using (user_id = (select auth.uid()));

create policy "Space members read shared notes" on public.shared_notes for select to authenticated
using (public.is_space_member(shared_notes.space_id));
create policy "Users insert own notes" on public.shared_notes for insert to authenticated
with check (user_id = (select auth.uid()) and public.is_space_member(shared_notes.space_id));
create policy "Users update own notes" on public.shared_notes for update to authenticated
using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Users delete own notes" on public.shared_notes for delete to authenticated using (user_id = (select auth.uid()));
-- Invite tokens have no direct client policies; raw secrets are returned once by the RPC only.

-- Explicit Data API grants; row level security still decides which rows are visible/mutable.
revoke all on public.profiles, public.spaces, public.space_members, public.daily_logs, public.daily_tasks, public.shared_notes, public.invite_tokens from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, timezone) on public.profiles to authenticated;
grant select on public.spaces, public.space_members to authenticated;
grant select, insert, update, delete on public.daily_logs, public.daily_tasks, public.shared_notes to authenticated;

create function public.create_space(p_name text default 'Our space')
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_space_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if exists (select 1 from public.space_members where user_id = auth.uid()) then
    raise exception 'You already belong to a space' using errcode = '23505';
  end if;
  insert into public.spaces(created_by, name) values (auth.uid(), coalesce(nullif(trim(p_name), ''), 'Our space')) returning id into v_space_id;
  insert into public.space_members(space_id, user_id, role) values (v_space_id, auth.uid(), 'owner');
  return v_space_id;
end;
$$;

create function public.create_space_invite(p_space_id uuid)
returns table(invite_token text, expires_at timestamptz) language plpgsql security definer set search_path = '' as $$
declare v_token text; v_expiry timestamptz;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  perform 1 from public.spaces s where s.id = p_space_id for update;
  if not found or not exists (select 1 from public.space_members m where m.space_id = p_space_id and m.user_id = auth.uid() and m.role = 'owner') then
    raise exception 'Only the space owner can invite a member' using errcode = '42501';
  end if;
  if (select count(*) from public.space_members where space_id = p_space_id) >= 2 then
    raise exception 'This space already has two members' using errcode = '23514';
  end if;
  -- Creating a replacement link invalidates a lost or previously shared unused link.
  update public.invite_tokens set expires_at = now()
    where space_id = p_space_id and consumed_at is null and expires_at > now();
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_expiry := now() + interval '7 days';
  insert into public.invite_tokens(space_id, created_by, token_hash, expires_at)
  values (p_space_id, auth.uid(), encode(extensions.digest(v_token, 'sha256'), 'hex'), v_expiry);
  return query select v_token, v_expiry;
end;
$$;

create function public.join_space(p_invite_token text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_invite public.invite_tokens%rowtype; v_space_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if p_invite_token is null or p_invite_token !~ '^[0-9a-f]{64}$' then raise exception 'Invite is invalid or expired' using errcode = '22023'; end if;
  select * into v_invite from public.invite_tokens i
    where i.token_hash = encode(extensions.digest(p_invite_token, 'sha256'), 'hex') for update;
  if not found or v_invite.expires_at <= now() or v_invite.consumed_at is not null then
    raise exception 'Invite is invalid, expired, or already used' using errcode = '22023';
  end if;
  v_space_id := v_invite.space_id;
  perform 1 from public.spaces s where s.id = v_space_id for update;
  if exists (select 1 from public.space_members where user_id = auth.uid()) then raise exception 'You already belong to a space' using errcode = '23505'; end if;
  if (select count(*) from public.space_members where space_id = v_space_id) >= 2 then raise exception 'This space already has two members' using errcode = '23514'; end if;
  insert into public.space_members(space_id, user_id, role) values (v_space_id, auth.uid(), 'member');
  update public.invite_tokens set consumed_at = now(), consumed_by = auth.uid() where id = v_invite.id;
  return v_space_id;
end;
$$;

revoke all on function public.create_space(text) from public, anon;
revoke all on function public.create_space_invite(uuid) from public, anon;
revoke all on function public.join_space(text) from public, anon;
grant execute on function public.create_space(text) to authenticated;
grant execute on function public.create_space_invite(uuid) to authenticated;
grant execute on function public.join_space(text) to authenticated;

commit;
