// Spike S7: does the *released* antd serve every endpoint the steward relies on?
// Exercises each one for real through bee-js 13.2.0 (the version Freedom 0.8.8 ships)
// and records pass/fail plus timings in results.json.
//
//   BEE_URL=http://localhost:1733 \
//   COMMUNITY_BATCH=<id> THROWAWAY_BATCH=<id> \
//   [MUTATE_STAMPS=1]  # also run the stamp top-up (1 PLUR per chunk) and dilute (+1 depth) on the throwaway batch
//   node check.mjs
import { Bee, PrivateKey, Topic, Identifier, Bytes } from '@ethersphere/bee-js'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const BEE_URL = process.env.BEE_URL || 'http://localhost:1733'
const COMMUNITY = process.env.COMMUNITY_BATCH
const THROWAWAY = process.env.THROWAWAY_BATCH
if (!COMMUNITY || !THROWAWAY) throw new Error('set COMMUNITY_BATCH and THROWAWAY_BATCH')
const bee = new Bee(BEE_URL)
const results = []
const ms = (t0) => Math.round(performance.now() - t0)
const sleep = (n) => new Promise((r) => setTimeout(r, n))
const eq = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0

async function check(name, endpoints, fn) {
  const t0 = performance.now()
  try {
    const detail = (await fn()) || {}
    results.push({ name, endpoints, ok: true, ms: ms(t0), ...detail })
    console.log(`PASS ${name} (${ms(t0)} ms)`, JSON.stringify(detail))
  } catch (e) {
    results.push({ name, endpoints, ok: false, ms: ms(t0), error: String(e?.message || e).slice(0, 400), status: e?.status })
    console.log(`FAIL ${name} (${ms(t0)} ms): ${String(e?.message || e).slice(0, 300)}`)
  }
}

async function getJson(path, init) {
  const r = await fetch(BEE_URL + path, init)
  const text = await r.text()
  if (!r.ok) throw Object.assign(new Error(`${init?.method || 'GET'} ${path} -> ${r.status} ${text.slice(0, 200)}`), { status: r.status })
  return text ? JSON.parse(text) : {}
}

// Poll fn until it returns truthy or the deadline passes; returns [value, elapsed ms].
async function until(fn, timeoutMs, stepMs = 500) {
  const t0 = performance.now()
  for (;;) {
    try { const v = await fn(); if (v) return [v, ms(t0)] } catch {}
    if (performance.now() - t0 > timeoutMs) return [null, ms(t0)]
    await sleep(stepMs)
  }
}

const health = await getJson('/health')
const addresses = await getJson('/addresses')
console.log('node', health.version, 'api', health.apiVersion, 'overlay', addresses.overlay)

// ---------- content ----------
let dataRef
await check('bytes upload + download', ['POST /bytes', 'GET /bytes/{ref}'], async () => {
  const data = randomBytes(10 * 1024)
  const t0 = performance.now()
  dataRef = (await bee.data.upload(THROWAWAY, data)).reference
  const upMs = ms(t0)
  const back = await bee.data.download(dataRef)
  if (!eq(back.toUint8Array(), data)) throw new Error('downloaded bytes differ')
  return { reference: dataRef.toHex(), uploadMs: upMs, size: data.length }
})

await check('chunk upload + download', ['POST /chunks', 'GET /chunks/{addr}'], async () => {
  const chunk = bee.makeContentAddressedChunk(randomBytes(512))
  const r = await bee.chunk.upload(THROWAWAY, chunk)
  const back = await bee.chunk.download(r.reference)
  if (!eq(back, chunk.data)) throw new Error('chunk differs')
  return { reference: r.reference.toHex() }
})

await check('bzz collection (site) upload + path reads', ['POST /bzz (tar collection)', 'GET /bzz/{ref}/', 'GET /bzz/{ref}/{path}'], async () => {
  const dir = mkdtempSync(join(tmpdir(), 's7-site-'))
  const html = `<!doctype html><title>s7</title><script src="app.js"></script><p>${randomBytes(8).toString('hex')}</p>`
  writeFileSync(join(dir, 'index.html'), html)
  writeFileSync(join(dir, 'app.js'), 'console.log("s7")\n')
  const ref = (await bee.collection.uploadFromDirectory(THROWAWAY, dir, { indexDocument: 'index.html' })).reference.toHex()
  const r1 = await fetch(`${BEE_URL}/bzz/${ref}/`)
  const t1 = await r1.text()
  const r2 = await fetch(`${BEE_URL}/bzz/${ref}/app.js`)
  const t2 = await r2.text()
  if (t1 !== html) throw new Error(`index mismatch (${r1.status} ${r1.headers.get('content-type')})`)
  if (!t2.includes('s7')) throw new Error(`app.js mismatch (${r2.status})`)
  return { reference: ref, indexContentType: r1.headers.get('content-type'), jsContentType: r2.headers.get('content-type') }
})

