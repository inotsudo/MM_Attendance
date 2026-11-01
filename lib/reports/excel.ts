import ExcelJS from 'exceljs'
import { formatKigaliDateTime } from './dataset'
import type { AttendanceReport, ReportDayCell } from './types'

const navy = '27345B'
const purple = '7058A4'
const pale = 'F3F1F8'
const border = 'D9D6E2'

function dayFill(day: ReportDayCell) {
  if (day.kind === 'no_records' || day.kind === 'stale' || day.overtime === 'Unverified') return 'FFF0E5'
  if (day.classification === 'Very late') return 'FCE4E4'
  if (day.classification === 'Late') return 'FFF4D6'
  if (day.kind === 'fingerprint_events') return 'E9F1FA'
  return 'EAF5EC'
}

function styleHeader(row: ExcelJS.Row) {
  row.height = 30
  row.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: navy } }
    cell.font = { name: 'Aptos', size: 10, bold: true, color: { argb: 'FFFFFF' } }
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
    cell.border = { bottom: { style: 'medium', color: { argb: purple } } }
  })
}

function setPrintLayout(sheet: ExcelJS.Worksheet, titleRows: string) {
  sheet.views = [{ state: 'frozen', ySplit: Number(titleRows.split(':')[1] ?? titleRows), xSplit: 3 }]
  sheet.pageSetup = { orientation: 'landscape', paperSize: 8 as ExcelJS.PaperSize, fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalDpi: 300, verticalDpi: 300, margins: { left: 0.25, right: 0.25, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } }
  sheet.pageSetup.printTitlesRow = titleRows
  sheet.headerFooter.oddFooter = '&LMM&RJD&CConfidential attendance information&RPage &P of &N'
}

