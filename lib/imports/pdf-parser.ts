import 'server-only'

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { normalizeEmployeeName, normalizeEmployeeNumber, parseSourceDateTime } from './time'
import type { ImportWarning, ParsedAttendanceImport, PdfAttendanceRecord } from './types'

type PositionedText = { text: string; x: number; y: number }
const FIELD_LABELS = [
  'person id', 'name', 'department', 'time', 'attendance status',
  'attendance check point', 'custom name', 'data source', 'handling type', 'temperature', 'abnormal',
]

export function pdfOpenErrorMessage(error: unknown): string {
  const errorName = error && typeof error === 'object' && 'name' in error && typeof error.name === 'string' ? error.name : ''
  const rawErrorMessage = error instanceof Error ? error.message : ''
  const errorMessage = rawErrorMessage.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
  if (errorName === 'PasswordException' || /password|encrypt/i.test(errorMessage)) {
    return 'This PDF is password-protected or encrypted. Export an unencrypted iVMS Original Records Report and try again.'
  }
  if (errorName === 'MissingPDFException') return 'The uploaded file has no readable PDF content. Export the original report again and try again.'
  const detail = errorMessage ? `: ${errorMessage}` : ''
  return `PDF.js could not open this file (${errorName || 'unreadable PDF'})${detail}. Export a new, unencrypted iVMS Original Records Report and try again.`
}

function columnIndex(x: number, starts: number[]): number {
  for (let i = 0; i < starts.length - 1; i++) {
    if (x < (starts[i] + starts[i + 1]) / 2) return i
  }
  return starts.length - 1
}

function normalizedIdentity(employeeNumber: string | null, employeeName: string | null, index: number) {
  return normalizeEmployeeNumber(employeeNumber) ?? `name:${normalizeEmployeeName(employeeName) ?? `record:${index}`}`
}

