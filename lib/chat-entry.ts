/**
 * Where every "start chatting" affordance on the marketing site points. Entry
 * points link here instead of branching on auth themselves — `/try` does the
 * check server-side, so no two entry points can drift apart.
 */
export const CHAT_ENTRY_PATH = "/try";

/**
 * Where a signed-in user lands when they enter chat from outside it: a fresh
 * draft, every time.
 *
 * This used to resolve to the user's most recent conversation, creating one
 * first if they had none — which meant simply logging in wrote a conversations
 * row. `/chat` now renders an empty draft that owns no id and no row until the
 * first message is sent, so there is nothing left to resolve and every caller
 * (`/try`, the OAuth callback, "New chat") can point at the same static path.
 */
export const CHAT_APP_PATH = "/chat";
