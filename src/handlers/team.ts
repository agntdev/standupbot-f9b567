import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import "../standup/session.js";
import { registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { actor, backToMenu, backToMenuRow } from "../standup/ui.js";
import {
  createTeam,
  getMember,
  getUserTeam,
  joinTeam,
  leaveTeam,
  setOptIn,
  teamMembers,
  updateTeam,
  type Team,
} from "../standup/store.js";

// 👥 Team — create or join a standup team, and (owner) configure it: digest
// channel, questions, schedule, and the admin-summary toggle. A user belongs to
// one team at a time; the join code links members across their private chats so
// their updates roll up into one team digest.
registerMainMenuItem({ label: "👥 Team", data: "team:open", order: 10 });

const composer = new Composer<Ctx>();

function clearFlow(ctx: Ctx): void {
  ctx.session.flow = undefined;
  ctx.session.step = undefined;
}

async function teamView(ctx: Ctx, team: Team, userId: number): Promise<void> {
  const members = await teamMembers(team);
  const me = await getMember(userId);
  const isOwner = team.ownerId === userId;
  const text = [
    `👥 ${team.name}`,
    `Join code: ${team.code}`,
    `Members: ${members.length} (opted-in: ${members.filter((m) => m.optIn).length})`,
    `Questions: ${team.questions.length}`,
    `Schedule: ${team.scheduledTime} ${team.timezone}, cutoff +${team.cutoffHours}h`,
    `Digest channel: ${team.channelId ? `linked (${team.channelId})` : "not set"}`,
    `Admin summary DM: ${team.adminSummary ? "on" : "off"}`,
    `Your status: ${me?.optIn ? "opted in ✅" : "opted out 🔕"}`,
  ].join("\n");

  const rows = [
    [inlineButton(me?.optIn ? "🔕 Opt out" : "✅ Opt in", "team:optin")],
    ...(isOwner
      ? [
          [inlineButton("📣 Open today's standup", "standup:open")],
          [inlineButton("✏️ Edit questions", "team:questions")],
          [inlineButton("⏰ Set schedule", "team:schedule")],
          [inlineButton("📡 Set digest channel", "team:setchannel")],
          [inlineButton(`📨 Admin summary: ${team.adminSummary ? "on" : "off"}`, "team:adminsummary")],
        ]
      : []),
    [inlineButton("🚪 Leave team", "team:leave")],
    backToMenuRow(),
  ];
  await ctx.editMessageText(text, { reply_markup: inlineKeyboard(rows) });
}

async function renderTeam(ctx: Ctx): Promise<void> {
  const { id } = actor(ctx);
  const team = await getUserTeam(id);
  if (team) {
    await teamView(ctx, team, id);
    return;
  }
  await ctx.editMessageText("You're not in a team yet. What would you like to do?", {
    reply_markup: inlineKeyboard([
      [inlineButton("➕ Create a team", "team:create")],
      [inlineButton("🔑 Join with a code", "team:join")],
      backToMenuRow(),
    ]),
  });
}

composer.callbackQuery("team:open", async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderTeam(ctx);
});

composer.callbackQuery("team:create", async (ctx) => {
  await ctx.answerCallbackQuery();
  const { id } = actor(ctx);
  if (await getUserTeam(id)) {
    await renderTeam(ctx); // already in a team — show it instead of double-joining
    return;
  }
  ctx.session.flow = "team_create";
  ctx.session.step = "name";
  await ctx.editMessageText("What's your team's name? Send it as a message.");
});

composer.callbackQuery("team:join", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.flow = "team_join";
  ctx.session.step = "code";
  await ctx.editMessageText("Send me the 6-character join code your team gave you.");
});

composer.callbackQuery("team:leave", async (ctx) => {
  await ctx.answerCallbackQuery();
  await leaveTeam(actor(ctx).id);
  await ctx.editMessageText("You've left your team. Tap 👥 Team to create or join another.", {
    reply_markup: backToMenu(),
  });
});

composer.callbackQuery("team:optin", async (ctx) => {
  await ctx.answerCallbackQuery();
  const { id } = actor(ctx);
  const me = await getMember(id);
  if (!me) {
    await renderTeam(ctx);
    return;
  }
  await setOptIn(id, !me.optIn);
  const team = await getUserTeam(id);
  if (team) await teamView(ctx, team, id);
});

composer.callbackQuery("team:adminsummary", async (ctx) => {
  await ctx.answerCallbackQuery();
  const { id } = actor(ctx);
  const team = await getUserTeam(id);
  if (!team || team.ownerId !== id) {
    await ctx.editMessageText("Only the team owner can change this.", { reply_markup: backToMenu() });
    return;
  }
  await updateTeam(team.code, { adminSummary: !team.adminSummary });
  const updated = await getUserTeam(id);
  if (updated) await teamView(ctx, updated, id);
});

async function ownerGate(ctx: Ctx): Promise<Team | undefined> {
  const { id } = actor(ctx);
  const team = await getUserTeam(id);
  if (!team || team.ownerId !== id) {
    await ctx.editMessageText("Only the team owner can do that.", { reply_markup: backToMenu() });
    return undefined;
  }
  return team;
}

