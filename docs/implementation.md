# StandupBot — Implementation notes

Companion to the contract in [`blueprint.md`](./blueprint.md). This documents how
the bot realises the spec, and — honestly — where it is partial. The bot is
button-first on grammY + the vendored `@agntdev/bot-toolkit`; it is refined across
successive build passes.

## Coverage against the blueprint

| Blueprint item | Status | Notes |
|---|---|---|
| Entry point `/start`, `/help` | ✅ | Menu + plain-language help (StandupBot copy). |
| `team:create` (Create Team) | ✅ | Name → team with default questions/timezone/schedule; creator = owner + opted-in. |
| `history:view` (View History) | ✅ | Paginated day list; open any day; search. |
| Team Creation flow | ✅ (config in admin menu) | Name at create; channel / questions / schedule / timezone set from the team admin menu. |
| Daily Standup Cycle | ◑ partial | Owner "📣 Open today's standup" broadcasts prompts to opted-in members; responses collected with a clock-based cutoff; nudge; digest; archive. **Time-based scheduling per member timezone is not wired (no cron in the toolkit)** — see "Scheduler boundary". |
| History Search (date + member + keyword) | ✅ | Combined filters via `member:` / `from:` / `to:` tokens + free keyword; results carry session permalinks. |
| Admin Controls | ◑ partial | Edit questions, set schedule (time/timezone/cutoff), set channel, toggle admin-summary, member opt-in/out. Per-member removal/permissions are deferred. |
| Data entities (Team, Member, Standup Session, Digest, History Entry) | ✅ | Modelled in `src/standup/store.ts`; Digest/History are derived from sessions. A session is persisted only by a real response or the owner explicitly opening the standup — viewing the digest is read-only (no phantom days). |
| Opt-in participation | ✅ | Members opt in on join; can opt out; only opted-in members are prompted / nudged / counted pending. |
| Late responses archived, excluded from digest | ✅ | `recordResponse` flags `late` when `now() > cutoffAt`; digest shows on-time only; history search still finds late ones. |
| Partial single-message answers marked incomplete | ✅ | A multi-line first reply is split per question and flagged incomplete if short. |
| Channel posting failure → owner error DM | ✅ | Guarded; on failure the owner is DM'd and the user still sees the digest. |
| Nudge (single per day) | ✅ | Enforced on the session; DMs only pending opted-in members; guarded sends. |
| Session permalinks | ◑ partial | Shareable `t.me/<bot>?start=s_<code>_<date>` links are shown; resolving an inbound deep-link to render that session is a next pass. |

## Scheduler boundary (the one structural gap)

The blueprint's headline flow is *scheduled per member timezone* with a cutoff and
a nudge 30 min before it. The toolkit provides no scheduler/cron and the test
harness can't advance time, so a literal timer cannot run here. Instead the full
cycle is exposed as real, testable actions:

- **Prompt** — owner taps "📣 Open today's standup"; the bot opens the session
  and DMs the question set to every opted-in member.
- **Cutoff / late** — each team has `scheduledTime`, `timezone`, `cutoffHours`
  (default +2h). `openSession` stamps `cutoffAt`; responses after it are archived
  but excluded from the digest.
- **Nudge** — single per day, to pending members.
- **Digest** — consolidated on-time responses, posted to the channel if linked.

Wiring this to a real cron (e.g. a deploy-time scheduler that calls the same
"open session + broadcast" path per team timezone at `scheduledTime`, and triggers
the nudge 30 min before `cutoffAt`) is the remaining step and is a deployment
concern, not a code change to the handlers.

## Architecture

```
src/
├── bot.ts                 # buildBot() — toolkit-provided; auto-loads handlers/ (UNCHANGED)
├── handlers/              # one Composer per feature, auto-loaded
│   ├── start.ts  help.ts  # menu + help (help copy customised)
│   ├── team.ts            # 👥 Team: create/join/leave/opt-in + owner config
│   ├── standup.ts         # ✍️ My Update + owner "Open today's standup" broadcast
│   ├── digest.ts          # 📊 Today's Digest (read-only view + channel post, owner error DM)
│   ├── nudge.ts           # 🔔 Nudge (single/day, pending only)
│   └── history.ts         # 🗂 History (history:view) + filtered search + permalinks
└── standup/               # shared, non-handler modules
    ├── store.ts           # session-model repository over the toolkit StorageAdapter
    ├── format.ts          # plain-text digest/response rendering
    ├── session.ts         # Session-type augmentation for flow state (no bot.ts edit)
    └── ui.ts              # shared keyboards + actor() identity helper
```

### Durable storage

`store.ts` is a typed repository over the toolkit's `resolveSessionStorage` — so
domain data is **Redis-backed in production** (`REDIS_URL`) and in-memory for
dev/tests, never a process-memory `Map`. Every read/write is `await`-ed (the Redis
adapter is async), and collections are reached via explicit indices
(`Team.memberIds[]`, `Team.days[]`) rather than `readAllKeys()` — whose shape
differs between adapters — which is also the correct Redis pattern.

Keys: `team:<code>`, `member:<userId>`, `session:<code>:<date>`.

A clock (`now()` / `today()`, with `_setNow` / `_setToday` test hooks) makes the
cutoff / late logic deterministic in tests.

## Testing — 70 passing (`npm install && npm run build && npm test`)

- **Declarative specs** (`tests/specs/*.json`) — happy paths + `/start` `/help`
  command coverage, replayed tokenlessly; run with per-spec store reset in
  `specs-runner.test.ts`.
- **Programmatic tests** — multi-member aggregation, configurable questions, owner
  broadcast, opt-out, nudge idempotency/targeting, channel posting, multi-day
  history, combined-filter search, and **adversarial paths** (blocked member;
  failing channel + failing owner DM) — the failure class the always-`ok:true`
  harness can't reach.

## Known limitations (next passes)

- Per-member-timezone scheduling needs a deploy-time cron (above).
- Telegram's 4096-char message cap isn't chunked — a very large digest/search
  could exceed it.
- Session-permalink deep links are shown but not yet resolved on inbound `/start`.
- Past-day digests read off the current member list, so a departed member's
  pending status in old digests reflects today's roster (their archived responses
  are preserved and searchable).
