import fs from 'node:fs'
import path from 'node:path'
import type { DeferredColumns, Row, SnapshotAdapter, TableConfig } from '../types'
import { parseNdjson } from '../codec'
import { assertSafeFileName, chunked, readLegacyJson, sha256 } from '../utils'
import { orderTables } from './order'
import { readManifest } from './manifest'
import { resolveTables } from './resolve'

export interface SeedOptions {
  adapter: SnapshotAdapter
  /**
   * Omit to restore the tables found in the snapshot's manifest.json (needs an introspecting
   * adapter such as createSqlAdapter; insert order and deferred FKs then come from the live database).
   */
  tables?: TableConfig[]
  dataDir: string
  /** FK columns to null-out on insert and patch afterwards (circular / self references). Detected automatically when `tables` is omitted. */
  deferredColumns?: DeferredColumns
  /** Max rows per INSERT. Automatically lowered for wide tables to stay under driver parameter limits. */
  chunkSize?: number
  /** Validate the snapshot and print the plan, but do not touch the database. */
  dryRun?: boolean
  log?: (msg: string) => void
}

/** Postgres allows 65535 bind parameters per statement, SQLite/MySQL setups often fewer. Stay well below. */
const MAX_PARAMS_PER_INSERT = 20000

interface LoadedTable {
  table: TableConfig
  rows: Row[]
}

function loadSnapshot(tables: TableConfig[], dataDir: string, log: (m: string) => void): LoadedTable[] {
  const manifest = readManifest(dataDir)
  if (!manifest) {
    log('⚠️  manifest.json tidak ada — integritas file tidak bisa diverifikasi (snapshot lama / belum pernah export).')
  }

  return tables.map((table) => {
    assertSafeFileName(table.file)
    const ndjson = path.join(dataDir, `${table.file}.ndjson`)
    const legacy = path.join(dataDir, `${table.file}.json`)
    const entry = manifest?.tables[table.file]

    if (manifest && !entry) {
      throw new Error(`Tabel "${table.file}" ada di config tapi tidak ada di manifest.json. Jalankan export ulang atau perbaiki config.`)
    }

    if (fs.existsSync(ndjson)) {
      const raw = fs.readFileSync(ndjson)
      const rows = parseNdjson(raw.toString('utf8'), `${table.file}.ndjson`)
      if (entry) {
        if (sha256(raw) !== entry.sha256) {
          throw new Error(`${table.file}.ndjson tidak cocok dengan checksum di manifest.json (file berubah/rusak). Seed dibatalkan, DB belum disentuh.`)
        }
        if (rows.length !== entry.rows) {
          throw new Error(`${table.file}.ndjson punya ${rows.length} baris, manifest bilang ${entry.rows}. Seed dibatalkan, DB belum disentuh.`)
        }
      }
      return { table, rows }
    }

    if (fs.existsSync(legacy)) {
      log(`⚠️  ${table.file}: memakai format lama .json (tanpa verifikasi checksum). Jalankan export ulang untuk migrasi ke .ndjson.`)
      return { table, rows: readLegacyJson(legacy) }
    }

    if (entry && entry.rows > 0) {
      throw new Error(`${table.file}.ndjson hilang, padahal manifest mencatat ${entry.rows} baris. Seed dibatalkan, DB belum disentuh.`)
    }
    log(`⚠️  ${table.file}: file snapshot tidak ada — tabel akan dikosongkan tanpa isi baru.`)
    return { table, rows: [] }
  })
}

function chunkSizeFor(rows: Row[], max: number): number {
  const cols = Math.max(1, Object.keys(rows[0] ?? {}).length)
  return Math.max(1, Math.min(max, Math.floor(MAX_PARAMS_PER_INSERT / cols)))
}

/**
 * Wipe every configured table and reload it from its snapshot.
 *
 * Safety model:
 *  1. The snapshot is fully read and verified (checksums, row counts) BEFORE the database is touched.
 *  2. TRUNCATE, all INSERTs, deferred-FK patches and the row-count check run in ONE transaction:
 *     any failure rolls everything back and the old data stays intact.
 *  3. Tables are inserted parents-first (topological order from `dependsOn`).
 *  4. Sequences are re-synced after commit.
 */
