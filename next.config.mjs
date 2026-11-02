import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.dirname(fileURLToPath(import.meta.url))

/** @type {import('next').NextConfig} */
const nextConfig = {
  // ExcelJS pulls a sizeable Node-only dependency graph (including jszip and
  // readable-stream). Load it with Node at runtime instead of making Turbopack
  // watch and bundle every transitive file in the pnpm store.
  serverExternalPackages: ['exceljs', 'pdfjs-dist'],
  // PDF.js loads its Node worker dynamically at runtime. Include it explicitly
  // in Vercel's traced route bundle so serverless imports can create the fake
  // worker instead of failing to resolve pdf.worker.mjs.
  outputFileTracingIncludes: {
    '/api/import/*': ['./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'],
  },
  // This project lives under a larger pnpm workspace. Keep Turbopack's file
  // watcher scoped to this application rather than the entire Documents tree.
  turbopack: {
    root: projectRoot,
  },
  experimental: {
    // In this environment Next's spawned `tsc --showConfig` process exits with
    // no stdout. Use Next's TypeScript compiler API instead; type checking stays on.
    useTypeScriptCli: false,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
