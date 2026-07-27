-- Private Supabase Storage bucket for chat attachments (uploaded files),
-- scoped per-user via RLS on storage.objects. Run this against your
-- Supabase project (SQL editor or `supabase db push`).
--
-- Objects are stored under a key of the form `{user_id}/{random}-{filename}`
-- — the first path segment is always the uploader's own auth.uid(), set by
-- server-side code that already verified the session (never client-chosen),
-- so every policy below just checks that segment against auth.uid(). RLS is
-- already enabled on storage.objects by default in every Supabase project;
-- this only adds the policies scoping it to this bucket.

insert into storage.buckets (id, name, public)
values ('chat-attachments', 'chat-attachments', false)
on conflict (id) do nothing;

create policy "chat_attachments_select_own"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'chat-attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "chat_attachments_insert_own"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'chat-attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "chat_attachments_delete_own"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'chat-attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- No update policy: attachments are immutable once uploaded — remove and
-- re-upload instead of editing in place.
