import type { Row } from './types'

/**
 * Lossless, ORM-neutral value encoding for the NDJSON snapshot.
 *
 * Plain JSON values (string, finite number, boolean, null, Json columns) are written as-is.
 * Everything JSON cannot represent faithfully is written as a single-key tagged object:
 *
 *   Date    -> {"$date":"2026-01-01T00:00:00.000Z"}
 *   BigInt  -> {"$bigint":"9007199254740993"}
 *   Decimal -> {"$decimal":"12.50"}          (string: never goes through a float)
 *   Bytes   -> {"$bytes":"<base64>"}
 *   a Json column value that itself contains a "$..." key -> {"$json": <value>}  (escape)
 *
 * A text column that merely looks like a date stays a plain string — nothing is guessed on read.
 */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function hasDollarKey(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasDollarKey)
  if (isPlainObject(v)) {
    return Object.entries(v).some(([k, val]) => k.startsWith('$') || hasDollarKey(val))
  }
  return false
}

function isDecimalLike(v: object): v is { toFixed(): string } {
  return (v as any).constructor?.name === 'Decimal' && typeof (v as any).toFixed === 'function'
}

export function encodeValue(v: unknown): unknown {
  if (v === null || v === undefined) return null
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return v
    case 'number':
      if (!Number.isFinite(v)) throw new Error(`Nilai number tidak didukung: ${v}`)
      return v
    case 'bigint':
      return { $bigint: v.toString() }
    case 'object': {
      if (v instanceof Date) {
        if (Number.isNaN(v.getTime())) throw new Error('Tanggal tidak valid (mis. 0000-00-00 dari MySQL)')
        return { $date: v.toISOString() }
      }
      if (v instanceof Uint8Array) return { $bytes: Buffer.from(v).toString('base64') }
      if (isDecimalLike(v)) return { $decimal: v.toFixed() }
      if (hasDollarKey(v)) return { $json: v }
      return v
    }
    default:
      throw new Error(`Tipe nilai tidak didukung: ${typeof v}`)
  }
}

export function decodeValue(v: unknown): unknown {
  if (!isPlainObject(v)) return v
  const keys = Object.keys(v)
  if (keys.length !== 1) return v
  const [tag] = keys
  const val = v[tag]
  switch (tag) {
    case '$date':
      return new Date(val as string)
    case '$bigint':
      return BigInt(val as string)
    case '$decimal':
      return String(val)
    case '$bytes':
      return Buffer.from(val as string, 'base64')
    case '$json':
      return val
    default:
      return v
  }
}

export function encodeRow(row: Row): Row {
  const out: Row = {}
  for (const [k, v] of Object.entries(row)) out[k] = encodeValue(v)
  return out
}

export function decodeRow(row: Row): Row {
  const out: Row = {}
  for (const [k, v] of Object.entries(row)) out[k] = decodeValue(v)
  return out
}

/** Coarse, ORM-neutral type label of a raw (pre-encoding) value, used in the manifest. */
export function typeOfValue(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  switch (typeof v) {
    case 'string':
      return 'string'
    case 'boolean':
      return 'bool'
    case 'number':
      return Number.isInteger(v) ? 'int' : 'float'
    case 'bigint':
      return 'bigint'
    default:
      if (v instanceof Date) return 'datetime'
      if (v instanceof Uint8Array) return 'bytes'
      if (isDecimalLike(v as object)) return 'decimal'
      return 'json'
  }
}

function compareId(a: unknown, b: unknown): number {
  if ((typeof a === 'number' || typeof a === 'bigint') && (typeof b === 'number' || typeof b === 'bigint')) {
    return a < b ? -1 : a > b ? 1 : 0
  }
  const sa = String(a)
  const sb = String(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

export interface SerializedTable {
  /** NDJSON text: one JSON object per line, sorted by `id` (or by line when there is no `id`). */
  content: string
  rows: number
  /** column -> sorted unique type labels seen in this table */
  columns: Record<string, string[]>
}

export function serializeRows(rows: Row[]): SerializedTable {
  const columns: Record<string, Set<string>> = {}
  const entries = rows.map((row) => {
    for (const [k, v] of Object.entries(row)) (columns[k] ??= new Set()).add(typeOfValue(v))
    return { id: row.id, line: JSON.stringify(encodeRow(row)) }
  })

  const allHaveId = entries.every((e) => e.id !== undefined && e.id !== null)
  entries.sort((a, b) => {
    if (allHaveId) {
      const c = compareId(a.id, b.id)
      if (c !== 0) return c
    }
    return a.line < b.line ? -1 : a.line > b.line ? 1 : 0
  })

  const sortedColumns = Object.fromEntries(
    Object.keys(columns)
      .sort()
      .map((k) => [k, [...columns[k]].sort()]),
  )
  return {
    content: entries.length ? entries.map((e) => e.line).join('\n') + '\n' : '',
    rows: entries.length,
    columns: sortedColumns,
  }
}

export function parseNdjson(text: string, label: string): Row[] {
  const rows: Row[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (err) {
      throw new Error(`${label}: baris ${i + 1} bukan JSON valid (${(err as Error).message})`)
    }
    if (!isPlainObject(parsed)) throw new Error(`${label}: baris ${i + 1} bukan object`)
    rows.push(decodeRow(parsed))
  }
  return rows
}
