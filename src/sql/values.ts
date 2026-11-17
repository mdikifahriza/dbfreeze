import type { ColumnSchema, Dialect } from './types'
import { quoteIdent } from '../utils'

/**
 * SELECT expression that makes the database hand the value over as plain text/number/boolean,
 * so the result never depends on driver type parsers or the session time zone.
 */
export function selectExpression(dialect: Dialect, col: ColumnSchema): string {
  if (dialect === 'postgres') {
    const q = quoteIdent(col.name, '"')
    switch (col.type) {
      case 'bool':
      case 'text':
      case 'enum':
        // interval/tsquery are canonical text but come back from the driver as objects — force text out.
        return col.dbType === 'interval' || col.dbType === 'tsquery' ? `${q}::text` : q
      case 'datetime':
        return col.dbType === 'timestamp with time zone'
          ? `to_char(${q} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`
          : `to_char(${q}, 'YYYY-MM-DD"T"HH24:MI:SS.US')`
      case 'date':
        return `to_char(${q}, 'YYYY-MM-DD')`
      case 'decimal':
        // money must lose its currency symbol but keep the numeric value.
        return col.dbType.toLowerCase() === 'money' ? `${q}::numeric::text` : `${q}::text`
      case 'array':
        // Driver would parse this into a JS array; the array_out literal roundtrips exactly,
        // including microsecond precision and exotic element types.
        return `${q}::text`
      case 'bit':
        // Already a string of '0'/'1' from the driver.
        return q
      case 'bytes':
        return `replace(encode(${q}, 'base64'), E'\\n', '')`
      default:
        return `${q}::text`
    }
  }

  const q = quoteIdent(col.name, '`')
  switch (col.type) {
    case 'text':
    case 'enum':
      return q
    case 'datetime':
      return `DATE_FORMAT(${q}, '%Y-%m-%dT%H:%i:%s.%f')`
    case 'date':
      return `DATE_FORMAT(${q}, '%Y-%m-%d')`
    case 'bytes':
      return `REPLACE(TO_BASE64(${q}), CHAR(10), '')`
    case 'bit':
      // mysql2 hands us the raw bytes of a BIT column directly.
      return q
    default:
      return `CAST(${q} AS CHAR)`
  }
}

const asString = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v))

/** bit length from dbType: 'bit(16)' -> 16, 'bit' -> 1, 'varbit' -> null (driver gives exact string). */
function bitLength(dbType: string): number | null {
  const m = /bit(?:\s+varying)?\((\d+)\)/i.exec(dbType)
  if (m) return Number(m[1])
  const dt = dbType.toLowerCase()
  if (dt === 'bit') return 1
  return null
}

/**
 * MySQL returns BIT values as big-endian bytes of the integer value (e.g. bit(3)=5 -> [0x05],
 * bit(16)=255 -> [0x00,0xFF]), i.e. bits right-aligned within the last byte, padded with 0 on the left.
 * Postgres (bit/varbit) gives a string of '0'/'1' already.
 */
function bufferToBits(raw: unknown, dbType: string): string {
  if (typeof raw === 'string' && /^[01]*$/.test(raw)) return raw
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array)
  let value = 0n
  for (const byte of buf) value = (value << 8n) | BigInt(byte)
  const n = bitLength(dbType)
  const bits = value.toString(2)
  return n === null ? bits : bits.padStart(n, '0').slice(-n)
}

function bitsToBigInt(bits: string): bigint {
  if (!/^[01]+$/.test(bits)) {
    throw new Error(`Nilai bit tidak valid (hanya 0/1): "${bits.length > 32 ? bits.slice(0, 32) + '…' : bits}"`)
  }
  return BigInt('0b' + bits)
}

/** MySQL `0000-00-00` style values cannot exist in Postgres (or in a JS Date). */
const ZERO_DATE = /^0000-00-00/

function trimFraction(s: string): string {
  const [base, frac = ''] = s.split('.')
  const f = frac.replace(/0+$/, '')
  return f ? `${base}.${f}` : base
}

function integer(s: string): number | bigint {
  const n = Number(s)
  return Number.isSafeInteger(n) ? n : BigInt(s)
}

/** Raw value from `selectExpression` -> canonical JS value (what the NDJSON codec then writes). */
export function fromDb(col: ColumnSchema, raw: unknown, warn?: (msg: string) => void): unknown {
  if (raw === null || raw === undefined) return null
  switch (col.type) {
    case 'bool':
      if (typeof raw === 'boolean') return raw
      return raw === '1' || raw === 1 ? true : raw === '0' || raw === 0 ? false : Number(raw)
    case 'int':
    case 'bigint':
      return integer(asString(raw))
    case 'float': {
      const n = Number(asString(raw))
      return Number.isFinite(n) ? n : asString(raw)
    }
    case 'datetime': {
      const s = asString(raw)
      if (ZERO_DATE.test(s)) {
        warn?.(`${col.name}: nilai ${s.slice(0, 10)} (zero date MySQL) diganti NULL`)
        return null
      }
      return trimFraction(s) + 'Z'
    }
    case 'date': {
      const s = asString(raw)
      if (ZERO_DATE.test(s)) {
        warn?.(`${col.name}: nilai ${s} (zero date MySQL) diganti NULL`)
        return null
      }
      return s
    }
    case 'time':
      return trimFraction(asString(raw))
    case 'json':
      return JSON.parse(asString(raw))
    case 'bytes':
      return Buffer.isBuffer(raw) ? raw : Buffer.from(asString(raw), 'base64')
    case 'bit':
      return bufferToBits(raw, col.dbType)
    default:
      return asString(raw) // decimal, text, uuid, enum, array literal
  }
}

function isoForDialect(dialect: Dialect, v: unknown): string {
  const s = v instanceof Date ? v.toISOString() : String(v)
  // Postgres accepts "…T…Z"; MySQL wants "YYYY-MM-DD HH:MM:SS[.ffffff]" without zone suffix (values are UTC).
  return dialect === 'postgres' ? s : s.replace('T', ' ').replace(/Z$/, '')
}

/** Canonical JS value from the snapshot -> value to bind as a SQL parameter for this column. */
export function toDb(dialect: Dialect, col: ColumnSchema, v: unknown): unknown {
  if (v === null || v === undefined) return null
  switch (col.type) {
    case 'bool':
      return typeof v === 'number' ? v !== 0 : v
    case 'int':
    case 'bigint':
      return typeof v === 'bigint' ? v.toString() : v
    case 'decimal':
      return String(v)
    case 'datetime':
      return isoForDialect(dialect, v)
    case 'date':
    case 'time':
      return v instanceof Date ? v.toISOString().slice(0, col.type === 'date' ? 10 : 19) : String(v)
    case 'json':
      return JSON.stringify(v) // always text: a JS array would otherwise be sent as a SQL array
    case 'bytes':
      return Buffer.isBuffer(v) ? v : v instanceof Uint8Array ? Buffer.from(v) : Buffer.from(String(v), 'base64')
    case 'bit':
      // Postgres BIT input takes the '0101' literal; MySQL BIT takes the integer value.
      if (dialect === 'postgres') {
        if (Buffer.isBuffer(v) || v instanceof Uint8Array) return bufferToBits(v, col.dbType)
        return String(v)
      }
      if (Buffer.isBuffer(v)) return v
      return bitsToBigInt(String(v))
    default:
      // array (pg literal "{1,2}"), text, uuid, enum pass through unchanged
      return v
  }
}
