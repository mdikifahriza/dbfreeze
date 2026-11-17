# Usulan Perbaikan Developer Experience — `dbfreeze` (npm)

Status: **proposal**, belum diimplementasikan. Basis diskusi dari pengalaman migrasi produksi
Gondowido (MySQL Railway → Neon PostgreSQL, 2026-11). Target: **first success < 5 menit**
untuk developer baru, tanpa menurunkan keselamatan.

---

## Masalah yang diangkat

1. **Proses instalasi belum mandiri** — user harus tahu menjalankan `dbfreeze init` sendiri;
   tidak ada "langkah berikutnya" interaktif. `init` ada, tapi minimal: tulis config + AGENTS.md,
   tidak menawarkan export/test run, dan tidak menjelaskan apa artinya masing-masing opsi.
2. **`seed` bisa menimpa produksi tanpa halangan** — tidak ada guard "ini mungkin produksi";
   semua risiko diserahkan ke disiplin user. (Sudah ditutup di versi Composer via SeedGuard.)
3. **Pesan error tidak actionable** — checkout checksum gagal, tabel tak ada di manifest, cycle FK,
   zero-date, DLL init — user harus menebak langkah berikutnya.
4. **Tidak ada konfirmasi interaktif `seed`** — berjalan non-interaktif sepenuhnya; untuk manusia
   seharusnya ada konfirmasi (dengan fallback `--yes`/`CI` untuk pipelines).
5. **Dokumentasi** — README panjang; quickstart "3 langkah" tidak ada; tidak ada contoh alur
   MySQL→PostgreSQL nyata.
6. **Distribusi** — versi npm terpasang, tapi belum ada mutual-compat note dengan Composer port
   (`prhatara/dbfreeze`) — user bisa bingung mana yang dipakai di proyek Laravel.

---

## Usulan (dengan urutan prioritas)

### P0 — Pengaman yang terlewat

- [ ] **Production seed guard** (port dari composer SeedGuard): tolak `seed` ke koneksi yang
  `host`-nya bukan localhost **dan** `dbname` mengandung `prod|live|production`. Override eksplisit
  `--i-know-this-overwrites-prod`. `--dry-run` selalu lolos.
  Pesan jelas: koneksi (host/port/db) dicetak di awal, sebelum tindakan apapun.
- [ ] **Konfirmasi interaktif untuk `seed`** bila TTY terdeteksi — tujuan ditampilkan,
  `[y/N]` pertanyaan. `--yes` untuk CI/pipeline (default tidak dianggap interaktif tanpa flag itu).
- [ ] **`--dry-run` tetap jalan di prod** — read-only, tidak perlu konfirmasi.

### P1 — Quickstart < 5 menit

- [ ] **`dbfreeze init` yang benar-benar membimbing**: setelah config dibuat, tampilkan
  ringkasan (engine, dataDir, jumlah tabel terdeteksi dari introspect live DB), lalu tanya
  interaktif: "Jalankan export sekarang? [Y/n]" → langsung jalan, lalu tawarkan `seed --dry-run`.
  Gagal di mana pun → tampilkan pesan diagnosis + langkah perbaikan (bukan stack trace mentah).
- [ ] **README: "Quickstart 3 langkah"** di atas — `npm i -D dbfreeze pg`, `npx dbfreeze init`,
  `npx dbfreeze export` + `seed --dry-run`. Contoh alur MySQL→PostgreSQL nyata (snapshot).
- [ ] **`dbfreeze info`** (baru): cetak engine, koneksi aktif (host/db), daftar tabel yang akan
  di-snapshot + estimasi baris, redact aktif — sekali perintah, tanpa meng-export dulu.

### P2 — Error message actionable

- [ ] Mapekan 8 error paling umum ke pesan + langkah perbaikan:
  checksum mismatch → "jalankan ulang export"; "table X not in manifest" → "export dulu",
  cycle FK NOT NULL → "jadikan FK optional / gunakan createMysqlTruncate", zero-date,
  unsupported type → "keluarkan lewat `exclude`", checksum cocok tapi jumlah beda → dst.
- [ ] Prefix `❌` diganti pesan yang selalu menjawab: apa yang terjadi + apa yang harus dilakukan.

### P3 — Dokumentasi & distribusi

- [ ] **Contoh nyata di repo**: `examples/laravel-sql/` + `examples/prisma/` — one-command each
  (`npm run demo`) dengan hasil snapshot yang bisa di-inspect.
- [ ] **README "Pilih versi"**: tabel singkat Node vs Composer (`prhatara/dbfreeze`) — kapan pakai
  yang mana (proyek Node/Prisma/non-PHP → npm; proyek Laravel → composer).
- [ ] **Badge CI** (unit tests + integration via service containers).

### P4 — Polish kecil

- [ ] `dbfreeze doctor` — memeriksa: driver terpasang, koneksi bisa dibuka, migrasi tabel ada,
  permission dataDir, redact valid. Keluar 0/1.
- [ ] `--tables` pada `seed` — restore sebagian tabel (berguna setelah reset parsial).

---

## Acceptance criteria (untuk rilis berikutnya)

1. Dev baru mengikuti README → selesai `export` + `seed --dry-run` dalam < 5 menit dengan
   config yang benar tanpa bertanya apa pun ke tim.
2. `seed` ke DB yang namanya mengandung `prod|live|production` **ditolak** tanpa flag override,
   dengan pesan yang jelas; dikonfirmasi: tidak mengubah apa pun di DB.
3. Semua error utama (8 di atas) punya pesan + langkah perbaikan; test suite mencakup pesan-pesan ini.
4. CI (GitHub Actions): unit + integration (service pgsql/mysql) hijau.
5. Tidak ada regresi pada format snapshot (backward compat NDJSON v2).

---

## Yang sengaja TIDAK diubah

- Format snapshot NDJSON v2 (sudah dipakai; break format = semua snapshot lama invalid).
- Perilaku seed transaksional (kekuatannya ada di rollback — jangan diganggu).
- `dbfreeze` tetap package Node; parity Composer adalah proyek terpisah (tapi DX guard serupa
  sudah diterapkan di sana).

---

## Estimasi

- P0 (production guard + TTY confirm + dry-run bypass): ~1 hari + test
- P1 (init interaktif + README quickstart + `info`): ~1 hari
- P2 (error mapping + test): ~1/2 hari
- P3–P4: ~1 hari total

**Total ±3,5 hari kerja.** Tidak memerlukan perubahan dependency; semuanya internal paket.
