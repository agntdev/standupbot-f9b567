// Shared UI bits for StandupBot handlers: common keyboards + the "who is acting"
// helper. Pure helpers (one toolkit import) — no handler registration here.

import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard, type InlineKeyboardMarkup } from "../toolkit/index.js";

/** The acting user as { id, name, chatId } — chatId is the DM chat to message. */
export function actor(ctx: Ctx): { id: number; name: string; chatId: number } {
  const u = ctx.from;
  const id = u?.id ?? 0;
  const name = u ? [u.first_name, u.last_name].filter(Boolean).join(" ") || `User ${id}` : `User ${id}`;
  const chatId = ctx.chat?.id ?? id;
  return { id, name, chatId };
}

/** A single "Back to menu" row (re-renders the /start main menu). */
export const backToMenuRow = () => [inlineButton("⬅️ Back to menu", "menu:main")];

export const backToMenu = (): InlineKeyboardMarkup => inlineKeyboard([backToMenuRow()]);

/** Shown when a feature needs a team but the user isn't in one. */
export const NOT_IN_TEAM =
  "You're not in a team yet.\n\nTap 👥 Team to create a team or join one with a code.";

export const openTeamKeyboard = (): InlineKeyboardMarkup =>
  inlineKeyboard([[inlineButton("👥 Team", "team:open")], backToMenuRow()]);
