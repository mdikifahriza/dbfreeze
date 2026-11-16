# dbfreeze: panduan untuk AI agent

Dokumen ini ditujukan untuk AI agent (Claude Code, Cursor, Copilot, dll.) yang menemukan paket `dbfreeze`
di `node_modules` atau di project pengguna. Baca ini dulu sebelum menjalankan perintah apa pun.

## Fungsi

`dbfreeze` membuat **snapshot isi database** (Postgres atau MySQL/MariaDB) menjadi file teks, lalu bisa
**memulihkannya** (`seed`). Cocok untuk: melacak data dev di git, mereset data setelah testing, dan membiarkan
AI membaca isi DB dari file tanpa koneksi ke DB.

- ORM-agnostik: bicara SQL langsung, jadi berlaku untuk Prisma, Drizzle, Knex, atau tanpa ORM.
- Struktur tabel dibaca dari DB itu sendiri (nama kolom SQL asli, bukan nama field ORM).
- Snapshot hanya berisi **data**. Skema (tabel, enum) harus sudah dibuat lewat migrasi di DB tujuan.

## Cara membaca data tanpa koneksi DB

Setelah `npx dbfreeze export`, folder data (default `./data`, lihat `dataDir` di `dbfreeze.config.*`) berisi:

| File | Isi |
|---|---|
| `SCHEMA.md` | Ringkasan tabel, kolom, tipe, PK, FK. **Baca ini dulu.** |
| `_schema.json` | Struktur yang sama dalam bentuk mesin |
| `manifest.json` | Jumlah baris, sha256, tipe kolom, kolom yang disamarkan per tabel |
| `<tabel>.ndjson` | Satu baris = satu row (JSON), diurut berdasarkan primary key |

Nilai khusus di NDJSON: `{"$date":"..."}`, `{"$bigint":"..."}`, `{"$decimal":"12.50"}` (string, bukan float),
`{"$bytes":"<base64>"}`, `{"$json": ...}`. `NULL` dan `""` dibedakan.

Untuk menjawab pertanyaan tentang data, cukup baca file-file ini. Jangan menjalankan `seed` untuk itu.

## Perintah

```bash
npx dbfreeze init [--db postgres|mysql] [--dir ./data] [--force] [--no-agent-doc]
npx dbfreeze export [--tables a,b] [--no-doc]    # DB -> file (aman, hanya membaca DB)
npx dbfreeze seed --dry-run                       # validasi snapshot, DB tidak disentuh
npx dbfreeze seed                                 # file -> DB (MENIMPA isi tabel)
npx dbfreeze generate [--schema p] [--out p]      # hanya mode ORM Prisma
```

## Aturan keselamatan (wajib)

1. **`seed` menghapus dan menimpa isi tabel di database yang ditunjuk `DATABASE_URL`.** Tidak ada pengaman
   host. Jangan jalankan `seed` tanpa persetujuan eksplisit pengguna di percakapan ini, dan periksa dulu
   `DATABASE_URL` mengarah ke DB dev/lokal, bukan produksi. Selalu jalankan `seed --dry-run` lebih dulu.
2. `export` aman untuk DB mana pun (read-only), tetapi hasilnya adalah **data asli**. Jangan commit snapshot
   yang berisi password, token, email, atau telepon kecuali `redact` sudah diatur di config.
3. Jangan mengedit `*.ndjson` atau `manifest.json` dengan tangan: checksum sha256 akan tidak cocok dan seed
   akan dibatalkan. Ubah data lewat DB lalu `export` ulang.
4. Jangan mencetak isi `.env` atau `DATABASE_URL` ke output percakapan.

## Setup awal (jika `dbfreeze.config.*` belum ada)

```bash
npm install dbfreeze pg          # atau: mysql2
npx dbfreeze init                # menebak engine dari driver / DATABASE_URL; --db untuk memaksa
```

`init` membuat `dbfreeze.config.ts` (atau `.cjs` bila project bukan TypeScript) dan menambah blok pendek ke
`AGENTS.md` project. Config `.ts` butuh `npm install -D tsx`. Lalu pastikan `DATABASE_URL` terisi di `.env`.

Bentuk config:

```ts
import { defineConfig, createSqlAdapter, pgClient } from 'dbfreeze'   // atau mysql2Client
import { Pool } from 'pg'

export default defineConfig({
  adapter: createSqlAdapter({ client: pgClient(new Pool({ connectionString: process.env.DATABASE_URL })) }),
  dataDir: './data',
  exclude: [],                       // tabel yang dilewati
  redactSalt: process.env.DBFREEZE_SALT,
  redact: { users: { email: 'fake-email', password_hash: 'hash' } },
})
```

Aturan `redact`: `'null'`, `'hash'`, `'fake-email'`, `'fake-phone'`, `'fake-text'`, `'mask'`, atau fungsi
`(value, row) => baru`. Penyamaran terjadi saat export, jadi data asli tidak menyentuh disk.

## Alur kerja yang disarankan

1. Pengguna minta data direset atau dipulihkan: `npx dbfreeze seed --dry-run`, tampilkan ringkasannya,
   minta konfirmasi, baru `npx dbfreeze seed`.
2. Pengguna minta snapshot diperbarui setelah ubah data: `npx dbfreeze export` (atau `--tables users,posts`).
3. Setelah migrasi skema berubah: jalankan `export` ulang, dan jalankan `seed` hanya setelah migrasi diterapkan
   ke DB tujuan.

## Pemecahan masalah singkat

- `Tidak ketemu dbfreeze.config`: jalankan dari root project, atau `npx dbfreeze init`.
- `package "tsx" belum terinstall`: `npm install -D tsx`, atau pakai config `.cjs`.
- Seed batal dengan pesan checksum: file snapshot berubah atau rusak. `export` ulang.
- Tabel ditolak karena tipe tidak didukung (array, interval, geometry, bit): masukkan ke `exclude`.
- MySQL dengan FK melingkar: `createMysqlTruncate({ ignoreForeignKeys: true })` (hanya mode ORM).

## Pemakaian lewat kode

```ts
import { exportSnapshot, seedFromSnapshot } from 'dbfreeze'   // ESM dan CommonJS sama-sama didukung
```

Dokumentasi lengkap ada di `README.md` pada paket ini.
