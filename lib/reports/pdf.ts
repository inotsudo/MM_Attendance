import type { AttendanceReport, ReportDayCell } from './types'
import { formatKigaliDateTime } from './dataset'

const PAGE_W = 1190
const PAGE_H = 842
const MARGIN = 36
const NAVY = [0.15, 0.20, 0.35] as const

type Rgb = readonly [number, number, number]
type PdfPage = { title: string; commands: string[] }

function winAnsi(value: string) {
  const special = new Map<number, number>([[0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97], [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f]])
  return [...value.normalize('NFKD')].flatMap((character) => {
    const point = character.codePointAt(0) ?? 63
    if (point >= 0x300 && point <= 0x36f) return []
    if (special.has(point)) return [special.get(point)!]
    if (point >= 32 && point <= 126 || point >= 160 && point <= 255) return [point]
    return [63]
  })
}

function pdfText(value: string) {
  return `${pdfHexString(value)} Tj`
}

function pdfHexString(value: string) { return `<${winAnsi(value).map((byte) => byte.toString(16).padStart(2, '0')).join('')}>` }

function point(value: number) { return Math.round(value * 100) / 100 }
function rgb(color: Rgb) { return color.map(point).join(' ') }

function drawText(commands: string[], x: number, top: number, value: string, size = 8, bold = false, color: Rgb = [0.18, 0.18, 0.22]) {
  const y = PAGE_H - top - size
  commands.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${rgb(color)} rg 1 0 0 1 ${point(x)} ${point(y)} Tm ${pdfText(value)} ET`)
}

function rect(commands: string[], x: number, top: number, width: number, height: number, fill: Rgb, stroke?: Rgb) {
  const y = PAGE_H - top - height
  commands.push(`${rgb(fill)} rg ${stroke ? `${rgb(stroke)} RG ` : ''}${point(x)} ${point(y)} ${point(width)} ${point(height)} re ${stroke ? 'B' : 'f'}`)
}

function line(commands: string[], x1: number, top1: number, x2: number, top2: number, color: Rgb = [0.82, 0.82, 0.86], width = 0.5) {
  commands.push(`${rgb(color)} RG ${point(width)} w ${point(x1)} ${point(PAGE_H - top1)} m ${point(x2)} ${point(PAGE_H - top2)} l S`)
}

function wrap(value: string, maxCharacters: number, maxLines = 3) {
  const words = value.replace(/\s+/g, ' ').trim().split(' ')
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (word.length > maxCharacters) {
      if (current) { lines.push(current); current = '' }
      for (let index = 0; index < word.length; index += maxCharacters) lines.push(word.slice(index, index + maxCharacters))
      continue
    }
    const next = current ? `${current} ${word}` : word
    if (next.length > maxCharacters && current) { lines.push(current); current = word }
    else current = next
  }
  if (current) lines.push(current)
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines)
    kept[maxLines - 1] = `${kept[maxLines - 1].slice(0, Math.max(0, maxCharacters - 3))}...`
    return kept
  }
  return lines.length ? lines : ['']
}

function dayColor(day: ReportDayCell): Rgb {
  if (day.kind === 'no_records' || day.kind === 'stale' || day.overtime === 'Unverified') return [1, 0.94, 0.88]
  if (day.classification === 'Very late') return [0.99, 0.88, 0.88]
  if (day.classification === 'Late') return [1, 0.96, 0.84]
  if (day.kind === 'fingerprint_events') return [0.91, 0.95, 0.99]
  return [0.91, 0.96, 0.92]
}

function pageHeader(page: PdfPage, report: AttendanceReport) {
  const c = page.commands
  rect(c, 0, 0, PAGE_W, 78, NAVY)
  drawText(c, MARGIN, 18, report.metadata.organization, 11, true, [1, 1, 1])
  drawText(c, MARGIN, 38, report.metadata.title, 18, true, [1, 1, 1])
  drawText(c, PAGE_W - 385, 20, `Period: ${report.metadata.periodStart} to ${report.metadata.periodEnd}`, 9, true, [1, 1, 1])
  drawText(c, PAGE_W - 385, 40, `Generated ${formatKigaliDateTime(report.metadata.generatedAt)} (${report.metadata.timezone})`, 8, false, [1, 1, 1])
  drawText(c, MARGIN, 91, `Employees ${report.summary.employeesIncluded}  |  Calculated days ${report.summary.attendanceDaysCalculated}  |  Late ${report.summary.lateDays}  |  Very late ${report.summary.veryLateDays}  |  Verified overtime ${report.summary.verifiedOvertimeDays}  |  Review exceptions ${report.summary.reviewExceptions}`, 8, true, NAVY)
  drawText(c, MARGIN, 107, page.title, 11, true, NAVY)
}

function finishPage(page: PdfPage, index: number, total: number, report: AttendanceReport) {
  drawText(page.commands, MARGIN, PAGE_H - 25, `MM&RJD | Confidential employee information | Report ${report.metadata.reportId}`, 7, false, [0.38, 0.38, 0.43])
  const pageLabel = `Page ${index + 1} of ${total}`
  drawText(page.commands, PAGE_W - MARGIN - pageLabel.length * 4, PAGE_H - 25, pageLabel, 7, true, [0.38, 0.38, 0.43])
}

function employeePages(report: AttendanceReport) {
  const columns = [
    { label: 'Employee ID', width: 62 }, { label: 'Employee name', width: 108 }, { label: 'Department', width: 85 },
    ...report.dates.flatMap(() => [{ label: 'IN', width: 38 }, { label: 'OUT', width: 38 }]),
    { label: 'Calc', width: 38 }, { label: 'Late', width: 36 }, { label: 'Very late', width: 45 }, { label: 'OT', width: 34 }, { label: 'No source', width: 46 }, { label: 'Review', width: 42 },
  ]
  const xTotal = columns.reduce((sum, column) => sum + column.width, 0)
  const maxRows = 13
  const rowChunks: typeof report.employees[] = []
  for (let i = 0; i < report.employees.length; i += maxRows) rowChunks.push(report.employees.slice(i, i + maxRows))
  if (!rowChunks.length) rowChunks.push([])
  return rowChunks.map((employees, pageIndex) => {
    const page: PdfPage = { title: `Weekly attendance detail${report.employees.length ? ` — employees ${pageIndex * maxRows + 1}-${Math.min((pageIndex + 1) * maxRows, report.employees.length)} of ${report.employees.length}` : ''}`, commands: [] }
    pageHeader(page, report)
    const startX = (PAGE_W - xTotal) / 2
    const headerTop = 130
    const headerHeight = 34
    let x = startX
    for (let index = 0; index < columns.length; index++) {
      const column = columns[index]
      rect(page.commands, x, headerTop, column.width, headerHeight, NAVY, [1, 1, 1])
      if (index >= 3 && index < 3 + report.dates.length * 2) {
        drawText(page.commands, x + 4, headerTop + 21, column.label, 6, true, [1, 1, 1])
      } else {
        wrap(column.label, Math.max(4, Math.floor(column.width / 5)), 2).forEach((text, lineIndex) => drawText(page.commands, x + 3, headerTop + 7 + lineIndex * 10, text, 7, true, [1, 1, 1]))
      }
      x += column.width
    }
    let dateX = startX + columns.slice(0, 3).reduce((sum, column) => sum + column.width, 0)
    report.dates.forEach((date, index) => {
      const pairWidth = columns[3 + index * 2].width + columns[4 + index * 2].width
      const label = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short' }).format(new Date(`${date}T12:00:00Z`))
      drawText(page.commands, dateX + Math.max(1, (pairWidth - label.length * 3.2) / 2), headerTop + 2, label, 5.2, true, [1, 1, 1])
      dateX += pairWidth
    })
    const rowHeight = 43
    employees.forEach((employee, rowIndex) => {
      const top = headerTop + headerHeight + rowIndex * rowHeight
      const cells: Array<{ text: string; fill?: Rgb }> = [
        { text: employee.employee.employeeNumber }, { text: employee.employee.fullName }, { text: employee.employee.department ?? '—' },
        ...employee.days.flatMap((day) => [
          { text: day.sourceInValues.join(', ') || (day.kind === 'calculated' ? day.inTimes.join(', ') : ''), fill: dayColor(day) },
          { text: day.sourceOutValues.join(', ') || (day.kind === 'calculated' ? day.outTimes.join(', ') : ''), fill: dayColor(day) },
        ]),
        { text: String(employee.totals.calculatedDays) }, { text: String(employee.totals.lateDays) }, { text: String(employee.totals.veryLateDays) }, { text: String(employee.totals.overtimeDays) }, { text: String(employee.totals.noSourceRecordDays) }, { text: String(employee.totals.reviewExceptions) },
      ]
      let cellX = startX
      cells.forEach((cell, columnIndex) => {
        const width = columns[columnIndex].width
        rect(page.commands, cellX, top, width, rowHeight, cell.fill ?? (rowIndex % 2 ? [0.98, 0.98, 0.99] : [1, 1, 1]), [0.84, 0.84, 0.87])
        const isTimeCell = columnIndex >= 3 && columnIndex < 3 + report.dates.length * 2
        const lines = wrap(cell.text, isTimeCell ? 18 : Math.max(4, Math.floor((width - 6) / 4)), isTimeCell ? 3 : 3)
        lines.forEach((text, lineIndex) => drawText(page.commands, cellX + 3, top + 5 + lineIndex * 9, text, isTimeCell ? 5.8 : 6.4, columnIndex < 2, [0.18, 0.18, 0.22]))
        cellX += width
      })
    })
    if (!employees.length) drawText(page.commands, MARGIN, 180, 'No active employees were present in the roster at report generation time.', 10)
    drawText(page.commands, MARGIN, 752, 'No records means no source evidence was imported for that employee and date; it is not a verified absence. PDF fingerprint events have unknown direction; no IN or OUT direction is inferred.', 7, false, [0.38, 0.38, 0.43])
    drawText(page.commands, MARGIN, 766, `Roster basis: ${report.metadata.rosterBasis}`, 7, false, [0.38, 0.38, 0.43])
    return page
  })
}

function tablePages(report: AttendanceReport, title: string, headers: string[], rows: string[][], widths: number[], rowLimit = 24) {
  const chunks: string[][][] = []
  for (let i = 0; i < rows.length; i += rowLimit) chunks.push(rows.slice(i, i + rowLimit))
  if (!chunks.length) chunks.push([])
  const totalWidth = widths.reduce((sum, width) => sum + width, 0)
  return chunks.map((chunk, pageIndex) => {
    const page: PdfPage = { title: `${title}${rows.length ? ` (${pageIndex * rowLimit + 1}-${Math.min((pageIndex + 1) * rowLimit, rows.length)} of ${rows.length})` : ''}`, commands: [] }
    pageHeader(page, report)
    const startX = (PAGE_W - totalWidth) / 2
    let x = startX
    for (let index = 0; index < headers.length; index++) {
      rect(page.commands, x, 132, widths[index], 30, NAVY, [1, 1, 1])
      wrap(headers[index], Math.max(4, Math.floor(widths[index] / 5)), 2).forEach((value, lineIndex) => drawText(page.commands, x + 3, 139 + lineIndex * 9, value, 7, true, [1, 1, 1]))
      x += widths[index]
    }
    const rowHeight = Math.min(46, Math.max(28, Math.floor(580 / Math.max(chunk.length, 1))))
    chunk.forEach((row, rowIndex) => {
      let cellX = startX
      const top = 162 + rowIndex * rowHeight
      row.forEach((value, columnIndex) => {
        rect(page.commands, cellX, top, widths[columnIndex], rowHeight, rowIndex % 2 ? [0.98, 0.98, 0.99] : [1, 1, 1], [0.84, 0.84, 0.87])
        wrap(value, Math.max(4, Math.floor((widths[columnIndex] - 6) / 4)), Math.max(2, Math.floor((rowHeight - 8) / 9))).forEach((text, lineIndex) => drawText(page.commands, cellX + 3, top + 4 + lineIndex * 9, text, 6.5, false))
        cellX += widths[columnIndex]
      })
    })
    if (!chunk.length) drawText(page.commands, MARGIN, 185, title === 'Review & exceptions' ? 'No review exceptions were recorded.' : 'No fingerprint source events were recorded.', 10)
    return page
  })
}

function metadataPages(report: AttendanceReport) {
  const rows = [
    ...report.rules.map((rule) => [`Rule v${rule.version}`, rule.id, `Effective ${rule.effectiveFrom}; ${rule.timezone}; start ${rule.normalStart}; late ${rule.graceUntil}; very late ${rule.veryLateFrom}; end ${rule.scheduledEnd}; overtime ${rule.overtimeFrom}; weekend overtime ${rule.weekendOvertimeDays == null ? 'not configured' : rule.weekendOvertimeDays.length ? rule.weekendOvertimeDays.join(', ') : 'disabled'}`]),
    ...report.imports.map((item) => [`${item.sourceType} source`, item.filename, `Import ${item.id}; uploaded ${item.uploadedAt}; SHA-256 ${item.checksum}`]),
  ]
  const perPage = 18
  const groups: string[][][] = []
  for (let index = 0; index < rows.length; index += perPage) groups.push(rows.slice(index, index + perPage))
  if (!groups.length) groups.push([])
  return groups.map((group, pageIndex) => {
    const page: PdfPage = { title: `Report metadata and source provenance${groups.length > 1 ? ` (${pageIndex + 1} of ${groups.length})` : ''}`, commands: [] }
    pageHeader(page, report)
    drawText(page.commands, MARGIN, 132, `Report generation ID: ${report.metadata.reportId}`, 9, true, NAVY)
    drawText(page.commands, MARGIN, 149, `Generated: ${formatKigaliDateTime(report.metadata.generatedAt)} (${report.metadata.timezone}); UTC ${report.metadata.generatedAt}; Period: ${report.metadata.periodStart} to ${report.metadata.periodEnd}`, 8, false)
    drawText(page.commands, MARGIN, 165, report.metadata.rosterBasis, 7, false)
    const startTop = 187
    const widths = [140, 280, 650]
    const headers = ['Type', 'Reference', 'Details']
    let x = MARGIN
    headers.forEach((header, index) => { rect(page.commands, x, startTop, widths[index], 30, NAVY, [1, 1, 1]); drawText(page.commands, x + 4, startTop + 10, header, 8, true, [1, 1, 1]); x += widths[index] })
    group.forEach((row, index) => {
      let cellX = MARGIN
      const top = startTop + 30 + index * 31
      row.forEach((value, columnIndex) => {
        rect(page.commands, cellX, top, widths[columnIndex], 31, index % 2 ? [0.98, 0.98, 0.99] : [1, 1, 1], [0.84, 0.84, 0.87])
        wrap(value, Math.floor((widths[columnIndex] - 8) / 4), 3).forEach((text, lineIndex) => drawText(page.commands, cellX + 4, top + 4 + lineIndex * 8, text, 6.5))
        cellX += widths[columnIndex]
      })
    })
    if (!group.length) drawText(page.commands, MARGIN, 230, 'No source files or rule versions applied to records in this reporting period.', 9)
    return page
  })
}

function makePdf(pages: PdfPage[], report: AttendanceReport) {
  const objects: string[] = []
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  const pageIds = pages.map((_, index) => 5 + index * 2)
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'
  pages.forEach((page, index) => {
    finishPage(page, index, pages.length, report)
    const pageId = pageIds[index]
    const streamId = pageId + 1
    const stream = `${page.commands.join('\n')}\n`
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${streamId} 0 R >>`
    objects[streamId] = `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}endstream`
  })
  const infoId = objects.length
  objects[infoId] = `<< /Title ${pdfHexString(`${report.metadata.organization} ${report.metadata.title}`)} /Author ${pdfHexString(report.metadata.organization)} /Subject ${pdfHexString(`${report.metadata.periodStart} to ${report.metadata.periodEnd}`)} >>`
  let output = '%PDF-1.4\n%MMRJD\n'
  const offsets = [0]
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(output, 'ascii')
    output += `${id} 0 obj\n${objects[id]}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(output, 'ascii')
  output += `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let id = 1; id < objects.length; id++) output += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  output += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`
  return Buffer.from(output, 'ascii')
}

export function createAttendancePdf(report: AttendanceReport) {
  const pages = employeePages(report)
  const exceptionRows = report.exceptions.map((item) => [item.severity.toUpperCase(), item.employeeNumber ?? '—', item.employeeName ?? '—', item.date ?? '—', item.source ?? '—', item.explanation])
  if (exceptionRows.length) pages.push(...tablePages(report, 'Review & exceptions', ['Severity', 'Employee ID', 'Employee name', 'Date', 'Source', 'Explanation'], exceptionRows, [60, 92, 150, 78, 135, 550], 22))
  else pages[0].commands.push(`BT /F2 9 Tf ${rgb(NAVY)} rg 1 0 0 1 ${MARGIN} ${PAGE_H - 784} Tm ${pdfText('No review exceptions were recorded.') } ET`)
  const fingerprintRows = report.fingerprintEvidence.map((item) => [item.employeeNumber ?? '—', item.employeeName ?? '—', item.date ?? '—', item.timestamp ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kigali', dateStyle: 'short', timeStyle: 'short' }).format(new Date(item.timestamp)) : item.sourceTimestampText ?? 'Invalid timestamp', item.attendanceStatus ?? '—', item.checkpoint ?? '—', report.imports.find((source) => source.id === item.importId)?.filename ?? item.importId, `${item.sourcePage ?? '—'} / ${item.sourceRow ?? '—'}`])
  if (fingerprintRows.length) pages.push(...tablePages(report, 'Raw fingerprint source evidence (direction not inferred)', ['Employee ID', 'Employee name', 'Date', 'Recorded time', 'Status', 'Checkpoint', 'Source file', 'Page / row'], fingerprintRows, [78, 125, 72, 105, 85, 190, 350, 75], 22))
  if (report.imports.length || report.rules.length) pages.push(...metadataPages(report))
  else pages[0].commands.push(`BT /F1 8 Tf ${rgb(NAVY)} rg 1 0 0 1 ${MARGIN} ${PAGE_H - 798} Tm ${pdfText('No source imports or attendance rule versions apply to this period.') } ET`)
  return makePdf(pages, report)
}
