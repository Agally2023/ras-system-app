revoke execute on function public.ras_handle_new_user() from public, anon, authenticated;
alter function public.ras_role() security invoker;
