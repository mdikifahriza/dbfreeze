# dbfreeze — contoh nyata

Tiga cara mencoba `dbfreeze` tanpa harus membaca README panjang dulu.

## 1. Contoh self-contained (tanpa database sama sekali)

```bash
node examples/inmem/demo.mjs
```

Contoh ini memasang adapter memori di dalam proses, mem-seed data contoh, lalu menjalankan
`export` dan `seed`; output memperlihatkan file `.ndjson`, `manifest.json`, dan verifikasi
restore. Ideal untuk memahami alur tanpa koneksi DB.

## 2. Contoh terhadap MySQL/Postgres lokal

Contoh di `examples/live/mysql.sql` dan `examples/live/postgres.sql` membuat tabel `items`
sederhana dengan beberapa row, kemudian walkthrough: `export` → acak data → `seed --dry-run`
→ `seed`. Persiapan:

```bash
# MySQL (asumsi root password kosong — sesuaikan dengan lingkungan Anda)
mysql -u root -e "CREATE DATABASE IF NOT EXISTS dbfreeze_demo; USE dbfreeze_demo; SOURCE examples/live/mysql.sql;"
DBFREEZE_MYSQL_URL=mysql://root@localhost:3306/dbfreeze_demo npx dbfreeze export

# PostgreSQL
psql -U postgres -d dbfreeze_demo -f examples/live/postgres.sql
DATABASE_URL=postgres://postgres@localhost:5432/dbfreeze_demo npx dbfreeze export
```

## 3. Contoh project Laravel

Lihat `examples/laravel/` — minimal Laravel project dengan 1 tabel `items`, perintah
`php artisan dbfreeze:export`, `php artisan dbfreeze:seed --dry-run`, dan `php artisan dbfreeze:seed`.
