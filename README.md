# dbfreeze

Snapshot database (export/seed) untuk **Postgres dan MySQL**, agnostik ORM. Dump semua tabel ke **NDJSON**
(satu baris = satu row), restore kembali ke database lewat **satu transaksi** dengan
verifikasi integritas. Engine tidak mengimpor Prisma/Drizzle/driver apa pun — cuma
bicara lewat interface `SnapshotAdapter`.

Tujuan pemakaian:
1. Tracking isi DB selama dev (commit snapshot ke git, restore kapan saja setelah testing mengacak data).
2. AI bisa membaca isi DB dari file, tanpa koneksi ke DB.
3. Gonta-ganti ORM / jenis DB.

## Mode SQL (v0.3): tanpa ORM, tabel dibaca dari DB

Sumber kebenarannya adalah database itu sendiri, bukan `schema.prisma` atau nama field ORM.
Snapshot memakai nama tabel dan kolom SQL asli (`created_at`, bukan `createdAt`), dan satu adapter
cocok untuk Prisma, Drizzle, Knex, atau tanpa ORM.

```ts
// dbfreeze.config.ts
import { defineConfig, createSqlAdapter, pgClient } from 'dbfreeze'   // atau mysql2Client
import { Pool } from 'pg'

export default defineConfig({
  adapter: createSqlAdapter({ client: pgClient(new Pool({ connectionString: process.env.DATABASE_URL })) }),
  dataDir: './data',
  // tables dikosongkan = semua tabel, kecuali tabel migrasi (_prisma_migrations, knex_migrations, ...)
  exclude: ['audit_log'],
})
```

MySQL: `mysql2Client(mysql.createPool({ uri: process.env.DATABASE_URL, charset: 'utf8mb4' }))`.

Yang berubah dibanding mode ORM:

- **Introspeksi.** Tabel, kolom, tipe, PK, FK, dan nullable dibaca dari `information_schema`/`pg_catalog`.
  `dependsOn` dan `deferredColumns` dihitung otomatis dari graf FK (Tarjan SCC, sama seperti jalur Prisma).
- **`_schema.json` dan `SCHEMA.md`** ditulis di folder snapshot, jadi AI paham struktur data tanpa koneksi DB.
  `--no-doc` melewati `SCHEMA.md`.
- **Tipe kanonik.** Nilai dibaca dan ditulis menurut tipe kolom di DB: `int`, `bigint`, `decimal` (string),
  `float`, `bool`, `text`, `uuid`, `enum`, `datetime` (ISO-8601 UTC), `date`, `time`, `json`, `bytes` (base64).
  Snapshot dari MySQL bisa di-seed ke Postgres dan sebaliknya. `tinyint(1)` dibaca sebagai bool, dan tanggal
  `0000-00-00` jadi `NULL` dengan peringatan. `datetime`/`timestamp` tanpa zona dianggap UTC.
- **Export konsisten.** Semua tabel dibaca dalam satu transaksi read-only (Postgres `REPEATABLE READ READ ONLY`,
  MySQL `WITH CONSISTENT SNAPSHOT`), jadi aman walau aplikasi masih menulis.
- **Streaming.** Tabel ber-PK dibaca per batch (`batchSize`, default 5000, keyset pagination) dan ditulis langsung
  ke disk, jadi memori tidak bergantung pada ukuran tabel. Urutan baris = urutan primary key di DB.
- **Export parsial.** `npx dbfreeze export --tables users,posts` hanya menulis ulang tabel itu; file dan entri
  manifest tabel lain dibiarkan. Butuh snapshot penuh sebelumnya.
- **Seed tanpa `tables`.** Tabel yang dipulihkan = isi `manifest.json`; urutan insert dan FK tertunda dihitung dari
  DB tujuan. Tabel di manifest yang tidak ada di DB tujuan membuat seed batal sebelum DB disentuh.
- **Kolom generated** dilewati saat export. **Postgres `GENERATED ALWAYS AS IDENTITY`** di-insert dengan
  `OVERRIDING SYSTEM VALUE`. Tipe yang belum didukung (array, interval, geometry, bit, ...) membuat tabelnya ditolak
  dengan pesan jelas; keluarkan lewat `exclude`.

### Redaksi kolom sensitif (nonaktif secara default)

Tidak ada yang disamarkan kecuali kamu mengaturnya. Penyamaran terjadi saat export, jadi data asli tidak pernah
menyentuh disk. Selama `redact` kosong, export dan `generate` hanya **memperingatkan** kolom bernama
`password`, `token`, `secret`, `email`, atau `phone`.

```ts
export default defineConfig({
  adapter,
  dataDir: './data',
  redactSalt: process.env.DBFREEZE_SALT,          // rahasiakan; tanpa ini hash email bisa ditebak
  redact: {
    users: { email: 'fake-email', password_hash: 'hash', phone: 'fake-phone', bio: (v) => 'redacted' },
  },
})
```

