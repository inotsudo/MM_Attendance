'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CalendarDays, FileCheck2, FileText, RefreshCw, Users } from 'lucide-react'

type ImportSummary = { id: string; original_filename: string; source_type: string; uploaded_at: string; processing_status: string }
type DashboardData = { week: { from: string; to: string }; counts: { employees: number; imports: number; reviewItems: number; calculatedDays: number }; recentImports: ImportSummary[] }
type AttendanceRecord = { id: string; employeeNumber: string; employeeName: string; department: string | null; date: string; firstEvent: string | null; lastEvent: string | null; eventCount: number; arrival: string; completeness: string; overtime: boolean; current: boolean; sources: string[] }

function Stat({ icon: Icon, label, value, note }: { icon: typeof Users; label: string; value: number | string; note: string }) {
  return <article className="stat-card"><div className="stat-icon"><Icon /></div><span>{label}</span><strong>{value}</strong><small>{note}</small></article>
}

function dateLabel(value: string) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kigali', dateStyle: 'medium' }).format(new Date(`${value}T12:00:00+02:00`))
}

function currentWeek() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const midnight = Date.parse(`${today}T00:00:00Z`)
  const day = new Date(midnight).getUTCDay()
  return new Date(midnight - ((day + 6) % 7) * 86_400_000).toISOString().slice(0, 10)
}

