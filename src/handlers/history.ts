import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import "../standup/session.js";
import { registerMainMenuItem, inlineButton, inlineKeyboard, paginate } from "../toolkit/index.js";
import { actor, backToMenu, backToMenuRow, NOT_IN_TEAM, openTeamKeyboard } from "../standup/ui.js";
import {
  getSession,
  getUserTeam,
  historyDays,
  pendingMembers,
  searchResponses,
  sessionPermalink,
  teamMembers,
  nameOf,
  type SearchFilters,
} from "../standup/store.js";
import { formatDigest } from "../standup/format.js";

// 🗂 History (callback history:view) — browse past standup days (paginated), open
// any day's digest with a shareable session permalink, and search the archive by
// any combination of keyword + member + date range.
registerMainMenuItem({ label: "🗂 History", data: "history:view", order: 50 });

const DAYS_PER_PAGE = 5;
const MAX_SEARCH_RESULTS = 10;

const composer = new Composer<Ctx>();

async function renderHistoryPage(ctx: Ctx, page: number): Promise<void> {
  const { id } = actor(ctx);
  const team = await getUserTeam(id);
  if (!team) {
    await ctx.editMessageText(NOT_IN_TEAM, { reply_markup: openTeamKeyboard() });
    return;
  }
  const days = await historyDays(team.code);
  if (days.length === 0) {
    await ctx.editMessageText("🗂 No standups archived yet. Post one with ✍️ My Update.", {
      reply_markup: inlineKeyboard([[inlineButton("🔎 Search", "history:search")], backToMenuRow()]),
    });
    return;
  }
  const { pageItems, controls, page: actualPage, totalPages } = paginate(days, {
    page,
    perPage: DAYS_PER_PAGE,
    callbackPrefix: "historypg",
  });
  const dayRows = pageItems.map((day) => [inlineButton(`📅 ${day}`, `history:day:${day}`)]);
  const keyboard = inlineKeyboard([
    ...dayRows,
    ...controls.inline_keyboard,
    [inlineButton("🔎 Search", "history:search")],
    backToMenuRow(),
  ]);
  await ctx.editMessageText(
    `🗂 ${team.name} — standup history (page ${actualPage + 1}/${totalPages})\nTap a date to open its digest.`,
    { reply_markup: keyboard },
  );
}

composer.callbackQuery("history:view", async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderHistoryPage(ctx, 0);
});

composer.callbackQuery(/^historypg:(?:prev|next):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderHistoryPage(ctx, Number(ctx.match![1]));
});

composer.callbackQuery(/^history:day:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const { id } = actor(ctx);
  const team = await getUserTeam(id);
  if (!team) {
    await ctx.editMessageText(NOT_IN_TEAM, { reply_markup: openTeamKeyboard() });
    return;
  }
  const day = ctx.match![1]!;
  const session = await getSession(team.code, day);
  if (!session) {
    await ctx.editMessageText("That day has no archived standup.", { reply_markup: backToMenu() });
    return;
  }
  const members = await teamMembers(team);
  const pendingNames = (await pendingMembers(team.code, day)).map((uid) => nameOf(members, uid));
  const permalink = sessionPermalink(ctx.me.username, team.code, day);
  await ctx.editMessageText(`${formatDigest(team, session, pendingNames)}\n\n🔗 ${permalink}`, {
    reply_markup: inlineKeyboard([
      [inlineButton("⬅️ Back to history", "history:view")],
      backToMenuRow(),
    ]),
  });
});

composer.callbackQuery("history:search", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.flow = "history_search";
  ctx.session.step = "query";
  await ctx.editMessageText(
    "🔎 Send a search. You can combine filters:\n" +
      "• plain words → keyword\n" +
      "• member:Name → only that member\n" +
      "• from:YYYY-MM-DD to:YYYY-MM-DD → date range\n\n" +
      "Example: member:Alex from:2026-06-01 deploy",
  );
});

/** Parse "member:Name from:DATE to:DATE free words" into structured filters. */
function parseFilters(input: string): SearchFilters {
  const filters: SearchFilters = {};
  const words: string[] = [];
  for (const tok of input.trim().split(/\s+/)) {
    const m = /^(member|from|to):(.+)$/i.exec(tok);
    if (m) {
      const key = m[1]!.toLowerCase();
      const val = m[2]!;
      if (key === "member") filters.member = val;
      else if (key === "from") filters.fromDate = val;
      else filters.toDate = val;
    } else if (tok) {
      words.push(tok);
    }
  }
  if (words.length) filters.keyword = words.join(" ");
  return filters;
}

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.flow !== "history_search") return next();
  ctx.session.flow = undefined;
  ctx.session.step = undefined;

  const { id } = actor(ctx);
  const team = await getUserTeam(id);
  if (!team) {
    await ctx.reply(NOT_IN_TEAM, { reply_markup: openTeamKeyboard() });
    return;
  }
  const filters = parseFilters(ctx.message.text);
  if (!filters.keyword && !filters.member && !filters.fromDate && !filters.toDate) {
    await ctx.reply("Please send at least one word or filter to search for.", { reply_markup: backToMenu() });
    return;
  }
  const hits = await searchResponses(team.code, filters);
  if (hits.length === 0) {
    await ctx.reply("No standups matched that search.", { reply_markup: backToMenu() });
    return;
  }
  const shown = hits.slice(0, MAX_SEARCH_RESULTS);
  const blocks = shown
    .map((h) => {
      const permalink = sessionPermalink(ctx.me.username, team.code, h.date);
      const flags = `${h.late ? " (late)" : ""}`;
      return `🗓 ${h.date} — 👤 ${h.name}${flags}\n${h.answers.join("\n")}\n🔗 ${permalink}`;
    })
    .join("\n\n");
  const more = hits.length > shown.length ? `\n\n…and ${hits.length - shown.length} more.` : "";
  await ctx.reply(`🔎 ${hits.length} result(s):\n\n${blocks}${more}`, { reply_markup: backToMenu() });
});

export default composer;
