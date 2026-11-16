import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runInit, detectDialect, detectFlavor, dialectFromUrl, parseEnvUrl, upsertAgentBlock, renderAgentBlock, renderConfig } from '../src/init'

function tmp(files: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbfreeze-init-'))
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content)
  return dir
}

test('dialectFromUrl + parseEnvUrl', () => {
  assert.equal(dialectFromUrl('postgresql://u:p@h/db'), 'postgres')
  assert.equal(dialectFromUrl('mysql://u:p@h/db'), 'mysql')
  assert.equal(dialectFromUrl('sqlite:./x.db'), null)
  assert.equal(parseEnvUrl('A=1\nDATABASE_URL="mysql://x/y"\n'), 'mysql://x/y')
  assert.equal(parseEnvUrl('export DATABASE_URL=postgres://a/b'), 'postgres://a/b')
})

test('detectDialect: flag > driver > .env', () => {
  const prev = process.env.DATABASE_URL
  delete process.env.DATABASE_URL
  try {
    assert.equal(detectDialect(tmp({ 'package.json': '{"dependencies":{"mysql2":"3"}}' })), 'mysql')
    assert.equal(detectDialect(tmp({ 'package.json': '{"dependencies":{"pg":"8"}}' })), 'postgres')
    assert.equal(detectDialect(tmp({ '.env': 'DATABASE_URL=mysql://a/b' })), 'mysql')
    assert.equal(detectDialect(tmp({ 'package.json': '{"dependencies":{"pg":"8","mysql2":"3"}}' }), 'mysql'), 'mysql')
    assert.equal(detectDialect(tmp()), null)
  } finally {
    if (prev !== undefined) process.env.DATABASE_URL = prev
  }
})

test('detectFlavor: ts bila ada tsconfig/tsx, selain itu cjs', () => {
  assert.equal(detectFlavor(tmp({ 'tsconfig.json': '{}' })), 'ts')
  assert.equal(detectFlavor(tmp({ 'package.json': '{"devDependencies":{"tsx":"4"}}' })), 'ts')
  assert.equal(detectFlavor(tmp({ 'package.json': '{}' })), 'cjs')
})

test('renderConfig: tiap kombinasi menghasilkan kode yang sesuai', () => {
  assert.match(renderConfig('postgres', 'ts', './data'), /import \{ Pool \} from 'pg'/)
  assert.match(renderConfig('mysql', 'ts', './data'), /mysql2Client\(mysql\.createPool/)
  assert.match(renderConfig('postgres', 'cjs', './x'), /require\('dbfreeze'\)/)
  assert.match(renderConfig('postgres', 'cjs', './x'), /dataDir: "\.\/x"/)
})

test('runInit menulis config + AGENTS.md, menolak menimpa tanpa --force', () => {
  const dir = tmp({ 'package.json': '{"dependencies":{"pg":"8"}}', 'AGENTS.md': '# Punyaku\n\nCatatan lama.\n' })
  const r = runInit({ cwd: dir })
  assert.equal(r.dialect, 'postgres')
  assert.equal(r.flavor, 'cjs')
  assert.ok(fs.existsSync(path.join(dir, 'dbfreeze.config.cjs')))
  const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')
  assert.match(agents, /Catatan lama\./)
  assert.match(agents, /node_modules\/dbfreeze\/AGENTS\.md/)
  assert.throws(() => runInit({ cwd: dir }), /sudah ada/)
  // dengan --force: config ditimpa, blok AGENTS.md diganti (tidak digandakan)
  runInit({ cwd: dir, force: true, dataDir: './snap' })
  const again = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')
  assert.equal(again.split('dbfreeze:begin').length - 1, 1)
  assert.match(again, /\.\/snap/)
  assert.match(again, /Catatan lama\./)
})

test('runInit: gagal jelas bila engine tidak bisa ditebak; --no-agent-doc tidak menulis AGENTS.md', () => {
  const prev = process.env.DATABASE_URL
  delete process.env.DATABASE_URL
  try {
    assert.throws(() => runInit({ cwd: tmp() }), /--db/)
  } finally {
    if (prev !== undefined) process.env.DATABASE_URL = prev
  }
  const dir = tmp()
  const r = runInit({ cwd: dir, dialect: 'mysql', agentDoc: false })
  assert.equal(r.agentDocFile, null)
  assert.ok(!fs.existsSync(path.join(dir, 'AGENTS.md')))
  assert.ok(r.warnings.some((w) => w.includes('mysql2')))
})

test('upsertAgentBlock idempoten', () => {
  const block = renderAgentBlock('./data')
  const once = upsertAgentBlock('# X\n', block)
  assert.equal(upsertAgentBlock(once, block), once)
})
