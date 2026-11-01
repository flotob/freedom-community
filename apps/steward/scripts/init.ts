// Create a community: steward key (if missing), the app's stable origin (a feed manifest
// owned by the steward), the first owner's key, and genesis.json.
//   BEE_URL BATCH STEWARD_KEY_FILE OWNER_KEY_FILE COMMUNITY (community.json) OUT (genesis.json)
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { communityId, keccakHex, PROTOCOL } from '@freedom-community/protocol'
import { Swarm } from '../src/swarm.ts'

const env = process.env
const need = (k: string) => env[k] ?? (() => { throw new Error(`${k} is required`) })()
const ensureKey = (path: string) => {
  if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString('hex') + '\n', { mode: 0o600 })
  return readFileSync(path, 'utf8').trim()
}
const stewardKey = ensureKey(need('STEWARD_KEY_FILE'))
const ownerKey = ensureKey(need('OWNER_KEY_FILE'))
const swarm = new Swarm(need('BEE_URL'), need('BATCH'), stewardKey)
const owner = new Swarm(need('BEE_URL'), need('BATCH'), ownerKey).owner
const cfg = JSON.parse(readFileSync(need('COMMUNITY'), 'utf8'))
const appTopic = keccakHex(cfg.appTopic)
const appManifest = await swarm.createFeedManifest(appTopic)
const genesis = {
  protocol: PROTOCOL, name: cfg.name, origin: `bzz://${appManifest}`, steward: swarm.owner, createdAt: Date.now(),
  roles: cfg.roles, defaultRoles: cfg.defaultRoles, owners: [owner], badges: cfg.badges, categories: cfg.categories,
  theme: cfg.theme, settings: cfg.settings,
}
writeFileSync(need('OUT'), JSON.stringify(genesis, null, 2) + '\n')
console.log(JSON.stringify({ community: communityId(genesis), steward: swarm.owner, owner, origin: genesis.origin, appTopic }, null, 2))
