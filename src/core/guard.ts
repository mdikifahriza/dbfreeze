/**
 * Cegah seed ke database produksi secara tidak sengaja.
 *
 * Sebelum menyentuh DB, dbfreeze mencetak koneksi target (host/port/dbname — BUKAN
 * kredensial). Strategi:
 *  - host lokal (localhost/127.0.0.1/::1/docker-internal) → selalu boleh
 *  - nama DB mengandung `prod|live|production` (case-insensitive) → BLOK,
 *    kecuali di-override dengan --i-know-this-overwrites-prod
 *  - host non-lokal lain → hanya peringatan, tetap jalan
 *  - `--dry-run` selalu lolos (read-only)
 */

export const LOCAL_HOST_PATTERN =
  /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1|host\.docker\.internal|host\.internal|kubernetes\.docker\.internal)$/i;
export const PROD_NAME_PATTERN = /(prod|production|live)/i;

export interface SeedTarget {
  host: string;
  port: string | null;
  database: string;
}

/** Best-effort parse dari DATABASE_URL. Tidak mengembalikan password. */
export function parseDatabaseUrl(url: string): SeedTarget | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: u.port || (u.protocol === 'mysql:' || u.protocol === 'mariadb:' ? '3306' : null),
      database: decodeURIComponent(u.pathname.replace(/^\//, '')),
    };
  } catch {
    return null;
  }
}

/** Rangkuman koneksi yang aman dicetak (tidak ada password). */
export function formatTarget(target: SeedTarget | null): string {
  if (!target) return '(koneksi tidak bisa dideteksi — periksa config/DATABASE_URL)';
  const port = target.port ? `:${target.port}` : '';
  return `host=${target.host}${port} database=${target.database}`;
}

export interface GuardInput {
  host: string;
  database: string;
  dryRun: boolean;
  overrideProdGuard: boolean;
}

/** @returns pesan error kalau ditolak, null kalau boleh. */
export function seedGuardBlock({ host, database, dryRun, overrideProdGuard }: GuardInput): string | null {
  if (dryRun) return null;
  const isLocal = LOCAL_HOST_PATTERN.test(host.trim());
  if (isLocal) return null;
  const looksProd = PROD_NAME_PATTERN.test(`${database} ${host}`);
  if (looksProd && !overrideProdGuard) {
    return (
      `Seed diblokir: database '${database}' di host '${host}' terlihat seperti produksi.\n` +
      'Kalau memang Anda sengaja, jalankan ulang dengan flag --i-know-this-overwrites-prod.'
    );
  }
  return null;
}
