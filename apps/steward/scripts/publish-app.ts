// Publish a built static site at a community's stable origin: upload the directory as a
// Swarm collection, then point the app feed (owner = steward, the feed behind the origin's
// feed manifest) at it. The origin URL never changes; members' app-scoped identities and
// journal topics are derived from it.
//   BEE_URL BATCH STEWARD_KEY_FILE APP_TOPIC ("freedom-community/v0/app/<name>") DIR [INDEX=index.html]
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { keccakHex } from '@freedom-community/protocol'
import { Swarm } from '../src/swarm.ts'

const env = process.env
const need = (k: string) => env[k] ?? (() => { throw new Error(`${k} is required`) })()
const dir = need('DIR')
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
