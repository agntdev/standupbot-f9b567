// StandupBot text rendering. Plain text only (no parse_mode) — so user-typed
// content can never break Markdown/HTML parsing. Shared by the digest and history
// handlers so a day's digest looks identical everywhere.

import type { Response, Session, Team } from "./store.js";
import { blockerHighlights, onTimeResponses } from "./store.js";

/** One member's response block, aligned to the session's questions. */
export function formatResponse(questions: string[], r: Response): string {
  const lines = [`👤 ${r.name}${r.incomplete ? " (incomplete)" : ""}${r.late ? " (late)" : ""}`];
  for (let i = 0; i < questions.length; i++) {
    lines.push(`• ${questions[i]} ${r.answers[i] ?? "—"}`);
  }
  return lines.join("\n");
}

/**
 * The consolidated digest for a session: on-time responses, a blocker-highlight
 * line, and who is still pending. Late responses are archived but excluded here.
 */
export function formatDigest(team: Team, session: Session, pendingNames: string[]): string {
  const header = `📊 ${team.name} — standup for ${session.date}`;
  const onTime = onTimeResponses(session);
  if (onTime.length === 0) {
    return `${header}\n\nNo on-time updates yet. Tap ✍️ My Update to post yours.`;
  }
  const blocks = onTime.map((r) => formatResponse(session.questions, r)).join("\n\n");
  const blockers = blockerHighlights(session);
  const blockerLine = blockers.length
    ? `🚧 Blockers from: ${blockers.map((r) => r.name).join(", ")}`
    : "🚧 No blockers reported.";
  const pendingLine =
    pendingNames.length === 0
      ? "✅ Everyone has checked in."
      : `⏳ Still pending: ${pendingNames.join(", ")}`;
  return `${header}\n\n${blocks}\n\n${blockerLine}\n${pendingLine}`;
}
