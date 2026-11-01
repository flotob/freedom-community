// Spike S1: journal round trip.
// A page in Freedom Browser writes journal entries to a feed (window.swarm); a Node
// process reads them back through a *different* Swarm node (the steward's antd) and
// checks topic derivation and SOC structure independently.
//
//   BEE_URL=http://localhost:1733 BATCH=<id for the site upload> \
//   FREEDOM_EXE=... PROFILES_DIR=... SECRETS=... PROFILE=member-a [ENTRIES=5] node run.mjs
import { Bee, Topic, Identifier, Bytes } from '@ethersphere/bee-js'
import { Binary } from 'cafe-utility'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch, waitAntRunning, ensureUnlocked, navigate, tabEval, tabUrl, approveManifestSheet, until, sleep } from '../../tools/freedom-driver/driver.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const BEE_URL = process.env.BEE_URL || 'http://localhost:1733'
const BATCH = process.env.BATCH
const PROFILE = process.env.PROFILE || 'member-a'
const ENTRIES = +(process.env.ENTRIES || 5)
const FEED = 'journal'
const secrets = JSON.parse(readFileSync(process.env.SECRETS, 'utf8'))
const bee = new Bee(BEE_URL)
const t = () => new Date().toISOString().slice(11, 23)
const result = { at: new Date().toISOString(), profile: PROFILE, freedom: '0.8.8', steps: {} }

// 1. Deploy the test site through the steward's node.
const site = await bee.collection.uploadFromDirectory(BATCH, join(here, 'site'), { indexDocument: 'index.html' })
const siteRef = site.reference.toHex()
const url = `bzz://${siteRef}/`
console.log(t(), 'site', url)
result.site = url

const app = await launch({ exe: process.env.FREEDOM_EXE, profileDir: join(process.env.PROFILES_DIR, PROFILE), logFile: join(process.env.PROFILES_DIR, `${PROFILE}.log`) })
try {
  await waitAntRunning(app.win)
  await ensureUnlocked(app.win, secrets[PROFILE].password)

  // 2. Open the site in Freedom.
  const tOpen = Date.now()
  await navigate(app.win, url)
  await until(async () => (await tabEval(app.win, 'typeof window.s1')) === 'object', { timeout: 180_000, step: 1000, what: 'test page loaded in Freedom' })
  result.steps.pageLoadMs = Date.now() - tOpen
  console.log(t(), `page loaded in ${result.steps.pageLoadMs} ms`, await tabUrl(app.win))
  result.capabilities = await tabEval(app.win, 's1.capabilities()')

  // 3. Connect: one consent sheet from the manifest.
  const connecting = tabEval(app.win, 's1.connect()')
  await approveManifestSheet(app.win)
  result.access = await connecting
  console.log(t(), 'access', JSON.stringify(result.access))

  // 4. Create the journal feed.
  const feed = await tabEval(app.win, `s1.createFeed(${JSON.stringify(FEED)})`)
  result.feed = feed
  console.log(t(), 'feed', JSON.stringify(feed))
  const permissionKey = `bzz://${siteRef}`
  const expectedTopic = Topic.fromString(`${permissionKey}/${FEED}`).toHex()
  result.topicMatches = expectedTopic === String(feed.topic).replace(/^0x/, '').toLowerCase()
  console.log(t(), 'topic derivation matches our shim:', result.topicMatches)

  // 5. Write entries in Freedom, read each back through the steward's node.
  const owner = String(feed.owner).replace(/^0x/, '').toLowerCase()
  const topic = String(feed.topic).replace(/^0x/, '').toLowerCase()
  const reader = bee.feed.makeReader(topic, owner)
  result.entries = []
  for (let i = 0; i < ENTRIES; i++) {
    const w = await tabEval(app.win, `s1.write(${JSON.stringify(FEED)}, ${i})`)
    const t0 = Date.now()
    const got = await until(async () => {
      const r = await reader.downloadPayload({ index: w.index }) // raw payload; download() assumes a timestamp prefix
      return r.payload.toUtf8() === w.entry ? r : null
    }, { timeout: 120_000, step: 500, what: `entry ${i} on the steward node` }).catch((e) => ({ error: e.message }))
    const visibleMs = got.error ? null : Date.now() - t0
    const latest = await until(async () => {
      const r = await reader.downloadPayload()
      return r.payload.toUtf8() === w.entry ? r : null
    }, { timeout: 60_000, step: 500, what: `entry ${i} as latest` }).catch(() => null)
    const latestMs = latest ? Date.now() - t0 : null
    // Independent check of the SOC: identifier = keccak256(topic || uint64be(index)), address = keccak256(id || owner).
    const idx = new Uint8Array(8)
    new DataView(idx.buffer).setBigUint64(0, BigInt(w.index))
    const identifier = new Identifier(Binary.keccak256(Binary.concatBytes(Binary.hexToUint8Array(topic), idx)))
    const soc = await bee.soc.makeReader(owner).download(identifier).catch((e) => ({ error: e.message }))
    const socOk = !soc.error && soc.owner.toHex() === owner
    result.entries.push({ index: w.index, writeMs: w.writeMs, visibleOnStewardMs: visibleMs, latestOnStewardMs: latestMs, socOwnerVerified: socOk, error: got.error || soc.error })
    console.log(t(), `entry ${i}: index ${w.index}, write ${w.writeMs} ms, readable by index on the steward node after ${visibleMs} ms, as latest after ${latestMs} ms, SOC owner verified ${socOk}`)
  }
  // (No swarm_getSigningIdentity here: it is a signing-tier call and would wait on a prompt; the feed result carries identityMode.)
} finally {
  await app.quit()
}

writeFileSync(join(here, `results-${PROFILE}.json`), JSON.stringify(result, null, 2) + '\n')
const ok = result.topicMatches && result.entries.every((e) => e.visibleOnStewardMs !== null && e.socOwnerVerified)
console.log(ok ? 'S1 PASS' : 'S1 FAIL')
process.exit(ok ? 0 : 1)
