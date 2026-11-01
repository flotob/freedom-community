// Spike S2 (node-only prelude): GSOC delivery through a single antd node.
// Subscribe, wait WARMUP_S seconds for antd's lurker to start pulling the target
// neighbourhood, then send PINGS messages INTERVAL_S apart and measure delivery.
//
//   BEE_URL=http://localhost:1733 BATCH=<id> [WARMUP_S=90] [PINGS=5] [INTERVAL_S=15] node gsoc-node.mjs
import { Bee, Identifier, Bytes } from '@ethersphere/bee-js'
import { randomBytes } from 'node:crypto'

const BEE_URL = process.env.BEE_URL || 'http://localhost:1733'
const BATCH = process.env.BATCH
const WARMUP_S = +(process.env.WARMUP_S || 90)
const PINGS = +(process.env.PINGS || 5)
const INTERVAL_S = +(process.env.INTERVAL_S || 15)
if (!BATCH) throw new Error('set BATCH')
const bee = new Bee(BEE_URL)
const sleep = (n) => new Promise((r) => setTimeout(r, n))
const t = () => new Date().toISOString().slice(11, 23)

const overlay = (await (await fetch(`${BEE_URL}/addresses`)).json()).overlay
const id = Identifier.fromString(`freedom-community/s2-gsoc/${randomBytes(6).toString('hex')}`)
const signer = bee.messaging.gsocMine(overlay, id, 8)
const owner = signer.publicKey().address()
const address = bee.calculateSingleOwnerChunkAddress(id, owner).toHex()
console.log(t(), 'watching GSOC address', address)

const sent = new Map()
const got = []
const sub = bee.messaging.gsocSubscribe(owner, id, {
  onMessage: (m) => {
    const text = new Bytes(m).toUtf8()
    const s = sent.get(text)
    got.push({ text, latencyMs: s ? Math.round(performance.now() - s) : null })
    console.log(t(), 'received', JSON.stringify(text), s ? `${Math.round(performance.now() - s)} ms after send` : '(unknown)')
  },
  onError: (e) => console.log(t(), 'subscription error', String(e?.message || e)),
  onClose: () => console.log(t(), 'subscription closed'),
})

console.log(t(), `warm-up ${WARMUP_S} s`)
await sleep(WARMUP_S * 1000)
for (let i = 0; i < PINGS; i++) {
  const text = `ding ${i} ${randomBytes(4).toString('hex')}`
  const t0 = performance.now()
  try {
    await bee.messaging.gsocSend(BATCH, signer, id, text)
    sent.set(text, t0)
    console.log(t(), 'sent', JSON.stringify(text), `(${Math.round(performance.now() - t0)} ms upload)`)
  } catch (e) {
    console.log(t(), 'send failed', String(e?.message || e))
  }
  await sleep(INTERVAL_S * 1000)
}
await sleep(60_000)
sub.cancel()
const lat = got.filter((g) => g.latencyMs !== null).map((g) => g.latencyMs).sort((a, b) => a - b)
console.log(JSON.stringify({ address, warmupS: WARMUP_S, sent: sent.size, received: got.length, latenciesMs: lat }))
process.exit(0)
