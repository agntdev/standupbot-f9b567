import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import "../standup/session.js";
import { registerMainMenuItem } from "../toolkit/index.js";
import { actor, backToMenu, NOT_IN_TEAM, openTeamKeyboard } from "../standup/ui.js";
import {
  getUserTeam,
  getSession,
  onTimeResponses,
  pendingMembers,
  teamMembers,
  today,
  transientSession,
  nameOf,
} from "../standup/store.js";
import { formatDigest } from "../standup/format.js";

// 📊 Today's Digest — the consolidated standup for the whole team today (on-time
// responses only; late ones are archived but excluded). If a digest channel is
// linked the digest is also posted there; a posting failure notifies the owner by
// DM (blueprint: "Error DM to owner if channel posting fails").
registerMainMenuItem({ label: "📊 Today's Digest", data: "digest:today", order: 30 });

const composer = new Composer<Ctx>();

composer.callbackQuery("digest:today", async (ctx) => {
  await ctx.answerCallbackQuery();
  const { id } = actor(ctx);
  const team = await getUserTeam(id);
  if (!team) {
    await ctx.editMessageText(NOT_IN_TEAM, { reply_markup: openTeamKeyboard() });
    return;
  }

  const day = today();
  // Read-only: viewing the digest must not archive a phantom session. Only an
  // actual response (or the owner explicitly opening the standup) persists a day.
  const session = (await getSession(team.code, day)) ?? transientSession(team, day);
  const members = await teamMembers(team);
  const pendingIds = await pendingMembers(team.code, day);
  const pendingNames = pendingIds.map((uid) => nameOf(members, uid));
  const digest = formatDigest(team, session, pendingNames);

  // Post to the team channel if linked and there's content. Guarded: a
  // misconfigured channel must not break the user's view — instead DM the owner.
  let note = "";
  if (team.channelId && onTimeResponses(session).length > 0) {
    try {
      await ctx.api.sendMessage(team.channelId, digest);
      note = "\n\n📡 Also posted to your team channel.";
    } catch {
      note = "\n\n⚠️ Couldn't post to your team channel.";
      const owner = members.find((m) => m.telegramId === team.ownerId);
      if (owner) {
        try {
          await ctx.api.sendMessage(
            owner.dmChatId,
            `⚠️ StandupBot couldn't post the ${day} digest to ${team.name}'s channel (${team.channelId}). Make sure the bot is an admin there.`,
          );
        } catch {
          // owner may have blocked the bot — nothing more we can do
        }
      }
    }
  }

  await ctx.editMessageText(digest + note, { reply_markup: backToMenu() });
});

export default composer;
