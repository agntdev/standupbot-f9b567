import { describe, it, expect, beforeEach } from "vitest";
import { _reset, _setToday } from "../src/standup/store.js";
import {
  callbackUpdate,
  createTeam,
  freshBot,
  joinTeam,
  lastText,
  submitStandup,
  textUpdate,
  type Call,
} from "./helpers.js";

// Nudge, channel posting, and multi-day history/search — the cross-cutting
// features beyond the core submit→digest loop.

beforeEach(() => {
  _reset();
  _setToday("2026-06-28");
});

describe("nudge", () => {
  it("DMs only the pending members and is single-shot per day", async () => {
    const { bot, calls } = await freshBot();
    const code = await createTeam(bot, calls, 100, "Rockets");
    await joinTeam(bot, 200, code);
    await joinTeam(bot, 300, code);
    await submitStandup(bot, 100, "a", "b", "none"); // owner submitted; 200 + 300 pending

    calls.length = 0;
    await bot.handleUpdate(callbackUpdate("nudge:send", 100));
    const dmTargets = calls.filter((c) => c.method === "sendMessage").map((c) => c.payload.chat_id);
    expect(dmTargets).toContain(200);
    expect(dmTargets).toContain(300);
    expect(dmTargets).not.toContain(100);
    expect(lastText(calls)).toContain("Nudged 2 member(s)");

    calls.length = 0;
    await bot.handleUpdate(callbackUpdate("nudge:send", 100));
    expect(calls.filter((c) => c.method === "sendMessage").length).toBe(0);
    expect(lastText(calls)).toContain("already sent");
  });

  it("reports when everyone has already checked in", async () => {
    const { bot, calls } = await freshBot();
    await createTeam(bot, calls, 100, "Solo");
    await submitStandup(bot, 100, "a", "b", "none");
    calls.length = 0;
    await bot.handleUpdate(callbackUpdate("nudge:send", 100));
    expect(lastText(calls)).toContain("Everyone has already checked in");
    expect(calls.some((c) => c.method === "sendMessage")).toBe(false);
  });

  it("excludes opted-out members from the pending list", async () => {
    const { bot, calls } = await freshBot();
    const code = await createTeam(bot, calls, 100, "Rockets");
    await joinTeam(bot, 200, code);
    await submitStandup(bot, 100, "a", "b", "none");
    // Member 200 opts out.
    await bot.handleUpdate(callbackUpdate("team:open", 200));
    await bot.handleUpdate(callbackUpdate("team:optin", 200)); // toggles opt-out (joined opted-in)
    calls.length = 0;
    await bot.handleUpdate(callbackUpdate("nudge:send", 100));
    expect(lastText(calls)).toContain("Everyone has already checked in");
  });
});

describe("digest channel", () => {
  it("posts the digest to the linked channel", async () => {
    const { bot, calls } = await freshBot();
    await createTeam(bot, calls, 100, "Rockets");
    await bot.handleUpdate(callbackUpdate("team:setchannel", 100));
    await bot.handleUpdate(textUpdate("-1001234567890", 100));
    await submitStandup(bot, 100, "shipped", "review", "none");

    calls.length = 0;
    await bot.handleUpdate(callbackUpdate("digest:today", 100));
    const channelPost = calls.find(
      (c) => c.method === "sendMessage" && c.payload.chat_id === -1001234567890,
    );
    expect(channelPost).toBeDefined();
    expect(String(channelPost!.payload.text)).toContain("shipped");
  });

  it("non-owners cannot set the channel", async () => {
    const { bot, calls } = await freshBot();
    const code = await createTeam(bot, calls, 100, "Rockets");
    await joinTeam(bot, 200, code);
    calls.length = 0;
    await bot.handleUpdate(callbackUpdate("team:setchannel", 200));
    expect(lastText(calls)).toContain("Only the team owner");
  });
});

describe("standup config", () => {
  it("uses owner-customised questions in the flow", async () => {
    const { bot, calls } = await freshBot();
    await createTeam(bot, calls, 100, "Rockets");
    await bot.handleUpdate(callbackUpdate("team:questions", 100));
    await bot.handleUpdate(textUpdate("Mood?\nFocus?", 100)); // 2 custom questions
    calls.length = 0;
    await bot.handleUpdate(callbackUpdate("standup:start", 100));
    expect(lastText(calls)).toContain("Mood?");
    await bot.handleUpdate(textUpdate("good", 100));
    expect(lastText(calls)).toContain("Focus?");
    await bot.handleUpdate(textUpdate("shipping", 100));
    expect(lastText(calls)).toContain("Standup saved");
  });

  it("owner broadcast prompts opted-in members", async () => {
    const { bot, calls } = await freshBot();
    const code = await createTeam(bot, calls, 100, "Rockets");
    await joinTeam(bot, 200, code);
    calls.length = 0;
    await bot.handleUpdate(callbackUpdate("standup:open", 100));
    const dm = calls.filter((c) => c.method === "sendMessage").map((c) => c.payload.chat_id);
    expect(dm).toContain(100);
    expect(dm).toContain(200);
    expect(lastText(calls)).toContain("prompted 2");
  });
});

