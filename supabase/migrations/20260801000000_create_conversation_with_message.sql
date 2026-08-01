-- Lazy conversation creation.
-- Run this against your Supabase project (SQL editor or `supabase db push`).
--
-- Conversations used to be created eagerly: on login, and again on every
-- press of "New chat". Both wrote a row before the user had said anything,
-- so the table filled with empty conversations that were never used.
--
-- A conversation is now created at the moment the first message is sent, and
-- the two rows have to appear together — a conversation without its first
-- message is exactly the empty row this change exists to stop creating.
--
-- Doing that as two round trips from the app leaves a window: if the process
-- dies (or the message insert is refused) between them, an empty conversation
-- is left behind and nothing knows to clean it up. A plpgsql function runs in
-- a single implicit transaction, so both inserts commit or neither does.
--
-- SECURITY INVOKER (the default — deliberately not DEFINER): this runs with
-- the caller's own privileges, so both inserts are still checked against the
-- RLS policies in 20260727000000_chat_messages.sql. The function can't be
-- used to write rows for another user, and the user_id it writes comes from
-- auth.uid() rather than from an argument, so there is no parameter a caller
-- can set to attribute a conversation to somebody else.

create or replace function public.create_conversation_with_message(
  p_conversation_id text,
  p_content text
)
returns text
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
begin
  -- No session means no owner to attribute the rows to. RLS would refuse the
  -- inserts anyway; failing here makes the reason obvious in the logs.
  if v_user_id is null then
    raise exception 'create_conversation_with_message: no authenticated user';
  end if;

  -- Same shape the app's CONVERSATION_ID_RE enforces (a 21-char nanoid).
  -- conversations.id is free-form text, so without this a caller could pick
  -- an id of any length or content.
  if p_conversation_id !~ '^[A-Za-z0-9_-]{21}$' then
    raise exception 'create_conversation_with_message: invalid conversation id';
  end if;

  -- chat_messages.content already has a char_length > 0 check; catching it
  -- here keeps the failure at the top rather than after the first insert.
  if p_content is null or char_length(p_content) = 0 then
    raise exception 'create_conversation_with_message: empty message content';
  end if;

  insert into public.conversations (id, user_id)
  values (p_conversation_id, v_user_id);

  insert into public.chat_messages (user_id, conversation_id, role, content)
  values (v_user_id, p_conversation_id, 'user', p_content);

  return p_conversation_id;
end;
$$;

-- Callable by signed-in users only. anon has no auth.uid(), so the guard
-- above would reject it regardless; revoking is the clearer statement.
revoke all on function public.create_conversation_with_message(text, text) from public;
revoke all on function public.create_conversation_with_message(text, text) from anon;
grant execute on function public.create_conversation_with_message(text, text) to authenticated;
