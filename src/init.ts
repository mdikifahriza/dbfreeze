import fs from 'node:fs'
import path from 'node:path'

export type InitDialect = 'postgres' | 'mysql'
export type ConfigFlavor = 'ts' | 'cjs'

export interface InitOptions {
  cwd: string
  dialect?: InitDialect
  dataDir?: string
  force?: boolean
  agentDoc?: boolean
  log?: (line: string) => void
}

export interface InitResult {
  configFile: string
  dialect: InitDialect
  flavor: ConfigFlavor
  agentDocFile: string | null
  warnings: string[]
}

const AGENT_BEGIN = '<!-- dbfreeze:begin -->'
const AGENT_END = '<!-- dbfreeze:end -->'

interface PkgJson {
  type?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

function readPkg(cwd: string): PkgJson {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as PkgJson
  } catch {
    return {}
  }
}

function hasDep(pkg: PkgJson, name: string): boolean {
  return !!(pkg.dependencies?.[name] || pkg.devDependencies?.[name])
}

/** Read `DATABASE_URL` from a .env style text (no variable expansion). */
export function parseEnvUrl(text: string): string | null {
  const m = text.match(/^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.+?)\s*$/m)
  if (!m) return null
  return m[1].replace(/^['"]|['"]$/g, '')
}

export function dialectFromUrl(url: string | null | undefined): InitDialect | null {
  if (!url) return null
  if (/^postgres(ql)?:/i.test(url)) return 'postgres'
  if (/^mysql2?:/i.test(url) || /^mariadb:/i.test(url)) return 'mysql'
  return null
}

/** Decide the engine from (in order): explicit flag, installed driver, DATABASE_URL in env or .env files. */
export function detectDialect(cwd: string, explicit?: InitDialect): InitDialect | null {
  if (explicit) return explicit
  const pkg = readPkg(cwd)
  const pg = hasDep(pkg, 'pg')
  const my = hasDep(pkg, 'mysql2')
  if (pg && !my) return 'postgres'
  if (my && !pg) return 'mysql'
  const urls: Array<string | null> = [process.env.DATABASE_URL ?? null]
  for (const f of ['.env', '.env.local', '.env.development']) {
    const p = path.join(cwd, f)
    if (fs.existsSync(p)) urls.push(parseEnvUrl(fs.readFileSync(p, 'utf8')))
  }
  for (const u of urls) {
    const d = dialectFromUrl(u)
    if (d) return d
  }
  return null
}

/** `.ts` when the project already uses TypeScript/tsx, otherwise a CommonJS `.cjs` (loads on any Node, no tsx needed). */
export function detectFlavor(cwd: string): ConfigFlavor {
  const pkg = readPkg(cwd)
  if (fs.existsSync(path.join(cwd, 'tsconfig.json')) || hasDep(pkg, 'typescript') || hasDep(pkg, 'tsx')) return 'ts'
  return 'cjs'
}

export function renderConfig(dialect: InitDialect, flavor: ConfigFlavor, dataDir: string): string {
  const pg = dialect === 'postgres'
  const factory = pg ? 'pgClient' : 'mysql2Client'
  const pool = pg
    ? `new Pool({ connectionString: process.env.DATABASE_URL })`
    : `mysql.createPool({ uri: process.env.DATABASE_URL, charset: 'utf8mb4' })`
  const body = `  adapter: createSqlAdapter({ client: ${factory}(${pool}) }),
  dataDir: ${JSON.stringify(dataDir)},
  // Kosong = semua tabel (kecuali tabel migrasi seperti _prisma_migrations). Isi untuk melewati tabel:
  exclude: [],
  // Snapshot berisi DATA ASLI. Sebelum commit ke git, samarkan kolom sensitif:
  // redactSalt: process.env.DBFREEZE_SALT,
  // redact: { users: { email: 'fake-email', password_hash: 'hash' } },`

  if (flavor === 'ts') {
    return `import { defineConfig, createSqlAdapter, ${factory} } from 'dbfreeze'
${pg ? `import { Pool } from 'pg'` : `import mysql from 'mysql2/promise'`}

export default defineConfig({
${body}
})
`
  }
  return `const { defineConfig, createSqlAdapter, ${factory} } = require('dbfreeze')
${pg ? `const { Pool } = require('pg')` : `const mysql = require('mysql2/promise')`}

module.exports = defineConfig({
${body}
})
`
}

/** Short block placed in the project's AGENTS.md so any AI agent finds the full guide shipped inside the package. */
export function renderAgentBlock(dataDir: string): string {
  return `${AGENT_BEGIN}
## dbfreeze (snapshot database)

Project ini memakai \`dbfreeze\`: isi database di-dump ke NDJSON di \`${dataDir}\` dan bisa di-restore.
- Untuk memahami data: baca \`${dataDir}/SCHEMA.md\` dan \`${dataDir}/*.ndjson\`. Tidak perlu koneksi DB.
- Panduan lengkap untuk agent: \`node_modules/dbfreeze/AGENTS.md\`.
- Perintah: \`npx dbfreeze export\`, \`npx dbfreeze seed --dry-run\`, \`npx dbfreeze seed\`.
- \`seed\` MENIMPA isi tabel di DB yang dituju (lihat \`DATABASE_URL\`). Jangan dijalankan tanpa izin pengguna.
${AGENT_END}
`
}

/** Insert or replace the dbfreeze block, leaving the rest of the file untouched. */
export function upsertAgentBlock(existing: string | null, block: string): string {
  if (existing === null || existing.trim() === '') return `# AGENTS.md\n\n${block}`
  const start = existing.indexOf(AGENT_BEGIN)
  const end = existing.indexOf(AGENT_END)
  if (start !== -1 && end !== -1 && end > start) {
    return existing.slice(0, start) + block.trimEnd() + existing.slice(end + AGENT_END.length)
  }
  return existing.replace(/\s*$/, '\n\n') + block
}

export function runInit(opts: InitOptions): InitResult {
  const { cwd } = opts
  const log = opts.log ?? (() => {})
  const dataDir = opts.dataDir ?? './data'
  const warnings: string[] = []

  const existing = ['ts', 'mts', 'cts', 'js', 'cjs', 'mjs'].map((e) => `dbfreeze.config.${e}`).find((n) => fs.existsSync(path.join(cwd, n)))
  if (existing && !opts.force) {
    throw new Error(`${existing} sudah ada. Pakai --force untuk menimpa.`)
  }

  const dialect = detectDialect(cwd, opts.dialect)
  if (!dialect) {
    throw new Error('Tidak bisa menebak jenis database. Jalankan: npx dbfreeze init --db postgres  (atau --db mysql)')
  }

  const flavor = detectFlavor(cwd)
  const configFile = path.join(cwd, `dbfreeze.config.${flavor === 'ts' ? 'ts' : 'cjs'}`)
  if (existing && existing !== path.basename(configFile)) fs.rmSync(path.join(cwd, existing))
  fs.writeFileSync(configFile, renderConfig(dialect, flavor, dataDir))
  log(`✓ ${path.basename(configFile)} dibuat (${dialect}, dataDir ${dataDir})`)

  const pkg = readPkg(cwd)
  const driver = dialect === 'postgres' ? 'pg' : 'mysql2'
  if (!hasDep(pkg, driver)) warnings.push(`Driver belum terpasang. Jalankan: npm install ${driver}`)
  if (flavor === 'ts' && !hasDep(pkg, 'tsx')) warnings.push('Config berupa .ts. Jalankan: npm install -D tsx')
  if (!process.env.DATABASE_URL && !['.env', '.env.local'].some((f) => fs.existsSync(path.join(cwd, f)))) {
    warnings.push('DATABASE_URL belum diatur. Isi di .env atau environment.')
  }

  let agentDocFile: string | null = null
  if (opts.agentDoc !== false) {
    agentDocFile = path.join(cwd, 'AGENTS.md')
    const prev = fs.existsSync(agentDocFile) ? fs.readFileSync(agentDocFile, 'utf8') : null
    fs.writeFileSync(agentDocFile, upsertAgentBlock(prev, renderAgentBlock(dataDir)))
    log(`✓ AGENTS.md ${prev === null ? 'dibuat' : 'diperbarui'} (petunjuk untuk AI agent)`)
  }

  return { configFile, dialect, flavor, agentDocFile, warnings }
}
