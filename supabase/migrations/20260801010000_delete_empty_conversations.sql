-- One-time cleanup of the empty conversations left behind by eager creation.
-- Run this once against your Supabase project, after
-- 20260801000000_create_conversation_with_message.sql.
--
-- Until that change, a conversations row was inserted on every login and on
-- every press of "New chat", before the user had sent anything. Every one of
-- those that was never used is a row with no messages attached. They are the
-- rows this deletes.
--
-- This is a one-off, deliberately NOT a trigger or a scheduled job: with
-- conversations now created together with their first message
-- (create_conversation_with_message), a conversation with zero messages
-- should no longer be reachable, and standing cleanup logic would quietly
-- paper over it if that ever stopped being true. The Recents query filters
-- empty conversations out on read as a defensive check instead, which hides
-- them from the user without destroying data nobody has looked at yet.
--
-- Orphans: chat_messages.conversation_id references conversations (id) on
-- delete cascade, so any messages of a deleted conversation would go with it
-- — by definition there are none here, since having none is the delete
-- condition. Nothing else in the schema references conversations: usage_events
-- (20260731000000_usage_tracking.sql) is keyed on user_id only, and uploaded
-- attachments are stored per user, not per conversation
-- (20260728000000_chat_attachments_storage.sql). So this leaves no dangling
-- rows anywhere else.
--
-- Safe to re-run: it only ever matches conversations that have no messages.

-- Have a look before deleting anything — this is what will go:
--
--   select c.id, c.user_id, c.created_at
--   from public.conversations c
--   where not exists (
--     select 1 from public.chat_messages m where m.conversation_id = c.id
--   )
--   order by c.created_at;

delete from public.conversations c
where not exists (
  select 1
  from public.chat_messages m
  where m.conversation_id = c.id
);

-- Should return 0 afterwards.
--
--   select count(*) from public.conversations c
--   where not exists (
--     select 1 from public.chat_messages m where m.conversation_id = c.id
--   );
