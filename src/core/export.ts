import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import type { Row, SnapshotAdapter, TableConfig } from '../types'
import { encodeRow, serializeRows } from '../codec'
import { assertSafeFileName, hashFile, sha256, writeIfChanged } from '../utils'
import { MANIFEST_FILE, SCHEMA_DOC_FILE, SCHEMA_FILE, readManifest, type Manifest } from './manifest'
import { makeRedactor, unredactedSensitive, validateRedact, type RedactConfig } from './redact'
import { resolveTables } from './resolve'
import { buildSchemaJson, buildSchemaMarkdown } from './schema-doc'
import type { DeferredColumns } from '../types'

export interface ExportOptions {
  adapter: SnapshotAdapter
  /** Omit to derive every table from the database (needs an introspecting adapter such as createSqlAdapter). */
  tables?: TableConfig[]
  dataDir: string
  /** Table names to leave out when `tables` is derived from the database. */
  exclude?: string[]
  /** Partial export: only these tables (by `file` name). Other tables keep their existing files and manifest entries. */
  only?: string[]
  /** Column masking. Off unless set. */
  redact?: RedactConfig
  /** Secret mixed into masking hashes. */
  redactSalt?: string
  /** Rows per batch when streaming (default 5000). Streaming needs an adapter with `findBatches` and a table with a primary key. */
  batchSize?: number
  /** Write SCHEMA.md next to `_schema.json` (default true; only when the schema is known). */
  writeSchemaDoc?: boolean
  deferredColumns?: DeferredColumns
  /** Called for logging; defaults to console.log. Pass a no-op to stay silent. */
  log?: (msg: string) => void
}

export interface ExportResult {
  changed: number
  unchanged: number
}

interface Written {
  rows: number
  sha: string
  changed: boolean
  columns: Record<string, string[]>
}

/**
 * Stream batches to `<file>.ndjson.tmp-…`, hash while writing, and only replace the real file when
 * the content differs. Memory use stays at one batch. Row order = the order the batches arrive (PK order).
 */
