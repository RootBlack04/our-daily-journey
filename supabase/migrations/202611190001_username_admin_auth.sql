-- Username login and administrator-managed member accounts.
-- Additive migration: preserves existing Auth users, spaces, and progress rows.
begin;

create table public.user_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username = lower(username) and username ~ '^[a-z0-9][a-z0-9_-]{2,29}$'),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.admin_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.account_setup_state (
  singleton boolean primary key default true check (singleton),
  initial_admin_assigned boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.account_setup_state(singleton, initial_admin_assigned) values (true, false);

alter table public.user_accounts enable row level security;
alter table public.admin_accounts enable row level security;
alter table public.account_setup_state enable row level security;

-- This additive migration can also run on projects where the original helper
-- function was not installed. Keep its lookup scoped to the signed-in user.
create or replace function public.is_space_peer(p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from public.space_members mine
      join public.space_members peer on peer.space_id = mine.space_id
     where mine.user_id = auth.uid()
       and peer.user_id = p_user_id
  )
$$;
revoke all on function public.is_space_peer(uuid) from public, anon;
grant execute on function public.is_space_peer(uuid) to authenticated;

create policy "Members can read usernames in their space" on public.user_accounts for select to authenticated
using (user_id = (select auth.uid()) or public.is_space_peer(user_accounts.user_id));

revoke all on public.user_accounts, public.admin_accounts, public.account_setup_state from anon, authenticated;
grant select (user_id, username, created_at) on public.user_accounts to authenticated;
-- Edge Functions need server-side SELECT grants in addition to RLS bypass.
grant select on public.user_accounts, public.admin_accounts, public.space_members to service_role;

create function public.current_user_is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admin_accounts a where a.user_id = auth.uid())
$$;
revoke all on function public.current_user_is_admin() from public, anon;
grant execute on function public.current_user_is_admin() to authenticated;

-- One-time owner-operated bootstrap for an existing Supabase Auth user.
create function public.bootstrap_initial_admin(p_user_id uuid, p_username text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_username is null or p_username <> lower(p_username) or p_username !~ '^[a-z0-9][a-z0-9_-]{2,29}$' then
    raise exception 'Username is invalid' using errcode = '22023';
  end if;
  update public.account_setup_state set initial_admin_assigned = true, updated_at = now()
   where singleton = true and initial_admin_assigned = false;
  if not found or exists (select 1 from public.admin_accounts) then
    raise exception 'Initial administrator has already been assigned' using errcode = '23505';
  end if;
  if not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'Choose an existing Auth account' using errcode = '22023';
  end if;
  insert into public.user_accounts(user_id, username)
  values (p_user_id, p_username)
  on conflict (user_id) do update set username = excluded.username;
  insert into public.admin_accounts(user_id) values (p_user_id);
  update public.profiles set display_name = p_username where user_id = p_user_id;
end;
$$;
revoke all on function public.bootstrap_initial_admin(uuid, text) from public, anon, authenticated;
grant execute on function public.bootstrap_initial_admin(uuid, text) to postgres, service_role;

-- Limit space creation to the administrator account established above.
create or replace function public.create_space(p_name text default 'Our space')
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_space_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '28000'; end if;
  if not exists (select 1 from public.admin_accounts a where a.user_id = auth.uid()) then
    raise exception 'Administrator authorization required' using errcode = '42501';
  end if;
  if exists (select 1 from public.space_members where user_id = auth.uid()) then
    raise exception 'You already belong to a space' using errcode = '23505';
  end if;
  insert into public.spaces(created_by, name)
  values (auth.uid(), coalesce(nullif(trim(p_name), ''), 'Our space'))
  returning id into v_space_id;
  insert into public.space_members(space_id, user_id, role) values (v_space_id, auth.uid(), 'owner');
  return v_space_id;
end;
$$;

-- Service-role-only function. The Edge Function verifies the administrator's JWT
-- before calling this; database checks still enforce the role, space, and capacity.
create function public.admin_register_member(p_admin_id uuid, p_member_id uuid, p_username text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_space_id uuid;
begin
  if p_username is null or p_username <> lower(p_username) or p_username !~ '^[a-z0-9][a-z0-9_-]{2,29}$' then
    raise exception 'Username is invalid' using errcode = '22023';
  end if;
  if not exists (select 1 from public.admin_accounts a where a.user_id = p_admin_id) then
    raise exception 'Administrator authorization required' using errcode = '42501';
  end if;
  if exists (select 1 from public.admin_accounts a where a.user_id = p_member_id) then
    raise exception 'An administrator cannot be created as a member' using errcode = '42501';
  end if;
  select s.id into v_space_id
    from public.space_members m join public.spaces s on s.id = m.space_id
   where m.user_id = p_admin_id and m.role = 'owner'
   for update of s;
  if v_space_id is null then raise exception 'Create your private space before adding a member' using errcode = '23514'; end if;
  if (select count(*) from public.space_members m where m.space_id = v_space_id) >= 2 then
    raise exception 'This space already has two members' using errcode = '23514';
  end if;
  if exists (select 1 from public.user_accounts a where a.username = p_username) then
    raise exception 'That username is already in use' using errcode = '23505';
  end if;
  if exists (select 1 from public.user_accounts a where a.user_id = p_member_id) then
    raise exception 'This Auth account is already assigned a username' using errcode = '23505';
  end if;
  insert into public.user_accounts(user_id, username, created_by) values (p_member_id, p_username, p_admin_id);
  insert into public.space_members(space_id, user_id, role) values (v_space_id, p_member_id, 'member');
end;
$$;

revoke all on function public.admin_register_member(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_register_member(uuid, uuid, text) to service_role;

-- New spaces can still be created by the signed-in administrator, but account
-- membership changes must now use the administrator Edge Function.
revoke all on function public.create_space_invite(uuid) from authenticated;
revoke all on function public.join_space(text) from authenticated;

commit;
