# StandupBot — Bot specification

**Archetype:** workflow

StandupBot automates asynchronous daily standups for distributed teams via Telegram. It privately prompts opted-in members with configurable questions on a per-team schedule, collects responses until a cutoff time, and posts a consolidated digest to the team's channel. Late responses are archived but excluded from digests by default. All data is persistent and searchable via history filters.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- Team leads / managers
- Distributed team members

## Success criteria

- Daily standup digests posted to team channels
- Members receive private prompts and can submit responses
- History search returns session permalinks with filters

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Open main menu with Create Team, View History, and Help options
- **Create Team** (button, actor: user, callback: team:create) — Initiate team creation flow for owner/admin
  - inputs: team name, channel ID, working days, timezone rules, default questions
  - outputs: Team entity created with owner assigned
- **View History** (button, actor: user, callback: history:view) — Access archived sessions with filters
  - inputs: date range, member name, keyword
  - outputs: Session permalinks or summarized results
- **/help** (command, actor: user, command: /help) — Display help documentation

## Flows

### Daily Standup Cycle
_Trigger:_ scheduled per member timezone

1. Send private DM with team questions to opted-in members
2. Collect responses until cutoff time (2h after schedule by default)
3. Send nudge to non-responders 30min before cutoff
4. Generate digest and post to team channel
5. Archive session data with metadata

_Data touched:_ Team, Member, Standup Session, Digest, History Entry

### Team Creation
_Trigger:_ Create Team button

1. Collect team name and channel ID
2. Configure working days and timezone rules
3. Set default questions
4. Create Team entity with owner as admin

_Data touched:_ Team, Member

### History Search
_Trigger:_ View History button

1. Request date range filter
2. Request member name filter
3. Request keyword search
4. Return matching session permalinks

_Data touched:_ History Entry

### Admin Controls
_Trigger:_ owner-only menu access

1. Update team configuration
2. Modify member list
3. Adjust schedule parameters
4. Toggle admin summary DM

_Data touched:_ Team, Member

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

- **Team** _(retention: persistent)_ — Team configuration and channel information
  - fields: name, channel_id, working_days, timezone_rules, questions, member_list
- **Member** _(retention: persistent)_ — Team member profile and participation status
  - fields: telegram_id, display_name, timezone, opt_in_status, skip_flags
- **Standup Session** _(retention: persistent)_ — Daily standup collection and timing data
  - fields: session_id, date, scheduled_time, cutoff_time, questions, responses, nudged_status, blocker_tags
- **Digest** _(retention: persistent)_ — Consolidated standup summary for team channel
  - fields: session_id, session_metadata, member_answers, blocker_highlights, pending_list
- **History Entry** _(retention: persistent)_ — Archived standup session data
  - fields: session_id, full_responses, metadata

## Integrations

- **Telegram** (required) — Bot API messaging
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- Create and configure teams
- Modify member lists and permissions
- Adjust schedule parameters
- Toggle admin summary DM
- Update team questions and timezone rules

## Notifications

- Digest posted to team channel
- Error DM to owner if channel posting fails
- Nudge DM to non-responders 30min before cutoff

## Permissions & privacy

- Members must opt-in to participate
- Responses tied to user identity
- Owner is sole admin initially

## Edge cases

- Members without timezone use team default
- Late responses after cutoff are archived but excluded from digest by default
- Partial answers in single-message replies are parsed and marked as incomplete
- Channel posting failures trigger owner error notification

## Required tests

- End-to-end digest generation with all response states
- Nudge timing accuracy across timezones
- History search with combined filters (date + member + keyword)

## Assumptions

- Default questions provided if not customized
- Single nudge 30min before cutoff
- Cutoff time is 2h after scheduled time
- First team creator becomes owner
- Auto-invite DM sent to new members
- Missing member timezones default to team timezone with owner alert
- Late responses saved but excluded from digest by default
