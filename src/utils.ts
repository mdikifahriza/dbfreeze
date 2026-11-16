import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/** LEGACY (.json snapshots from dbfreeze 0.1): turn ISO date strings back into Date objects. */
export function revive(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === 'string' && ISO_DATE.test(value) ? new Date(value) : value,
    ]),
  )
}

/** LEGACY reader for `<file>.json` snapshots written by dbfreeze 0.1. */
export function readLegacyJson(file: string): Record<string, unknown>[] {
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>[]).map(revive)
}

export function sha256(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

/** Write via temp file + rename so an interrupted export never leaves a half-written file. */
export function writeIfChanged(file: string, content: string): boolean {
  const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  if (prev === content) return false
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, file)
  return true
}

export function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export function assertSafeFileName(file: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(file) || file.startsWith('.')) {
    throw new Error(`Nama file tabel tidak valid: "${file}" (hanya huruf, angka, _ . -)`)
  }
}

export function quoteIdent(name: string, quote: '"' | '`'): string {
  return quote + name.split(quote).join(quote + quote) + quote
}

/** sha256 of a file, streamed (never loads the whole file into memory). */
export function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}