composer.callbackQuery("team:setchannel", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await ownerGate(ctx))) return;
  ctx.session.flow = "set_channel";
  ctx.session.step = "channel_id";
  await ctx.editMessageText(
    "Send the numeric chat ID of your team channel or group (add the bot there as an admin first). It usually looks like -1001234567890.",
  );
});

composer.callbackQuery("team:questions", async (ctx) => {
  await ctx.answerCallbackQuery();
  const team = await ownerGate(ctx);
  if (!team) return;
  ctx.session.flow = "edit_questions";
  ctx.session.step = "questions";
  await ctx.editMessageText(
    `Send your standup questions, one per line. Current:\n\n${team.questions.join("\n")}`,
  );
});

composer.callbackQuery("team:schedule", async (ctx) => {
  await ctx.answerCallbackQuery();
  const team = await ownerGate(ctx);
  if (!team) return;
  ctx.session.flow = "set_schedule";
  ctx.session.step = "schedule";
  await ctx.editMessageText(
    `Send the schedule as: HH:MM TIMEZONE CUTOFF_HOURS\nExample: 09:00 UTC 2\nCurrent: ${team.scheduledTime} ${team.timezone} ${team.cutoffHours}`,
  );
});

// Typed-input router for this handler's flows. Always next() for flows we don't own.
composer.on("message:text", async (ctx, next) => {
  const flow = ctx.session.flow;
  if (
    flow !== "team_create" &&
    flow !== "team_join" &&
    flow !== "set_channel" &&
    flow !== "edit_questions" &&
    flow !== "set_schedule"
  ) {
    return next();
  }
  const { id, name, chatId } = actor(ctx);
  const text = ctx.message.text.trim();

  if (flow === "team_create") {
    if (!text) {
      await ctx.reply("Please send a non-empty team name.");
      return;
    }
    const team = await createTeam(text, id, name, chatId);
    clearFlow(ctx);
    await ctx.reply(
      `✅ Created “${team.name}”.\n\nJoin code: ${team.code}\nShare it so teammates can join. Default questions are set — tap 👥 Team to customise.`,
      { reply_markup: backToMenu() },
    );
    return;
  }

  if (flow === "team_join") {
    const team = await joinTeam(text.toUpperCase(), id, name, chatId);
    clearFlow(ctx);
    if (!team) {
      await ctx.reply("I couldn't find a team with that code. Double-check it and tap 🔑 Join again.", {
        reply_markup: backToMenu(),
      });
      return;
    }
    await ctx.reply(`✅ Joined “${team.name}”. You're opted in. Tap ✍️ My Update to post today's standup.`, {
      reply_markup: backToMenu(),
    });
    return;
  }

  if (flow === "set_channel") {
    const channelId = Number(text);
    if (!Number.isInteger(channelId)) {
      await ctx.reply("That doesn't look like a numeric chat ID. Send digits only, e.g. -1001234567890.");
      return;
    }
    const team = await getUserTeam(id);
    clearFlow(ctx);
    if (!team || team.ownerId !== id) {
      await ctx.reply("Only the team owner can set the digest channel.", { reply_markup: backToMenu() });
      return;
    }
    await updateTeam(team.code, { channelId });
    await ctx.reply("📡 Digest channel linked. Today's Digest will also be posted there.", {
      reply_markup: backToMenu(),
    });
    return;
  }

  if (flow === "edit_questions") {
    const questions = text
      .split("\n")
      .map((q) => q.trim())
      .filter((q) => q !== "");
    const team = await getUserTeam(id);
    clearFlow(ctx);
    if (!team || team.ownerId !== id) {
      await ctx.reply("Only the team owner can edit questions.", { reply_markup: backToMenu() });
      return;
    }
    if (questions.length === 0) {
      await ctx.reply("I need at least one question. Tap ✏️ Edit questions to try again.", {
        reply_markup: backToMenu(),
      });
      return;
    }
    await updateTeam(team.code, { questions });
    await ctx.reply(`✅ Saved ${questions.length} question(s):\n\n${questions.join("\n")}`, {
      reply_markup: backToMenu(),
    });
    return;
  }

  // set_schedule
  const parts = text.split(/\s+/);
  const [time, tz, cutoffRaw] = parts;
  const cutoff = Number(cutoffRaw);
  const team = await getUserTeam(id);
  clearFlow(ctx);
  if (!team || team.ownerId !== id) {
    await ctx.reply("Only the team owner can set the schedule.", { reply_markup: backToMenu() });
    return;
  }
  if (!/^\d{1,2}:\d{2}$/.test(time ?? "") || !tz || !Number.isFinite(cutoff) || cutoff <= 0) {
    await ctx.reply("Format: HH:MM TIMEZONE CUTOFF_HOURS — e.g. 09:00 UTC 2. Tap ⏰ Set schedule to retry.", {
      reply_markup: backToMenu(),
    });
    return;
  }
  await updateTeam(team.code, { scheduledTime: time, timezone: tz, cutoffHours: cutoff });
  await ctx.reply(`⏰ Schedule set: ${time} ${tz}, cutoff +${cutoff}h.`, { reply_markup: backToMenu() });
});

export default composer;
