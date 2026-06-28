import { describe, it, expect, beforeEach } from "vitest";
import { buildBot } from "../src/bot.js";
import { _reset, _setToday } from "../src/standup/store.js";
import { FAKE_BOT_INFO, callbackUpdate, createTeam, joinTeam, lastText, submitStandup, textUpdate, type Call } from "./helpers.js";

// Adversarial Telegram responses the always-ok harness can't produce: a member
// who blocked the bot (403) and a misconfigured digest channel. The bot must not
// crash, lose the daily-nudge flag, or hide the user's own digest — and the
// owner error-DM (itself a send that can fail) must not throw.
//
// `fail` is mutable and starts empty, so SETUP sends (join/create confirmations)
// succeed; the test enables the failure right before the action under test.

async function botFailing() {
  const fail = new Set<number>();
  const bot = await buildBot("test-token");
  (bot as unknown as { botInfo: typeof FAKE_BOT_INFO }).botInfo = FAKE_BOT_INFO;
  const calls: Call[] = [];
  bot.catch(() => {});
  bot.api.config.use(async (_prev, method, payload) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    calls.push({ method, payload: p });
    if (method === "sendMessage" && typeof p.chat_id === "number" && fail.has(p.chat_id)) {
      return { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" } as never;
    }
    return { ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: "private" } } } as never;
  });
  return { bot, calls, fail };
}

beforeEach(() => {
  _reset();
  _setToday("2026-06-28");
});

describe("adversarial paths", () => {
  it("a blocked member doesn't abort the nudge or lose the confirmation", async () => {
    const { bot, calls, fail } = await botFailing();
    const code = await createTeam(bot, calls, 100, "Rockets");
    await joinTeam(bot, 200, code);
    await joinTeam(bot, 300, code);
    await submitStandup(bot, 100, "a", "b", "none"); // 200 + 300 pending

    fail.add(200); // member 200 blocked the bot
    calls.length = 0;
    await bot.handleUpdate(callbackUpdate("nudge:send", 100));
    expect(lastText(calls)).toContain("Nudged 1 of 2 member(s)");
    const targets = calls.filter((c) => c.method === "sendMessage").map((c) => c.payload.chat_id);
    expect(targets).toContain(200);
    expect(targets).toContain(300);
  });

  it("a failing digest channel still shows the digest, with a warning + owner DM", async () => {
    const channel = -1009999;
    const { bot, calls, fail } = await botFailing();
    await createTeam(bot, calls, 100, "Rockets");
    await bot.handleUpdate(callbackUpdate("team:setchannel", 100));
    await bot.handleUpdate(textUpdate(String(channel), 100));
    await submitStandup(bot, 100, "shipped it", "review", "none");

    fail.add(channel);
    calls.length = 0;
    await bot.handleUpdate(callbackUpdate("digest:today", 100));
    const shown = lastText(calls);
    expect(shown).toContain("shipped it");
    expect(shown).toContain("Couldn't post to your team channel");
    expect(calls.some((c) => c.method === "sendMessage" && c.payload.chat_id === 100)).toBe(true);
  });

  it("does not throw when both the channel AND the owner DM fail", async () => {
    const channel = -1009999;
    const { bot, calls, fail } = await botFailing();
    await createTeam(bot, calls, 100, "Rockets");
    await bot.handleUpdate(callbackUpdate("team:setchannel", 100));
    await bot.handleUpdate(textUpdate(String(channel), 100));
    await submitStandup(bot, 100, "shipped it", "review", "none");

    fail.add(channel);
    fail.add(100); // owner DM also fails
    calls.length = 0;
    await expect(bot.handleUpdate(callbackUpdate("digest:today", 100))).resolves.toBeUndefined();
    expect(lastText(calls)).toContain("Couldn't post to your team channel");
  });
});
