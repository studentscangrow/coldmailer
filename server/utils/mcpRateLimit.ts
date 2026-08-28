// Simple in-memory fixed-window limiter per API token, so a misbehaving/looping agent can't
// hammer the DB. Deliberately not persisted/shared across processes — same "good enough for
// one dev-server process" tradeoff as outreach-scheduler.ts's in-memory timer map.
const WINDOW_MS = 60_000
const MAX_REQUESTS_PER_WINDOW = 60

const windows = new Map<string, { count: number; windowStart: number }>()

export function checkMcpRateLimit(tokenId: string): boolean {
  const now = Date.now()
  const entry = windows.get(tokenId)

  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    windows.set(tokenId, { count: 1, windowStart: now })
    return true
  }

  entry.count++
  return entry.count <= MAX_REQUESTS_PER_WINDOW
}