function parsePageItems(items: PositionedText[], page: number, sourceIndexStart: number, fallbackLayout?: { starts: number[]; headerY: number }): { records: PdfAttendanceRecord[]; hasHeader: boolean; layout?: { starts: number[]; headerY: number } } {
  const labelItems = items.map((item) => ({ ...item, normalized: item.text.toLowerCase().replace(/\s+/g, ' ').trim() }))
  const header = FIELD_LABELS.map((field) => labelItems.find((item) => item.normalized === field))
  const hasHeader = Boolean(header[0] && header[1] && header[2] && header[3] && header[4] && header[5])
  if (!hasHeader && !fallbackLayout) return { records: [], hasHeader: false }

  const starts = hasHeader ? header.map((item) => item!.x) : fallbackLayout!.starts
  const headerY = hasHeader ? Math.max(...header.map((item) => item!.y)) : fallbackLayout!.headerY
  const bodyItems = items.filter((item) => item.y < headerY - 5)
  const rowAnchors = bodyItems.filter((item) => columnIndex(item.x, starts) <= 5 && item.text.trim() && item.text.trim() !== '-')
  const anchorYs: number[] = []
  const primaryAnchors = rowAnchors.filter((item) => [0, 3].includes(columnIndex(item.x, starts)))
  for (const item of primaryAnchors.sort((a, b) => b.y - a.y)) {
    const cluster = anchorYs.findIndex((y) => Math.abs(y - item.y) <= 2)
    if (cluster < 0) anchorYs.push(item.y)
    else if (item.y > anchorYs[cluster]) anchorYs[cluster] = item.y
  }
  const fallbackAnchors = rowAnchors.filter((item) => ![0, 3].includes(columnIndex(item.x, starts))
    && !anchorYs.some((y) => Math.abs(y - item.y) <= 16))
  for (const item of fallbackAnchors.sort((a, b) => b.y - a.y)) {
    const cluster = anchorYs.findIndex((y) => Math.abs(y - item.y) <= 13)
    if (cluster < 0) anchorYs.push(item.y)
    else if (item.y > anchorYs[cluster]) anchorYs[cluster] = item.y
  }
  anchorYs.sort((a, b) => b - a)

  const records: PdfAttendanceRecord[] = []
  let sourceIndex = sourceIndexStart
  for (const y of anchorYs) {
    const cells = Array.from({ length: FIELD_LABELS.length }, (_, fieldIndex) => {
      const matching = bodyItems
        .filter((item) => columnIndex(item.x, starts) === fieldIndex && Math.abs(item.y - y) <= 11)
        .sort((a, b) => b.y - a.y || a.x - b.x)
      const byLine = new Map<number, PositionedText[]>()
      for (const item of matching) {
        const lineY = Math.round(item.y * 2) / 2
        byLine.set(lineY, [...(byLine.get(lineY) ?? []), item])
      }
      return [...byLine.entries()].sort((a, b) => b[0] - a[0]).map(([, line]) => line.sort((a, b) => a.x - b.x).map((item) => item.text.trim()).filter(Boolean).join(' ')).filter(Boolean).join(' ')
    })
    if (cells.every((value) => !value)) continue
    sourceIndex += 1
    const [employeeNumberRaw, employeeNameRaw, departmentRaw, timeRaw, statusRaw, checkpointRaw, customName, dataSource, handlingType, temperature, abnormal] = cells
    const employeeNumber = employeeNumberRaw && employeeNumberRaw !== '-' ? employeeNumberRaw : null
    const employeeName = employeeNameRaw && employeeNameRaw !== '-' ? employeeNameRaw : null
    const sourceTimestamp = timeRaw ?? ''
    const parsedTimestamp = parseSourceDateTime(sourceTimestamp)
    const warnings: ImportWarning[] = []
    if (!employeeNumber) warnings.push({ code: 'missing_employee_id', severity: 'warning', message: 'The PDF event has no Person ID.', sourceIndex, page })
    if (!employeeName) warnings.push({ code: 'missing_employee_name', severity: 'warning', message: 'The PDF event has no employee name.', sourceIndex, page })
    if (!sourceTimestamp || sourceTimestamp === '-') warnings.push({ code: 'missing_timestamp', severity: 'error', message: 'The PDF event has no timestamp.', sourceIndex, page })
    else if (!parsedTimestamp.iso) warnings.push({ code: parsedTimestamp.ambiguous ? 'ambiguous_timestamp' : 'invalid_timestamp', severity: 'error', message: parsedTimestamp.ambiguous ? 'The source timestamp is ambiguous and was preserved without normalization.' : 'The source timestamp could not be interpreted and was preserved without normalization.', sourceIndex, page })
    records.push({
      sourceIndex,
      sourcePage: page,
      sourceRow: records.length + 1,
      identityKey: normalizedIdentity(employeeNumber, employeeName, sourceIndex),
      employeeNumber,
      employeeName,
      department: departmentRaw && departmentRaw !== '-' ? departmentRaw : null,
      sourceTimestamp,
      normalizedTimestamp: parsedTimestamp.iso,
      attendanceStatus: statusRaw && statusRaw !== '-' ? statusRaw : null,
      checkpoint: checkpointRaw && checkpointRaw !== '-' ? checkpointRaw : null,
      fields: {
        personId: employeeNumber,
        name: employeeName,
        department: departmentRaw || null,
        time: sourceTimestamp || null,
        attendanceStatus: statusRaw || null,
        attendanceCheckPoint: checkpointRaw || null,
        customName: customName || null,
        dataSource: dataSource || null,
        handlingType: handlingType || null,
        temperature: temperature || null,
        abnormal: abnormal || null,
      },
      rawText: cells.join(' | '),
      warnings,
    })
  }
  return { records, hasHeader, layout: hasHeader ? { starts, headerY } : fallbackLayout }
}

export async function parseIvmsPdf(bytes: Uint8Array): Promise<ParsedAttendanceImport> {
  if (bytes.length < 8 || new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') throw new Error('The file signature is not a PDF.')
  const task = getDocument({ data: bytes, useSystemFonts: true, disableFontFace: true })
  let document: Awaited<typeof task.promise>
  try {
    document = await task.promise
  } catch (error) {
    await task.destroy().catch(() => undefined)
    throw new Error(pdfOpenErrorMessage(error))
  }
  try {
    if (document.numPages < 1) throw new Error('The PDF contains no pages.')
    if (document.numPages > 300) throw new Error('The PDF contains too many pages to process safely.')
    const records: PdfAttendanceRecord[] = []
    let foundReportHeader = false
    let layout: { starts: number[]; headerY: number } | undefined
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      const positioned: PositionedText[] = content.items.flatMap((item) => {
        if (!('str' in item) || !item.str.trim() || !('transform' in item)) return []
        return [{ text: item.str, x: item.transform[4], y: item.transform[5] }]
      })
      const result = parsePageItems(positioned, pageNumber, records.length, layout)
      foundReportHeader ||= result.hasHeader
      if (result.layout) layout = result.layout
      records.push(...result.records)
    }
    if (!foundReportHeader) throw new Error('This PDF is not a supported iVMS-4200 Original Records Report. Expected the Person ID, Name, Department, Time, Attendance Status, and Attendance Check Point columns.')
    if (records.length === 0) throw new Error('The Original Records Report contains no extractable event rows.')
    const warnings: ImportWarning[] = []
    return { sourceType: 'ivms_pdf_original_records', records, warnings }
  } finally {
    await task.destroy()
  }
}