// ---------- single-owner chunks and feeds ----------
await check('SOC write + read', ['POST /soc/{owner}/{id}', 'GET /soc/{owner}/{id}'], async () => {
  const signer = new PrivateKey(randomBytes(32))
  const owner = signer.publicKey().address()
  const id = new Identifier(randomBytes(32))
  const payload = randomBytes(200)
  const up = await bee.soc.makeWriter(signer).upload(THROWAWAY, id, payload)
  const expected = bee.calculateSingleOwnerChunkAddress(id, owner)
  if (up.reference.toHex() !== expected.toHex()) throw new Error(`SOC address ${up.reference.toHex()} != expected ${expected.toHex()}`)
  const [soc, readMs] = await until(() => bee.soc.makeReader(owner).download(id), 30_000)
  if (!soc) throw new Error('SOC not readable within 30 s')
  if (!eq(soc.payload.toUint8Array(), payload)) throw new Error('SOC payload differs')
  return { address: up.reference.toHex(), readAfterWriteMs: readMs }
})

await check('sequence feed: 3 updates, latest read after each', ['POST /soc (feed updates)', 'GET /feeds/{owner}/{topic}'], async () => {
  const signer = new PrivateKey(randomBytes(32))
  const owner = signer.publicKey().address()
  const topic = Topic.fromString(`freedom-community/s7/${randomBytes(6).toString('hex')}`)
  const writer = bee.feed.makeWriter(topic, signer)
  const reader = bee.feed.makeReader(topic, owner)
  const lat = []
  for (let i = 0; i < 3; i++) {
    const payload = `update ${i} ${randomBytes(4).toString('hex')}`
    const t0 = performance.now()
    await writer.uploadPayload(THROWAWAY, payload)
    const writeMs = ms(t0)
    const [got, readMs] = await until(async () => {
      const r = await reader.downloadPayload()
      return r.payload.toUtf8() === payload ? r : null
    }, 60_000, 500)
    if (!got) throw new Error(`update ${i} not visible as latest within 60 s`)
    lat.push({ index: Number(got.feedIndex.toBigInt()), writeMs, visibleAfterMs: readMs })
  }
  return { owner: owner.toHex(), topic: topic.toHex(), updates: lat }
})

await check('feed manifest resolves through /bzz', ['POST /feeds/{owner}/{topic}', 'GET /bzz/{feed manifest}/'], async () => {
  const signer = new PrivateKey(randomBytes(32))
  const owner = signer.publicKey().address()
  const topic = Topic.fromString(`freedom-community/s7-manifest/${randomBytes(6).toString('hex')}`)
  const body = `feed target ${randomBytes(6).toString('hex')}`
  const file = await bee.file.upload(THROWAWAY, body, 'target.txt', { contentType: 'text/plain' })
  await bee.feed.makeWriter(topic, signer).uploadReference(THROWAWAY, file.reference)
  const manifest = await bee.feed.createManifest(THROWAWAY, topic, owner)
  const [text, readMs] = await until(async () => {
    const r = await fetch(`${BEE_URL}/bzz/${manifest.toHex()}/`)
    const t = await r.text()
    return r.ok && t === body ? t : null
  }, 60_000, 1000)
  if (!text) throw new Error('feed manifest did not resolve to the target within 60 s')
  return { manifest: manifest.toHex(), resolvedAfterMs: readMs }
})

// ---------- steward-specific ----------
await check('stewardship: retrievable check + re-stamp on the community batch', ['GET /stewardship/{ref}', 'PUT /stewardship/{ref}'], async () => {
  const before = await bee.data.isRetrievable(dataRef)
  const t0 = performance.now()
  await bee.pin.reuploadData(COMMUNITY, dataRef)
  const putMs = ms(t0)
  const after = await bee.data.isRetrievable(dataRef)
  return { reference: dataRef.toHex(), retrievableBefore: before, reuploadMs: putMs, retrievableAfter: after }
})

await check('envelope: pre-signed stamp, then upload with it', ['POST /envelope/{address}', 'POST /chunks (swarm-postage-stamp)'], async () => {
  const chunk = bee.makeContentAddressedChunk(randomBytes(300))
  const env = await bee.createEnvelope(COMMUNITY, chunk.address)
  const r = await bee.chunk.upload(env, chunk)
  const back = await bee.chunk.download(r.reference)
  if (!eq(back, chunk.data)) throw new Error('chunk uploaded with envelope differs')
  return { issuer: env.issuer.toHex(), index: Buffer.from(env.index).toString('hex'), reference: r.reference.toHex() }
})

