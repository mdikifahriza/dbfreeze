#!/usr/bin/env node
import path from 'node:path'
import fs from 'node:fs'
import readline from 'node:readline/promises'
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
  npx dbfreeze init [--db postgres|mysql] [--dir ./data] [--force] [--no-agent-doc] [--no-export]
                           Buat dbfreeze.config.(ts|cjs) awal + AGENTS.md untuk AI agent.
                           Dengan TTY interaktif: menawarkan langsung menjalankan export setelah config dibuat.
  npx dbfreeze generate [--schema <path>] [--out <path>]
                           Baca schema.prisma, tulis daftar tabel otomatis
  npx dbfreeze export [--tables a,b] [--no-doc]
                           Dump semua tabel ke NDJSON + manifest.json (+ _schema.json, SCHEMA.md
                           kalau adapter bisa membaca struktur DB). --tables = export parsial.
  npx dbfreeze info [--tables a,b]
                           Cetak engine, koneksi, dan jumlah baris per tabel (tanpa dump)
  npx dbfreeze doctor      Cek config, koneksi DB, dan writable dataDir
  npx dbfreeze seed       Restore snapshot kembali ke DB (satu transaksi, rollback kalau gagal)
  npx dbfreeze seed --tables users,posts   Restore hanya tabel tertentu (partial restore)
                           Catatan: tabel lain TIDAK di-truncate dan tidak di-restore
  npx dbfreeze seed --dry-run
                           Cek snapshot (checksum, urutan insert) tanpa menyentuh DB

  Opsi seed:
    --yes                    Lewati konfirmasi interaktif (untuk CI/pipeline)
    --i-know-this-overwrites-prod   Override: seed ke DB yang namanya terlihat seperti produksi
                                    (nama mengandung prod/live/production)

  Guard keamanan (untuk seed):
    - Target koneksi (host/port/database) dicetak SEBELUM menyentuh DB
    - Seed ke DB yang namanya mengandung prod|live|production diblokir
    - --dry-run selalu lolos (read-only); localhost selalu boleh

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

function detectSeedTarget() {
  // target dari DATABASE_URL — diekstrak via core/guard (teruji, tidak membocorkan kredensial)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { parseDatabaseUrl } = require('./core/guard')
  return parseDatabaseUrl(process.env.DATABASE_URL ?? '')
}

async function askYesNo(question: string, defaultYes = false): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const hint = defaultYes ? '[Y/n]' : '[y/N]'
    const answer = (await rl.question(`${question} ${hint} `)).trim().toLowerCase()
    if (answer === '') return defaultYes
    return answer === 'y' || answer === 'yes'
  } finally {
    rl.close()
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

    // `dbfreeze init` interaktif: tawarkan export langsung (kecuali non-interaktif/--no-export)
    if (!process.argv.includes('--no-export') && !process.env.CI && process.stdout.isTTY) {
      if (await askYesNo('\nJalankan `npx dbfreeze export` sekarang?', true)) {
        console.log('\nMenjalankan `npx dbfreeze export`…\n')
        const { spawnSync } = await import('node:child_process')
        const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
        const child = spawnSync(npx, ['dbfreeze', 'export'], { stdio: 'inherit', cwd })
        if (child.status === 0) {
          console.log('\n✅ Export berhasil. Mau divalidasi juga?')
          if (await askYesNo('Jalankan `npx dbfreeze seed --dry-run` sekarang?', true)) {
            spawnSync(npx, ['dbfreeze', 'seed', '--dry-run'], { stdio: 'inherit', cwd })
          }
        }
      }
    }
  } catch (err) {
    console.error('❌', err instanceof Error ? err.message : err)
    process.exit(1)
  }
}

async function runInfoCommand(cwd: string) {
  loadDotEnv(cwd)
  const config = await loadConfig(cwd)
  const adapter = config.adapter
  if (typeof adapter.introspect !== 'function') {
    console.error('❌ Adapter tidak bisa membaca struktur DB (butuh createSqlAdapter atau adapter yang punya method introspect()).')
    process.exit(1)
  }
  try {
    const { MIGRATION_TABLES } = await import('./core/resolve')
    const schema = await adapter.introspect()
    const excluded = new Set([...(config.exclude ?? [])])
    const onlyRaw = flagValue('--tables', '')
    const only = onlyRaw ? new Set(onlyRaw.split(',').map((s) => s.trim()).filter(Boolean)) : null

    const tableNames = Object.keys(schema.tables).filter((n) => !MIGRATION_TABLES.includes(n) && !excluded.has(n)).sort()
    const shown = tableNames.filter((n) => !only || only.has(n))

    console.log(`Engine   : ${schema.dialect}`)
    console.log(`Exclude  : ${[...excluded].length ? [...excluded].join(', ') : '(tidak ada)'}`)
    console.log(`Redact   : ${Object.keys(config.redact ?? {}).length ? Object.keys(config.redact ?? {}).join(', ') : '(tidak ada)'}`)
    console.log(`Tabel    : ${shown.length}${only ? ` (dari ${tableNames.length})` : ''}`)

    for (const name of shown) {
      const pk: string[] = (schema.tables as any)[name]?.primaryKey ?? []
      try {
        const rows = typeof adapter.count === 'function' ? await adapter.count(name) : '?'
        console.log(`  - ${name}${pk.length ? ' [PK: ' + pk.join(', ') + ']' : ''} — ${rows} baris`)
      } catch {
        console.log(`  - ${name}${pk.length ? ' [PK: ' + pk.join(', ') + ']' : ''} — (gagal membaca jumlah baris)`)
      }
    }
  } finally {
    await config.adapter.close?.()
  }
}

