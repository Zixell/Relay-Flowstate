import type { RateLimitInfo } from '../agents/adapter'

/** The earliest future reset among limits that are used up; undefined when none is. */
export function blockedResetAt(limits: RateLimitInfo[] | undefined, now = Date.now()): number | undefined {
  const resets = (limits ?? [])
    .filter((l) => (l.status === 'blocked' || (l.usedPercent ?? 0) >= 100) && l.resetsAt && l.resetsAt > now)
    .map((l) => l.resetsAt!)
  return resets.length ? Math.min(...resets) : undefined
}

/** Offset of a time zone from UTC at the given instant, in milliseconds. */
function zoneOffset(timeZone: string, at: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
      .formatToParts(at)
      .map((p) => [p.type, Number(p.value)])
  )
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(at / 1000) * 1000
}

/**
 * The next moment a limit message's "resets 10pm (Asia/Novosibirsk)" points at.
 * Only a time of day is understood; anything else gives undefined.
 */
export function parseResetTime(text: string, now = Date.now()): number | undefined {
  const m = /resets\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i.exec(text)
  if (!m) return undefined
  let hour = Number(m[1])
  const minute = m[2] ? Number(m[2]) : 0
  const meridiem = m[3]?.toLowerCase()
  if (meridiem === 'pm' && hour < 12) hour += 12
  if (meridiem === 'am' && hour === 12) hour = 0
  if (hour > 23 || minute > 59) return undefined

  const timeZone = m[4]?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone
  try {
    // Today's date in that zone, at the given wall-clock time
    const today = new Date(now + zoneOffset(timeZone, now))
    const wall = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), hour, minute)
    let at = wall - zoneOffset(timeZone, wall)
    if (at <= now) at += 24 * 60 * 60 * 1000
    return at
  } catch {
    // Unknown time zone
    return undefined
  }
}
