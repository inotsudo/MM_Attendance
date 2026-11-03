import ExcelJS from 'exceljs'

export type ImportHistoryExportRow = {
  id: string
  original_filename: string
  source_type: string
  file_type: string
  file_size_bytes: number
  uploaded_at: string
  processing_status: string
  processing_error: string | null
}

const navy = '27345B'
const purple = '7058A4'

function sourceLabel(value: string) {
  return value === 'ivms_pdf_original_records' ? 'iVMS PDF Original Records' : value === 'organized_excel' ? 'Organized Excel' : value
}

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export async function createImportHistoryWorkbook(rows: ImportHistoryExportRow[], generatedAt = new Date()) {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Attendance Sheet Builder'
  workbook.title = 'Attendance Import History'
  workbook.subject = 'Original attendance source file import log'
  workbook.created = generatedAt

  const sheet = workbook.addWorksheet('Import History', { views: [{ state: 'frozen', ySplit: 6, xSplit: 2 }] })
  const lastColumn = 8
  sheet.mergeCells(1, 1, 1, lastColumn)
  sheet.getCell('A1').value = 'Attendance Import History'
  sheet.getCell('A1').font = { name: 'Aptos Display', size: 18, bold: true, color: { argb: 'FFFFFF' } }
  sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: navy } }
  sheet.getCell('A1').alignment = { vertical: 'middle' }
  sheet.getRow(1).height = 36
  sheet.mergeCells(2, 1, 2, lastColumn)
  sheet.getCell('A2').value = `Generated ${new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kigali', dateStyle: 'medium', timeStyle: 'short' }).format(generatedAt)} (Africa/Kigali)`
  sheet.getCell('A2').font = { name: 'Aptos', size: 10, color: { argb: '43415A' } }
  sheet.mergeCells(3, 1, 3, lastColumn)
  sheet.getCell('A3').value = `${rows.length} original file${rows.length === 1 ? '' : 's'} · Source files remain private · This is an import log, not an attendance calculation report.`
  sheet.getCell('A3').font = { name: 'Aptos', size: 9, italic: true, color: { argb: '746D89' } }
  sheet.getRow(3).height = 24
  sheet.addRow([])
  const header = sheet.addRow(['Import ID', 'Original filename', 'Source format', 'File type', 'File size', 'Uploaded at (Kigali)', 'Status', 'Review / processing note'])
  header.height = 32
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: navy } }
    cell.font = { name: 'Aptos', size: 10, bold: true, color: { argb: 'FFFFFF' } }
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
    cell.border = { bottom: { style: 'medium', color: { argb: purple } } }
  })

  for (const item of rows) {
    const row = sheet.addRow([
      item.id,
      item.original_filename,
      sourceLabel(item.source_type),
      item.file_type,
      formatSize(item.file_size_bytes),
      new Date(item.uploaded_at),
      item.processing_status.replaceAll('_', ' '),
      item.processing_error ?? '',
    ])
    row.height = 30
    row.getCell(6).numFmt = 'dd mmm yyyy, hh:mm'
    row.eachCell((cell, column) => {
      cell.font = { name: 'Aptos', size: 9, color: { argb: '343243' } }
      cell.alignment = { vertical: 'middle', wrapText: column === 2 || column === 8 }
      cell.border = { bottom: { style: 'hair', color: { argb: 'D9D6E2' } } }
      if (row.number % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FAF9FC' } }
    })
    const status = row.getCell(7)
    if (item.processing_status === 'failed' || item.processing_status === 'needs_review') {
      status.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: item.processing_status === 'failed' ? 'FCE4E4' : 'FFF4D6' } }
      status.font = { name: 'Aptos', size: 9, bold: true, color: { argb: item.processing_status === 'failed' ? '9C2020' : '8A6414' } }
    }
  }
  if (!rows.length) {
    const empty = sheet.addRow(['No attendance source files have been uploaded.'])
    sheet.mergeCells(empty.number, 1, empty.number, lastColumn)
  }
  sheet.columns = [{ width: 38 }, { width: 36 }, { width: 30 }, { width: 52 }, { width: 14 }, { width: 24 }, { width: 20 }, { width: 62 }]
  sheet.autoFilter = { from: 'A5', to: `H${Math.max(5, rows.length + 5)}` }
  sheet.pageSetup = {
    orientation: 'landscape', paperSize: 8 as ExcelJS.PaperSize, fitToPage: true,
    fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:5',
    margins: { left: 0.25, right: 0.25, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
  }
  sheet.headerFooter.oddFooter = '&LConfidential attendance information&RPage &P of &N'
  return workbook.xlsx.writeBuffer()
}
