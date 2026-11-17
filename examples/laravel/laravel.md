# Contoh Laravel (singkat)

```bash
composer require prhatara/dbfreeze
php artisan dbfreeze:install          # deteksi engine, buat config/dbfreeze.php
php artisan dbfreeze:export           # dump semua tabel ke storage/app/dbfreeze/
php artisan dbfreeze:info             # tabel terdeteksi + jumlah baris
php artisan dbfreeze:seed --dry-run   # validasi
php artisan dbfreeze:seed             # restore (menimpa isi tabel)
```

Untuk sesuatu yang lebih rumit (multiple connections, redact, partial restore),
lihat dokumentasi resmi: https://github.com/mdikifahriza/dbfreeze-composer#readme
