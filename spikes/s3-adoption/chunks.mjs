// Spike S3, chunk level: from a fresh, cache-less antd, fetch each blob's root chunk and
// every child chunk it lists (/chunks), then the whole blob (/bytes) three times. Shows how
// far the control has faded: antd uploads carry erasure coding (100 KiB = 25 data + 5 parity
// chunks), so a blob still downloads with up to 5 missing children.
//   ANTD=/path/to/antd node chunks.mjs
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const setup = JSON.parse(readFileSync(join(here, 'setup.json'), 'utf8'))
const port = 1836
const api = `http://127.0.0.1:${port}`
const sleep = (n) => new Promise((r) => setTimeout(r, n))
const chunk = async (addr) => {
  try {
    const r = await fetch(`${api}/chunks/${addr}`, { signal: AbortSignal.timeout(30_000) })
    return r.ok ? Buffer.from(await r.arrayBuffer()) : r.status
  } catch (e) { return String(e.message || e) }
}
const antd = spawn(process.env.ANTD || 'antd', ['--data-dir', mkdtempSync(join(tmpdir(), 's3c-antd-')), '--api-addr', `127.0.0.1:${port}`,
  '--no-disk-cache', '--no-peerstore', '--per-request-chunk-cache', '--no-control-socket', '--gnosis-logs-rpc-url', ''], { stdio: 'ignore' })
try {
  let peers = 0
  for (let i = 0; i < 120; i++) {
    try { peers = ((await (await fetch(`${api}/peers`)).json()).peers || []).length; if (peers >= 50) break } catch {}
    await sleep(1000)
  }
  const out = { at: new Date().toISOString(), memberBatchExpiresApprox: setup.memberBatchExpiresApprox, peers, results: [] }
  for (const b of [...setup.blobs, ...setup.extra]) {
    const root = await chunk(b.ref)
    const res = { label: b.label, ref: b.ref, root: Buffer.isBuffer(root) ? 'ok' : root }
    if (Buffer.isBuffer(root)) {
      // span: 8 bytes little-endian; the top byte carries the redundancy level, the rest the byte count
      const span = Number(root.readBigUInt64LE(0) & 0x00ffffffffffffffn)
      const kids = span > 4096 ? Array.from({ length: (root.length - 8) / 32 }, (_, i) => root.subarray(8 + 32 * i, 40 + 32 * i).toString('hex')) : []
      const got = await Promise.all(kids.map(chunk))
      Object.assign(res, {
        bytes: span, redundancyByte: root[7], children: kids.length, childrenOk: got.filter(Buffer.isBuffer).length,
        missing: got.map((g, i) => (Buffer.isBuffer(g) ? null : { addr: kids[i], status: g })).filter(Boolean),
      })
    }
    res.downloads = []
    for (let k = 0; k < 3; k++) {
      const t0 = Date.now()
      try {
        const r = await fetch(`${api}/bytes/${b.ref}`, { signal: AbortSignal.timeout(60_000) })
        res.downloads.push({ status: r.status, bytes: r.ok ? (await r.arrayBuffer()).byteLength : 0, ms: Date.now() - t0 })
      } catch (e) { res.downloads.push({ status: String(e.message || e), ms: Date.now() - t0 }) }
    }
    out.results.push(res)
    console.log(JSON.stringify({ ...res, missing: res.missing?.length }))
  }
  writeFileSync(join(here, `chunks-${out.at.slice(0, 16).replace(/:/g, '')}.json`), JSON.stringify(out, null, 2) + '\n')
} finally {
  antd.kill()
}
