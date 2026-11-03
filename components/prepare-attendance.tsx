'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CalendarDays, CheckCircle2, Download, FileCheck2, FileSpreadsheet, FileText, Fingerprint, LoaderCircle, RotateCcw, ShieldCheck, Upload } from 'lucide-react'

type AttendancePreviewData = {
  fileName: string; timezone: string; period: { from: string; to: string }
  summary: { sourceRecords: number; recordsInPeriod: number; employeeIdentities: number; missingEmployeeIds: number; duplicateRecords: number; warnings: number; dateRange: { from: string; to: string } | null }
  warningList: Array<{ severity: string; message: string; sourceIndex?: number; page?: number; sheet?: string; row?: number }>
  warningListTruncated: boolean
  employees: Array<{ employeeId: string | null; employeeName: string; absentCount: number; days: Array<{ date: string; inTime: string | null; outTime: string | null; inStatus: string; outStatus: string }> }>
}

function mondayOfCurrentWeek(timezone: string) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const instant = Date.parse(`${today}T00:00:00Z`)
  const weekday = new Date(instant).getUTCDay()
  return new Date(instant - ((weekday + 6) % 7) * 86_400_000).toISOString().slice(0, 10)
}

function addDays(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

export function PrepareAttendance() {
  const [deviceTimezone, setDeviceTimezone] = useState('UTC')
  const [timezone, setTimezone] = useState('UTC')
  const [file, setFile] = useState<File | null>(null)
  const [downloadFormat, setDownloadFormat] = useState<'pdf' | 'xlsx'>('xlsx')
  const [weekStart, setWeekStart] = useState(() => mondayOfCurrentWeek('UTC'))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<AttendancePreviewData | null>(null)
  const [busyMode, setBusyMode] = useState<'preview' | 'download' | null>(null)
  const [result, setResult] = useState<{ employees: string; records: string; warnings: string; period: string } | null>(null)
  const periodEnd = useMemo(() => weekStart ? addDays(weekStart, 6) : '', [weekStart])
  const validTimezone = useMemo(() => {
    try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); return true } catch { return false }
  }, [timezone])
  const timezoneOptions = useMemo(() => {
    // Keep the initial option list identical during server rendering and hydration.
    // The browser's detected timezone is added after mount by the effect below.
    const commonTimezones = [
      'Africa/Cairo', 'Africa/Johannesburg', 'Africa/Kampala', 'Africa/Kigali', 'Africa/Lagos', 'Africa/Nairobi',
      'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Mexico_City', 'America/New_York', 'America/Sao_Paulo', 'America/Toronto',
      'Asia/Dubai', 'Asia/Hong_Kong', 'Asia/Kolkata', 'Asia/Riyadh', 'Asia/Singapore', 'Asia/Tokyo',
      'Australia/Melbourne', 'Australia/Sydney', 'Europe/Amsterdam', 'Europe/Berlin', 'Europe/London', 'Europe/Paris', 'Europe/Rome', 'Europe/Istanbul',
      'Pacific/Auckland', 'UTC',
    ]
    return [...new Set([...commonTimezones, deviceTimezone])].sort()
  }, [deviceTimezone])

  useEffect(() => {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    setDeviceTimezone(detected)
    setTimezone(detected)
    setWeekStart(mondayOfCurrentWeek(detected))
  }, [])

  function selectTimezone(value: string) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date())
      setTimezone(value)
      setError('')
      setPreview(null)
      setResult(null)
    } catch { setTimezone(value); setPreview(null); setResult(null); setError('Enter a valid IANA timezone, such as Europe/London or Africa/Kigali.') }
  }

  function requestBody(mode: 'preview' | 'download') {
    const body = new FormData()
    if (file) body.set('file', file)
    body.set('weekStart', weekStart)
    body.set('timezone', timezone)
    body.set('mode', mode)
    if (mode === 'download') body.set('format', downloadFormat)
    return body
  }

  async function previewAttendance() {
    if (!file || !validTimezone) return
    setBusyMode('preview'); setError(''); setResult(null); setPreview(null)
    try {
      const response = await fetch('/api/prepare-attendance', { method: 'POST', body: requestBody('preview'), cache: 'no-store' })
      if (!response.ok) {
        const detail = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(detail.error ?? 'The attendance file could not be previewed.')
      }
      setPreview(await response.json())
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'The attendance file could not be previewed.')
    } finally { setBusyMode(null) }
  }

  async function downloadPreparedFile() {
    if (!file || !preview || !validTimezone) return
    setBusyMode('download'); setError('')
    try {
      const response = await fetch('/api/prepare-attendance', { method: 'POST', body: requestBody('download'), cache: 'no-store' })
      if (!response.ok) {
        const detail = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(detail.error ?? `The attendance file could not be prepared as ${downloadFormat === 'pdf' ? 'PDF' : 'Excel'}.`)
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = response.headers.get('Content-Disposition')?.match(/filename="?([^";]+)"?/)?.[1] ?? `attendance-sheet.${downloadFormat}`
      document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url)
      setResult({ employees: response.headers.get('X-Prepared-Employees') ?? '0', records: response.headers.get('X-Prepared-Records') ?? '0', warnings: response.headers.get('X-Prepared-Warnings') ?? '0', period: response.headers.get('X-Reporting-Period')?.replace('/', ' – ') ?? `${weekStart} – ${periodEnd}` })
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'The attendance file could not be prepared.')
    } finally { setBusyMode(null) }
  }

  return <main className="prepare-shell">
    <header className="prepare-brand"><div className="brand-mark"><Fingerprint /></div><div><strong>Attendance Sheet Builder</strong><span>Weekly attendance preparation</span></div><span className="prepare-local-badge"><ShieldCheck /> Temporary processing</span></header>
    <section className="prepare-hero"><p className="eyebrow">WEEKLY HR WORKFLOW</p><h1>Prepare your attendance sheet</h1><p>Upload the iVMS-4200 Original Records PDF or an attendance workbook. Review the organized attendance, then download it as a color-coded Excel workbook or PDF.</p></section>
    <ol className="prepare-steps" aria-label="Preparation steps"><li className={file ? 'complete' : 'active'}><span>01</span><div><strong>Choose a file</strong><small>PDF or Excel</small></div></li><li className={preview ? 'complete' : file ? 'active' : ''}><span>02</span><div><strong>Review preview</strong><small>Check names and times</small></div></li><li className={result ? 'complete' : preview ? 'active' : ''}><span>03</span><div><strong>Download</strong><small>PDF or Excel</small></div></li></ol>
    <section className="prepare-card" aria-busy={Boolean(busyMode)}>
      <div className="prepare-card-title"><div className="prepare-title-icon"><Upload /></div><div><h2>Choose an attendance file</h2><p>PDF or Excel workbook · maximum 25 MB</p></div></div>
      <label className={`prepare-dropzone ${file ? 'has-file' : ''}`}>
        <input type="file" accept=".pdf,.xlsx,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setError(''); setPreview(null); setResult(null) }} />
        {file ? <><FileSpreadsheet /><strong>{file.name}</strong><span>{(file.size / 1024 / 1024).toFixed(2)} MB · Click to choose another file</span></> : <><Upload /><strong>Choose a file to prepare</strong><span>iVMS PDF report or XLSX attendance sheet</span></>}
      </label>
      <div className="prepare-controls"><label className="field-label"><span><CalendarDays /> Week starts on Monday</span><input type="date" value={weekStart} onChange={(event) => { setWeekStart(event.target.value); setPreview(null); setResult(null) }} /></label><label className="field-label timezone-field"><span>Attendance timezone</span><input list="attendance-timezones" value={timezone} onChange={(event) => selectTimezone(event.target.value)} aria-describedby="timezone-help" /><datalist id="attendance-timezones">{timezoneOptions.map((option) => <option key={option} value={option}>{option}</option>)}</datalist><small id="timezone-help">Detected from your device: {deviceTimezone}. Change it to match the workplace that created the records.</small></label><p className="prepare-period">Reporting period <strong>{weekStart || '—'} to {periodEnd || '—'}</strong><span>Week dates follow the selected timezone.</span></p></div>
      {!preview && <button className="button primary prepare-submit" disabled={!file || Boolean(busyMode) || !weekStart || !validTimezone} onClick={() => void previewAttendance()}>{busyMode === 'preview' ? <><LoaderCircle className="spinning" /> Reading attendance file…</> : <><FileCheck2 /> Preview attendance</>}</button>}
      {error && <p className="form-notice prepare-message error" role="alert">{error}</p>}
      {result && <div className="prepare-success" role="status"><CheckCircle2 /><div><strong>Your attendance file is ready</strong><p>{result.period} · {result.employees} source identities · {result.records} records · {result.warnings} items to check</p></div><button className="button secondary small" onClick={() => void downloadPreparedFile()}><RotateCcw /> Download {downloadFormat === 'pdf' ? 'PDF' : 'Excel'} again</button></div>}
    </section>
    {preview && <AttendancePreview preview={preview} onDownload={() => void downloadPreparedFile()} format={downloadFormat} onFormatChange={setDownloadFormat} busy={Boolean(busyMode)} busyMode={busyMode} />}
    <section className="prepare-policy"><div className="policy-heading"><FileText /><div><h2>Color and attendance rules</h2><p>Applied to the selected reporting week</p></div></div><div className="policy-grid"><div className="policy-item"><i className="swatch late" /><span><strong>Late</strong><small>IN from 08:30</small></span></div><div className="policy-item"><i className="swatch very-late" /><span><strong>Very late</strong><small>IN from 09:30</small></span></div><div className="policy-item"><i className="swatch absent" /><span><strong>Absent mark</strong><small>Missing weekday IN or OUT</small></span></div><div className="policy-item"><i className="swatch overtime" /><span><strong>Overtime</strong><small>19:30+, when policy allows</small></span></div></div><p className="prepare-footnote">Earliest event before 12:00 is IN; latest event after 12:00 is OUT. Saturday and Sunday are rest days and are not marked absent. Time after 17:30 by itself is not overtime.</p></section>
    <footer className="prepare-privacy"><ShieldCheck /><span>The file is processed to prepare your download and is not saved to attendance history or Supabase storage.</span></footer>
  </main>
}

