// Write one action to a member's journal from Node, exactly as Freedom's
// swarm_writeFeedEntry would (raw JSON payload, next free index, topic
// keccak256("<origin>/journal")), and ring the doorbell. For operators and tests:
// e.g. an owner granting a role.
//   BEE_URL BATCH GENESIS KEY_FILE TYPE BODY='{"member":"0x…","role":"moderator"}'
import { readFileSync } from 'node:fs'
import { communityId, doorbellTopic, journalTopic } from '@freedom-community/protocol'
import { Swarm } from '../src/swarm.ts'

const env = process.env
const need = (k: string) => env[k] ?? (() => { throw new Error(`${k} is required`) })()
const genesis = JSON.parse(readFileSync(need('GENESIS'), 'utf8'))
const C = communityId(genesis)
const topic = journalTopic(genesis.origin)
const swarm = new Swarm(need('BEE_URL'), need('BATCH'), readFileSync(need('KEY_FILE'), 'utf8').trim())
let index = 0
while (await swarm.readJournal(swarm.owner, topic, index)) index++
const entry = { v: 0, c: C, type: need('TYPE'), at: Date.now(), body: JSON.parse(need('BODY')) }
await swarm.writeFeedPayload(topic, index, JSON.stringify(entry))
await swarm.ringDoorbell(doorbellTopic(C), JSON.stringify({ owner: swarm.owner, index })).catch(() => {})
console.log(JSON.stringify({ author: swarm.owner, index, action: `${swarm.owner}:${index}`, type: entry.type }))
