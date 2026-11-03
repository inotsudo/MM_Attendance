import type { AttendanceReport, ManualAttendanceDay } from './types'
import { formatKigaliDateTime } from './dataset'

const PAGE_W = 842
const PAGE_H = 595
const MARGIN = 26
type Rgb = readonly [number, number, number]
type PdfPage = { commands: string[] }

const color = {
  navy: [49 / 255, 90 / 255, 159 / 255] as Rgb,
  title: [38 / 255, 58 / 255, 104 / 255] as Rgb,
  paleBlue: [217 / 255, 226 / 255, 243 / 255] as Rgb,
  grid: [180 / 255, 199 / 255, 231 / 255] as Rgb,
  red: [1, 0, 0] as Rgb,
  yellow: [1, 1, 0] as Rgb,
  orange: [1, 192 / 255, 0] as Rgb,
  green: [142 / 255, 224 / 255, 126 / 255] as Rgb,
  review: [1, 230 / 255, 153 / 255] as Rgb,
  white: [1, 1, 1] as Rgb,
  ink: [32 / 255, 38 / 255, 52 / 255] as Rgb,
  muted: [76 / 255, 86 / 255, 107 / 255] as Rgb,
}

function winAnsi(value: string) {
  const special = new Map<number, number>([[0x20ac, 0x80], [0x2013, 0x96], [0x2014, 0x97], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95]])
  return [...value.normalize('NFKD')].flatMap((character) => {
    const point = character.codePointAt(0) ?? 63
    if (point >= 0x300 && point <= 0x36f) return []
    if (special.has(point)) return [special.get(point)!]
    if ((point >= 32 && point <= 126) || (point >= 160 && point <= 255)) return [point]
    return [63]
  })
}

function hexText(value: string) {
  return `<${winAnsi(value).map((byte) => byte.toString(16).padStart(2, '0')).join('')}>`
}

function rgb(value: Rgb) {
  return value.map((part) => Math.round(part * 1000) / 1000).join(' ')
}

function drawRect(commands: string[], x: number, top: number, width: number, height: number, fill: Rgb, stroke?: Rgb) {
  const y = PAGE_H - top - height
  commands.push(`${rgb(fill)} rg ${stroke ? `${rgb(stroke)} RG ` : ''}${x} ${y} ${width} ${height} re ${stroke ? 'B' : 'f'}`)
}