async function runDoctorCommand(cwd: string) {
  const checks: { label: string; ok: boolean; detail?: string }[] = []
  const add = (label: string, ok: boolean, detail?: string) => checks.push({ label, ok, detail })

  loadDotEnv(cwd)
  let config: DbfreezeConfig | null = null
  try {
    config = await loadConfig(cwd)
    add('config', true, 'dbfreeze.config.* ditemukan dan parse dengan benar')
  } catch (err) {
    add('config', false, err instanceof Error ? err.message : String(err))
  }

  if (config) {
    try {
      const { MIGRATION_TABLES } = await import('./core/resolve')
      if (typeof config.adapter.introspect !== 'function') {
        add('introspect', false, 'adapter tidak punya method introspect() — pakai createSqlAdapter untuk diagnostic penuh')
      } else {
        const schema = await config.adapter.introspect()
        add('introspect', true, `dialect: ${schema.dialect}, ${Object.keys(schema.tables).length} tabel terbaca`)
        const excluded = new Set(config.exclude ?? [])
        const missing = MIGRATION_TABLES.filter((t) => !schema.tables[t])
        add('table_migrations', true, missing.length === MIGRATION_TABLES.length ? 'tidak perlu ditulis ulang' : 'ok')
        if (excluded.size > 0) {
          add('exclude', true, [...excluded].join(', '))
        }
      }
    } catch (err) {
      add('introspect', false, err instanceof Error ? err.message : String(err))
    }

    try {
      fs.mkdirSync(path.resolve(cwd, config.dataDir), { recursive: true })
      const probe = path.resolve(cwd, config.dataDir, `.dbfreeze-doctor-${process.pid}`)
      fs.writeFileSync(probe, 'ok')
      fs.unlinkSync(probe)
      add('dataDir', true, `${config.dataDir} dapat ditulis`)
    } catch (err) {
      add('dataDir', false, err instanceof Error ? err.message : String(err))
    }

    try { config.adapter.close?.() } catch { /* ignore */ }
  }

  for (const c of checks) {
    console.log(`${c.ok ? '✓' : '❌'} ${c.label}${c.detail ? ': ' + c.detail : ''}`)
  }
  const bad = checks.filter((c) => !c.ok).length
  process.exit(bad === 0 ? 0 : 1)
}

async function main() {
  const command = process.argv[2]
  if (command !== 'export' && command !== 'seed' && command !== 'generate' && command !== 'init' && command !== 'info' && command !== 'doctor') {
    printUsage()
    process.exit(command ? 1 : 0)
  }

  if (command === 'doctor') {
    await runDoctorCommand(process.cwd())
    return
  }

  if (command === 'info') {
    await runInfoCommand(process.cwd())
    return
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
  const { seedGuardBlock, formatTarget } = await import('./core/guard')

  // Cetak target SEBELUM menyentuh DB (tanpa kredensial) — sama seperti di composer
  const target = detectSeedTarget()
  if (command === 'seed' && target) {
    console.log(`Target: ${formatTarget(target)}\n`)
  }

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
      const dryRun = process.argv.includes('--dry-run')
      const onlyRaw = flagValue('--tables', '')
      const onlyTables = onlyRaw ? onlyRaw.split(',').map((x) => x.trim()).filter(Boolean) : undefined
      // P0 — production guard: blok seed ke DB yang namanya terlihat produksi
      if (target) {
        const block = seedGuardBlock({
          host: target.host,
          database: target.database,
          dryRun,
          overrideProdGuard: process.argv.includes('--i-know-this-overwrites-prod'),
        })
        if (block) {
          console.error('❌ ' + block)
          process.exit(1)
        }
      }
      // P0 — konfirmasi sebelum seed: readline di stdin (TTY, atau pipe 'y'/'n').
      // Dilewati hanya kalau --yes atau CI (untuk pipeline yang sengaja non-interaktif).
      // EOF/stdin kosong = jawaban N → batal.
      if (!dryRun && !process.env.CI && !process.argv.includes('--yes')) {
        const dest = target ? formatTarget(target) : '(tidak terdeteksi dari DATABASE_URL)'
        console.log(`PERINGATAN: ini akan MENGHAPUS dan menimpa isi tabel di: ${dest}`)
        if (!(await askYesNo('Lanjutkan?'))) {
          console.log('Dibatalkan. Tidak ada yang berubah.')
          process.exit(0)
        }
      }
      await seedFromSnapshot({
        adapter: config.adapter,
        tables: config.tables,
        dataDir: config.dataDir,
        deferredColumns: config.deferredColumns,
        dryRun,
        onlyTables,
      })
    }
  } finally {
    await config.adapter.close?.()
  }
}

main().catch((err) => {
  // Semua error dbfreeze ditulis untuk memuat petunjuk apa yang harus dilakukan.
  console.error('\n❌ ' + (err instanceof Error ? err.message : String(err)))
  if (process.env.DBFREEZE_DEBUG && err instanceof Error) console.error(err.stack)
  else console.error('   (set DBFREEZE_DEBUG=1 untuk stack trace)')
  process.exit(1)
})
