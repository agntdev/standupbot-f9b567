import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";

// /help — plain-language explanation for non-technical users. This bot is
// button-driven: tell the user to tap /start to open the menu rather than listing
// slash commands. The same text is shown when the user taps the Help button on the
// main menu (`menu:help`). Enhance the copy for your specific bot; keep it short.
const composer = new Composer<Ctx>();

const HELP =
  "🗒️ StandupBot runs your team's async daily standups.\n\n" +
  "Tap /start to open the menu, then:\n" +
  "• 👥 Team — create a team or join one with a code\n" +
  "• ✍️ My Update — post today's standup (yesterday / today / blockers)\n" +
  "• 📊 Today's Digest — see everyone's update in one place\n" +
  "• 🔔 Nudge — remind teammates who haven't posted yet\n" +
  "• 🗂 History — browse and search past standups\n\n" +
  "Everything is reachable by tapping — you don't need to remember any commands.";

const backToMenu = inlineKeyboard([[inlineButton("⬅️ Back to menu", "menu:main")]]);

composer.command("help", async (ctx) => {
  await ctx.reply(HELP);
});

composer.callbackQuery("menu:help", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(HELP, { reply_markup: backToMenu });
});

export default composer;
