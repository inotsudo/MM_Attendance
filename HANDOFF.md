# Attendance Sheet Builder Handoff

## 1. Project structure

- `app/page.tsx` — application entry point; renders `AttendanceApp`.
- `app/layout.tsx` — metadata, viewport, global stylesheet, and production analytics.
- `app/globals.css` — purple navigation shell, responsive layout, forms, empty states, and shared visual tokens.
- `app/api/import/route.ts` — server-side multipart file validation endpoint. It accepts `.xlsx` and `.pdf`, validates size and emptiness, and returns an explicit unavailable response because no parser/database integration is configured.
- `components/attendance-app.tsx` — current client presentation layer and local interaction state.
- `lib/attendance-engine.ts` — isolated attendance calculation logic.
- `lib/attendance-engine.test.ts` — automated attendance-engine tests.
- `components/ui/button.tsx`, `lib/utils.ts` — existing project UI utility files.

## 2. Reusable UI pieces

`AttendanceApp` owns navigation and page selection. `EmptyState`, `StatCard`, `DashboardView`, `ImportView`, `RecordsView`, `EmployeeView`, `ReportsView`, and `SettingsView` separate the major product surfaces. The current data boundary is intentionally local: future API/server-action calls can replace the local handlers without changing the navigation shell.

## 3. Attendance engine

`lib/attendance-engine.ts` accepts normalized fingerprint events and configurable rules. It orders events, groups by employee/date, preserves source IDs, classifies arrival time, detects overtime evidence and weekends, and emits review issues for invalid timestamps, unmatched employees, duplicate timestamps, and single-event days. It does not infer IN/OUT direction or calculate verified working duration.

The tests cover all requested arrival boundaries, overtime at 19:30, weekends, one-event days, invalid timestamps, duplicate timestamps, unmatched employees, and custom rule versions. Current result: **14 tests passed**.

## 4. Frontend functionality

- Dashboard renders truthful empty states with no fabricated counts or attendance rows.
- Navigation works across dashboard, employees, imports, records, review, reports, and settings.
- Mobile navigation opens and closes through the menu/scrim and remains usable at narrow widths.
- Import flow tracks idle, selected, uploading, and failed states.
- File input only accepts `.xlsx` and `.pdf` in the UI; the server endpoint repeats validation.
- Employee form validates required draft fields and clearly says the draft is local and not persisted.
- Attendance records search and filter controls are present, with an explicit empty result state.
- Report request controls and attendance-rule controls are present, but clearly identify that they are not saved/generated.
- Review, reports, activity, and settings surfaces use honest empty/unavailable states.

## 5. Not implemented

- Supabase, authentication, database schema, RLS, storage, and persistent employee/import/report data.
- Real Excel/PDF parsing and iVMS-4200 format detection.
- Import preview populated from extracted file contents.
- Employee matching, duplicate persistence, review corrections, and audit history.
- Dashboard queries, attendance-record persistence, report generation, and downloads.
- Real signed-in account identity.

No genuine source files were available in the project, so no PDF or Excel extraction is claimed or verified.

## 6. Dependencies and environment

The project uses Next.js 16.4.3, React 19, TypeScript, Tailwind CSS 4, Lucide React, shadcn dependencies, Vercel Analytics, and Vitest 5 for tests. No database environment variables or Supabase configuration are required for this frontend-only handoff.

## 7. Recommended backend integration points

1. Replace `POST /api/import` with an authenticated upload endpoint that stores the original file and creates an import record.
2. Add isolated PDF/XLSX parser modules returning format-specific raw records.
3. Add normalization and employee-matching services that emit the existing `FingerprintEvent` shape.
4. Persist raw evidence separately from normalized events and `DailyAttendanceResult` rows.
5. Load rules from versioned storage and pass the active version into `processAttendanceEvents`.
6. Add dashboard/records/review/report read endpoints and correction/audit write endpoints.
7. Replace local draft handlers with server actions or API calls and show pending/error states from the request lifecycle.

## 8. Known technical debt

- `components/attendance-app.tsx` is still a large client component and should be split further when a real data layer is introduced.
- Several controls are intentionally presentation-only until backend contracts exist.
- The current import route returns HTTP 503 after successful validation because parser/database services are intentionally absent.
- TypeScript validation is part of `next build`; there is no separate lint script configured.
- The engine uses JavaScript `Date` local-time behavior; production processing should establish and test the organization's timezone explicitly.

## 9. Local commands

```bash
pnpm install
pnpm dev
pnpm test
pnpm build
pnpm start
```

The app runs at `http://localhost:3000` by default. The production build and automated tests were run during this handoff: **build succeeded; 14/14 tests passed**.
