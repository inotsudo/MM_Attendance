import ExcelJS from 'exceljs'
import type { AttendanceReport, ManualAttendanceDay } from './types'

const colors = {
  navy: '305A9F',
  titleBlue: '315A9F',
  paleBlue: 'D9E2F3',
  gridBlue: 'B4C7E7',
  red: 'FFFF0000',
  yellow: 'FFFFFF00',
  orange: 'FFFFC000',
  green: 'FF8EE07E',
  review: 'FFFFE699',
  white: 'FFFFFFFF',
}

function fill(argb: string): ExcelJS.Fill {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb: argb.length === 6 ? `FF${argb}` : argb } }
}

function border(color = colors.gridBlue, style: ExcelJS.BorderStyle = 'thin'): Partial<ExcelJS.Borders> {
  const edge = { style, color: { argb: color } }
  return { top: edge, bottom: edge, left: edge, right: edge }
}

function statusColor(day: ManualAttendanceDay, side: 'in' | 'out') {
  const status = side === 'in' ? day.inStatus : day.outStatus
  if (status === 'absent') return colors.red
  if (status === 'late') return colors.yellow
  if (status === 'very_late') return colors.orange
  if (status === 'overtime') return colors.green
  if (status === 'review') return colors.review
  if (!day.hasEvidence) return colors.paleBlue
  return colors.white
}

function styleCell(cell: ExcelJS.Cell, args: { fill?: string; bold?: boolean; color?: string; size?: number; rotation?: number; horizontal?: 'left' | 'center' | 'right'; borderColor?: string } = {}) {
  cell.fill = fill(args.fill ?? colors.white)
  cell.font = { name: 'Calibri', size: args.size ?? 10, bold: args.bold ?? false, color: { argb: args.color ?? 'FF202020' } }
  cell.alignment = { horizontal: args.horizontal ?? 'center', vertical: 'middle', wrapText: true, ...(args.rotation == null ? {} : { textRotation: args.rotation }) }
  cell.border = border(args.borderColor ?? colors.gridBlue)
}

function dateLabel(date: string) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short' }).format(new Date(`${date}T12:00:00Z`))
}