function AttendancePreview({ preview, onDownload, format, onFormatChange, busy, busyMode }: { preview: AttendancePreviewData; onDownload: () => void; format: 'pdf' | 'xlsx'; onFormatChange: (format: 'pdf' | 'xlsx') => void; busy: boolean; busyMode: 'preview' | 'download' | null }) {
  const dateLabel = (value: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short' }).format(new Date(`${value}T12:00:00Z`))
  const sourceLocation = (warning: AttendancePreviewData['warningList'][number]) => [warning.page ? `PDF page ${warning.page}` : null, warning.sheet ? `Sheet ${warning.sheet}` : null, warning.row ? `row ${warning.row}` : null].filter(Boolean).join(' · ')
  return <section className="preview-card" aria-label="Extracted attendance preview">
    <div className="preview-heading"><div><p className="eyebrow">REVIEW BEFORE DOWNLOAD</p><h2>Attendance preview</h2><p>Check source names, recorded times, and highlighted missing or late punches.</p></div><span className="preview-timezone">{preview.timezone}</span></div>
    <div className="preview-summary"><article><small>Source records</small><strong>{preview.summary.sourceRecords}</strong><span>{preview.summary.recordsInPeriod} in this week</span></article><article><small>Source identities</small><strong>{preview.summary.employeeIdentities}</strong><span>Names as written in the source</span></article><article className={preview.summary.warnings ? 'needs-review' : ''}><small>Items to review</small><strong>{preview.summary.warnings}</strong><span>{preview.summary.duplicateRecords} duplicate records</span></article><article><small>Events without an ID</small><strong>{preview.summary.missingEmployeeIds}</strong><span>Source names remain in the sheet</span></article></div>
    {preview.summary.dateRange && <p className="preview-range">Dates found in file: <strong>{preview.summary.dateRange.from}</strong> to <strong>{preview.summary.dateRange.to}</strong> · Report: {preview.period.from} to {preview.period.to}</p>}
    {!preview.employees.length ? <div className="preview-empty"><AlertTriangle /><div><strong>No employee identities were extracted for this week.</strong><p>Check the selected week or choose a supported source file.</p></div></div> : <div className="preview-table-wrap"><table className="preview-table"><thead><tr><th className="sticky-employee">Employee ID / name</th>{preview.employees[0].days.map((day) => <th key={day.date}>{dateLabel(day.date)}<small>IN / OUT</small></th>)}<th>No. absent</th></tr></thead><tbody>{preview.employees.map((employee, index) => <tr key={`${employee.employeeId ?? employee.employeeName}-${index}`}><td className="sticky-employee"><strong>{employee.employeeName || 'Name not provided by source'}</strong><small>{employee.employeeId || 'ID not provided'}</small></td>{employee.days.map((day) => <td key={day.date}><span className={`preview-time ${day.inStatus}`}>{day.inTime ?? (day.inStatus === 'absent' ? 'Absent' : '—')}</span><span className={`preview-time ${day.outStatus}`}>{day.outTime ?? (day.outStatus === 'absent' ? 'Absent' : '—')}</span></td>)}<td className="preview-absent">{employee.absentCount}</td></tr>)}</tbody></table></div>}
    {preview.summary.warnings > 0 && <details className="preview-warnings"><summary><AlertTriangle /> Review extraction notes <span>{preview.summary.warnings}</span></summary><ul>{preview.warningList.map((warning, index) => <li key={`${warning.sourceIndex ?? 'warning'}-${index}`}><span className={`warning-dot ${warning.severity}`} /><div><strong>{warning.message}</strong>{sourceLocation(warning) && <small>{sourceLocation(warning)}</small>}</div></li>)}</ul>{preview.warningListTruncated && <p>Showing the first 100 warnings. The workbook preserves the extracted records for your review.</p>}</details>}
    <div className="preview-actions"><p>Review the names and daily times above. This file is still temporary and hasn’t been saved.</p><div className="preview-download-controls"><label className="field-label">Download as<select value={format} onChange={(event) => onFormatChange(event.target.value as 'pdf' | 'xlsx')} disabled={busy}><option value="xlsx">Excel workbook (.xlsx)</option><option value="pdf">PDF document (.pdf)</option></select></label><button className="button primary" onClick={onDownload} disabled={busy || !preview.employees.length}>{busyMode === 'download' ? <><LoaderCircle className="spinning" /> Creating {format === 'pdf' ? 'PDF' : 'Excel'}…</> : <><Download /> Download {format === 'pdf' ? 'PDF' : 'Excel workbook'}</>}</button></div></div>
  </section>
}
