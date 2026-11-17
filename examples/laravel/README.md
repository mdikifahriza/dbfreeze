# Contoh Laravel

Lihat [`examples/laravel.md`](./laravel.md) untuk versi ringkas. Contoh ini mengasumsikan
Anda sudah memiliki proyek Laravel dengan database terkoneksi.

## 1. Install

```bash
composer require prhatara/dbfreeze
php artisan dbfreeze:install          # buat config/dbfreeze.php (sekali saja)
```

## 2. Dump & reset

```bash
php artisan dbfreeze:export           # snapshot semua tabel ke storage/app/dbfreeze/*.ndjson
php artisan dbfreeze:seed --dry-run   # validasi snapshot tanpa menyentuh DB
php artisan dbfreeze:seed             # restore penuh — menimpa isi tabel
```

Semua langkah di atas dijelaskan lebih lanjut di `vendor/prhatara/dbfreeze/README.md`.