export async function createAttendanceWorkbook(report: AttendanceReport) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Attendance Sheet Builder'
  workbook.subject = 'Prepared weekly attendance sheet'
  workbook.title = `Attendance Sheet ${report.metadata.periodStart} to ${report.metadata.periodEnd}`
  workbook.created = new Date(report.metadata.generatedAt)
  workbook.modified = new Date(report.metadata.generatedAt)

  const sheet = workbook.addWorksheet('Attendance Sheet', {
    properties: { tabColor: { argb: `FF${colors.titleBlue}` }, defaultRowHeight: 24 },
    views: [{ state: 'frozen', ySplit: 5, xSplit: 1, showGridLines: false, zoomScale: 85 }],
  })
  sheet.columns = [
    { width: 28 },
    ...report.dates.flatMap(() => [{ width: 10.25 }, { width: 10.25 }]),
    { width: 13 },
  ]
  const absentColumn = 2 + report.dates.length * 2
  const lastColumn = absentColumn

  sheet.getRow(1).height = 38
  sheet.mergeCells(1, 1, 1, lastColumn)
  const title = sheet.getCell(1, 1)
  title.value = 'Weekly Employee Attendance Sheet'
  styleCell(title, { fill: '263A68', color: colors.white, bold: true, size: 17, horizontal: 'left', borderColor: '263A68' })
  title.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 }
  sheet.getRow(2).height = 25
  sheet.mergeCells(2, 1, 2, lastColumn)
  const period = sheet.getCell(2, 1)
  period.value = `REPORTING PERIOD     ${report.metadata.periodStart}  —  ${report.metadata.periodEnd}`
  styleCell(period, { fill: 'EAF0FA', color: '263A68', bold: true, size: 10, horizontal: 'left', borderColor: 'D5DEEE' })
  period.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 }
  sheet.getRow(3).height = 23
  sheet.mergeCells(3, 1, 3, lastColumn)
  const context = sheet.getCell(3, 1)
  const generatedLabel = new Intl.DateTimeFormat('en-GB', { timeZone: report.metadata.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(report.metadata.generatedAt))
  context.value = `Generated ${generatedLabel} (${report.metadata.timezone})     •     ${report.manualAttendanceRows.length} employee identities`
  styleCell(context, { fill: 'F5F7FB', color: '56627A', size: 9, horizontal: 'left', borderColor: 'DDE3ED' })
  context.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 }

  sheet.getRow(4).height = 27
  sheet.getRow(5).height = 22
  sheet.mergeCells('A4:A5')
  sheet.getCell('A4').value = 'Employees Names'
  styleCell(sheet.getCell('A4'), { fill: colors.titleBlue, color: colors.white, bold: true, size: 11, borderColor: 'FFFFFFFF' })
  report.dates.forEach((date, index) => {
    const firstColumn = 2 + index * 2
    const heading = sheet.getCell(4, firstColumn)
    heading.value = dateLabel(date)
    sheet.mergeCells(4, firstColumn, 4, firstColumn + 1)
    styleCell(heading, { fill: colors.titleBlue, color: colors.white, bold: true, size: 10, borderColor: 'FFFFFFFF' })
    sheet.getCell(5, firstColumn).value = 'IN'
    sheet.getCell(5, firstColumn + 1).value = 'OUT'
    styleCell(sheet.getCell(5, firstColumn), { fill: 'DCE6F5', color: '263A68', bold: true, size: 9 })
    styleCell(sheet.getCell(5, firstColumn + 1), { fill: 'DCE6F5', color: '263A68', bold: true, size: 9 })
  })
  sheet.mergeCells(4, absentColumn, 5, absentColumn)
  sheet.getCell(4, absentColumn).value = 'No. absent'
  styleCell(sheet.getCell(4, absentColumn), { fill: 'E8F5EC', color: '23653D', bold: true, size: 10, borderColor: 'FF00B050' })

  let rowNumber = 6
  for (const employee of report.manualAttendanceRows) {
    const row = sheet.getRow(rowNumber)
    row.height = 25
    const name = row.getCell(1)
    name.value = employee.employeeName
    styleCell(name, { fill: rowNumber % 2 === 0 ? 'F2F5FA' : colors.white, bold: true, color: '24365D', size: 10, horizontal: 'left', borderColor: 'C7D2E4' })
    employee.days.forEach((day, index) => {
      const inCell = row.getCell(2 + index * 2)
      const outCell = row.getCell(3 + index * 2)
      inCell.value = day.inTime
      outCell.value = day.outTime
      const inFill = statusColor(day, 'in')
      const outFill = statusColor(day, 'out')
      styleCell(inCell, { fill: inFill, color: inFill === colors.red ? colors.white : 'FF202020', bold: inFill !== colors.white && inFill !== colors.paleBlue, size: 9, borderColor: 'C7D2E4' })
      styleCell(outCell, { fill: outFill, color: outFill === colors.red ? colors.white : 'FF202020', bold: outFill !== colors.white && outFill !== colors.paleBlue, size: 9, borderColor: 'C7D2E4' })
    })
    const absent = row.getCell(absentColumn)
    absent.value = employee.absentCount
    styleCell(absent, { fill: 'EDF5EF', color: '24583A', bold: true, size: 10, borderColor: 'FF00B050' })
    rowNumber++
  }
  if (!report.manualAttendanceRows.length) {
    sheet.mergeCells(rowNumber, 1, rowNumber, absentColumn - 1)
    sheet.getCell(rowNumber, 1).value = 'No identified source employee records were found in this import and reporting period.'
    styleCell(sheet.getCell(rowNumber, 1), { fill: colors.white, horizontal: 'left', size: 10 })
    styleCell(sheet.getCell(rowNumber, absentColumn), { fill: colors.paleBlue, borderColor: 'FF00B050' })
    rowNumber++
  }

  sheet.mergeCells(rowNumber, 1, rowNumber, absentColumn)
  const policyNote = sheet.getCell(rowNumber, 1)
  policyNote.value = 'ATTENDANCE RULES   •   Before 12:00 = IN; after 12:00 = OUT; earliest IN and latest OUT are shown. Weekdays: yellow = late (08:30+), orange = very late (09:30+), red = missing IN/OUT; each red cell counts in No. absent. Saturday and Sunday are rest days and are not marked absent. Green = overtime evidence from 19:30 when permitted; time after 17:30 alone is not overtime.'
  styleCell(policyNote, { fill: 'F5F7FB', color: '495675', size: 9, horizontal: 'left', borderColor: 'D5DEEE' })
  policyNote.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true, indent: 1 }
  sheet.getRow(rowNumber).height = 39
  rowNumber++
  const legend = [
    { label: 'very late', color: colors.orange },
    { label: 'Absent', color: colors.red },
    { label: 'Late', color: colors.yellow },
    { label: 'Overtime', color: colors.green },
  ]
  const legendStarts = [1, 4, 7, 10]
  for (const [index, item] of legend.entries()) {
    const start = legendStarts[index]
    const swatch = sheet.getCell(rowNumber, start)
    swatch.fill = fill(item.color)
    swatch.border = border('FFB4C7E7', 'thin')
    const label = sheet.getCell(rowNumber, start + 1)
    label.value = item.label
    styleCell(label, { fill: colors.white, color: '39445B', horizontal: 'left', size: 9, bold: true, borderColor: 'FFFFFFFF' })
  }
  rowNumber++

  sheet.pageSetup = {
    orientation: 'landscape',
    paperSize: 8 as ExcelJS.PaperSize,
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    printArea: `A1:${sheet.getColumn(absentColumn).letter}${rowNumber - 1}`,
    margins: { left: 0.25, right: 0.25, top: 0.4, bottom: 0.4, header: 0.15, footer: 0.15 },
  }
  sheet.pageSetup.printTitlesRow = '1:5'
  sheet.headerFooter.oddHeader = '&L&BWeekly Employee Attendance Sheet&R' + report.metadata.periodStart + ' to ' + report.metadata.periodEnd
  sheet.headerFooter.oddFooter = '&LConfidential attendance information&CPage &P of &N&R' + report.metadata.timezone
  return workbook.xlsx.writeBuffer()
}