export async function seedFromSnapshot({
  adapter,
  tables: configuredTables,
  dataDir,
  deferredColumns: configuredDeferred,
  chunkSize = 1000,
  dryRun = false,
  log = console.log,
}: SeedOptions): Promise<void> {
  let only: string[] | undefined
  if (!configuredTables) {
    const manifest = readManifest(dataDir)
    if (!manifest) throw new Error('Tanpa `tables` di config, seed butuh manifest.json untuk tahu tabel mana yang dipulihkan.')
    only = Object.keys(manifest.tables)
  }
  const resolved = await resolveTables({ adapter, tables: configuredTables, deferredColumns: configuredDeferred, only, log })
  const deferredColumns = resolved.deferredColumns

  const ordered = orderTables(resolved.tables)
  const loaded = loadSnapshot(ordered, dataDir, log)

  // Rows of deferred tables must be locatable: by primary key when the adapter can patch by key, otherwise by `id`.
  const keyColumns = (file: string): string[] | undefined => (adapter.updateWhere ? resolved.primaryKeys[file] : undefined)
  for (const { table, rows } of loaded) {
    const cols = deferredColumns[table.file] ?? []
    if (cols.length === 0) continue
    const pk = keyColumns(table.file) ?? ['id']
    if (rows.some((r) => pk.some((k) => r[k] === undefined || r[k] === null))) {
      throw new Error(`Tabel "${table.file}" punya deferredColumns tapi ada baris tanpa nilai untuk kolom kunci (${pk.join(', ')}) — tidak bisa dipatch.`)
    }
  }

  log(dryRun ? '🔎 DRY RUN — database tidak akan diubah\n' : '🌱 Memulai seed dari snapshot\n')
  log('Urutan insert:')
  for (const { table, rows } of loaded) {
    const d = deferredColumns[table.file]
    log(`  ${table.file}: ${rows.length} baris${d?.length ? ` (ditunda: ${d.join(', ')})` : ''}`)
  }
  if (dryRun) {
    log('\n✅ Snapshot valid. Tidak ada perubahan ke database.')
    return
  }

  const keys = loaded.map((l) => l.table.key)

  await adapter.transaction(async (tx) => {
    await tx.truncateAll(keys)
    log(`\n🧹 ${keys.length} tabel dikosongkan (di dalam transaksi)`)

    const patches: { key: string; items: { id: string; where?: Row; data: Row }[] }[] = []

    for (const { table, rows: original } of loaded) {
      if (original.length === 0) continue
      let rows = original

      const deferredCols = deferredColumns[table.file] ?? []
      if (deferredCols.length > 0) {
        const pk = keyColumns(table.file)
        const items = rows
          .map((row) => ({
            id: row.id as string,
            where: pk ? Object.fromEntries(pk.map((k) => [k, row[k]])) : undefined,
            data: Object.fromEntries(deferredCols.filter((col) => row[col] != null).map((col) => [col, row[col]])),
          }))
          .filter((item) => Object.keys(item.data).length > 0)
        if (items.length > 0) patches.push({ key: table.key, items })
        rows = rows.map((row) => ({ ...row, ...Object.fromEntries(deferredCols.map((col) => [col, null])) }))
      }

      for (const chunk of chunked(rows, chunkSizeFor(rows, chunkSize))) {
        await tx.insertMany(table.key, chunk)
      }
    }

    // Pasang kembali kolom FK yang ditunda, setelah semua tabel tujuan terisi.
    for (const { key, items } of patches) {
      for (const { id, where, data } of items) {
        if (where && tx.updateWhere) await tx.updateWhere(key, where, data)
        else await tx.update(key, id, data)
      }
    }

    if (tx.count) {
      for (const { table, rows } of loaded) {
        const actual = await tx.count(table.key)
        if (actual !== rows.length) {
          throw new Error(`Verifikasi gagal di "${table.file}": DB punya ${actual} baris, snapshot ${rows.length}. Transaksi di-rollback.`)
        }
      }
    }
  })

  for (const { table, rows } of loaded) log(`  ✓ ${table.file}: ${rows.length} baris`)

  if (adapter.resetSequences) {
    try {
      await adapter.resetSequences(keys)
    } catch (err) {
      log(`⚠️  Data sudah ter-commit, tapi sinkronisasi sequence/auto-increment gagal: ${(err as Error).message}`)
      log('   Insert baru dengan id otomatis bisa bentrok sampai sequence disesuaikan manual.')
    }
  }
  log('\n✅ Seed selesai.')
}