Aturan: `'null'`, `'hash'`, `'fake-email'`, `'fake-phone'`, `'fake-text'`, `'mask'`, atau fungsi `(value, row) => baru`.
Aturan berbasis hash deterministik (per tabel dan kolom), jadi UNIQUE dan nilai yang sama tetap konsisten.
`'null'` pada kolom NOT NULL ditolak saat export, bukan saat seed. Kolom yang disamarkan dicatat di `manifest.json`.

## Untuk AI agent

Lihat [`AGENTS.md`](./AGENTS.md): cara membaca snapshot tanpa DB, perintah, dan aturan keselamatan (terutama: `seed` menimpa data).

Format snapshot naik ke **versi 2**. Versi 1 (v0.2) dan `.json` v0.1 tetap bisa dibaca saat seed.

## Format snapshot

```
data/
  manifest.json     # jumlah baris, sha256, dan tipe kolom per tabel
  users.ndjson      # satu row per baris, diurut berdasarkan id
  posts.ndjson
```

- Diurut berdasarkan `id` (numerik untuk angka) → `git diff` hanya menampilkan row yang benar-benar berubah.
- Nilai yang tidak bisa dibawa JSON polos ditulis eksplisit, tanpa tebak-tebakan saat dibaca:

  | Tipe | Bentuk di file |
  |---|---|
  | Date | `{"$date":"2026-01-01T00:00:00.000Z"}` |
  | BigInt | `{"$bigint":"9007199254740993"}` |
  | Decimal | `{"$decimal":"12.50"}` (string, tidak pernah lewat float) |
  | Bytes | `{"$bytes":"<base64>"}` |
  | Json yang berisi key `$...` | `{"$json": ...}` (di-escape) |

  String biasa yang kebetulan mirip tanggal tetap string. `NULL` dan `""` dibedakan.
- Snapshot lama `.json` (versi 0.1) masih bisa dibaca saat seed (tanpa verifikasi checksum). Export ulang untuk migrasi ke `.ndjson`.

## Keamanan seed

Karena seed menghapus isi tabel, urutannya dibuat defensif:

1. **Snapshot diverifikasi dulu** (checksum + jumlah baris dari `manifest.json`) sebelum DB disentuh. File rusak/hilang → batal, DB utuh.
2. **TRUNCATE + semua INSERT + patch FK + cek jumlah baris berjalan dalam satu transaksi.** Gagal di mana pun → rollback, data lama tetap ada.
3. **Urutan insert otomatis** induk → anak dari `dependsOn` (hasil `generate`), tidak tergantung urutan di config.
4. **Tidak ada `CASCADE`.** Tabel yang tidak terdaftar tapi masih punya FK ke tabel yang dikosongkan membuat seed gagal + rollback, bukan ikut terhapus diam-diam.
5. **Sequence/auto-increment disinkronkan** setelah commit (Postgres: `setval` ke `MAX+1`; MySQL: `AUTO_INCREMENT`).
6. **Insert dipecah otomatis** mengikuti batas parameter driver, jadi tabel lebar tidak error.
7. Timeout transaksi Prisma dinaikkan (default dbfreeze: 10 menit; bawaan Prisma cuma 5 detik).
8. `npx dbfreeze seed --dry-run`: validasi snapshot dan lihat rencana tanpa menyentuh DB.

> Seed **menimpa** isi tabel di DB yang dituju, termasuk DB remote. Tidak ada pengaman host di tool ini — pastikan `DATABASE_URL` yang dipakai memang yang kamu maksud.

Catatan per engine:
- **Postgres:** `TRUNCATE ... RESTART IDENTITY` (transaksional).
- **MySQL:** TRUNCATE itu DDL (commit implisit, merusak rollback), jadi dipakai `DELETE` anak dulu. Kalau tabel-tabelmu punya FK melingkar, pakai `createMysqlTruncate({ ignoreForeignKeys: true })` — konsekuensinya tabel tak terdaftar yang bergantung tidak terdeteksi.
- **SQLite:** `DELETE` + `PRAGMA defer_foreign_keys` (FK dicek saat COMMIT). Prisma butuh versi ≥ 5.12 untuk `createMany`.

## Install

```bash
npm install dbfreeze pg          # Postgres (atau: mysql2 untuk MySQL/MariaDB)
npx dbfreeze init                # buat dbfreeze.config.* + AGENTS.md
npx dbfreeze export
```

Paket ini dual-format: `import { ... } from 'dbfreeze'` (ESM) dan `require('dbfreeze')` (CommonJS) sama-sama jalan,
lengkap dengan tipe TypeScript. Butuh Node >= 18.

### `npx dbfreeze init`

Membuat config awal tanpa menulis dari nol:

```bash
npx dbfreeze init                       # engine ditebak dari driver (pg/mysql2) atau DATABASE_URL
npx dbfreeze init --db mysql --dir ./snapshot
npx dbfreeze init --force               # timpa config yang sudah ada
npx dbfreeze init --no-agent-doc        # jangan sentuh AGENTS.md
```

