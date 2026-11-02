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
  gray: 'D9D9D9',
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

function displayMonth(report: AttendanceReport) {
  const first = new Date(`${report.metadata.periodStart}T12:00:00Z`)
  const last = new Date(`${report.metadata.periodEnd}T12:00:00Z`)
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long' })
  const start = formatter.format(first)
  const end = formatter.format(last)
  return start === end ? start : `${start}–${end}`
}

function dateLabel(date: string) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const [year, month, day] = date.split('-').map(Number)
  return `${day}/${months[month - 1]}`
}

export async function createAttendanceWorkbook(report: AttendanceReport) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'MM&RJD Attendance'
  workbook.subject = 'Prepared weekly attendance sheet'
  workbook.title = `Attendance Sheet ${report.metadata.periodStart} to ${report.metadata.periodEnd}`
  workbook.created = new Date(report.metadata.generatedAt)
  workbook.modified = new Date(report.metadata.generatedAt)

  const sheet = workbook.addWorksheet('Attendance Sheet', {
    properties: { tabColor: { argb: `FF${colors.titleBlue}` }, defaultRowHeight: 22 },
    views: [{ state: 'frozen', ySplit: 5, xSplit: 1, showGridLines: false, zoomScale: 90 }],
  })
  sheet.columns = [
    { width: 27.5 },
    ...report.dates.flatMap(() => [{ width: 8.65 }, { width: 8.65 }]),
    { width: 15.5 },
  ]
  const lastColumn = 2 + report.dates.length * 2
  const absentColumn = lastColumn

  sheet.getRow(1).height = 34
  sheet.mergeCells(1, 1, 1, lastColumn)
  const title = sheet.getCell(1, 1)
  title.value = 'MM&RJD  |  Weekly Employee Attendance Sheet'
  styleCell(title, { fill: '263A68', color: colors.white, bold: true, size: 16, horizontal: 'left', borderColor: '263A68' })
  title.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 }
  sheet.getRow(2).height = 30
  sheet.mergeCells(2, 1, 2, 3)
  sheet.mergeCells(2, 4, 2, Math.min(8, lastColumn - 4))
  sheet.mergeCells(2, 9, 2, 11)
  sheet.mergeCells(2, 12, 2, lastColumn)
  const monthLabel = sheet.getCell(2, 1)
  monthLabel.value = 'Month'
  styleCell(monthLabel, { fill: colors.paleBlue, size: 12 })
  const monthValue = sheet.getCell(2, 4)
  monthValue.value = displayMonth(report)
  styleCell(monthValue, { fill: colors.titleBlue, color: colors.white, size: 12 })
  const yearLabel = sheet.getCell(2, 9)
  yearLabel.value = 'Year'
  styleCell(yearLabel, { fill: colors.gray, size: 12 })
  const yearValue = sheet.getCell(2, 12)
  yearValue.value = report.metadata.periodStart.slice(0, 4) === report.metadata.periodEnd.slice(0, 4)
    ? report.metadata.periodStart.slice(0, 4)
    : `${report.metadata.periodStart.slice(0, 4)}–${report.metadata.periodEnd.slice(0, 4)}`
  styleCell(yearValue, { fill: colors.titleBlue, color: colors.white, size: 12 })
  sheet.getRow(3).height = 24
  sheet.mergeCells(3, 1, 3, lastColumn)
  const context = sheet.getCell(3, 1)
  context.value = `Reporting period: ${report.metadata.periodStart} to ${report.metadata.periodEnd}  |  Generated: ${new Intl.DateTimeFormat('en-GB', { timeZone: report.metadata.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(report.metadata.generatedAt))} (${report.metadata.timezone})  |  Attendance identities: ${report.manualAttendanceRows.length}`
  styleCell(context, { fill: 'F3F6FC', color: '34415F', size: 9, horizontal: 'left', borderColor: 'D5DEEE' })
  context.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 }

  sheet.getRow(4).height = 40
  sheet.getRow(5).height = 22
  sheet.mergeCells('A4:A5')
  sheet.getCell('A4').value = 'Employees Names'
  styleCell(sheet.getCell('A4'), { fill: colors.titleBlue, color: colors.white, bold: true, size: 12, borderColor: 'FFFFFFFF' })
  report.dates.forEach((date, index) => {
    const firstColumn = 2 + index * 2
    const heading = sheet.getCell(4, firstColumn)
    heading.value = dateLabel(date)
    styleCell(heading, { fill: colors.white, bold: true, size: 11, rotation: 90 })
    styleCell(sheet.getCell(4, firstColumn + 1), { fill: colors.white, bold: true, size: 11 })
    sheet.getCell(5, firstColumn).value = 'IN'
    sheet.getCell(5, firstColumn + 1).value = 'OUT'
    styleCell(sheet.getCell(5, firstColumn), { fill: colors.white, size: 11 })
    styleCell(sheet.getCell(5, firstColumn + 1), { fill: colors.white, size: 11 })
  })
  sheet.getCell(4, absentColumn).value = 'no of absent'
  sheet.getCell(5, absentColumn).value = 'no'
  styleCell(sheet.getCell(4, absentColumn), { fill: colors.white, size: 12, borderColor: 'FF00B050' })
  styleCell(sheet.getCell(5, absentColumn), { fill: colors.white, size: 11, borderColor: 'FF00B050' })

  let rowNumber = 6
  for (const employee of report.manualAttendanceRows) {
    const row = sheet.getRow(rowNumber)
    row.height = 22
    const name = row.getCell(1)
    name.value = employee.employeeName
    styleCell(name, { fill: rowNumber % 2 === 0 ? 'F7F9FD' : colors.white, bold: true, color: '24365D', size: 10, borderColor: '9FB5D8' })
    employee.days.forEach((day, index) => {
      const inCell = row.getCell(2 + index * 2)
      const outCell = row.getCell(3 + index * 2)
      inCell.value = day.inTime
      outCell.value = day.outTime
      styleCell(inCell, { fill: statusColor(day, 'in'), size: 9 })
      styleCell(outCell, { fill: statusColor(day, 'out'), size: 9 })
    })
    const absent = row.getCell(absentColumn)
    absent.value = employee.absentCount
    styleCell(absent, { fill: colors.paleBlue, size: 10, borderColor: 'FF00B050' })
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
  policyNote.value = 'Before 12:00 = IN; after 12:00 = OUT; earliest IN and latest OUT are shown. Yellow = late (08:30+); orange = very late (09:30+). Red = missing IN/OUT; each red cell counts in No. absent, and a no-event day has two red cells. Green = verified overtime (19:30+) when allowed by the applicable weekday/weekend rule. Weekend overtime with no configured rule is marked for review.'
  styleCell(policyNote, { fill: 'F3F6FC', color: '495675', size: 9, horizontal: 'left', borderColor: 'D5DEEE' })
  policyNote.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true, indent: 1 }
  sheet.getRow(rowNumber).height = 42
  rowNumber++
  const legend = [
    { label: 'very late', color: colors.orange },
    { label: 'Absent', color: colors.red },
    { label: 'Late', color: colors.yellow },
    { label: 'Overtime', color: colors.green },
  ]
  for (const item of legend) {
    const swatch = sheet.getCell(rowNumber, 1)
    swatch.fill = fill(item.color)
    swatch.border = border('FFB4C7E7', 'medium')
    const label = sheet.getCell(rowNumber, 2)
    label.value = item.label
    styleCell(label, { fill: colors.white, horizontal: 'left', size: 10 })
    rowNumber++
  }

  sheet.autoFilter = undefined
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
  sheet.headerFooter.oddFooter = '&LMM&RJD&CPage &P of &N'
  return workbook.xlsx.writeBuffer()
}
