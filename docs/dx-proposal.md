# Usulan Perbaikan Developer Experience — `dbfreeze` (npm)

Status: **terimplementasi** (commit `50f452f` + lanjutan ini) — lihat catatan di bawah untuk status masing-masing item.
Basis diskusi dari pengalaman migrasi produksi
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

### P0 — Pengaman yang terlewat — ✅ TERJAWAB

- [x] **Production seed guard** (port dari composer SeedGuard): tolak `seed` ke DB yang namanya
  mengandung `prod|live|production` (kecuali localhost atau override `--i-know-this-overwrites-prod`).
  `--dry-run` selalu lolos; target koneksi (host/port/db) dicetak di awal sebelum menyentuh DB.
- [x] **Konfirmasi seed** — selalu diminta sebelum tabel di-overwrite; dilewati hanya kalau `--yes`
  atau env `CI=true`. Jawaban N/EOF = batal, tidak menyentuh DB.
- [x] **`--dry-run` tetap jalan di prod** — read-only.

### P1 — Quickstart < 5 menit — ✅ TERJAWAB

- [x] **`dbfreeze init` interaktif** — setelah config dibuat, akses TTY akan ditanya "Jalankan export
  sekarang?" → langsung spawn `npx dbfreeze export`, lalu tawarkan `seed --dry-run`.
- [x] **README Quickstart 3 langkah** di awal README + ajakan "lihat `npx dbfreeze seed --dry-run`".
- [x] **`dbfreeze info`** (baru) — cetak engine, dir data, tabel terdeteksi + jumlah baris.
- [x] **`dbfreeze doctor`** — cek config, koneksi DB, writable dataDir; exit 0/1.
- [x] **`--no-export`** — opsi `--no-export` untuk init tanpa langsung menjalankan export.

### P2 — Error message actionable — ✅ TERJAWAB (sebagian)

- [x] `main().catch` mencetak alasan + petunjuk (`set DBFREEZE_DEBUG=1 untuk stack trace`).
- [x] Pesan dalam engine (seed/order/checksum/load) sudah membawa langkah perbaikan eksplisit.
- [ ] Mapping otomatis 8 kasus error ke pesan + langkah (belum dipisah jadi helper `friendlyError`) —
  pesan saat ini sudah cukup actionable tetapi belum memiliki test suite khusus.

### P3 — Dokumentasi & distribusi

- [x] **Contoh nyata di repo**: `examples/inmem/demo.mjs` (self-contained, tanpa DB) +
  `examples/live/mysql.sql` / `examples/live/postgres.sql` + `examples/laravel/`. `npm run demo`
  menjalankan demo.
- [x] **README "Pilih versi"** — tabel kapan pakai npm vs composer.

### P4 — Polish kecil

- [x] `dbfreeze doctor` (lihat P1).
- [x] `--tables` pada `seed` — partial restore hanya untuk tabel yang diminta; tabel lain tidak disentuh.
- [ ] Contoh Laravel live runner (`npm run demo` dalam folder `examples/laravel/`) — belum; dibutuhkan
  lingkungan Laravel nyata.

---

## Acceptance criteria (untuk rilis berikutnya)

1. Dev baru mengikuti README → selesai `export` + `seed --dry-run` dalam < 5 menit dengan
   config yang benar tanpa bertanya apa pun ke tim.
2. `seed` ke DB yang namanya mengandung `prod|live|production` **ditolak** tanpa flag override,
   dengan pesan yang jelas; dikonfirmasi: tidak mengubah apa pun di DB.
3. Semua error utama (8 di atas) punya pesan + langkah perbaikan; test suite mencakup pesan-pesan ini.
   → Pesan engine sudah actionable; `DBFREEZE_DEBUG=1` untuk stack trace. Test eksplisit khusus error mapping belum ada.
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
