import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectExpression, fromDb, toDb } from '../src/sql/values'
import type { ColumnSchema, CanonicalType } from '../src/sql/types'

function col(type: CanonicalType, dbType: string, extra: Partial<ColumnSchema> = {}): ColumnSchema {
  return { name: 'c', type, dbType, nullable: true, generated: false, identityAlways: false, ...extra }
}

// --- selectExpression ---

test('selectExpression pg money: dibaca sebagai numeric tanpa simbol mata uang', () => {
  const s = selectExpression('postgres', col('decimal', 'money'))
  assert.match(s, /::numeric::text/)
})

test('selectExpression pg interval/tsquery (canonical text): dipaksa ::text, bukan driver object', () => {
  assert.equal(selectExpression('postgres', col('text', 'interval')), '"c"::text')
  assert.equal(selectExpression('postgres', col('text', 'tsquery')), '"c"::text')
  assert.equal(selectExpression('postgres', col('text', 'tsvector')), '"c"')
})

test('selectExpression pg array & decltype lain: literal keluar dari DB', () => {
  assert.equal(selectExpression('postgres', col('array', 'ARRAY')), '"c"::text')
  assert.equal(selectExpression('postgres', col('bit', 'bit')), '"c"')
  assert.equal(selectExpression('postgres', col('decimal', 'numeric')), '"c"::text')
})

test('selectExpression mysql bit: buffer mentah dibiarkan driver (bukan CAST AS CHAR)', () => {
  assert.equal(selectExpression('mysql', col('bit', 'bit(8)')), '`c`')
})

// --- fromDb(bit) ---

test('fromDb bit: pg memberi string biner apa adanya (bit dan varbit)', () => {
  assert.equal(fromDb(col('bit', 'bit(8)'), '10101010'), '10101010')
  assert.equal(fromDb(col('bit', 'varbit'), '101'), '101')
})

test('fromDb bit: mysql memberi Buffer big-endian right-aligned, di-pad ke bit(n)', () => {
  assert.equal(fromDb(col('bit', 'bit(8)'), Buffer.from([0xaa])), '10101010')
  assert.equal(fromDb(col('bit', 'bit(16)'), Buffer.from([0xaa, 0x71])), '1010101001110001')
  // bit(3): nilai 5 = b'101' disimpan sebagai byte 0x05
  assert.equal(fromDb(col('bit', 'bit(3)'), Buffer.from([0x05])), '101')
  // bit(1): nilai 1 = b'1' disimpan sebagai byte 0x01
  assert.equal(fromDb(col('bit', 'bit(1)'), Buffer.from([0x01])), '1')
  // bit(16)=255: zero-padding di kiri
  assert.equal(fromDb(col('bit', 'bit(16)'), Buffer.from([0x00, 0xff])), '0000000011111111')
  // bit(17)=255: tiga byte 00 00 FF, dipad ke 17 bit
  assert.equal(fromDb(col('bit', 'bit(17)'), Buffer.from([0x00, 0x00, 0xff])), '0'.repeat(9) + '11111111')
})

test('fromDb bytes: Buffer dari driver dibiarkan apa adanya', () => {
  const b = Buffer.from([0xde, 0xad])
  assert.equal(fromDb(col('bytes', 'bytea'), b), b)
})

// --- bit roundtrip ---

test('bit roundtrip pg: string biner bertahan utuh', () => {
  const c = col('bit', 'varbit')
  const raw = fromDb(c, '101')
  assert.equal(toDb('postgres', c, raw), '101')
})

test('bit roundtrip mysql: string biner -> BigInt -> string biner', () => {
  const c = col('bit', 'bit(16)')
  const bits = '1010101001110001'
  const v = toDb('mysql', c, bits) as bigint
  assert.equal(typeof v, 'bigint')
  assert.equal(v, 0b1010101001110001n)
  assert.equal(fromDb(c, Buffer.from([0xaa, 0x71])), bits)
})

test('bit roundtrip mysql bit(3): integer dikirim, dipad saat dibaca', () => {
  const c = col('bit', 'bit(3)')
  assert.equal(toDb('mysql', c, '101'), 5n)
})

test('bit roundtrip mysql bit(1): nilai 1', () => {
  const c = col('bit', 'bit(1)')
  assert.equal(toDb('mysql', c, '1'), 1n)
  assert.equal(fromDb(c, Buffer.from([0x01])), '1')
})

test('bit roundtrip mysql bit(64): nilai 2^64-1 lewat BigInt', () => {
  const c = col('bit', 'bit(64)')
  const bits = '1'.repeat(64)
  assert.equal(toDb('mysql', c, bits), 0xffffffffffffffffn)
})

test('toDb bit mysql: nilai selain 0/1 ditolak dengan pesan jelas', () => {
  assert.throws(() => toDb('mysql', col('bit', 'bit(8)'), '10201010'), /bit tidak valid/)
})

// --- array & money (literal passthrough) ---

test('array literal pg lewat apa adanya (keduanya arah)', () => {
  const c = col('array', 'ARRAY')
  const literal = '{"2026-01-01 10:00:00+00",NULL,"{in)"}'
  assert.equal(fromDb(c, literal), literal)
  assert.equal(toDb('postgres', c, literal), literal)
})

test('money -> decimal: nilai numeric mentah tanpa simbol, keduanya arah', () => {
  const c = col('decimal', 'money')
  assert.equal(toDb('postgres', c, '-1234.56'), '-1234.56')
})
