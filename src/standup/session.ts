// Session shape extension for StandupBot's multi-step flows.
//
// AGENTS.md says don't edit src/bot.ts to wire features in. The bot's `Session`
// interface lives there, but we extend it WITHOUT touching that file via
// TypeScript module augmentation: the fields below merge into `Session`, so every
// handler that types `ctx` as `Ctx` sees them. tsconfig compiles all of `src/`,
// so this augmentation is always in effect. These hold EPHEMERAL conversation
// state only (a guided-input flow's current step + draft) — durable domain data
// lives in the store (see store.ts).

import type {} from "../bot.js";

declare module "../bot.js" {
  interface Session {
    /** Which guided flow the user is currently in (undefined = none). */
    flow?:
      | "team_create"
      | "team_join"
      | "set_channel"
      | "edit_questions"
      | "set_schedule"
      | "standup"
      | "history_search";
    /** The current step within `flow` (flow-specific). */
    step?: string;
    /** Draft standup answers being collected across steps. */
    draftAnswers?: string[];
  }
}
