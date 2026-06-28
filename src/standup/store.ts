// StandupBot durable store (session model).
//
// A typed repository over the toolkit's persistent StorageAdapter. In production
// (REDIS_URL set) `resolveSessionStorage` returns a Redis-backed adapter; in
// development / under the test harness it falls back to the in-memory adapter. We
// reuse that SAME selection so the bot's DURABLE domain data (teams, members,
// standup sessions) is Redis-backed in prod with zero extra config — and is NOT a
// process-memory Map standing in for a database (see AGENTS.md).
//
// Adapter-contract rules honoured throughout:
//   1. Every read/write is `await`-ed (the Redis adapter is async).
//   2. Collections are NEVER discovered via `readAllKeys()` (its shape differs
//      between adapters). Every collection hangs off an explicit index: a Team
//      carries `memberIds[]` and `days[]`, so digests read computed keys and
//      history walks the day index. This is also the correct Redis pattern.
//
// Clock: `now()` / `today()` are injectable (`_setNow` / `_setToday`) so the
// cutoff / late-response logic is deterministically testable without real time.

import { randomUUID } from "node:crypto";
import type { StorageAdapter } from "grammy";
import { resolveSessionStorage } from "../toolkit/index.js";

// ---------------------------------------------------------------------------
// Defaults (the blueprint: "default questions provided if not customized")
// ---------------------------------------------------------------------------

export const DEFAULT_QUESTIONS = [
  "What did you do yesterday?",
  "What will you work on today?",
  "Any blockers?",
];
export const DEFAULT_TIMEZONE = "UTC";
export const DEFAULT_WORKING_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
export const DEFAULT_SCHEDULE = "09:00";
export const DEFAULT_CUTOFF_HOURS = 2;

const BLANK_BLOCKERS = new Set(["", "none", "no", "n/a", "na", "nope", "nothing"]);

// ---------------------------------------------------------------------------
// Domain types (blueprint entities: Team, Member, Standup Session)
// ---------------------------------------------------------------------------

export interface Team {
  code: string;
  name: string;
  ownerId: number;
  channelId?: number;
  timezone: string;
  workingDays: string[];
  questions: string[];
  scheduledTime: string; // "HH:MM" team-local
  cutoffHours: number;
  adminSummary: boolean;
  memberIds: number[];
  days: string[]; // ascending session dates (history index)
}

export interface Member {
  telegramId: number;
  displayName: string;
  dmChatId: number;
  teamCode: string;
  timezone?: string;
  optIn: boolean;
  skipFlags: string[];
}

export interface Response {
  userId: number;
  name: string;
  answers: string[];
  late: boolean;
  incomplete: boolean;
  ts: number;
}

export interface Session {
  code: string;
  date: string;
  scheduledAt: number;
  cutoffAt: number;
  questions: string[];
  responses: Record<string, Response>;
  nudged: boolean;
  status: "open" | "closed";
}

// ---------------------------------------------------------------------------
// Adapter + clock
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let adapter: StorageAdapter<any> = resolveSessionStorage<Record<string, unknown>>(undefined);

let frozenNow: number | null = null;
let frozenDay: string | null = null;

/** Current epoch ms (frozen value wins, for tests). */
export function now(): number {
  return frozenNow ?? Date.now();
}

/** The standup "day" as YYYY-MM-DD (frozen value wins, then derived from now()). */
export function today(): string {
  if (frozenDay) return frozenDay;
  return new Date(now()).toISOString().slice(0, 10);
}

/** TEST HOOK — pin epoch ms (or null to use the real clock). */
export function _setNow(ms: number | null): void {
  frozenNow = ms;
}

/** TEST HOOK — pin `today()` to a fixed date (or null). */
export function _setToday(day: string | null): void {
  frozenDay = day;
}

/** TEST HOOK — drop all data + unfreeze clocks. Never call in production. */
export function _reset(): void {
  adapter = resolveSessionStorage<Record<string, unknown>>(undefined);
  frozenNow = null;
  frozenDay = null;
}

// ---------------------------------------------------------------------------
// Low-level KV (the only place the adapter is touched)
// ---------------------------------------------------------------------------

async function get<T>(key: string): Promise<T | undefined> {
  return (await adapter.read(key)) as T | undefined;
}
async function put<T extends object>(key: string, value: T): Promise<void> {
  await adapter.write(key, value);
}
async function drop(key: string): Promise<void> {
  await adapter.delete(key);
}

const teamKey = (code: string) => `team:${code}`;
const memberKey = (userId: number) => `member:${userId}`;
const sessionKey = (code: string, date: string) => `session:${code}:${date}`;

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

