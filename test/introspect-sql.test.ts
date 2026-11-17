import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { detectDeferredColumns, readPrismaTables } from '../src/introspect/prisma'
import { isGeneratedExtra } from '../src/sql/introspect'
import { postgresTruncate } from '../src/truncate/postgres'
import { createMysqlTruncate, mysqlTruncate } from '../src/truncate/mysql'
import { sqliteTruncate } from '../src/truncate/sqlite'

function schemaFile(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbfreeze-schema-'))
  const file = path.join(dir, 'schema.prisma')
  fs.writeFileSync(file, body)
  return file
}

const SCHEMA = `
model Post {
  id       String @id
  authorId String
  author   User   @relation(fields: [authorId], references: [id])
  @@map("posts")
}

model User {
  id       String  @id
  photoId  String?
  photo    Media?  @relation("photo", fields: [photoId], references: [id])
  mediaId  String?
  parentId String?
  parent   User?   @relation("tree", fields: [parentId], references: [id])
  @@map("users")
}

model Media {
  id           String @id
  uploadedById String?
  uploadedBy   User?  @relation("up", fields: [uploadedById], references: [id])
  @@map("media")
}
`

test('prisma: dependsOn + deferred untuk cycle User<->Media dan self-reference', () => {
  const file = schemaFile(SCHEMA)
  const tables = readPrismaTables(file)
  const post = tables.find((t) => t.file === 'posts')!
  assert.deepEqual(post.dependsOn, ['users'])
  const { deferredColumns, warnings } = detectDeferredColumns(file)
  assert.deepEqual(deferredColumns.users.sort(), ['parentId', 'photoId'])
  assert.deepEqual(deferredColumns.media, ['uploadedById'])
  assert.deepEqual(warnings, [])
  // setelah defer, users/media tidak saling bergantung lagi
  assert.equal(tables.find((t) => t.file === 'users')!.dependsOn, undefined)
})

test('prisma: cycle yang sudah putus oleh FK optional TIDAK memicu warning palsu', () => {
  const file = schemaFile(`
model A {
  id  String @id
  bId String
  b   B @relation(fields: [bId], references: [id])
}
model B {
  id  String @id
  aId String?
  a   A? @relation(fields: [aId], references: [id])
}`)
  const { deferredColumns, warnings } = detectDeferredColumns(file)
  assert.deepEqual(deferredColumns, { B: ['aId'] })
  assert.deepEqual(warnings, [])
  assert.deepEqual(readPrismaTables(file).find((t) => t.file === 'A')!.dependsOn, ['B'])
})

test('prisma: cycle semua NOT NULL tetap diberi warning', () => {
  const file = schemaFile(`
model A {
  id  String @id
  bId String
  b   B @relation(fields: [bId], references: [id])
}
model B {
  id  String @id
  aId String
  a   A @relation(fields: [aId], references: [id])
}`)
  assert.equal(detectDeferredColumns(file).warnings.length, 2)
})

test('mysql: DEFAULT CURRENT_TIMESTAMP (EXTRA=DEFAULT_GENERATED) BUKAN kolom generated', () => {
  assert.equal(isGeneratedExtra('DEFAULT_GENERATED'), false)
  assert.equal(isGeneratedExtra('auto_increment'), false)
  assert.equal(isGeneratedExtra('STORED GENERATED'), true)
  assert.equal(isGeneratedExtra('VIRTUAL GENERATED'), true)
  assert.equal(isGeneratedExtra('VIRTUAL GENERATED, DEFAULT_GENERATED'), true)
  assert.equal(isGeneratedExtra('PERSISTENT'), true)
  assert.equal(isGeneratedExtra(''), false)
})

async function collect(fn: (run: (s: string) => Promise<void>) => Promise<void>) {
  const sql: string[] = []
  await fn(async (s) => void sql.push(s))
  return sql
}

test('truncate postgres: tanpa CASCADE, nama di-quote', async () => {
  const sql = await collect((run) => postgresTruncate.truncateAll(run, ['users', 'we"ird']))
  assert.deepEqual(sql, ['TRUNCATE TABLE "users", "we""ird" RESTART IDENTITY'])
  assert.ok(!sql[0].includes('CASCADE'))
})

test('truncate postgres: reset sequence meng-escape literal', async () => {
  const sql = await collect((run) => postgresTruncate.resetSequences!(run, ["o'neil"]))
  assert.match(sql[0], /IN \('o''neil'\)/)
})

test('truncate mysql: DELETE anak dulu, tanpa TRUNCATE (DDL = commit implisit), FK checks default aktif', async () => {
  const sql = await collect((run) => mysqlTruncate.truncateAll(run, ['users', 'posts']))
  assert.deepEqual(sql, ['DELETE FROM `posts`', 'DELETE FROM `users`'])
})

test('truncate mysql: ignoreForeignKeys menyalakan lagi FK checks walau DELETE gagal', async () => {
  const sql: string[] = []
  const run = async (s: string) => {
    sql.push(s)
    if (s.startsWith('DELETE')) throw new Error('gagal')
  }
  await assert.rejects(() => createMysqlTruncate({ ignoreForeignKeys: true }).truncateAll(run, ['a']), /gagal/)
  assert.deepEqual(sql, ['SET FOREIGN_KEY_CHECKS = 0', 'DELETE FROM `a`', 'SET FOREIGN_KEY_CHECKS = 1'])
})

test('truncate sqlite: defer FK + DELETE anak dulu', async () => {
  const sql = await collect((run) => sqliteTruncate.truncateAll(run, ['users', 'posts']))
  assert.deepEqual(sql, ['PRAGMA defer_foreign_keys = ON', 'DELETE FROM "posts"', 'DELETE FROM "users"'])
})