function addDays(value: string, days: number) {
  return new Date(Date.parse(`${value}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

async function readResponse<T>(response: Response): Promise<T> {
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? 'The request could not be completed.')
  return result as T
}

export function DashboardPage({ onImport, onNavigate }: { onImport: () => void; onNavigate: (page: string) => void }) {
  const [data, setData] = useState<DashboardData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await readResponse<DashboardData>(await fetch('/api/dashboard', { cache: 'no-store' }))
      setData(result)
      setError(null)
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Dashboard information could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])
  return <>
    {error && <div className="dashboard-load-error" role="alert"><div><strong>Dashboard data could not be refreshed</strong><span>{error}</span></div><button className="button secondary small" onClick={() => void load()} disabled={loading}><RefreshCw /> Try again</button></div>}
    <section className="overview-grid" aria-busy={loading}>
      {loading && !data ? <>{[
        ['Staff on file', 'Available for attendance matching'], ['Files uploaded', 'Original files kept private'], ['Need attention', 'Open attendance questions'], ['Saved attendance records', 'Africa/Kigali'],
      ].map(([label, note]) => <article className="stat-card stat-loading" key={label}><div className="stat-icon"><span className="skeleton skeleton-icon" /></div><span>{label}</span><span className="skeleton skeleton-value" /><small>{note}</small></article>)}</> : <>
        <Stat icon={Users} label="Staff on file" value={data?.counts.employees ?? 0} note="Available for attendance matching" />
        <Stat icon={FileCheck2} label="Files uploaded" value={data?.counts.imports ?? 0} note="Original files kept private" />
        <Stat icon={AlertTriangle} label="Need attention" value={data?.counts.reviewItems ?? 0} note="Open attendance questions" />
        <Stat icon={CalendarDays} label="Saved attendance records" value={data?.counts.calculatedDays ?? 0} note={data ? `${dateLabel(data.week.from)} – ${dateLabel(data.week.to)}` : 'Africa/Kigali'} />
      </>}
    </section>
    <section className="dashboard-grid">
      <section className="panel upload-panel"><div className="panel-heading"><div><h2>Your weekly workflow</h2><p>Three clear steps to prepare attendance for HR.</p></div><FileText className="heading-icon" /></div><ol className="dashboard-workflow"><li><span>1</span><div><strong>Import the weekly file</strong><small>Upload an iVMS PDF or prepared attendance workbook.</small></div></li><li><span>2</span><div><strong>Review items that need attention</strong><small>Check names, missing punches, and other exceptions.</small></div></li><li><span>3</span><div><strong>Prepare the HR report</strong><small>Download the reviewed attendance for the selected week.</small></div></li></ol><div className="heading-actions"><button className="button primary" onClick={onImport}>Import attendance</button><button className="button secondary" onClick={() => onNavigate('Reports')}>Prepare HR report</button></div></section>
      <section className="panel weekly-panel"><div className="panel-heading"><div><h2>Recent files</h2><p>See which files are ready and which need attention.</p></div></div>
        {loading && !data ? <div className="recent-loading" aria-label="Loading recent files"><span className="skeleton skeleton-row" /><span className="skeleton skeleton-row" /><span className="skeleton skeleton-row short" /></div> : !data?.recentImports.length ? <div className="dashboard-empty"><span className="empty-icon"><FileCheck2 /></span><div><strong>No files uploaded yet</strong><p>Your weekly imports and their review status will appear here.</p></div><button className="button secondary small" onClick={onImport}>Upload first file</button></div> : <div className="table-wrap"><table><thead><tr><th>File</th><th>Uploaded</th><th>Status</th></tr></thead><tbody>{data.recentImports.map((item) => <tr key={item.id}><td>{item.original_filename}</td><td>{new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'Africa/Kigali' }).format(new Date(item.uploaded_at))}</td><td><span className={`import-status ${item.processing_status}`}>{item.processing_status.replaceAll('_', ' ')}</span></td></tr>)}</tbody></table></div>}
      </section>
    </section>
  </>
}

export function AttendanceRecordsPage() {
  const [week, setWeek] = useState(currentWeek)
  const [search, setSearch] = useState('')
  const [records, setRecords] = useState<AttendanceRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const limit = 50
  const to = useMemo(() => addDays(week, 6), [week])
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ from: week, to, offset: String(offset), limit: String(limit) })
      if (search.trim()) params.set('search', search.trim())
      const result = await readResponse<{ records: AttendanceRecord[]; total: number }>(await fetch(`/api/attendance-records?${params}`, { cache: 'no-store' }))
      setRecords(result.records); setTotal(result.total); setError(null)
    } catch (issue) { setError(issue instanceof Error ? issue.message : 'Attendance records could not be loaded.') }
    finally { setLoading(false) }
  }, [week, to, offset, search])
  useEffect(() => { const timer = setTimeout(() => { void load() }, 150); return () => clearTimeout(timer) }, [load])
  return <section className="panel records-page">
    <div className="filters"><div className="search-field"><Users /><input value={search} onChange={(event) => { setSearch(event.target.value); setOffset(0) }} placeholder="Search employee ID or name" /></div><label className="field-label">Week starting Monday<input type="date" value={week} onChange={(event) => { setWeek(event.target.value); setOffset(0) }} /></label><button className="button secondary" onClick={() => { setWeek(addDays(week, -7)); setOffset(0) }}>Previous week</button><button className="button secondary" onClick={() => { setWeek(addDays(week, 7)); setOffset(0) }}>Next week</button></div>
    <p className="subtitle">{week} to {to} · Africa/Kigali · Times show the first and last recorded events, not assumed IN/OUT.</p>
    {error && <p className="form-notice" role="alert">{error}</p>}
    <div className="table-meta"><span>{loading ? 'Loading records…' : `${total} saved attendance calculations`}</span></div>
    {loading ? null : !records.length ? <p className="subtitle">No saved attendance calculations in this week. Upload and confirm an attendance file to populate this list.</p> : <div className="table-wrap"><table><thead><tr><th>Date</th><th>Employee ID</th><th>Employee name</th><th>First event</th><th>Last event</th><th>Arrival</th><th>Evidence</th><th>Overtime</th><th>Source file</th></tr></thead><tbody>{records.map((record) => <tr key={record.id}><td>{dateLabel(record.date)}</td><td>{record.employeeNumber}</td><td>{record.employeeName}</td><td>{record.firstEvent ?? '—'}</td><td>{record.lastEvent ?? '—'}</td><td>{record.arrival.replaceAll('_', ' ')}</td><td>{record.completeness}{record.eventCount ? ` · ${record.eventCount} event${record.eventCount === 1 ? '' : 's'}` : ''}</td><td>{record.overtime ? 'Verified' : '—'}</td><td>{record.sources.join(', ') || '—'}</td></tr>)}</tbody></table></div>}
    {total > limit && <div className="heading-actions"><button className="button secondary" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - limit))}>Previous</button><button className="button secondary" disabled={offset + limit >= total || loading} onClick={() => setOffset(offset + limit)}>Next</button></div>}
  </section>
}
