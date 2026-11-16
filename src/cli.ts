#!/usr/bin/env node
import path from 'node:path'
import fs from 'node:fs'
import type { DbfreezeConfig } from './types'

const CONFIG_CANDIDATES = [
  'dbfreeze.config.ts',
  'dbfreeze.config.mts',
  'dbfreeze.config.cts',
  'dbfreeze.config.js',
  'dbfreeze.config.cjs',
  'dbfreeze.config.mjs',
]

function findConfig(cwd: string): { file: string; ext: string } | null {
  for (const name of CONFIG_CANDIDATES) {
    const full = path.join(cwd, name)
    if (fs.existsSync(full)) return { file: full, ext: path.extname(name) }
  }
  return null
}

function printUsage() {
  console.log(`dbfreeze — snapshot export/seed, agnostik ORM & DB

Pemakaian:
  npx dbfreeze init [--db postgres|mysql] [--dir ./data] [--force] [--no-agent-doc]
                           Buat dbfreeze.config.(ts|cjs) awal + AGENTS.md untuk AI agent
  npx dbfreeze generate [--schema <path>] [--out <path>]
                           Baca schema.prisma, tulis daftar tabel otomatis
  npx dbfreeze export [--tables a,b] [--no-doc]
                           Dump semua tabel ke NDJSON + manifest.json (+ _schema.json, SCHEMA.md
                           kalau adapter bisa membaca struktur DB). --tables = export parsial.
  npx dbfreeze seed       Restore snapshot kembali ke DB (satu transaksi, rollback kalau gagal)
  npx dbfreeze seed --dry-run
                           Cek snapshot (checksum, urutan insert) tanpa menyentuh DB

Default --schema: ./prisma/schema.prisma
Default --out:    ./dbfreeze.tables.generated.ts

Butuh file "dbfreeze.config.ts" (atau .js) di root project. Mode SQL (tanpa ORM, tabel dibaca dari DB):

  import { defineConfig, createSqlAdapter, pgClient } from 'dbfreeze'
  import { Pool } from 'pg'

  export default defineConfig({
    adapter: createSqlAdapter({ client: pgClient(new Pool({ connectionString: process.env.DATABASE_URL })) }),
    dataDir: './data',
  })

Mode ORM: isi juga \`tables\` (lihat \`npx dbfreeze generate\` untuk Prisma).
`)
}

