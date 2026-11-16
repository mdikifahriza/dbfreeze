import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { exportSnapshot } from '../src/core/export'
import { seedFromSnapshot } from '../src/core/seed'
import { orderTables } from '../src/core/order'
import { decodeValue, encodeValue, parseNdjson, serializeRows } from '../src/codec'
import { makeFakeDb } from './helpers'
import type { TableConfig } from '../src/types'

const silent = () => {}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dbfreeze-test-'))

const tables: TableConfig[] = [
  { key: 'posts', file: 'posts', dependsOn: ['users'] },
  { key: 'users', file: 'users' },
]
const fks = { posts: [{ col: 'authorId', parent: 'users' }] }
const data = {
  users: [
    { id: 'u2', name: 'Budi', createdAt: new Date('2026-01-02T00:00:00.000Z') },
    { id: 'u1', name: 'Ani', createdAt: new Date('2026-01-01T00:00:00.000Z') },
  ],
  posts: [{ id: 'p1', authorId: 'u1', title: '' }],
}

// ---------- codec ----------

test('codec: roundtrip tipe yang tidak bisa dibawa JSON polos', () => {
  const fakeDecimal = new (class Decimal {
    toFixed() {
      return '12.50'
    }
  })()
  assert.deepEqual(decodeValue(encodeValue(123456789012345678901234567890n)), 123456789012345678901234567890n)
  assert.equal(decodeValue(encodeValue(fakeDecimal)), '12.50')
  const d = new Date('2026-05-05T05:05:05.005Z')
  assert.deepEqual(decodeValue(encodeValue(d)), d)
  assert.deepEqual(decodeValue(encodeValue(Buffer.from([0, 255, 7]))), Buffer.from([0, 255, 7]))
})

test('codec: string yang mirip tanggal tetap string, null != string kosong', () => {
  const iso = '2026-01-01T00:00:00.000Z'
  assert.equal(decodeValue(encodeValue(iso)), iso)
  assert.equal(decodeValue(encodeValue('')), '')
  assert.equal(decodeValue(encodeValue(null)), null)
})

test('codec: kolom Json yang berisi key "$..." di-escape dan kembali utuh', () => {
  const tricky = { $date: 'bukan tanggal', nested: [{ $bigint: '1' }] }
  assert.deepEqual(decodeValue(encodeValue(tricky)), tricky)
  const plain = { a: 1, b: [1, 2, { c: null }] }
  assert.deepEqual(decodeValue(encodeValue(plain)), plain)
})

test('codec: Date tidak valid (0000-00-00) ditolak dengan pesan jelas', () => {
  assert.throws(() => encodeValue(new Date('invalid')), /Tanggal tidak valid/)
})

test('codec: serialisasi deterministik, urut id (numerik untuk angka), satu baris per row', () => {
  const a = serializeRows([{ id: 10, t: 'a\nb' }, { id: 2, t: 'x' }])
  const b = serializeRows([{ id: 2, t: 'x' }, { id: 10, t: 'a\nb' }])
  assert.equal(a.content, b.content)
  assert.equal(a.content.trim().split('\n').length, 2)
  assert.deepEqual(
    parseNdjson(a.content, 't').map((r) => r.id),
    [2, 10],
  )
  assert.deepEqual(a.columns, { id: ['int'], t: ['string'] })
})

test('codec: baris rusak dilaporkan dengan nomor baris', () => {
  assert.throws(() => parseNdjson('{"a":1}\n{rusak\n', 'users.ndjson'), /users\.ndjson: baris 2/)
})

// ---------- order ----------

test('order: induk selalu sebelum anak, urutan lain stabil', () => {
  const out = orderTables([
    { key: 'c', file: 'c', dependsOn: ['b'] },
    { key: 'x', file: 'x' },
    { key: 'b', file: 'b', dependsOn: ['a'] },
    { key: 'a', file: 'a' },
  ])
  assert.deepEqual(
    out.map((t) => t.file),
    ['x', 'a', 'b', 'c'],
  )
})

test('order: cycle yang tidak bisa dipecah -> error jelas', () => {
  assert.throws(
    () =>
      orderTables([
        { key: 'a', file: 'a', dependsOn: ['b'] },
        { key: 'b', file: 'b', dependsOn: ['a'] },
      ]),
    /circular FK/,
  )
})

// ---------- export ----------

test('export: tulis ndjson + manifest, export ulang tanpa perubahan = 0 file berubah', async () => {
  const dir = tmp()
  const db = makeFakeDb(fks, data)
  const r1 = await exportSnapshot({ adapter: db.adapter, tables, dataDir: dir, log: silent })
  assert.equal(r1.changed, 2)
  assert.ok(fs.existsSync(path.join(dir, 'users.ndjson')))
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.tables.users.rows, 2)
  assert.match(manifest.tables.users.sha256, /^[0-9a-f]{64}$/)
  // urut id: u1 sebelum u2 walau data awal terbalik
  const lines = fs.readFileSync(path.join(dir, 'users.ndjson'), 'utf8').trim().split('\n')
  assert.equal(JSON.parse(lines[0]).id, 'u1')
  const r2 = await exportSnapshot({ adapter: db.adapter, tables, dataDir: dir, log: silent })
  assert.equal(r2.changed, 0)
})

// ---------- seed ----------

async function exported() {
  const dir = tmp()
  await exportSnapshot({ adapter: makeFakeDb(fks, data).adapter, tables, dataDir: dir, log: silent })
  return dir
}

