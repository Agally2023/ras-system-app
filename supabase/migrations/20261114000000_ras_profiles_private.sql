-- Staff profiles (emails, roles) are visible only to the person themself; admins keep full access through ras_profiles_admin.
drop policy if exists ras_profiles_read on public.ras_profiles;
create policy ras_profiles_read on public.ras_profiles for select to authenticated using (id = (select auth.uid()));
