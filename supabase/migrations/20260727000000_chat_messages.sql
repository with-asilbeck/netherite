-- Conversations and chat history for the security advisor chatbot.
-- Run this against your Supabase project (SQL editor or `supabase db push`).
--
-- Note: this replaces the original version of this migration, which was
-- never applied to any live project (confirmed empty schema cache before
-- this revision) — conversation_id below is now `text` (a nanoid token)
-- instead of `uuid`, and chat_messages ownership is now also gated by a
-- join to conversations.user_id, not just its own user_id column.

create table if not exists public.conversations (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  title text,
  created_at timestamptz not null default now()
);

create index if not exists conversations_user_id_idx
  on public.conversations (user_id, created_at desc);

alter table public.conversations enable row level security;

-- Ownership is always checked via user_id = auth.uid() — never by id alone.
create policy "conversations_select_own"
  on public.conversations
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy "conversations_insert_own"
  on public.conversations
  for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "conversations_update_own"
  on public.conversations
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "conversations_delete_own"
  on public.conversations
  for delete
  to authenticated
  using (auth.uid() = user_id);


create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  conversation_id text not null references public.conversations (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) > 0),
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_conversation_idx
  on public.chat_messages (conversation_id, created_at);

alter table public.chat_messages enable row level security;

-- Ownership is verified via a join to the parent conversation's user_id,
-- not just this row's own user_id — a message can't be read or inserted
-- without also owning the conversation it belongs to, even if its exact
-- id/conversation_id is known.
create policy "chat_messages_select_own"
  on public.chat_messages
  for select
  to authenticated
  using (
    auth.uid() = user_id
    and exists (
      select 1
      from public.conversations c
      where c.id = chat_messages.conversation_id
        and c.user_id = auth.uid()
    )
  );

create policy "chat_messages_insert_own"
  on public.chat_messages
  for insert
  to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.conversations c
      where c.id = chat_messages.conversation_id
        and c.user_id = auth.uid()
    )
  );

-- No update/delete policies: chat history is append-only for now.
