import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import "../standup/session.js";
import { registerMainMenuItem } from "../toolkit/index.js";
import { actor, backToMenu, NOT_IN_TEAM, openTeamKeyboard } from "../standup/ui.js";
import {
  getMember,
  getUserTeam,
  openSession,
  optedInMembers,
  recordResponse,
  today,
} from "../standup/store.js";

// ✍️ My Update — the private daily standup. Members answer the team's questions
// (configurable; defaults provided). The owner's "📣 Open today's standup"
// broadcasts the prompts to every opted-in member — the closest the toolkit allows
// to the blueprint's scheduled cycle (a real cron is a deploy-time addition).
registerMainMenuItem({ label: "✍️ My Update", data: "standup:start", order: 20 });

const composer = new Composer<Ctx>();

function clearFlow(ctx: Ctx): void {
  ctx.session.flow = undefined;
  ctx.session.step = undefined;
  ctx.session.draftAnswers = undefined;
}

function promptText(teamName: string, questions: string[]): string {
  return [`📝 ${teamName} standup for ${today()}:`, "", ...questions.map((q, i) => `${i + 1}. ${q}`), "", "Reply here — one line per answer, or send them one at a time."].join("\n");
}

// Owner broadcasts the standup prompt to all opted-in members.
composer.callbackQuery("standup:open", async (ctx) => {
  await ctx.answerCallbackQuery();
  const { id } = actor(ctx);
  const team = await getUserTeam(id);
  if (!team) {
    await ctx.editMessageText(NOT_IN_TEAM, { reply_markup: openTeamKeyboard() });
    return;
  }
  if (team.ownerId !== id) {
    await ctx.editMessageText("Only the team owner can open the daily standup.", {
      reply_markup: backToMenu(),
    });
    return;
  }
  await openSession(team.code);
  const members = await optedInMembers(team);
  const prompt = promptText(team.name, team.questions);
  let delivered = 0;
  for (const m of members) {
    try {
      await ctx.api.sendMessage(m.dmChatId, prompt);
      delivered++;
    } catch {
      // member may have blocked the bot — skip, keep going
    }
  }
  await ctx.editMessageText(
    `📣 Opened today's standup and prompted ${delivered} of ${members.length} opted-in member(s).`,
    { reply_markup: backToMenu() },
  );
});

// Member starts (or restarts) their own update.
composer.callbackQuery("standup:start", async (ctx) => {
  await ctx.answerCallbackQuery();
  const { id } = actor(ctx);
  const team = await getUserTeam(id);
  if (!team) {
    await ctx.editMessageText(NOT_IN_TEAM, { reply_markup: openTeamKeyboard() });
    return;
  }
  const me = await getMember(id);
  if (!me?.optIn) {
    await ctx.editMessageText("You're opted out. Tap 👥 Team → ✅ Opt in to take part in standups.", {
      reply_markup: openTeamKeyboard(),
    });
    return;
  }
  ctx.session.flow = "standup";
  ctx.session.step = "answers";
  ctx.session.draftAnswers = [];
  await ctx.editMessageText(`Let's do your standup for ${today()}.\n\n📝 ${team.questions[0]}`);
});

async function finish(ctx: Ctx, code: string, id: number, name: string, answers: string[]): Promise<void> {
  clearFlow(ctx);
  const result = await recordResponse(code, id, name, answers);
  if (!result) {
    await ctx.reply(NOT_IN_TEAM, { reply_markup: openTeamKeyboard() });
    return;
  }
  const { session, response } = result;
  const lines = ["✅ Standup saved! Here's what you posted:", ""];
  session.questions.forEach((q, i) => lines.push(`• ${q} ${response.answers[i] ?? "—"}`));
  if (response.late) lines.push("", "⏰ This was after the cutoff, so it's archived but excluded from today's digest.");
  else if (response.incomplete) lines.push("", "⚠️ Marked incomplete — you can resend to fill in the rest.");
  lines.push("", "Tap 📊 Today's Digest to see the whole team.");
  await ctx.reply(lines.join("\n"), { reply_markup: backToMenu() });
}

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.flow !== "standup") return next();

  const { id, name } = actor(ctx);
  const text = ctx.message.text.trim();
  if (!text) {
    await ctx.reply("Please send a non-empty answer.");
    return;
  }
  const team = await getUserTeam(id);
  if (!team) {
    clearFlow(ctx);
    await ctx.reply(NOT_IN_TEAM, { reply_markup: openTeamKeyboard() });
    return;
  }
  const questions = team.questions;
  const draft = ctx.session.draftAnswers ?? [];

  // Bundled reply: a multi-line first message answers several questions at once.
  // Parsed and (if short) marked incomplete by the store — blueprint edge case.
  if (draft.length === 0 && text.includes("\n")) {
    const answers = text.split("\n").map((l) => l.trim()).filter((l) => l !== "").slice(0, questions.length);
    await finish(ctx, team.code, id, name, answers);
    return;
  }

  draft.push(text);
  ctx.session.draftAnswers = draft;

  if (draft.length < questions.length) {
    await ctx.reply(`📝 ${questions[draft.length]}`);
    return;
  }
  await finish(ctx, team.code, id, name, draft);
});

export default composer;
