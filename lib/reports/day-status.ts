import type { ReportDayCell } from './types'

export function reportDayStatus(day: ReportDayCell) {
  if (day.kind === 'no_records') return 'No source records'
  if (day.kind === 'fingerprint_events') return 'Calculation missing · reprocess import'
  if (day.kind === 'stale') return 'Stale · review'
  if (day.kind === 'organized_evidence') return 'Incomplete · review'

  const status = day.classification === '—' ? 'Unclassified' : day.classification
  const incomplete = day.completeness !== 'Evidence complete'
  const review = day.notes.length > 0
  return [status, incomplete ? 'Incomplete' : 'Complete', day.overtime === 'Yes' ? 'OT evidence' : null, day.overtime === 'Unverified' ? 'OT review' : null, review ? 'Review' : null]
    .filter(Boolean)
    .join(' · ')
}
