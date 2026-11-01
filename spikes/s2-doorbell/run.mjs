// Spike S2: a page in Freedom rings a GSOC doorbell; the steward's antd (a different
// node) receives it. The steward derives the doorbell address from the topic exactly
// as Freedom does (messaging-service.js): identifier = keccak256(topic), signer =
// gsocMine(keccak256('freedom-gsoc-v1:' + topic), identifier, 12).
//   BEE_URL=... BATCH=... FREEDOM_EXE=... PROFILES_DIR=... SECRETS=... PROFILE=member-b [RINGS=5] node run.mjs
import { Bee, Identifier, Bytes } from '@ethersphere/bee-js'
import { Binary } from 'cafe-utility'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch, waitAntRunning, ensureUnlocked, navigate, tabEval, approveManifestSheet, until, sleep } from '../../tools/freedom-driver/driver.mjs'
const here = dirname(fileURLToPath(import.meta.url))
const PROFILE = process.env.PROFILE || 'member-b'
const RINGS = +(process.env.RINGS || 5)
const secrets = JSON.parse(readFileSync(process.env.SECRETS, 'utf8'))
const bee = new Bee(process.env.BEE_URL || 'http://localhost:1733')
const t = () => new Date().toISOString().slice(11, 23)
const utf8 = (s) => new TextEncoder().encode(s)

const topic = `freedom-community/doorbell/s2-${randomBytes(4).toString('hex')}`
const identifier = new Identifier(Binary.keccak256(utf8(topic)))
const signer = bee.messaging.gsocMine(Binary.keccak256(utf8('freedom-gsoc-v1:' + topic)), identifier, 12)
const owner = signer.publicKey().address()
const expectedAddress = bee.calculateSingleOwnerChunkAddress(identifier, owner).toHex()
console.log(t(), 'doorbell', topic, '->', expectedAddress)

const received = []
const sub = bee.messaging.gsocSubscribe(owner, identifier, {
  onMessage: (m) => { received.push({ text: new Bytes(m).toUtf8(), at: Date.now() }); console.log(t(), 'steward received', new Bytes(m).toUtf8()) },
  onError: (e) => console.log(t(), 'subscription error', String(e?.message || e)),
  onClose: () => {},
})

const site = (await bee.collection.uploadFromDirectory(process.env.BATCH, join(here, 'site'), { indexDocument: 'index.html' })).reference.toHex()
const result = { at: new Date().toISOString(), profile: PROFILE, topic, expectedAddress, site: `bzz://${site}/`, rings: [] }
const app = await launch({ exe: process.env.FREEDOM_EXE, profileDir: join(process.env.PROFILES_DIR, PROFILE), logFile: join(process.env.PROFILES_DIR, `${PROFILE}.log`) })
try {
  await waitAntRunning(app.win)
  await ensureUnlocked(app.win, secrets[PROFILE].password)
  await navigate(app.win, `bzz://${site}/`)
  await until(async () => (await tabEval(app.win, 'typeof window.s2')) === 'object', { timeout: 180_000, what: 'S2 page' })
  const connecting = tabEval(app.win, 's2.connect()')
  await approveManifestSheet(app.win)
  await connecting
  for (let i = 0; i < RINGS; i++) {
    const data = JSON.stringify({ v: 0, ring: i, nonce: randomBytes(4).toString('hex') })
    const r = await tabEval(app.win, `s2.ring(${JSON.stringify(topic)}, ${JSON.stringify(data)})`)
    const got = await until(() => received.find((m) => m.text === data), { timeout: 60_000, step: 100, what: `ring ${i}` }).catch(() => null)
    const ring = { i, sendMs: r.sendMs, addressMatches: r.address.replace(/^0x/, '') === expectedAddress, deliveredAfterSendMs: got ? got.at - r.doneAt : null }
    result.rings.push(ring)
    console.log(t(), JSON.stringify(ring))
    await sleep(5000)
  }
} finally {
  sub.cancel()
  await app.quit()
}
writeFileSync(join(here, `results-${PROFILE}.json`), JSON.stringify(result, null, 2) + '\n')
const ok = result.rings.every((r) => r.addressMatches && r.deliveredAfterSendMs !== null)
console.log(ok ? 'S2 PASS' : 'S2 FAIL')
process.exit(ok ? 0 : 1)