function drawText(commands: string[], x: number, top: number, value: string, size = 8, bold = false, fill: Rgb = color.ink, align: 'left' | 'center' = 'left', width = 0) {
  const approximateWidth = winAnsi(value).length * size * 0.5
  const left = align === 'center' ? x + Math.max(0, (width - approximateWidth) / 2) : x
  const y = PAGE_H - top - size
  commands.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${rgb(fill)} rg 1 0 0 1 ${left} ${y} Tm ${hexText(value)} Tj ET`)
}

function cellFill(day: ManualAttendanceDay, side: 'in' | 'out'): Rgb {
  const status = side === 'in' ? day.inStatus : day.outStatus
  if (status === 'absent') return color.red
  if (status === 'late') return color.yellow
  if (status === 'very_late') return color.orange
  if (status === 'overtime') return color.green
  if (status === 'review') return color.review
  if (!day.hasEvidence) return color.paleBlue
  return color.white
}

function dateHeading(date: string) {
  const label = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short' }).format(new Date(`${date}T12:00:00Z`))
  return label
}

function sheetPages(report: AttendanceReport) {
  const rowHeight = 18
  const rowsPerPage = 20
  const groups: AttendanceReport['manualAttendanceRows'][] = []
  for (let index = 0; index < report.manualAttendanceRows.length; index += rowsPerPage) {
    groups.push(report.manualAttendanceRows.slice(index, index + rowsPerPage))
  }
  if (!groups.length) groups.push([])

  const nameWidth = 132
  const absentWidth = 50
  const timeWidth = (PAGE_W - MARGIN * 2 - nameWidth - absentWidth) / Math.max(report.dates.length * 2, 1)
  return groups.map((rows, pageIndex) => {
    const commands: string[] = []
    const page: PdfPage = { commands }
    drawRect(commands, 0, 0, PAGE_W, 62, color.title)
    drawText(commands, MARGIN, 9, report.metadata.organization, 9, true, color.white)
    drawText(commands, MARGIN, 24, report.metadata.title, 17, true, color.white)
    const period = `${report.metadata.periodStart} to ${report.metadata.periodEnd}`
    drawText(commands, PAGE_W - MARGIN - 250, 17, `Reporting period: ${period}`, 8, true, color.white, 'left', 250)
    drawText(commands, PAGE_W - MARGIN - 250, 33, `Generated ${formatKigaliDateTime(report.metadata.generatedAt)} (${report.metadata.timezone})`, 7, false, color.white, 'left', 250)

    const totalAbsenceMarks = report.manualAttendanceRows.reduce((sum, employee) => sum + employee.absentCount, 0)
    const lateDays = report.manualAttendanceRows.reduce((sum, employee) => sum + employee.days.filter((day) => day.inStatus === 'late').length, 0)
    const veryLateDays = report.manualAttendanceRows.reduce((sum, employee) => sum + employee.days.filter((day) => day.inStatus === 'very_late').length, 0)
    const overtimeDays = report.manualAttendanceRows.reduce((sum, employee) => sum + employee.days.filter((day) => day.outStatus === 'overtime').length, 0)
    drawText(commands, MARGIN, 72, `Employees: ${report.manualAttendanceRows.length}  |  Absence marks: ${totalAbsenceMarks}  |  Late: ${lateDays}  |  Very late: ${veryLateDays}  |  Overtime evidence: ${overtimeDays}`, 7, true, color.navy)
    drawText(commands, MARGIN, 85, 'Workdays: yellow late from 08:30  |  orange very late from 09:30  |  red missing IN/OUT (each red cell counted)', 6.5, false, color.muted)
    drawText(commands, MARGIN, 94, 'Saturday/Sunday are rest days: empty cells are not absent. Green: overtime from 19:30 only when the applicable rule allows it.', 6.5, false, color.muted)

    const tableTop = 111
    const dayTopHeight = 22
    const subTopHeight = 19
    const nameX = MARGIN
    const daysX = nameX + nameWidth
    const absentX = daysX + timeWidth * report.dates.length * 2
    drawRect(commands, nameX, tableTop, nameWidth, dayTopHeight + subTopHeight, color.navy, color.white)
    drawText(commands, nameX + 5, tableTop + 15, 'Employees Names', 8, true, color.white)

    report.dates.forEach((date, index) => {
      const x = daysX + index * timeWidth * 2
      drawRect(commands, x, tableTop, timeWidth * 2, dayTopHeight, color.navy, color.white)
      drawText(commands, x, tableTop + 7, dateHeading(date), 7, true, color.white, 'center', timeWidth * 2)
      for (let side = 0; side < 2; side++) {
        const sideX = x + side * timeWidth
        drawRect(commands, sideX, tableTop + dayTopHeight, timeWidth, subTopHeight, color.paleBlue, color.grid)
        drawText(commands, sideX, tableTop + dayTopHeight + 6, side === 0 ? 'IN' : 'OUT', 6.5, true, color.navy, 'center', timeWidth)
      }
    })
    drawRect(commands, absentX, tableTop, absentWidth, dayTopHeight + subTopHeight, color.white, color.green)
    drawText(commands, absentX, tableTop + 7, 'no of absent', 7, true, color.ink, 'center', absentWidth)
    drawText(commands, absentX, tableTop + 27, 'no', 6.5, false, color.ink, 'center', absentWidth)

    const bodyTop = tableTop + dayTopHeight + subTopHeight
    rows.forEach((employee, rowIndex) => {
      const top = bodyTop + rowIndex * rowHeight
      drawRect(commands, nameX, top, nameWidth, rowHeight, rowIndex % 2 ? [0.97, 0.98, 0.99] : color.white, color.grid)
      drawText(commands, nameX + 4, top + 5, employee.employeeName, 7, true, color.ink)
      employee.days.forEach((day, dayIndex) => {
        const x = daysX + dayIndex * timeWidth * 2
        drawRect(commands, x, top, timeWidth, rowHeight, cellFill(day, 'in'), color.grid)
        drawRect(commands, x + timeWidth, top, timeWidth, rowHeight, cellFill(day, 'out'), color.grid)
        if (day.inTime) drawText(commands, x, top + 5, day.inTime, 5.5, false, color.ink, 'center', timeWidth)
        if (day.outTime) drawText(commands, x + timeWidth, top + 5, day.outTime, 5.5, false, color.ink, 'center', timeWidth)
      })
      drawRect(commands, absentX, top, absentWidth, rowHeight, color.paleBlue, color.green)
      drawText(commands, absentX, top + 5, String(employee.absentCount), 7, false, color.ink, 'center', absentWidth)
    })

    if (!rows.length) {
      drawRect(commands, nameX, bodyTop, PAGE_W - MARGIN * 2, 34, color.white, color.grid)
      drawText(commands, nameX + 8, bodyTop + 12, 'No source employee records were found in this import and reporting period.', 8, false, color.muted)
    }

    const noteTop = bodyTop + Math.max(rows.length, 1) * rowHeight + 12
    drawText(commands, MARGIN, noteTop, 'iVMS rule: before 12:00 is IN; after 12:00 is OUT. Earliest IN and latest OUT are shown.', 6.5, false, color.muted)
    drawText(commands, MARGIN, noteTop + 8, 'Workdays with no events have red IN and OUT cells; each red cell adds to No. absent. Saturday/Sunday are rest days and are not counted absent.', 6.5, false, color.muted)
    const legendTop = noteTop + 19
    const legend = [
      { label: 'Very late', fill: color.orange },
      { label: 'Absent', fill: color.red },
      { label: 'Late', fill: color.yellow },
      { label: 'Overtime', fill: color.green },
    ]
    let legendX = MARGIN
    for (const item of legend) {
      drawRect(commands, legendX, legendTop, 15, 8, item.fill, color.grid)
      drawText(commands, legendX + 19, legendTop, item.label, 6.5, false, color.muted)
      legendX += 82
    }
    const footer = `Attendance information | Page ${pageIndex + 1} of ${groups.length}`
    drawText(commands, MARGIN, PAGE_H - 16, footer, 6.5, false, color.muted)
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
    const pageId = pageIds[index]
    const streamId = pageId + 1
    const stream = `${page.commands.join('\n')}\n`
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${streamId} 0 R >>`
    objects[streamId] = `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}endstream`
  })
  const infoId = objects.length
  objects[infoId] = `<< /Title ${hexText(`${report.metadata.organization} ${report.metadata.title}`)} /Author ${hexText(report.metadata.organization)} /Subject ${hexText(`${report.metadata.periodStart} to ${report.metadata.periodEnd}`)} >>`
  let output = '%PDF-1.4\n%AttendanceSheet\n'
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
  return makePdf(sheetPages(report), report)
}