test('seed: restore penuh walau config menulis anak lebih dulu (urutan FK otomatis)', async () => {
  const dir = await exported()
  const target = makeFakeDb(fks, { users: [{ id: 'old' }], posts: [] })
  await seedFromSnapshot({ adapter: target.adapter, tables, dataDir: dir, log: silent })
  assert.deepEqual(target.state.users.map((u) => u.id), ['u1', 'u2'])
  assert.deepEqual(target.state.users[0].createdAt, new Date('2026-01-01T00:00:00.000Z'))
  assert.equal(target.state.posts.length, 1)
  assert.deepEqual(target.sequencesReset, ['users', 'posts'])
  // truncate harus terjadi di dalam transaksi, urut induk -> anak
  assert.equal(target.log[0], 'truncate users,posts')
})

test('seed: gagal di tengah -> rollback, data lama TETAP utuh', async () => {
  const dir = await exported()
  const oldData = { users: [{ id: 'keep1' }, { id: 'keep2' }], posts: [{ id: 'keepP', authorId: 'keep1' }] }
  const target = makeFakeDb(fks, oldData)
  target.failOnInsert('posts')
  await assert.rejects(() => seedFromSnapshot({ adapter: target.adapter, tables, dataDir: dir, log: silent }), /boom insert posts/)
  assert.deepEqual(target.state, oldData)
  assert.equal(target.sequencesReset, null)
})

test('seed: checksum tidak cocok -> batal SEBELUM menyentuh DB', async () => {
  const dir = await exported()
  fs.appendFileSync(path.join(dir, 'users.ndjson'), '{"id":"hacked","name":"x"}\n')
  const target = makeFakeDb(fks, { users: [{ id: 'keep' }] })
  await assert.rejects(() => seedFromSnapshot({ adapter: target.adapter, tables, dataDir: dir, log: silent }), /checksum/)
  assert.deepEqual(target.log, [])
  assert.deepEqual(target.state.users, [{ id: 'keep' }])
})

test('seed: file snapshot hilang padahal manifest mencatat baris -> batal', async () => {
  const dir = await exported()
  fs.rmSync(path.join(dir, 'users.ndjson'))
  const target = makeFakeDb(fks, { users: [{ id: 'keep' }] })
  await assert.rejects(() => seedFromSnapshot({ adapter: target.adapter, tables, dataDir: dir, log: silent }), /hilang/)
  assert.deepEqual(target.log, [])
})

test('seed: dry-run memvalidasi tapi tidak mengubah DB', async () => {
  const dir = await exported()
  const target = makeFakeDb(fks, { users: [{ id: 'keep' }] })
  await seedFromSnapshot({ adapter: target.adapter, tables, dataDir: dir, dryRun: true, log: silent })
  assert.deepEqual(target.log, [])
  assert.deepEqual(target.state.users, [{ id: 'keep' }])
})

test('seed: verifikasi jumlah baris sebelum commit (count tidak cocok -> rollback)', async () => {
  const dir = await exported()
  const target = makeFakeDb(fks, { users: [{ id: 'keep' }] })
  const realCount = target.adapter.count!
  target.adapter.count = async (k) => (k === 'users' ? (await realCount(k)) + 1 : realCount(k))
  await assert.rejects(() => seedFromSnapshot({ adapter: target.adapter, tables, dataDir: dir, log: silent }), /Verifikasi gagal/)
  assert.deepEqual(target.state.users, [{ id: 'keep' }])
})

test('seed: circular / self FK lewat deferredColumns', async () => {
  const cyc: TableConfig[] = [
    { key: 'users', file: 'users' },
    { key: 'media', file: 'media' },
  ]
  const cycFks = {
    users: [{ col: 'photoId', parent: 'media' }, { col: 'managerId', parent: 'users' }],
    media: [{ col: 'uploadedById', parent: 'users' }],
  }
  const cycData = {
    users: [
      { id: 'u1', photoId: 'm1', managerId: null },
      { id: 'u2', photoId: null, managerId: 'u1' },
    ],
    media: [{ id: 'm1', uploadedById: 'u1' }],
  }
  const dir = tmp()
  // sumber tanpa pengecekan FK, supaya bisa diekspor
  await exportSnapshot({ adapter: makeFakeDb({}, cycData).adapter, tables: cyc, dataDir: dir, log: silent })
  const target = makeFakeDb(cycFks)
  await seedFromSnapshot({
    adapter: target.adapter,
    tables: cyc,
    dataDir: dir,
    deferredColumns: { users: ['photoId', 'managerId'], media: ['uploadedById'] },
    log: silent,
  })
  assert.deepEqual(target.state.users, cycData.users)
  assert.deepEqual(target.state.media, cycData.media)
})

test('seed: tabel lebar di-chunk supaya tidak melewati batas parameter', async () => {
  const wide = tmp()
  const cols = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`c${i}`, i]))
  const rows = Array.from({ length: 500 }, (_, i) => ({ id: i + 1, ...cols }))
  await exportSnapshot({ adapter: makeFakeDb({}, { t: rows }).adapter, tables: [{ key: 't', file: 't' }], dataDir: wide, log: silent })
  const target = makeFakeDb()
  await seedFromSnapshot({ adapter: target.adapter, tables: [{ key: 't', file: 't' }], dataDir: wide, log: silent })
  const inserts = target.log.filter((l) => l.startsWith('insert'))
  assert.ok(inserts.length > 1, 'harus lebih dari satu INSERT')
  for (const l of inserts) assert.ok(Number(l.split('x')[1]) * 201 <= 20000)
  assert.equal(target.state.t.length, 500)
})

test('seed: snapshot lama (.json tanpa manifest) masih bisa dibaca', async () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: 'u1', createdAt: '2026-01-01T00:00:00.000Z' }]))
  const target = makeFakeDb()
  await seedFromSnapshot({ adapter: target.adapter, tables: [{ key: 'users', file: 'users' }], dataDir: dir, log: silent })
  assert.deepEqual(target.state.users[0].createdAt, new Date('2026-01-01T00:00:00.000Z'))
})
