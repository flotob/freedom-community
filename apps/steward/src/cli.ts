#!/usr/bin/env node
// steward run    — run the steward for one community
// steward audit  — replay a community's ledger from Swarm and verify it
//
// run:   BEE_URL BATCH STEWARD_KEY_FILE GENESIS (path to genesis.json) [DATA_DIR] [POLL_MS] [CANARY_MS]
// audit: BEE_URL STEWARD (address) COMMUNITY (id)
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { Swarm } from './swarm.ts'
import { Steward } from './steward.ts'
import { audit } from './audit.ts'

const env = process.env
const need = (k: string) => env[k] ?? (() => { throw new Error(`${k} is required`) })()
const cmd = process.argv[2]

if (cmd === 'run') {
  const key = readFileSync(need('STEWARD_KEY_FILE'), 'utf8').trim()
  const swarm = new Swarm(need('BEE_URL'), need('BATCH'), key)
  const genesis = JSON.parse(readFileSync(need('GENESIS'), 'utf8'))
  const steward = new Steward({
    swarm, genesis, dataDir: env.DATA_DIR ?? './steward-data',
    pollMs: Number(env.POLL_MS ?? 30_000), canaryMs: Number(env.CANARY_MS ?? 300_000),
  })
  process.on('SIGTERM', () => { steward.stop(); process.exit(0) })
  process.on('SIGINT', () => { steward.stop(); process.exit(0) })
  await steward.start()
  steward.log(`running: community ${steward.community}, steward ${swarm.owner}, ledger ${steward.ledgerTopic}`)
} else if (cmd === 'audit') {
  const swarm = new Swarm(need('BEE_URL'), env.BATCH ?? '0'.repeat(64), randomBytes(32).toString('hex'))
  const r = await audit(swarm, need('STEWARD'), need('COMMUNITY'), (...a) => console.error(...a))
  const { state, ...summary } = r
  console.log(JSON.stringify({ ...summary, members: state ? Object.keys(state.members).length : 0, posts: state ? Object.keys(state.posts).length : 0 }, null, 2))
  process.exit(r.mismatches.length ? 1 : 0)
} else {
  console.log('usage: steward run | steward audit')
  process.exit(2)
}
