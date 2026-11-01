// Buy a storage plan in a Freedom test profile the way a user does: Freedom quotes
// the plan in xDAI, the node wallet is funded, and the node swaps, buys and
// registers the batch. FUND_SCRIPT (optional) is called as
// `node $FUND_SCRIPT send-xdai <nodeWallet> <amount>` once the quote is known.
//
//   FREEDOM_EXE=... PROFILES_DIR=... SECRETS=... [FUND_SCRIPT=...] node buy-plan.mjs <profile> [starter|advanced|plus]
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, waitAntRunning, ensureUnlocked, profileInfo, sleep } from './driver.mjs'

const [name, planId = 'starter'] = process.argv.slice(2)
const exe = process.env.FREEDOM_EXE
const dir = process.env.PROFILES_DIR || '/root/freedom-test/profiles'
const secrets = JSON.parse(readFileSync(process.env.SECRETS, 'utf8'))
if (!exe || !name || !secrets[name]) throw new Error('usage: buy-plan.mjs <profile> [plan] (profile must exist in SECRETS)')
const profileDir = join(dir, name)
const t = () => new Date().toISOString().slice(11, 19)

const app = await launch({ exe, profileDir, logFile: join(dir, `${name}.log`) })
try {
  await waitAntRunning(app.win)
  await ensureUnlocked(app.win, secrets[name].password)
  const armed = await app.win.evaluate((p) => window.publishSetup.arm({ kind: 'buy', planId: p }), planId)
  if (armed && armed.ok === false) throw new Error(`arm refused: ${armed.error}`)
  console.log(t(), `armed ${planId}`)
  let funded = false
  let lastPhase = null
  const deadline = Date.now() + 25 * 60_000
  for (;;) {
    const st = await app.win.evaluate(() => window.publishSetup.getState())
    const op = st?.operation
    const phase = op?.phase || null
    if (phase !== lastPhase) {
      console.log(t(), 'phase', phase, op?.quote ? JSON.stringify({ send: op.quote.send?.display, price: op.quote.price?.display, wallet: op.quote.walletAddress, sufficient: op.quote.sufficientFunds, depositXbzz: op.quote.depositXbzz }) : '', op?.notice ? JSON.stringify(op.notice) : '', op?.error || '')
      lastPhase = phase
    }
    if (op?.quote && !op.quote.sufficientFunds && !funded && process.env.FUND_SCRIPT) {
      const out = execFileSync('node', [process.env.FUND_SCRIPT, 'send-xdai', op.quote.walletAddress, String(op.quote.send.display)], { encoding: 'utf8' })
      console.log(t(), 'funded:', out.trim().split('\n')[0])
      funded = true
    }
    if (st?.stamps?.usable > 0 && (!op || ['done', 'complete', 'completed'].includes(phase))) break
    if (phase === 'failed' || op?.error) throw new Error(`plan purchase failed: ${op?.error || JSON.stringify(op?.notice)}`)
    if (Date.now() > deadline) throw new Error('timed out after 25 min')
    await sleep(3000)
  }
  const info = await profileInfo(app.win, profileDir)
  console.log(JSON.stringify({ name, plan: planId, nodeBalances: info.nodeBalances, stamps: info.stamps }))
} finally {
  await app.quit()
}
