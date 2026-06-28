import { buildBot } from "../src/bot.js";
import type { Update } from "grammy/types";

// Shared tokenless-harness helpers for the programmatic tests (the paths the
// declarative BotSpec JSON can't express: multi-user, multi-day, exact calls).
// In real private chats chat.id === user.id, so each "user" id is used for both —
// which also means a DM the bot sends targets that same id.

export const FAKE_BOT_INFO = {
  id: 42,
  is_bot: true,
  first_name: "TestBot",
  username: "test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as const;

export interface Call {
  method: string;
  payload: Record<string, unknown>;
}

let seq = 0;

export function textUpdate(text: string, user = 1): Update {
  const id = ++seq;
  const isCmd = text.startsWith("/");
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      chat: { id: user, type: "private", first_name: `U${user}` },
      from: { id: user, is_bot: false, first_name: `U${user}` },
      text,
      ...(isCmd ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }] } : {}),
    },
  } as Update;
}

export function callbackUpdate(data: string, user = 1): Update {
  const id = ++seq;
  return {
    update_id: id,
    callback_query: {
      id: String(id),
      from: { id: user, is_bot: false, first_name: `U${user}` },
      message: {
        message_id: 500,
        date: 0,
        chat: { id: user, type: "private", first_name: `U${user}` },
        from: { id: 42, is_bot: true, first_name: "TestBot" },
        text: "(prev)",
      },
      chat_instance: `ci-${user}`,
      data,
    },
  } as Update;
}

type Bot = Awaited<ReturnType<typeof buildBot>>;

export async function freshBot(): Promise<{ bot: Bot; calls: Call[] }> {
  const bot = await buildBot("test-token");
  (bot as unknown as { botInfo: typeof FAKE_BOT_INFO }).botInfo = FAKE_BOT_INFO;
  const calls: Call[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: (payload ?? {}) as Record<string, unknown> });
    return { ok: true, result: { message_id: ++seq, date: 0, chat: { id: 1, type: "private" } } } as never;
  });
  return { bot, calls };
}

export function lastText(calls: Call[]): string {
  for (let i = calls.length - 1; i >= 0; i--) {
    const t = calls[i]!.payload.text;
    if (typeof t === "string") return t;
  }
  return "";
}

/** Create a team and return its join code (parsed from the confirmation). */
export async function createTeam(bot: Bot, calls: Call[], user: number, name: string): Promise<string> {
  await bot.handleUpdate(callbackUpdate("team:create", user));
  await bot.handleUpdate(textUpdate(name, user));
  return /Join code: ([A-Z0-9]{6})/.exec(lastText(calls))![1]!;
}

export async function joinTeam(bot: Bot, user: number, code: string): Promise<void> {
  await bot.handleUpdate(callbackUpdate("team:join", user));
  await bot.handleUpdate(textUpdate(code, user));
}

/** Submit the default 3-question standup one answer at a time. */
export async function submitStandup(bot: Bot, user: number, y: string, t: string, b: string): Promise<void> {
  await bot.handleUpdate(callbackUpdate("standup:start", user));
  await bot.handleUpdate(textUpdate(y, user));
  await bot.handleUpdate(textUpdate(t, user));
  await bot.handleUpdate(textUpdate(b, user));
}
