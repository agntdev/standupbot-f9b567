import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import "../standup/session.js";
import { registerMainMenuItem } from "../toolkit/index.js";
import { actor, backToMenu, NOT_IN_TEAM, openTeamKeyboard } from "../standup/ui.js";
import {
  getMember,
  getUserTeam,
  openSession,
  pendingMembers,
  setNudged,
  teamMembers,
  today,
  nameOf,
} from "../standup/store.js";

// 🔔 Nudge — send ONE reminder per day to opted-in members who haven't posted on
// time. The single-nudge rule is enforced on the session (setNudged returns false
// on a repeat), so a team can't be spammed.
registerMainMenuItem({ label: "🔔 Nudge", data: "nudge:send", order: 40 });

const composer = new Composer<Ctx>();

composer.callbackQuery("nudge:send", async (ctx) => {
  await ctx.answerCallbackQuery();
  const { id } = actor(ctx);
  const team = await getUserTeam(id);
  if (!team) {
    await ctx.editMessageText(NOT_IN_TEAM, { reply_markup: openTeamKeyboard() });
    return;
  }

  const day = today();
  await openSession(team.code, day);
  const pendingIds = await pendingMembers(team.code, day);
  const members = await teamMembers(team);
  if (pendingIds.length === 0) {
    await ctx.editMessageText("🎉 Everyone has already checked in today — no nudge needed.", {
      reply_markup: backToMenu(),
    });
    return;
  }

  const names = pendingIds.map((uid) => nameOf(members, uid)).join(", ");
  if (!(await setNudged(team.code, day))) {
    await ctx.editMessageText(`🔕 Today's nudge was already sent. Still pending: ${names}.`, {
      reply_markup: backToMenu(),
    });
    return;
  }

  // DM each pending member. Guard every send: a blocked member (403) must not
  // abort the loop or swallow the confirmation — the nudge flag is already set.
  let delivered = 0;
  for (const uid of pendingIds) {
    const m = await getMember(uid);
    if (!m) continue;
    try {
      await ctx.api.sendMessage(
        m.dmChatId,
        `👋 Reminder: ${team.name} is waiting on your standup. Tap ✍️ My Update to post it.`,
      );
      delivered++;
    } catch {
      // member likely blocked the bot; skip and continue
    }
  }

  const summary =
    delivered === pendingIds.length
      ? `🔔 Nudged ${delivered} member(s): ${names}.`
      : `🔔 Nudged ${delivered} of ${pendingIds.length} member(s): ${names}. Some couldn't be reached (they may have blocked the bot).`;
  await ctx.editMessageText(summary, { reply_markup: backToMenu() });
});

export default composer;