async function loadConfig(cwd: string): Promise<DbfreezeConfig> {
  const found = findConfig(cwd)
  if (!found) {
    console.error(`❌ Tidak ketemu dbfreeze.config.(ts|js) di ${cwd}`)
    printUsage()
    process.exit(1)
  }

  const isTs = found.ext === '.ts' || found.ext === '.mts' || found.ext === '.cts'
  if (isTs) {
    try {
      // Mendaftarkan loader TypeScript on-the-fly via `tsx`.
      // `tsx` cukup ada sebagai devDependency di project pemakai (bukan di dbfreeze).
      require('tsx/cjs')
    } catch {
      console.error('❌ Config berupa .ts tapi package "tsx" belum terinstall.')
      console.error('   Jalankan: npm install -D tsx')
      process.exit(1)
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(found.file)
  const config: DbfreezeConfig = mod.default ?? mod
  if (!config?.adapter || !config?.dataDir) {
    console.error(`❌ ${path.basename(found.file)} harus export { adapter, dataDir }`)
    process.exit(1)
  }
  if (!config.tables && typeof config.adapter.introspect !== 'function') {
    console.error(`❌ ${path.basename(found.file)}: isi \`tables\`, atau pakai adapter yang bisa membaca struktur DB (createSqlAdapter).`)
    process.exit(1)
  }
  return config
}

function flagValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(name)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

async function runGenerate(cwd: string) {
  const schemaPath = path.resolve(cwd, flagValue('--schema', 'prisma/schema.prisma'))
  const outPath = path.resolve(cwd, flagValue('--out', 'dbfreeze.tables.generated.ts'))

  if (!fs.existsSync(schemaPath)) {
    console.error(`❌ schema.prisma tidak ditemukan di ${schemaPath}`)
    console.error('   Pakai --schema <path> kalau lokasinya bukan di prisma/schema.prisma')
    process.exit(1)
  }

  const { readPrismaTables, detectDeferredColumns, detectSensitiveFields } = await import('./introspect/prisma')
  const tables = readPrismaTables(schemaPath)

  if (tables.length === 0) {
    console.error(`⚠️  Tidak ada "model" yang ketemu di ${schemaPath}`)
    process.exit(1)
  }

  const { deferredColumns, warnings } = detectDeferredColumns(schemaPath)

  const content = `// Auto-generated oleh \`npx dbfreeze generate\` — JANGAN diedit manual.
// Sumber: ${path.relative(cwd, schemaPath)}
// Jalankan ulang perintah ini tiap kali schema.prisma berubah.

import type { TableConfig, DeferredColumns } from 'dbfreeze'

export const tables: TableConfig[] = ${JSON.stringify(tables, null, 2)}

// dependsOn = tabel induk (FK) yang harus diinsert lebih dulu; seed mengurutkan otomatis.
// Kolom FK yang berada dalam circular reference (dideteksi otomatis lewat
// analisis graf relasi antar model — lihat README bagian "Deteksi FK melingkar").
// Cek lagi hasilnya; kolom di sini akan di-null-kan dulu saat insert, lalu
// dipasang kembali setelah semua tabel selesai dimuat.
export const deferredColumns: DeferredColumns = ${JSON.stringify(deferredColumns, null, 2)}
`
  fs.writeFileSync(outPath, content)
  console.log(`✓ ${tables.length} tabel ditulis ke ${path.relative(cwd, outPath)}`)
  for (const t of tables) console.log(`  - ${t.key} → ${t.file}.ndjson${t.dependsOn?.length ? ` (setelah: ${t.dependsOn.join(', ')})` : ''}`)

  const deferredCount = Object.keys(deferredColumns).length
  if (deferredCount > 0) {
    console.log(`\n🔁 ${deferredCount} tabel dengan kolom FK melingkar terdeteksi:`)
    for (const [table, cols] of Object.entries(deferredColumns)) {
      console.log(`  - ${table}: ${cols.join(', ')}`)
    }
  }
  if (warnings.length > 0) {
    console.log(`\n⚠️  ${warnings.length} peringatan:`)
    for (const w of warnings) console.log(`  - ${w}`)
  }

  const sensitive = detectSensitiveFields(schemaPath)
  if (sensitive.length > 0) {
    console.log(`\n🕶️  ${sensitive.length} kolom terlihat sensitif (password/token/secret/email/phone):`)
    for (const f of sensitive) console.log(`  - ${f}`)
    console.log('   Snapshot menyimpan data asli. Atur \`redact\` di dbfreeze.config.ts bila snapshot akan di-commit.')
  }
}

function loadDotEnv(cwd: string) {
  // Node >= 20.12 punya loadEnvFile. Variabel yang sudah ada di environment tidak ditimpa.
  const load = (process as any).loadEnvFile as ((p: string) => void) | undefined
  if (!load) return
  for (const f of ['.env', '.env.local']) {
    const p = path.join(cwd, f)
    if (!fs.existsSync(p)) continue
    try {
      const before = { ...process.env }
      load(p)
      Object.assign(process.env, before)
    } catch {
      /* .env tidak valid: biarkan config yang melaporkan DATABASE_URL kosong */
    }
  }
}

async function runInitCommand(cwd: string) {
  const { runInit } = await import('./init')
  const db = flagValue('--db', '')
  if (db && db !== 'postgres' && db !== 'mysql') {
    console.error('❌ --db harus postgres atau mysql')
    process.exit(1)
  }
  try {
    const result = runInit({
      cwd,
      dialect: (db || undefined) as 'postgres' | 'mysql' | undefined,
      dataDir: flagValue('--dir', './data'),
      force: process.argv.includes('--force'),
      agentDoc: !process.argv.includes('--no-agent-doc'),
      log: (l) => console.log(l),
    })
    for (const w of result.warnings) console.log(`⚠️  ${w}`)
    console.log('\nLangkah berikutnya:')
    console.log('  1. Pastikan DATABASE_URL benar (seed MENIMPA isi tabel di DB itu)')
    console.log('  2. npx dbfreeze export')
    console.log('  3. npx dbfreeze seed --dry-run')
  } catch (err) {
    console.error('❌', err instanceof Error ? err.message : err)
    process.exit(1)
  }
}

async function main() {
  const command = process.argv[2]
  if (command !== 'export' && command !== 'seed' && command !== 'generate' && command !== 'init') {
    printUsage()
    process.exit(command ? 1 : 0)
  }

  if (command === 'init') {
    await runInitCommand(process.cwd())
    return
  }

  if (command === 'generate') {
    await runGenerate(process.cwd())
    return
  }

  loadDotEnv(process.cwd())
  const config = await loadConfig(process.cwd())
  const { exportSnapshot, seedFromSnapshot } = await import('./index')

  try {
    if (command === 'export') {
      const only = flagValue('--tables', '')
      await exportSnapshot({
        adapter: config.adapter,
        tables: config.tables,
        dataDir: config.dataDir,
        exclude: config.exclude,
        deferredColumns: config.deferredColumns,
        redact: config.redact,
        redactSalt: config.redactSalt,
        batchSize: config.batchSize,
        only: only ? only.split(',').map((x) => x.trim()).filter(Boolean) : undefined,
        writeSchemaDoc: !process.argv.includes('--no-doc'),
      })
    } else {
      await seedFromSnapshot({
        adapter: config.adapter,
        tables: config.tables,
        dataDir: config.dataDir,
        deferredColumns: config.deferredColumns,
        dryRun: process.argv.includes('--dry-run'),
      })
    }
  } finally {
    await config.adapter.close?.()
  }
}

main().catch((err) => {
  console.error('❌', err)
  process.exit(1)
})
