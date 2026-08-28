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
- `search_partners` — find partners by name/content, optionally scoped to a project.
- `get_negotiation` — full detail of one partner in one project: contacts, status, plnění,
  to-do, complete e-mail/note timeline, and roles (oslovovatel, vyjednavači, plnitelé).
- `get_pipeline_overview` — counts per project: total partners, raw breakdown by
  `negotiationStatus` (deliberately no invented "promising" score — that's a judgment call for
  a human or the agent reading the notes, not something derivable from the status field alone),
  e-mails sent, new notes, optionally since a given date.
- `get_activity_feed` — chronological e-mails/notes across all partners in a project since a
  given date. For one specific partner's full history, use `get_negotiation` instead.

**Write** (all gated by the same permission checks as the app UI, all logged to the partner's
`RecordEvent` history tagged `source: "mcp"` so agent-made changes are visible and traceable)
- `add_note`, `update_note` — poznámky.
- `update_fulfillment` — "My jim" / "Oni nám" checklisty.
- `update_todo` — To-Do checklist.
- `update_negotiation_status` — stav jednání (cannot set `PRED_OSLOVENIM` — that's not a
  manually-settable state).

## What's deliberately NOT exposed

Sending e-mail (Gmail send), deleting anything, blacklist management, and GlobalRecord
merge/duplicate resolution stay human-only actions in the app. These are either hard to undo or
externally visible, so they're kept out of the agent's reach — see the comment at the top of
`server/utils/mcp-tools.ts` before adding a tool for any of them.

## Rate limiting

Each token is limited to 60 requests/minute (in-memory, per dev-server process — see
`server/utils/mcpRateLimit.ts`). A 429 means the agent is looping; it is not a permission error.
