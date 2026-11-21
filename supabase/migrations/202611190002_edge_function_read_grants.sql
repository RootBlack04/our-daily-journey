-- Server-side Edge Functions use the service role for narrowly scoped reads.
-- RLS bypass does not replace PostgreSQL table privileges; grant read-only access
-- to only the account and membership tables queried by the functions.
begin;

grant select on public.user_accounts, public.admin_accounts, public.space_members to service_role;

commit;
