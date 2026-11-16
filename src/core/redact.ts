import { createHash } from 'node:crypto'
import type { Row } from '../types'
import type { DbSchema } from '../sql/types'

/**
 * Column masking applied at export time, so the real value never touches disk.
 * OFF by default: nothing is masked unless `redact` is configured.
 *
 *  - 'null'        -> NULL (the column must be nullable)
 *  - 'hash'        -> 32 hex chars, deterministic
 *  - 'fake-email'  -> user-<hash>@example.test
 *  - 'fake-phone'  -> +1555 + 7 digits
 *  - 'fake-text'   -> text-<hash>
 *  - 'mask'        -> first character kept, the rest replaced by '*'
 *  - function      -> your own (value, row) => newValue
 *
 * Every hash-based rule is deterministic (same input -> same output, per table and column),
 * so UNIQUE constraints and equal values stay consistent across exports. Set `redactSalt` to a
 * secret: without it, hashes of guessable values (emails) can be brute-forced.
 */
export type RedactRule = 'null' | 'hash' | 'fake-email' | 'fake-phone' | 'fake-text' | 'mask' | ((value: unknown, row: Row) => unknown)

/** table name (the `file` name) -> column -> rule */
export type RedactConfig = Record<string, Record<string, RedactRule>>

const SENSITIVE = ['password', 'passwd', 'secret', 'token', 'apikey', 'api_key', 'email', 'phone']

/** Heuristic by column name only (case-insensitive substring). Used for warnings, never for masking. */
export function isSensitiveColumn(name: string): boolean {
  const n = name.toLowerCase()
  return SENSITIVE.some((s) => n.includes(s))
}

function digest(salt: string, table: string, column: string, value: unknown): string {
  const text = value instanceof Uint8Array ? Buffer.from(value).toString('base64') : String(value)
  return createHash('sha256').update([salt, table, column, text].join('\u0000')).digest('hex')
}

function apply(rule: RedactRule, table: string, column: string, value: unknown, row: Row, salt: string): unknown {
  if (value === null || value === undefined) return null
  if (typeof rule === 'function') return rule(value, row)
  if (rule === 'null') return null
  if (rule === 'mask') {
    const s = String(value)
    return s.length <= 1 ? '*' : s[0] + '*'.repeat(s.length - 1)
  }
  const h = digest(salt, table, column, value)
  switch (rule) {
    case 'hash':
      return h.slice(0, 32)
    case 'fake-email':
      return `user-${h.slice(0, 16)}@example.test`
    case 'fake-phone':
      return '+1555' + String(BigInt('0x' + h.slice(0, 12)) % 10_000_000n).padStart(7, '0')
    case 'fake-text':
      return `text-${h.slice(0, 12)}`
    default:
      throw new Error(`Aturan redaksi tidak dikenal: "${String(rule)}" (${table}.${column})`)
  }
}

/** Row -> masked row for one table, or null when the table has no rules. */
export function makeRedactor(table: string, config: RedactConfig | undefined, salt = ''): ((row: Row) => Row) | null {
  const rules = config?.[table]
  if (!rules || Object.keys(rules).length === 0) return null
  const entries = Object.entries(rules)
  return (row) => {
    const out: Row = { ...row }
    for (const [col, rule] of entries) if (col in row) out[col] = apply(rule, table, col, row[col], row, salt)
    return out
  }
}

/**
 * Fail early on rules that can never work: unknown table/column, or 'null' on a NOT NULL column
 * (the seed would fail much later). `fileToKey` maps snapshot file name -> table key in the schema.
 */
export function validateRedact(config: RedactConfig | undefined, schema: DbSchema | undefined, fileToKey: Map<string, string>): void {
  if (!config) return
  for (const [file, rules] of Object.entries(config)) {
    if (!fileToKey.has(file)) throw new Error(`redact: tabel "${file}" tidak ada di daftar tabel yang di-export.`)
    const t = schema?.tables[fileToKey.get(file)!]
    if (!t) continue
    for (const [col, rule] of Object.entries(rules)) {
      const c = t.columns.find((x) => x.name === col)
      if (!c) throw new Error(`redact: kolom "${file}.${col}" tidak ada di database.`)
      if (rule === 'null' && !c.nullable) {
        throw new Error(`redact: "${file}.${col}" NOT NULL, jadi aturan 'null' membuat seed gagal. Pakai 'hash', 'fake-text', atau fungsi sendiri.`)
      }
    }
  }
}

/** "table.column" entries whose name looks sensitive but that have no redaction rule. */
export function unredactedSensitive(columns: { table: string; column: string }[], config: RedactConfig | undefined): string[] {
  return columns.filter(({ table, column }) => isSensitiveColumn(column) && !config?.[table]?.[column]).map((x) => `${x.table}.${x.column}`)
}