async function freshCode(): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const code = randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
    if (!(await get<Team>(teamKey(code)))) return code;
  }
  return randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase();
}

export async function getTeam(code: string): Promise<Team | undefined> {
  return get<Team>(teamKey(code));
}

export async function getMember(userId: number): Promise<Member | undefined> {
  return get<Member>(memberKey(userId));
}

/** The team a user currently belongs to, or undefined. */
export async function getUserTeam(userId: number): Promise<Team | undefined> {
  const m = await getMember(userId);
  if (!m) return undefined;
  return getTeam(m.teamCode);
}

/** Create a team with sensible defaults; creator becomes owner + opted-in member. */
export async function createTeam(
  name: string,
  ownerId: number,
  ownerName: string,
  dmChatId: number,
): Promise<Team> {
  await leaveTeam(ownerId);
  const code = await freshCode();
  const team: Team = {
    code,
    name,
    ownerId,
    timezone: DEFAULT_TIMEZONE,
    workingDays: [...DEFAULT_WORKING_DAYS],
    questions: [...DEFAULT_QUESTIONS],
    scheduledTime: DEFAULT_SCHEDULE,
    cutoffHours: DEFAULT_CUTOFF_HOURS,
    adminSummary: false,
    memberIds: [ownerId],
    days: [],
  };
  await put(teamKey(code), team);
  await put(memberKey(ownerId), {
    telegramId: ownerId,
    displayName: ownerName,
    dmChatId,
    teamCode: code,
    optIn: true,
    skipFlags: [],
  } satisfies Member);
  return team;
}

/** Owner-editable team configuration. */
export type TeamConfig = Partial<
  Pick<Team, "channelId" | "questions" | "timezone" | "workingDays" | "scheduledTime" | "cutoffHours" | "adminSummary">
>;

