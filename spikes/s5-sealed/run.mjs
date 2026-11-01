// Spike S5 runner: the page in Freedom seals answers; Node opens them. Also checks tamper detection.
//   BEE_URL=... BATCH=... FREEDOM_EXE=... PROFILES_DIR=... SECRETS=... PROFILE=member-a node run.mjs
import { Bee } from '@ethersphere/bee-js'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch, waitAntRunning, ensureUnlocked, navigate, tabEval, until } from '../../tools/freedom-driver/driver.mjs'
import { stewardKeypair, open } from './open.mjs'
const here = dirname(fileURLToPath(import.meta.url))
const PROFILE = process.env.PROFILE || 'member-a'
const secrets = JSON.parse(readFileSync(process.env.SECRETS, 'utf8'))
const bee = new Bee(process.env.BEE_URL || 'http://localhost:1733')
const site = (await bee.collection.uploadFromDirectory(process.env.BATCH, join(here, 'site'), { indexDocument: 'index.html' })).reference.toHex()
const steward = stewardKeypair()
const app = await launch({ exe: process.env.FREEDOM_EXE, profileDir: join(process.env.PROFILES_DIR, PROFILE), logFile: join(process.env.PROFILES_DIR, `${PROFILE}.log`) })
const result = { at: new Date().toISOString(), site: `bzz://${site}/`, cases: [] }
try {
  await waitAntRunning(app.win)
  await ensureUnlocked(app.win, secrets[PROFILE].password)
  await navigate(app.win, `bzz://${site}/`)
  await until(async () => (await tabEval(app.win, 'typeof window.s5')) === 'object', { timeout: 180_000, what: 'S5 page' })
  result.env = await tabEval(app.win, 's5.env()')
  console.log('page env', JSON.stringify(result.env))
  for (const answer of ['42', 'the answer is ünïcödé ✓', 'x'.repeat(2000)]) {
    const aad = `quest:q1|member:0x26a0b77e303e64c947a5781708eec04912a907d6|${Date.now()}`
    const sealed = await tabEval(app.win, `s5.seal(${JSON.stringify(steward.publicRawB64)}, ${JSON.stringify(answer)}, ${JSON.stringify(aad)})`)
    const opened = open(sealed, steward.privateKey, steward.publicRawB64)
    let tamperRejected = false
    try { open({ ...sealed, aad: sealed.aad + 'x' }, steward.privateKey, steward.publicRawB64) } catch { tamperRejected = true }
    const c = { answerBytes: Buffer.byteLength(answer), sealedJsonBytes: JSON.stringify(sealed).length, roundTrip: opened === answer, tamperRejected }
    result.cases.push(c)
    console.log(JSON.stringify(c))
  }
} finally {
  await app.quit()
}
writeFileSync(join(here, 'results.json'), JSON.stringify(result, null, 2) + '\n')
const ok = result.env?.subtle && result.cases.every((c) => c.roundTrip && c.tamperRejected)
console.log(ok ? 'S5 PASS' : 'S5 FAIL')
process.exit(ok ? 0 : 1)