async function writeStreaming(target: string, batches: AsyncIterable<Row[]>, redactor: ((r: Row) => Row) | null): Promise<{ rows: number; sha: string; changed: boolean }> {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp-${process.pid}`
  const fd = fs.openSync(tmp, 'w')
  const hash = crypto.createHash('sha256')
  let rows = 0
  try {
    for await (const batch of batches) {
      let chunk = ''
      for (const raw of batch) {
        chunk += JSON.stringify(encodeRow(redactor ? redactor(raw) : raw)) + '\n'
        rows++
      }
      if (chunk) {
        hash.update(chunk)
        fs.writeSync(fd, chunk)
      }
    }
  } catch (err) {
    fs.closeSync(fd)
    fs.rmSync(tmp, { force: true })
    throw err
  }
  fs.closeSync(fd)

  const sha = hash.digest('hex')
  const previous = fs.existsSync(target) ? await hashFile(target) : null
  if (previous === sha) {
    fs.rmSync(tmp, { force: true })
    return { rows, sha, changed: false }
  }
  fs.renameSync(tmp, target)
  return { rows, sha, changed: true }
}

/**
 * Dump every configured table to `<dataDir>/<file>.ndjson` (one row per line) and write
 * `<dataDir>/manifest.json` (row counts, sha256, column types). With an introspecting adapter it also
 * writes `_schema.json` + `SCHEMA.md`. Files are only rewritten when their content changed, so this is
 * diff-friendly in git. Rows are sorted by id (full load) or by primary key (streaming).
 */
export async function exportSnapshot(options: ExportOptions): Promise<ExportResult> {
  const { adapter, dataDir, only, redact, redactSalt = '', batchSize = 5000, writeSchemaDoc = true, log = console.log } = options

  const resolved = await resolveTables({ adapter, tables: options.tables, deferredColumns: options.deferredColumns, exclude: options.exclude, log })
  const allTables = resolved.tables

  const seen = new Set<string>()
  for (const { file } of allTables) {
    assertSafeFileName(file)
    if (seen.has(file)) throw new Error(`Nama file tabel ganda di config: "${file}"`)
    seen.add(file)
  }

  let tables = allTables
  if (only?.length) {
    const unknown = only.filter((f) => !seen.has(f))
    if (unknown.length) throw new Error(`Export parsial: tabel tidak dikenal: ${unknown.join(', ')}`)
    tables = allTables.filter((t) => only.includes(t.file))
  }

  validateRedact(redact, resolved.schema, new Map(allTables.map((t) => [t.file, t.key])))

  if (resolved.schema) {
    const risky = unredactedSensitive(
      tables.flatMap((t) => (resolved.schema!.tables[t.key]?.columns ?? []).map((c) => ({ table: t.file, column: c.name }))),
      redact,
    )
    if (risky.length) {
      log(`⚠️  ${risky.length} kolom terlihat sensitif dan ditulis apa adanya ke snapshot: ${risky.join(', ')}`)
      log('   Atur `redact` di config kalau snapshot ini akan di-commit atau dibagikan.\n')
    }
  }

  fs.mkdirSync(dataDir, { recursive: true })

  const previous = only?.length ? readManifest(dataDir) : null
  if (only?.length && !previous) {
    throw new Error('Export parsial butuh snapshot penuh sebelumnya (manifest.json tidak ada). Jalankan export tanpa --tables dulu.')
  }
  const manifest: Manifest = {
    version: 2,
    format: 'ndjson',
    ...(resolved.schema ? { dialect: resolved.schema.dialect } : {}),
    tables: { ...(previous?.tables ?? {}) },
  }

  let changed = 0
  let unchanged = 0

  const work = async (reader: SnapshotAdapter) => {
    for (const { key, file } of tables) {
      const schemaTable = resolved.schema?.tables[key]
      const redactor = makeRedactor(file, redact, redactSalt)
      const target = path.join(dataDir, `${file}.ndjson`)

      let written: Written
      if (reader.findBatches && schemaTable?.primaryKey.length) {
        const w = await writeStreaming(target, reader.findBatches(key, batchSize), redactor)
        written = { ...w, columns: {} }
      } else {
        let rows = await reader.findMany(key)
        if (redactor) rows = rows.map(redactor)
        const { content, rows: count, columns } = serializeRows(rows)
        written = { rows: count, sha: sha256(content), changed: writeIfChanged(target, content), columns }
      }

      // With a known schema the manifest carries canonical types (datetime, uuid, ...), not just JS types.
      const columns = schemaTable
        ? Object.fromEntries(
            schemaTable.columns
              .filter((c) => !c.generated)
              .map((c): [string, string[]] => [c.name, [c.type]])
              .sort((a, b) => (a[0] < b[0] ? -1 : 1)),
          )
        : written.columns

      const redacted = Object.keys(redact?.[file] ?? {}).sort()
      manifest.tables[file] = { rows: written.rows, sha256: written.sha, columns, ...(redacted.length ? { redacted } : {}) }

      if (written.changed) {
        changed++
        log(`  ✓ ${file}.ndjson (${written.rows} baris)`)
      } else {
        unchanged++
      }
    }
  }

  // One consistent read-only view of the whole database when the adapter supports it.
  if (adapter.readSnapshot) await adapter.readSnapshot(work)
  else await work(adapter)

  // Manifest is written after the data files: if anything above threw, the old manifest still matches the old files.
  if (writeIfChanged(path.join(dataDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n')) {
    log(`  ✓ ${MANIFEST_FILE}`)
  }

  if (resolved.schema) {
    const schemaJson = buildSchemaJson(resolved.schema, allTables, resolved.deferredColumns)
    if (writeIfChanged(path.join(dataDir, SCHEMA_FILE), JSON.stringify(schemaJson, null, 2) + '\n')) log(`  ✓ ${SCHEMA_FILE}`)
    if (writeSchemaDoc && writeIfChanged(path.join(dataDir, SCHEMA_DOC_FILE), buildSchemaMarkdown(schemaJson, manifest))) {
      log(`  ✓ ${SCHEMA_DOC_FILE}`)
    }
  }

  log(`\nSelesai: ${changed} file diperbarui, ${unchanged} tidak berubah.`)
  return { changed, unchanged }
}
