import { describe, it, expect, beforeEach } from "vitest";
import { _reset, _setToday } from "../src/standup/store.js";
import { callbackUpdate, createTeam, freshBot, joinTeam, lastText, submitStandup } from "./helpers.js";

// Team + standup core: create, join-by-code, cross-member digest aggregation.

beforeEach(() => {
  _reset();
  _setToday("2026-06-28");
});

describe("team + standup core", () => {
  it("creates a team and returns a join code", async () => {
    const { bot, calls } = await freshBot();
    const code = await createTeam(bot, calls, 100, "Rockets");
    expect(lastText(calls)).toContain("Created");
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
  });

  it("a second member joins via the code and both roll into one digest", async () => {
    const { bot, calls } = await freshBot();
    const code = await createTeam(bot, calls, 100, "Rockets");
    await submitStandup(bot, 100, "shipped login", "build digest", "none");

    await joinTeam(bot, 200, code);
    await submitStandup(bot, 200, "wrote tests", "review PRs", "waiting on QA");

    calls.length = 0;
    await bot.handleUpdate(callbackUpdate("digest:today", 100));
    const digest = lastText(calls);
    expect(digest).toContain("U100");
    expect(digest).toContain("shipped login");
    expect(digest).toContain("U200");
    expect(digest).toContain("waiting on QA");
    expect(digest).toContain("✅ Everyone has checked in.");
  });

  it("digest shows pending members who haven't submitted", async () => {
    const { bot, calls } = await freshBot();
    const code = await createTeam(bot, calls, 100, "Rockets");
    await joinTeam(bot, 200, code);

    await submitStandup(bot, 100, "a", "b", "none");
    calls.length = 0;
    await bot.handleUpdate(callbackUpdate("digest:today", 100));
    expect(lastText(calls)).toContain("Still pending: U200");
  });

  it("re-submitting the same day overwrites, not duplicates", async () => {
    const { bot, calls } = await freshBot();
    await createTeam(bot, calls, 100, "Rockets");
    await submitStandup(bot, 100, "old", "old", "none");
    await submitStandup(bot, 100, "new yesterday", "new today", "none");
    calls.length = 0;
    await bot.handleUpdate(callbackUpdate("digest:today", 100));
    const digest = lastText(calls);
    expect(digest).toContain("new yesterday");
    expect(digest).not.toContain("old");
    expect(digest.match(/U100/g)?.length).toBe(1);
  });

  it("blocks standup when the user isn't in a team", async () => {
    const { bot, calls } = await freshBot();
    await bot.handleUpdate(callbackUpdate("standup:start", 100));
    expect(lastText(calls)).toContain("not in a team");
  });

  it("switching teams moves the member's membership", async () => {
    const { bot, calls } = await freshBot();
    const a = await createTeam(bot, calls, 100, "Alpha");
    const b = await createTeam(bot, calls, 200, "Beta");
    expect(a).not.toBe(b);
    await joinTeam(bot, 300, a);
    await joinTeam(bot, 300, b);
    await submitStandup(bot, 300, "x", "y", "none");
    calls.length = 0;
    await bot.handleUpdate(callbackUpdate("digest:today", 200));
    expect(lastText(calls)).toContain("U300");
    calls.length = 0;
    await bot.handleUpdate(callbackUpdate("digest:today", 100));
    expect(lastText(calls)).not.toContain("U300");
  });

  it("accepts a bundled multi-line reply and marks it incomplete when short", async () => {
    const { bot, calls } = await freshBot();
    await createTeam(bot, calls, 100, "Rockets");
    await bot.handleUpdate(callbackUpdate("standup:start", 100));
    calls.length = 0;
    // Two lines for three questions → parsed, marked incomplete.
    await bot.handleUpdate({
      update_id: 9001,
      message: {
        message_id: 9001,
        date: 0,
        chat: { id: 100, type: "private", first_name: "U100" },
        from: { id: 100, is_bot: false, first_name: "U100" },
        text: "did the thing\ndoing the next thing",
      },
    } as never);
    expect(lastText(calls)).toContain("incomplete");
  });
});
