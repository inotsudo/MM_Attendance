export const DEFAULT_ATTENDANCE_TIME_ZONE = 'Africa/Kigali'

function localParts(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant))
  const values = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]))
  return { year: values.year, month: values.month, day: values.day, hour: values.hour, minute: values.minute, second: values.second }
}

export function zonedIso(year: number, month: number, day: number, hour: number, minute: number, second = 0, timeZone = DEFAULT_ATTENDANCE_TIME_ZONE): string | null {
  if (![year, month, day, hour, minute, second].every(Number.isInteger) || year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null
  const requested = Date.UTC(year, month - 1, day, hour, minute, second)
  const calendarDate = new Date(Date.UTC(year, month - 1, day))
  if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1 || calendarDate.getUTCDate() !== day) return null
  try {
    let instant = requested
    for (let attempt = 0; attempt < 4; attempt++) {
      const represented = localParts(instant, timeZone)
      const representedAsUtc = Date.UTC(represented.year, represented.month - 1, represented.day, represented.hour, represented.minute, represented.second)
      const offset = representedAsUtc - instant
      const adjusted = requested - offset
      if (adjusted === instant) break
      instant = adjusted
    }
    const result = localParts(instant, timeZone)
    if (result.year !== year || result.month !== month || result.day !== day || result.hour !== hour || result.minute !== minute || result.second !== second) return null
    return new Date(instant).toISOString()
  } catch { return null }
}

export function parseSourceDateTime(value: string, timeZone = DEFAULT_ATTENDANCE_TIME_ZONE): { iso: string | null; ambiguous: boolean } {
  const text = value.trim().replace(/^\*+/, '')
  if (!text) return { iso: null, ambiguous: false }

  const explicit = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (explicit) {
    return { iso: zonedIso(+explicit[1], +explicit[2], +explicit[3], +explicit[4], +explicit[5], +(explicit[6] ?? 0), timeZone), ambiguous: false }
  }

  const dayFirst = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (dayFirst) {
    const first = +dayFirst[1]
    const second = +dayFirst[2]
    if (first <= 12 && second <= 12) return { iso: null, ambiguous: true }
    const day = first > 12 ? first : second
    const month = first > 12 ? second : first
    return { iso: zonedIso(+dayFirst[3], month, day, +dayFirst[4], +dayFirst[5], +(dayFirst[6] ?? 0), timeZone), ambiguous: false }
  }

  const offsetTimestamp = Date.parse(text)
  if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(text) && Number.isFinite(offsetTimestamp)) {
    return { iso: new Date(offsetTimestamp).toISOString(), ambiguous: false }
  }
  return { iso: null, ambiguous: false }
}

export function kigaliIso(year: number, month: number, day: number, hour: number, minute: number, second = 0): string | null {
  return zonedIso(year, month, day, hour, minute, second, DEFAULT_ATTENDANCE_TIME_ZONE)
}

export function normalizeEmployeeNumber(value: string | null | undefined): string | null {
  // iVMS prints IDs as text with a leading apostrophe (for example, '123),
  // while the organized workbook stores the same ID without that marker.
  // Ignore only wrapping quote marks for matching; raw source values remain intact.
  const normalized = value?.trim().replace(/^['’]+|['’]+$/g, '').trim().toLocaleUpperCase('en-US')
  return normalized || null
}

export function normalizeEmployeeName(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
  return normalized || null
}