export async function createAttendanceWorkbook(report: AttendanceReport) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'MM&RJD Attendance'
  workbook.subject = report.metadata.title
  workbook.title = `${report.metadata.title} ${report.metadata.periodStart} to ${report.metadata.periodEnd}`
  workbook.created = new Date(report.metadata.generatedAt)
  workbook.modified = new Date(report.metadata.generatedAt)

  const weekly = workbook.addWorksheet('Weekly Attendance', { views: [{ state: 'frozen', ySplit: 7, xSplit: 3 }] })
  const summaryColumns = ['Calculated days', 'Evidence days', 'Late days', 'Very late days', 'Verified OT days', 'Incomplete days', 'No source record days', 'Review items']
  const lastColumn = 3 + report.dates.length * 2 + summaryColumns.length
  weekly.mergeCells(1, 1, 1, lastColumn)
  weekly.getCell(1, 1).value = 'MM&RJD | Weekly Employee Attendance Report'
  weekly.getCell(1, 1).font = { name: 'Aptos Display', size: 18, bold: true, color: { argb: 'FFFFFF' } }
  weekly.getCell(1, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: navy } }
  weekly.getCell(1, 1).alignment = { vertical: 'middle' }
  weekly.getRow(1).height = 34
  for (const [row, text] of [[2, `Reporting period: ${report.metadata.periodStart} to ${report.metadata.periodEnd}`], [3, `Generated: ${formatKigaliDateTime(report.metadata.generatedAt)} (${report.metadata.timezone}) | UTC: ${report.metadata.generatedAt}`], [4, `Employees: ${report.summary.employeesIncluded} | Calculated days: ${report.summary.attendanceDaysCalculated} | Late: ${report.summary.lateDays} | Very late: ${report.summary.veryLateDays} | Verified overtime: ${report.summary.verifiedOvertimeDays} | Review exceptions: ${report.summary.reviewExceptions}`], [5, '“No records” means no imported source evidence was found. It is not a verified absence. PDF fingerprint events are not assigned IN/OUT direction.']] as const) {
    weekly.mergeCells(row, 1, row, lastColumn)
    weekly.getCell(row, 1).value = text
    weekly.getCell(row, 1).font = { name: 'Aptos', size: row === 5 ? 9 : 10, italic: row === 5, color: { argb: row === 5 ? '8A5A22' : '43415A' } }
    weekly.getCell(row, 1).alignment = { vertical: 'middle', wrapText: true }
    weekly.getRow(row).height = row === 5 ? 27 : 22
  }
  weekly.mergeCells('A6:A7'); weekly.mergeCells('B6:B7'); weekly.mergeCells('C6:C7')
  weekly.getCell('A6').value = 'Employee ID'; weekly.getCell('B6').value = 'Employee name'; weekly.getCell('C6').value = 'Department'
  report.dates.forEach((date, index) => {
    const start = 4 + index * 2
    weekly.mergeCells(6, start, 6, start + 1)
    weekly.getCell(6, start).value = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short' }).format(new Date(`${date}T12:00:00Z`))
    weekly.getCell(7, start).value = 'IN'; weekly.getCell(7, start + 1).value = 'OUT'
  })
  summaryColumns.forEach((label, index) => {
    const column = 4 + report.dates.length * 2 + index
    weekly.getCell(7, column).value = label
  })
  styleHeader(weekly.getRow(6)); styleHeader(weekly.getRow(7))
  weekly.getRow(6).height = 27; weekly.getRow(7).height = 22
  weekly.columns = [
    { width: 15 }, { width: 24 }, { width: 18 },
    ...report.dates.flatMap(() => [{ width: 12 }, { width: 12 }]),
    ...summaryColumns.map(() => ({ width: 15 })),
  ]
  for (const employee of report.employees) {
    const values: (string | number | null)[] = [employee.employee.employeeNumber, employee.employee.fullName, employee.employee.department ?? '—']
    for (const day of employee.days) {
      const inValue = day.sourceInValues.join('\n') || (day.kind === 'calculated' ? day.inTimes.join('\n') : '')
      const outValue = day.sourceOutValues.join('\n') || (day.kind === 'calculated' ? day.outTimes.join('\n') : '')
      values.push(inValue, outValue)
    }
    values.push(employee.totals.calculatedDays, employee.totals.evidenceDays, employee.totals.lateDays, employee.totals.veryLateDays, employee.totals.overtimeDays, employee.totals.incompleteDays, employee.totals.noSourceRecordDays, employee.totals.reviewExceptions)
    const row = weekly.addRow(values)
    row.height = 63
    row.eachCell((cell, column) => {
      cell.font = { name: 'Aptos', size: 9, color: { argb: '343243' } }
      cell.alignment = { vertical: 'middle', horizontal: column >= 4 && column < 4 + report.dates.length * 2 ? 'center' : 'left', wrapText: true }
      cell.border = { bottom: { style: 'hair', color: { argb: border } } }
      if (column >= 4 && column < 4 + report.dates.length * 2) {
        const day = employee.days[Math.floor((column - 4) / 2)]
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: dayFill(day) } }
      } else if (column <= 3) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FAF9FC' } }
    })
  }
  const finalWeeklyRow = Math.max(8, weekly.rowCount)
  if (report.employees.length) weekly.addConditionalFormatting({
    ref: `${weekly.getColumn(4 + report.dates.length * 2).letter}8:${weekly.getColumn(lastColumn).letter}${finalWeeklyRow}`,
    rules: [{ type: 'expression', formulae: [`AND(ISNUMBER(${weekly.getColumn(4 + report.dates.length * 2).letter}8),${weekly.getColumn(4 + report.dates.length * 2).letter}8>0)`], priority: 1, style: { fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4D6' } }, font: { color: { argb: '8A6414' }, bold: true } } }],
  })
  if (!report.employees.length) {
    const row = weekly.addRow(['No active employees were present in the roster at report generation time.'])
    weekly.mergeCells(row.number, 1, row.number, lastColumn)
  }
  if (report.employees.length) weekly.autoFilter = { from: 'A7', to: `${weekly.getColumn(lastColumn).letter}${weekly.rowCount}` }
  setPrintLayout(weekly, '1:7')

  const summary = workbook.addWorksheet('Attendance Summary')
  summary.addRow(['MM&RJD | Attendance Summary'])
  summary.mergeCells('A1:K1')
  summary.getCell('A1').font = { name: 'Aptos Display', size: 16, bold: true, color: { argb: 'FFFFFF' } }
  summary.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: navy } }
  summary.addRow([`Period ${report.metadata.periodStart} to ${report.metadata.periodEnd} | Generated ${formatKigaliDateTime(report.metadata.generatedAt)} (${report.metadata.timezone}) | UTC ${report.metadata.generatedAt}`])
  summary.mergeCells('A2:K2')
  summary.addRow(['Employee ID', 'Employee name', 'Department', 'Calculated days', 'Days with evidence', 'Late days', 'Very late days', 'Verified overtime days', 'Incomplete days', 'No source record days', 'Review exceptions'])
  styleHeader(summary.getRow(3))
  for (const row of report.employees) summary.addRow([row.employee.employeeNumber, row.employee.fullName, row.employee.department ?? '—', row.totals.calculatedDays, row.totals.evidenceDays, row.totals.lateDays, row.totals.veryLateDays, row.totals.overtimeDays, row.totals.incompleteDays, row.totals.noSourceRecordDays, row.totals.reviewExceptions])
  const summaryLastEmployeeRow = summary.rowCount
  summary.addRow(['TOTAL', '', '', report.summary.attendanceDaysCalculated, report.summary.daysWithEvidence, report.summary.lateDays, report.summary.veryLateDays, report.summary.verifiedOvertimeDays, report.summary.incompleteDays, report.employees.reduce((sum, row) => sum + row.totals.noSourceRecordDays, 0), report.summary.reviewExceptions])
  summary.columns = [{ width: 16 }, { width: 27 }, { width: 20 }, ...Array.from({ length: 8 }, () => ({ width: 19 }))]
  summary.autoFilter = { from: 'A3', to: `K${Math.max(3, summaryLastEmployeeRow)}` }
  setPrintLayout(summary, '1:3')

  const exceptions = workbook.addWorksheet('Review & Exceptions')
  exceptions.addRow(['Review items and exceptions'])
  exceptions.mergeCells('A1:F1')
  exceptions.getCell('A1').font = { name: 'Aptos Display', size: 16, bold: true, color: { argb: 'FFFFFF' } }
  exceptions.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: navy } }
  exceptions.addRow(['Severity', 'Employee ID', 'Employee name', 'Date', 'Source', 'Explanation'])
  styleHeader(exceptions.getRow(2))
  for (const item of report.exceptions) exceptions.addRow([item.severity.toUpperCase(), item.employeeNumber ?? '—', item.employeeName ?? '—', item.date ?? '—', item.source ?? '—', item.explanation])
  exceptions.addRow([])
  const sectionRow = exceptions.rowCount + 1
  exceptions.addRow(['Original fingerprint events (direction is not inferred)'])
  exceptions.mergeCells(sectionRow, 1, sectionRow, 9)
  exceptions.getCell(sectionRow, 1).font = { bold: true, color: { argb: purple }, size: 12 }
  const evidenceHeaderRow = exceptions.rowCount + 1
  exceptions.addRow(['Employee ID', 'Employee name', 'Department', 'Date', 'Recorded time', 'Source status', 'Checkpoint', 'Import file', 'Page / row'])
  styleHeader(exceptions.getRow(evidenceHeaderRow))
  const importName = new Map(report.imports.map((item) => [item.id, item.filename]))
  for (const item of report.fingerprintEvidence) exceptions.addRow([item.employeeNumber ?? '—', item.employeeName ?? '—', item.department ?? '—', item.date ?? '—', item.timestamp ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kigali', dateStyle: 'short', timeStyle: 'short' }).format(new Date(item.timestamp)) : item.sourceTimestampText ?? 'Invalid timestamp', item.attendanceStatus ?? '—', item.checkpoint ?? '—', importName.get(item.importId) ?? item.importId, `${item.sourcePage ?? '—'} / ${item.sourceRow ?? '—'}`])
  exceptions.columns = [{ width: 12 }, { width: 16 }, { width: 24 }, { width: 14 }, { width: 24 }, { width: 22 }, { width: 32 }, { width: 34 }, { width: 12 }]
  exceptions.autoFilter = report.exceptions.length ? { from: 'A2', to: `F${report.exceptions.length + 2}` } : undefined
  setPrintLayout(exceptions, '1:2')
  exceptions.views = [{ state: 'frozen', ySplit: 2 }]

  const metadata = workbook.addWorksheet('Report Metadata')
  metadata.addRow(['Report metadata'])
  metadata.mergeCells('A1:D1')
  metadata.getCell('A1').font = { name: 'Aptos Display', size: 16, bold: true, color: { argb: 'FFFFFF' } }
  metadata.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: navy } }
  metadata.addRows([
    ['Organization', report.metadata.organization], ['Report title', report.metadata.title], ['Reporting period', `${report.metadata.periodStart} to ${report.metadata.periodEnd}`],
    ['Generated at (Africa/Kigali)', formatKigaliDateTime(report.metadata.generatedAt)], ['Generated at (UTC)', report.metadata.generatedAt], ['Organization timezone', report.metadata.timezone], ['Report generation ID', report.metadata.reportId],
    ['Roster basis', report.metadata.rosterBasis], ['Active employees included', report.summary.activeEmployees], ['Attendance engine version', '2 (persisted calculations only)'],
  ])
  metadata.addRow([])
  metadata.addRow(['Rule version ID', 'Version', 'Effective from', 'Timezone', 'Normal start', 'Late threshold', 'Very late from', 'Scheduled end', 'Overtime from', 'Weekend overtime policy'])
  styleHeader(metadata.getRow(metadata.rowCount))
  for (const rule of report.rules) metadata.addRow([rule.id, rule.version, rule.effectiveFrom, rule.timezone, rule.normalStart, rule.graceUntil, rule.veryLateFrom, rule.scheduledEnd, rule.overtimeFrom, rule.weekendOvertimeDays == null ? 'Not configured' : rule.weekendOvertimeDays.length ? rule.weekendOvertimeDays.join(', ') : 'Disabled'])
  metadata.addRow([])
  metadata.addRow(['Source import ID', 'Filename', 'Source type', 'Uploaded at', 'SHA-256'])
  styleHeader(metadata.getRow(metadata.rowCount))
  for (const item of report.imports) metadata.addRow([item.id, item.filename, item.sourceType, item.uploadedAt, item.checksum])
  metadata.columns = [{ width: 38 }, { width: 40 }, { width: 32 }, { width: 30 }, { width: 20 }, { width: 20 }, { width: 20 }, { width: 20 }, { width: 20 }, { width: 30 }]
  setPrintLayout(metadata, '1:1')

  for (const sheet of workbook.worksheets) {
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        if (!cell.font?.name) cell.font = { name: 'Aptos', size: 9 }
        if (!cell.alignment?.vertical) cell.alignment = { ...cell.alignment, vertical: 'middle' }
      })
    })
  }
  return workbook.xlsx.writeBuffer()
}
