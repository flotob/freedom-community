// Spike S3 check: after the member batch has expired, fetch each blob from a fresh,
// cache-less antd (so no earlier download can answer) and compare SHA-256.
//   ANTD=/path/to/antd node check.mjs
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const setup = JSON.parse(readFileSync(join(here, 'setup.json'), 'utf8'))
const port = 1835
const api = `http://127.0.0.1:${port}`
const sleep = (n) => new Promise((r) => setTimeout(r, n))
const antd = spawn(process.env.ANTD || 'antd', ['--data-dir', mkdtempSync(join(tmpdir(), 's3-antd-')), '--api-addr', `127.0.0.1:${port}`,
  '--no-disk-cache', '--no-peerstore', '--per-request-chunk-cache', '--no-control-socket', '--gnosis-logs-rpc-url', ''], { stdio: 'ignore' })
try {
  for (let i = 0; i < 120; i++) {
    try { const p = await (await fetch(`${api}/peers`)).json(); if ((p.peers || []).length >= 50) break } catch {}
    await sleep(1000)
  }
  const out = { at: new Date().toISOString(), memberBatchExpiresApprox: setup.memberBatchExpiresApprox, results: [] }
  for (const b of [...setup.blobs, ...setup.extra]) {
    const t0 = Date.now()
    let status, sha256 = null
    try {
      const r = await fetch(`${api}/bytes/${b.ref}`, { signal: AbortSignal.timeout(120_000) })
      status = r.status
      if (r.ok) sha256 = createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex')
    } catch (e) { status = String(e.message || e) }
    const res = { label: b.label, ref: b.ref, status, retrievable: status === 200, contentMatches: b.sha256 ? sha256 === b.sha256 : null, ms: Date.now() - t0 }
    out.results.push(res)
    console.log(JSON.stringify(res))
  }
  writeFileSync(join(here, `check-${out.at.slice(0, 16).replace(/:/g, '')}.json`), JSON.stringify(out, null, 2) + '\n')
} finally {
  antd.kill()
}
