const KIGALI_OFFSET_MINUTES = 120

export function parseSourceDateTime(value: string): { iso: string | null; ambiguous: boolean } {
  const text = value.trim().replace(/^\*+/, '')
  if (!text) return { iso: null, ambiguous: false }

  const explicit = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (explicit) {
    return { iso: kigaliIso(+explicit[1], +explicit[2], +explicit[3], +explicit[4], +explicit[5], +(explicit[6] ?? 0)), ambiguous: false }
  }

  const dayFirst = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (dayFirst) {
    const first = +dayFirst[1]
    const second = +dayFirst[2]
    if (first <= 12 && second <= 12) return { iso: null, ambiguous: true }
    const day = first > 12 ? first : second
    const month = first > 12 ? second : first
    return { iso: kigaliIso(+dayFirst[3], month, day, +dayFirst[4], +dayFirst[5], +(dayFirst[6] ?? 0)), ambiguous: false }
  }

  const offsetTimestamp = Date.parse(text)
  if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(text) && Number.isFinite(offsetTimestamp)) {
    return { iso: new Date(offsetTimestamp).toISOString(), ambiguous: false }
  }
  return { iso: null, ambiguous: false }
}

export function kigaliIso(year: number, month: number, day: number, hour: number, minute: number, second = 0): string | null {
  if (![year, month, day, hour, minute, second].every(Number.isInteger)) return null
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null
  const utc = Date.UTC(year, month - 1, day, hour, minute, second) - KIGALI_OFFSET_MINUTES * 60_000
  const check = new Date(Date.UTC(year, month - 1, day))
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null
  return new Date(utc).toISOString()
}

export function normalizeEmployeeNumber(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLocaleUpperCase('en-US')
  return normalized || null
}

export function normalizeEmployeeName(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
  return normalized || null
}