- Menulis `dbfreeze.config.ts` kalau project memakai TypeScript/tsx, selain itu `dbfreeze.config.cjs` (tanpa tsx).
- Menambah blok kecil ke `AGENTS.md` project (dibuat kalau belum ada, bagian lain file tidak disentuh, aman dijalankan ulang).
  Blok itu mengarahkan AI agent ke `node_modules/dbfreeze/AGENTS.md`, panduan lengkap yang ikut terpasang bersama paket.
- Memberi peringatan kalau driver, `tsx`, atau `DATABASE_URL` belum ada.
- CLI membaca `.env` dan `.env.local` otomatis (Node >= 20.12); variabel yang sudah ada di environment tidak ditimpa.

### Instalasi dari sumber lain

```bash
npm install git+https://github.com/namakamu/dbfreeze.git
npm install ./dbfreeze-0.4.0.tgz      # hasil `npm pack`
```

## Pakai sebagai CLI

### 1. (Prisma) Generate daftar tabel dari schema

```bash
npx dbfreeze generate
npx dbfreeze generate --schema path/ke/schema.prisma --out dbfreeze.tables.generated.ts
```

Menulis `tables` (dengan `dependsOn` untuk urutan FK) dan `deferredColumns` (FK opsional yang ada di cycle, ditunda saat insert lalu dipatch). Deteksi cycle memakai Tarjan SCC. Warning hanya muncul kalau cycle **tetap** tidak bisa dipecah setelah semua FK opsional ditunda (semua NOT NULL). Pembacanya regex ringan, jadi schema harus dalam format standar (`prisma format`).

### 2. `dbfreeze.config.ts` di root project

```ts
import { defineConfig, createPrismaAdapter } from 'dbfreeze'
import { PrismaClient } from '@prisma/client'
import { tables, deferredColumns } from './dbfreeze.tables.generated'

const prisma = new PrismaClient()

export default defineConfig({
  adapter: createPrismaAdapter({ prisma }),   // Postgres default; ganti truncateStrategy untuk MySQL/SQLite
  tables,
  dataDir: './prisma/data',
  deferredColumns,
})
```

Config `.ts` butuh `tsx` terpasang di project (`npm i -D tsx`).

### 3. Jalankan

```bash
npx dbfreeze export
npx dbfreeze seed --dry-run
npx dbfreeze seed
```

## Lewat kode

```ts
import { createPrismaAdapter, exportSnapshot, seedFromSnapshot } from 'dbfreeze'

const adapter = createPrismaAdapter({ prisma })
const tables = [
  { key: 'user', file: 'users' },
  { key: 'post', file: 'posts', dependsOn: ['users'] },
]

await exportSnapshot({ adapter, tables, dataDir: './prisma/data' })
await seedFromSnapshot({ adapter, tables, dataDir: './prisma/data', deferredColumns: { users: ['photoId'] } })
```

Kalau nama tabel SQL asli beda dari delegate (`@@map`), isi `resolveTableName` di adapter.

## Drizzle

```ts
import { createDrizzleAdapter, mysqlTruncate } from 'dbfreeze'
createDrizzleAdapter({ db, schema })                                   // Postgres
createDrizzleAdapter({ db, schema, truncateStrategy: mysqlTruncate })  // MySQL
```

Tersedia: `postgresTruncate`, `mysqlTruncate` / `createMysqlTruncate(opts)`, `sqliteTruncate`.

## Menambah ORM lain

Implement `SnapshotAdapter` (lihat `src/types.ts`): `findMany`, `insertMany`, `update`, `truncateAll`, `transaction` — plus `count` dan `resetSequences` (opsional tapi dianjurkan).

## Batasan yang diketahui

- **Mode ORM** (Prisma/Drizzle adapter): nama kolom di snapshot adalah nama field ORM, `findMany` memuat satu tabel penuh ke memori, PK diasumsikan `id` untuk deferred FK, dan export tidak konsisten antar-tabel. Pakai mode SQL untuk menghindari semua itu.
- **Mode SQL:** hanya Postgres dan MySQL/MariaDB. Skema (tabel, enum, tipe) di DB tujuan harus sudah dibuat lewat migrasi; snapshot hanya berisi data. Tabel ber-PK diurutkan menurut collation DB, jadi urutan baris bisa berbeda antar-engine.
- **MySQL:** tabel dengan FK melingkar atau self-reference gagal di `DELETE` saat seed kecuali memakai `createMysqlTruncate({ ignoreForeignKeys: true })`.
- Struktur DB di-cache per instance adapter; buat adapter baru setelah menjalankan migrasi.
- ⚠️ Isi snapshot adalah **data asli** kecuali kolomnya diatur lewat `redact`. Jangan commit ke repo yang tidak semestinya.

## Test

```bash
npm test
```
