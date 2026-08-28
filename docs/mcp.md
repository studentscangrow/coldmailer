# MCP server

ColdMailer exposes an MCP (Model Context Protocol) server at `/mcp` so an AI agent (Claude Code,
Claude Desktop, ...) can read and update partner/negotiation data under your own identity and
permissions — the same rules that apply to you in the browser apply to the agent.

## Getting a token

1. Go to **Nastavení → MCP tokeny** (`/settings?tab=api-tokens`).
2. Click **+ Nový token**, give it a name (e.g. "Claude Code"), and copy the value shown —
   it's shown once, the server only ever stores its hash.
3. Revoke it any time from the same screen; a revoked token stops working immediately.

The agent acts as **you**: it sees only projects you have a role in (or all of them, if you're
admin), and can only edit a negotiation if you personally could (same `canEditNegotiation` /
`canEditInteractionRecord` checks as the app UI).

## Connecting Claude Code

```bash
claude mcp add --transport http coldmailer http://localhost:3000/mcp \
  --header "Authorization: Bearer <your token>"
```

Use the deployed URL instead of `localhost:3000` for a non-local instance.

## Available tools

**Read-only**
- `list_projects` — groups/projects you have access to.
- `search_partners` — find partners by name/content, optionally scoped to a project (adds
  `negotiationStatus` and `dealConfidence` when scoped).
- `get_negotiation` — full detail of one partner in one project: contacts, status, dealConfidence
  (Možná/Domluveno), Discord thread link, fulfillment doc link, plnění, to-do, complete
  e-mail/note timeline, and roles (oslovovatel, vyjednavači, plnitelé).
- `get_pipeline_overview` — counts per project: total partners, raw breakdown by
  `negotiationStatus` (deliberately no invented "promising" score — that's a judgment call for
  a human or the agent reading the notes, not something derivable from the status field alone),
  breakdown by `dealConfidence`, e-mails sent, new notes, optionally since a given date.
- `get_activity_feed` — chronological e-mails/notes across all partners in a project since a
  given date. For one specific partner's full history, use `get_negotiation` instead.
- `get_research_prompt` — returns the due-diligence deep-research prompt template used to
  research a new partner candidate (the same one the "Kopírovat research prompt" button on
  `/partners` copies). The app's own automatic deep research was removed (too expensive to run
  on every candidate) — an agent capable of live web search can run this prompt itself and feed
  the resulting JSON into `create_partner`; otherwise hand the prompt to the human.

**Write** (all gated by the same permission checks as the app UI, all logged to the partner's
`RecordEvent` history tagged `source: "mcp"` so agent-made changes are visible and traceable)
- `add_note`, `update_note` — poznámky.
- `update_fulfillment` — "My jim" / "Oni nám" checklisty.
- `update_todo` — To-Do checklist.
- `update_negotiation_status` — stav jednání (cannot set `PRED_OSLOVENIM` — that's not a
  manually-settable state).
- `create_partner` — new GlobalRecord (any authenticated user, matching the REST endpoint);
  optionally joins it straight into a project's Oslovování queue via `projectId`.
- `update_partner` — edits a partner's name/payload (merge semantics: a `null` value deletes
  that key). Unrestricted like the REST endpoint it mirrors — any authenticated user can edit
  any partner, there's no project scoping on a global record.
- `delete_partner` — **admin or Vedení obchodu only** (in any project). Permanent, cascades
  across every project's negotiation history for that partner. This is stricter than most tools
  here on purpose — see below.
- `assign_partner_to_project` — creates/reopens the Negotiation row for a project (Oslovování,
  `PRED_OSLOVENIM`) and optionally sets outreach/negotiation assignees in the same call.
  Admin/Vedení obchodu only.
- `claim_outreach` / `unclaim_outreach` — self-assign/unassign as the outreach owner for a
  partner. Only requires project membership (same as the REST claim/unclaim endpoints).
- `assign_outreach` — assign (or clear, `userId: null`) the outreach owner to *any* user, not
  just yourself. Admin/Vedení obchodu only.

## What's deliberately NOT exposed

Sending e-mail (Gmail send), blacklist management, and GlobalRecord merge/duplicate resolution
stay human-only actions in the app. These are either hard to undo or externally visible, so
they're kept out of the agent's reach — see the comment at the top of `server/utils/mcp-tools.ts`
before adding a tool for any of them. Partner deletion *is* exposed (above), gated behind
`canManagePartnersGlobally` — fixing a real gap: the underlying REST endpoint used to allow any
authenticated user to permanently delete any partner (`server/api/partners/[id].delete.ts` now
enforces the same admin/Vedení obchodu check, not just the MCP tool).

## Rate limiting

Each token is limited to 60 requests/minute (in-memory, per dev-server process — see
`server/utils/mcpRateLimit.ts`). A 429 means the agent is looping; it is not a permission error.