export async function updateTeam(code: string, patch: TeamConfig): Promise<Team | undefined> {
  const team = await getTeam(code);
  if (!team) return undefined;
  Object.assign(team, patch);
  await put(teamKey(code), team);
  return team;
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

/** Join a team by code (opted-in by default). Returns undefined if no such team. */
export async function joinTeam(
  code: string,
  userId: number,
  name: string,
  dmChatId: number,
): Promise<Team | undefined> {
  const team = await getTeam(code);
  if (!team) return undefined;
  await leaveTeam(userId);
  if (!team.memberIds.includes(userId)) team.memberIds.push(userId);
  await put(teamKey(code), team);
  await put(memberKey(userId), {
    telegramId: userId,
    displayName: name,
    dmChatId,
    teamCode: code,
    optIn: true,
    skipFlags: [],
  } satisfies Member);
  return team;
}

export async function leaveTeam(userId: number): Promise<void> {
  const m = await getMember(userId);
  if (!m) return;
  const team = await getTeam(m.teamCode);
  if (team) {
    team.memberIds = team.memberIds.filter((id) => id !== userId);
    await put(teamKey(team.code), team);
  }
  await drop(memberKey(userId));
}

export async function setOptIn(userId: number, optIn: boolean): Promise<Member | undefined> {
  const m = await getMember(userId);
  if (!m) return undefined;
  m.optIn = optIn;
  await put(memberKey(userId), m);
  return m;
}

/** Members of a team, in join order. */
export async function teamMembers(team: Team): Promise<Member[]> {
  const out: Member[] = [];
  for (const id of team.memberIds) {
    const m = await getMember(id);
    if (m) out.push(m);
  }
  return out;
}

/** Opted-in members only (who the daily cycle prompts / nudges). */
export async function optedInMembers(team: Team): Promise<Member[]> {
  return (await teamMembers(team)).filter((m) => m.optIn);
}

/** Display name for a member id (best-effort, sync-friendly via a members map). */
export function nameOf(members: Member[], userId: number): string {
  return members.find((m) => m.telegramId === userId)?.displayName ?? `Member ${userId}`;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Open today's (or a given day's) session, snapshotting the team's questions and
 *  computing the cutoff from `cutoffHours`. Idempotent: returns the existing one. */
export async function openSession(code: string, date?: string): Promise<Session | undefined> {
  const team = await getTeam(code);
  if (!team) return undefined;
  const day = date ?? today();
  const existing = await get<Session>(sessionKey(code, day));
  if (existing) return existing;
  const scheduledAt = now();
  const session: Session = {
    code,
    date: day,
    scheduledAt,
    cutoffAt: scheduledAt + team.cutoffHours * 3_600_000,
    questions: [...team.questions],
    responses: {},
    nudged: false,
    status: "open",
  };
  await put(sessionKey(code, day), session);
  if (!team.days.includes(day)) {
    team.days.push(day);
    team.days.sort();
    await put(teamKey(code), team);
  }
  return session;
}

export async function getSession(code: string, date: string): Promise<Session | undefined> {
  return get<Session>(sessionKey(code, date));
}

/** An UNPERSISTED empty session for read-only rendering (e.g. an empty digest)
 *  so merely viewing a day doesn't archive a phantom session. */
export function transientSession(team: Team, date: string): Session {
  const scheduledAt = now();
  return {
    code: team.code,
    date,
    scheduledAt,
    cutoffAt: scheduledAt + team.cutoffHours * 3_600_000,
    questions: [...team.questions],
    responses: {},
    nudged: false,
    status: "open",
  };
}

/** Record (or overwrite) a member's response for today, computing late/incomplete.
 *  Auto-opens the session if the owner hasn't explicitly opened one. */
export async function recordResponse(
  code: string,
  userId: number,
  name: string,
  answers: string[],
): Promise<{ session: Session; response: Response } | undefined> {
  const session = (await getSession(code, today())) ?? (await openSession(code));
  if (!session) return undefined;
  const late = now() > session.cutoffAt;
  const incomplete =
    answers.length < session.questions.length || answers.some((a) => a.trim() === "");
  const response: Response = {
    userId,
    name,
    answers,
    late,
    incomplete,
    ts: now(),
  };
  session.responses[userId] = response;
  await put(sessionKey(code, session.date), session);
  return { session, response };
}

export async function setNudged(code: string, date: string): Promise<boolean> {
  const session = await getSession(code, date);
  if (!session || session.nudged) return false;
  session.nudged = true;
  await put(sessionKey(code, date), session);
  return true;
}

export async function closeSession(code: string, date: string): Promise<Session | undefined> {
  const session = await getSession(code, date);
  if (!session) return undefined;
  session.status = "closed";
  await put(sessionKey(code, date), session);
  return session;
}

/** On-time responses (the digest content). Late responses are archived but excluded. */
export function onTimeResponses(session: Session): Response[] {
  return Object.values(session.responses).filter((r) => !r.late);
}

export function lateResponses(session: Session): Response[] {
  return Object.values(session.responses).filter((r) => r.late);
}

/** Blocker highlights: on-time responses whose last answer names a real blocker. */
export function blockerHighlights(session: Session): Response[] {
  return onTimeResponses(session).filter((r) => {
    const last = (r.answers[r.answers.length - 1] ?? "").trim().toLowerCase();
    return last !== "" && !BLANK_BLOCKERS.has(last);
  });
}

/** Opted-in member ids with no on-time response yet. */
export async function pendingMembers(code: string, date: string): Promise<number[]> {
  const team = await getTeam(code);
  if (!team) return [];
  const session = await getSession(code, date);
  const responded = new Set(
    session ? onTimeResponses(session).map((r) => r.userId) : [],
  );
  return (await optedInMembers(team)).map((m) => m.telegramId).filter((id) => !responded.has(id));
}

// ---------------------------------------------------------------------------
// History & search (walk the day index — never a key scan)
// ---------------------------------------------------------------------------

export async function historyDays(code: string): Promise<string[]> {
  const team = await getTeam(code);
  if (!team) return [];
  return [...team.days].sort().reverse();
}

export interface SearchFilters {
  keyword?: string;
  member?: string;
  fromDate?: string;
  toDate?: string;
}

export interface SearchHit {
  date: string;
  userId: number;
  name: string;
  answers: string[];
  late: boolean;
}

/** Search archived responses by any combination of keyword + member + date range. */
export async function searchResponses(code: string, filters: SearchFilters): Promise<SearchHit[]> {
  const team = await getTeam(code);
  if (!team) return [];
  const kw = filters.keyword?.trim().toLowerCase() ?? "";
  const member = filters.member?.trim().toLowerCase() ?? "";
  const hits: SearchHit[] = [];
  for (const day of [...team.days].sort().reverse()) {
    if (filters.fromDate && day < filters.fromDate) continue;
    if (filters.toDate && day > filters.toDate) continue;
    const session = await getSession(code, day);
    if (!session) continue;
    for (const r of Object.values(session.responses)) {
      if (member && !r.name.toLowerCase().includes(member)) continue;
      if (kw) {
        const hay = `${r.name}\n${r.answers.join("\n")}`.toLowerCase();
        if (!hay.includes(kw)) continue;
      }
      hits.push({ date: day, userId: r.userId, name: r.name, answers: r.answers, late: r.late });
    }
  }
  return hits;
}

/** A stable deep-link permalink to a day's session digest. */
export function sessionPermalink(botUsername: string, code: string, date: string): string {
  return `https://t.me/${botUsername}?start=s_${code}_${date}`;
}