await check('GSOC: subscribe, send, receive', ['GET /gsoc/subscribe/{address} (websocket)', 'POST /soc (gsoc)'], async () => {
  const id = Identifier.fromString(`freedom-community/s7-gsoc/${randomBytes(6).toString('hex')}`)
  const signer = bee.messaging.gsocMine(addresses.overlay, id, 8)
  const owner = signer.publicKey().address()
  const msg = `ding ${randomBytes(6).toString('hex')}`
  let received = null
  let error = null
  const sub = bee.messaging.gsocSubscribe(owner, id, {
    onMessage: (m) => { received = { text: new Bytes(m).toUtf8(), at: performance.now() } },
    onError: (e) => { error = String(e?.message || e) },
    onClose: () => {},
  })
  await sleep(3000) // let the websocket and the node's watch settle
  const t0 = performance.now()
  await bee.messaging.gsocSend(THROWAWAY, signer, id, msg)
  const [got] = await until(() => received, 90_000, 250)
  sub.cancel()
  if (error && !got) throw new Error(`subscription error: ${error}`)
  if (!got) throw new Error('no GSOC message within 90 s')
  if (got.text !== msg) throw new Error(`wrong message: ${got.text}`)
  return { address: bee.calculateSingleOwnerChunkAddress(id, owner).toHex(), deliveryMs: Math.round(got.at - t0) }
})

await check('ACT grantee list create + read', ['POST /grantee', 'GET /grantee/{ref}'], async () => {
  const r = await bee.grantee.create(COMMUNITY, [addresses.publicKey])
  const back = await bee.grantee.get(r.ref)
  return { ref: r.ref.toHex(), grantees: back.grantees.length }
})

await check('pins add / list / remove', ['POST /pins/{ref}', 'GET /pins', 'DELETE /pins/{ref}'], async () => {
  await bee.pin.add(dataRef)
  const all = await bee.pin.getAll()
  const listed = all.some((r) => r.toHex() === dataRef.toHex())
  await bee.pin.remove(dataRef)
  if (!listed) throw new Error('pinned reference not listed')
  return { listed }
})

await check('tags create / get', ['POST /tags', 'GET /tags/{uid}'], async () => {
  const t = await bee.tag.create()
  const back = await bee.tag.get(t.uid)
  return { uid: t.uid, split: back.split }
})

await check('stamps read: list, one, buckets, chain state', ['GET /stamps', 'GET /stamps/{id}', 'GET /stamps/{id}/buckets', 'GET /chainstate'], async () => {
  const s = await getJson(`/stamps/${COMMUNITY}`)
  const b = await getJson(`/stamps/${COMMUNITY}/buckets`)
  const c = await getJson('/chainstate')
  return { communityUtilization: s.utilization, communityTtlDays: +(s.batchTTL / 86400).toFixed(1), buckets: b.buckets?.length, price: c.currentPrice }
})

if (process.env.MUTATE_STAMPS === '1') {
  await check('stamps top-up (1 PLUR/chunk) on the throwaway batch', ['PATCH /stamps/topup/{id}/{amount}'], async () => {
    const before = await getJson(`/stamps/${THROWAWAY}`)
    await bee.stamp.topUp(THROWAWAY, '1')
    const [after] = await until(async () => {
      const s = await getJson(`/stamps/${THROWAWAY}`)
      return BigInt(s.amount) > BigInt(before.amount) ? s : null
    }, 60_000, 2000)
    if (!after) throw new Error('amount did not increase within 60 s')
    return { amountBefore: before.amount, amountAfter: after.amount }
  })
  await check('stamps dilute (+1 depth) on the throwaway batch', ['PATCH /stamps/dilute/{id}/{depth}'], async () => {
    const before = await getJson(`/stamps/${THROWAWAY}`)
    await bee.stamp.dilute(THROWAWAY, before.depth + 1)
    const [after] = await until(async () => {
      const s = await getJson(`/stamps/${THROWAWAY}`)
      return s.depth > before.depth ? s : null
    }, 60_000, 2000)
    if (!after) throw new Error('depth did not increase within 60 s')
    return { depthBefore: before.depth, depthAfter: after.depth, ttlDaysBefore: +(before.batchTTL / 86400).toFixed(2), ttlDaysAfter: +(after.batchTTL / 86400).toFixed(2) }
  })
}

const out = { at: new Date().toISOString(), node: health.version, apiVersion: health.apiVersion, beeJs: '13.2.0', results }
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'results.json'), JSON.stringify(out, null, 2) + '\n')
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