describe("history + search", () => {
  async function seedMultiDay(bot: Awaited<ReturnType<typeof freshBot>>["bot"], calls: Call[]) {
    const code = await createTeam(bot, calls, 100, "Rockets");
    _setToday("2026-06-26");
    await submitStandup(bot, 100, "migrated db", "write docs", "none");
    _setToday("2026-06-27");
    await submitStandup(bot, 100, "wrote docs", "fix flaky test", "CI is slow");
    _setToday("2026-06-28");
    await submitStandup(bot, 100, "fixed tests", "ship release", "none");
    return code;
  }

  it("lists archived days, most recent first", async () => {
    const { bot, calls } = await freshBot();
    await seedMultiDay(bot, calls);
    calls.length = 0;
    await bot.handleUpdate(callbackUpdate("history:view", 100));
    const buttons = JSON.stringify(calls.at(-1)!.payload.reply_markup);
    expect(buttons).toContain("history:day:2026-06-28");
    expect(buttons).toContain("history:day:2026-06-26");
    expect(buttons.indexOf("2026-06-28")).toBeLessThan(buttons.indexOf("2026-06-26"));
  });

  it("opens a specific day's digest with a permalink", async () => {
    const { bot, calls } = await freshBot();
    await seedMultiDay(bot, calls);
    calls.length = 0;
    await bot.handleUpdate(callbackUpdate("history:day:2026-06-27", 100));
    const text = lastText(calls);
    expect(text).toContain("2026-06-27");
    expect(text).toContain("fix flaky test");
    expect(text).not.toContain("ship release");
    expect(text).toContain("t.me/test_bot?start=s_");
  });

  it("searches the archive across days by keyword", async () => {
    const { bot, calls } = await freshBot();
    await seedMultiDay(bot, calls);
    await bot.handleUpdate(callbackUpdate("history:search", 100));
    calls.length = 0;
    await bot.handleUpdate(textUpdate("docs", 100));
    const text = lastText(calls);
    expect(text).toContain("result");
    expect(text).toContain("2026-06-26");
    expect(text).toContain("2026-06-27");
  });

  it("supports combined member + date-range filters", async () => {
    const { bot, calls } = await freshBot();
    await seedMultiDay(bot, calls);
    await bot.handleUpdate(callbackUpdate("history:search", 100));
    calls.length = 0;
    await bot.handleUpdate(textUpdate("member:U100 from:2026-06-27 to:2026-06-27 docs", 100));
    const text = lastText(calls);
    expect(text).toContain("2026-06-27");
    expect(text).not.toContain("2026-06-26"); // out of range
  });

  it("search reports no matches cleanly", async () => {
    const { bot, calls } = await freshBot();
    await seedMultiDay(bot, calls);
    await bot.handleUpdate(callbackUpdate("history:search", 100));
    calls.length = 0;
    await bot.handleUpdate(textUpdate("zzzznotfound", 100));
    expect(lastText(calls)).toContain("No standups matched");
  });

  it("viewing the digest before anyone checks in does not archive a phantom day", async () => {
    const { bot, calls } = await freshBot();
    await createTeam(bot, calls, 100, "Rockets");
    // Owner peeks at the digest each morning before anyone has submitted.
    await bot.handleUpdate(callbackUpdate("digest:today", 100));
    await bot.handleUpdate(callbackUpdate("digest:today", 100));
    calls.length = 0;
    await bot.handleUpdate(callbackUpdate("history:view", 100));
    // No day should have been recorded yet.
    expect(lastText(calls)).toContain("No standups archived yet");
  });

  it("paginates when there are many days", async () => {
    const { bot, calls } = await freshBot();
    await createTeam(bot, calls, 100, "Rockets");
    for (let d = 1; d <= 7; d++) {
      _setToday(`2026-06-0${d}`);
      await submitStandup(bot, 100, `y${d}`, `t${d}`, "none");
    }
    calls.length = 0;
    await bot.handleUpdate(callbackUpdate("history:view", 100));
    expect(JSON.stringify(calls.at(-1)!.payload.reply_markup)).toContain("historypg:next:1");
    calls.length = 0;
    await bot.handleUpdate(callbackUpdate("historypg:next:1", 100));
    expect(JSON.stringify(calls.at(-1)!.payload.reply_markup)).toContain("historypg:prev:0");
  });
});
