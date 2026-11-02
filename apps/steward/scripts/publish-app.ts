// Publish a built static site at a community's stable origin: upload the directory as a
// Swarm collection, then point the app feed (owner = steward, the feed behind the origin's
// feed manifest) at it. The origin URL never changes; members' app-scoped identities and
// journal topics are derived from it.
// With GENESIS set, the site gets `community.json` (which community it shows) and a matching
// `freedom-manifest.json`, so one app build serves any community.
//   BEE_URL BATCH STEWARD_KEY_FILE APP_TOPIC ("freedom-community/v0/app/<name>") DIR [INDEX=index.html] [GENESIS]
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { communityId, keccakHex } from '@freedom-community/protocol'
import { Swarm } from '../src/swarm.ts'

const env = process.env
const need = (k: string) => env[k] ?? (() => { throw new Error(`${k} is required`) })()
let dir = need('DIR')
if (env.GENESIS) {
  const genesis = JSON.parse(readFileSync(env.GENESIS, 'utf8'))
  const tmp = mkdtempSync(join(tmpdir(), 'site-'))
  cpSync(dir, tmp, { recursive: true })
  writeFileSync(join(tmp, 'community.json'), JSON.stringify({ id: communityId(genesis), steward: genesis.steward.toLowerCase(), origin: genesis.origin, name: genesis.name }, null, 2))
  const manifest = {
    schema: 'freedom-manifest/1',
    name: String(genesis.name).slice(0, 32),
    description: 'A community on Swarm. What you post goes to your own journal; the community\'s steward applies its rules and publishes the result.',
    capabilities: { swarm: {
      publish: { why: 'Upload your posts and longer comments to Swarm, paid from your own storage.' },
      feeds: { why: 'Write your posts, comments and likes to your journal, signed with a key only this community sees.' },
      messaging: { why: 'Ring the community\'s doorbell, so the steward picks up what you did within seconds.' },
    } },
  }
  writeFileSync(join(tmp, 'freedom-manifest.json'), JSON.stringify(manifest, null, 2))
  process.on('exit', () => rmSync(tmp, { recursive: true, force: true }))
  dir = tmp
  console.log(`community ${communityId(genesis)} (${genesis.name})`)
}
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]))
const files = walk(dir)
const maps = files.filter((f) => f.endsWith('.map'))
if (maps.length) throw new Error(`refusing to publish source maps: ${maps.slice(0, 3).join(', ')}`)

const swarm = new Swarm(need('BEE_URL'), need('BATCH'), readFileSync(need('STEWARD_KEY_FILE'), 'utf8').trim())
const topic = keccakHex(need('APP_TOPIC'))
const t0 = Date.now()
const site = await swarm.bee.collection.uploadFromDirectory(need('BATCH'), dir, { indexDocument: env.INDEX ?? 'index.html' })
const ref = site.reference.toHex()
console.log(`site ${ref} (${files.length} files, ${Date.now() - t0} ms)`)
const index = await swarm.nextFeedIndex(topic)
await swarm.bee.feed.makeWriter(topic, swarm.key).uploadReference(need('BATCH'), site.reference, { index })
const manifest = await swarm.createFeedManifest(topic)
console.log(JSON.stringify({ site: `bzz://${ref}/`, feedIndex: index, origin: `bzz://${manifest}/` }, null, 2))
