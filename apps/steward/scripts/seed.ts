// Seed a community with made-up members: each writes journal entries from Node in the
// exact format Freedom's swarm_writeFeedEntry produces (raw JSON payload, sequence feed,
// topic keccak256("<origin>/journal")), uploads post bodies as files, and rings the doorbell.
//   BEE_URL BATCH GENESIS KEYS (json file, created if missing) [OWNER_KEY_FILE]
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { communityId, doorbellTopic, journalTopic, sha256Hex, actionId } from '@freedom-community/protocol'
import { Swarm } from '../src/swarm.ts'
import { viewTopic } from '../src/views.ts'

const env = process.env
const need = (k: string) => env[k] ?? (() => { throw new Error(`${k} is required`) })()
const genesis = JSON.parse(readFileSync(need('GENESIS'), 'utf8'))
const C = communityId(genesis)
const topic = journalTopic(genesis.origin)
const keysPath = need('KEYS')
const keys: Record<string, string> = existsSync(keysPath) ? JSON.parse(readFileSync(keysPath, 'utf8')) : {}
for (const n of ['alice', 'bob', 'carla', 'dmitri']) keys[n] ??= randomBytes(32).toString('hex')
writeFileSync(keysPath, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 })
if (env.OWNER_KEY_FILE) keys.owner = readFileSync(env.OWNER_KEY_FILE, 'utf8').trim()
const sleep = (n: number) => new Promise((r) => setTimeout(r, n))

class Member {
  swarm: Swarm
  name: string
  next = 0
  constructor(name: string, key: string) { this.name = name; this.swarm = new Swarm(need('BEE_URL'), need('BATCH'), key) }
  get id() { return this.swarm.owner }
  async init() {
    // continue after the last entry this member already wrote
    while (await this.swarm.readJournal(this.id, topic, this.next)) this.next++
    return this
  }
  async act(type: string, body: unknown = {}) {
    const index = this.next++
    const entry = { v: 0, c: C, type, at: Date.now(), body }
    await this.swarm.writeFeedPayload(topic, index, JSON.stringify(entry))
    await this.swarm.ringDoorbell(doorbellTopic(C), JSON.stringify({ owner: this.id, index })).catch(() => {})
    console.log(`${this.name} #${index} ${type}`)
    return actionId(this.id, index)
  }
  async publish(markdown: string, name = 'post.md') {
    const r = await this.swarm.bee.file.upload(need('BATCH'), markdown, name, { contentType: 'text/markdown' })
    return { content: r.reference.toHex(), contentHash: sha256Hex(markdown) }
  }
  async post(title: string, markdown: string, categories: string[]) {
    const excerpt = markdown.replace(/[#*_>`]/g, '').trim().slice(0, 240)
    return this.act('post.create', { title, excerpt, categories, ...(await this.publish(markdown)) })
  }
}

const m = Object.fromEntries(await Promise.all(Object.entries(keys).map(async ([n, k]) => [n, await new Member(n, k).init()]))) as Record<string, Member>
// Resume: journals exist. Re-ring for members the steward hasn't admitted yet (doorbell
// rings can be lost), then make sure the owner's badge grants landed.
if (Object.values(m).some((x) => x.next > 0)) {
  const membersView = async () => (await m.alice.swarm.readFeedJson<{ members: { owner: string; badges: string[] }[] }>(genesis.steward, viewTopic(C, 'members')))?.members ?? []
  for (let round = 0; round < 20; round++) {
    const present = new Set((await membersView()).map((x) => x.owner))
    const missing = Object.values(m).filter((x) => x.next > 0 && !present.has(x.id) && x.name !== 'owner')
    if (!missing.length) break
    console.log(`waiting for ${missing.map((x) => x.name).join(', ')} to be admitted (round ${round})`)
    for (const x of missing) await x.swarm.ringDoorbell(doorbellTopic(C), JSON.stringify({ owner: x.id, index: x.next - 1 })).catch(() => {})
    await sleep(15_000)
  }
  if (m.owner) {
    const view = await membersView()
    const has = (who: Member, badge: string) => view.find((x) => x.owner === who.id)?.badges.includes(badge)
    for (const [who, badge] of [[m.alice, 'founding'], [m.bob, 'founding'], [m.carla, 'warden']] as [Member, string][]) {
      if (!has(who, badge)) await m.owner.act('badge.grant', { member: who.id, badge })
    }
  }
  // Carla's first hide came before she was a warden (rejected); now she holds the badge.
  const spam = actionId(m.dmitri.id, 1)
  const home = await m.alice.swarm.readFeedJson<{ posts: { id: string }[] }>(genesis.steward, viewTopic(C, 'home/0'))
  if (home?.posts.some((p) => p.id === spam)) {
    await sleep(20_000) // let the badge grant land first
    await m.carla.act('mod.hide', { target: spam, reason: 'Advertising, not about owls.' })
  }
  console.log('resume done')
  process.exit(0)
}
const { alice, bob, carla, dmitri, owner } = m
console.log(JSON.stringify(Object.fromEntries(Object.entries(m).map(([n, x]) => [n, x.id]))))

if (owner) await owner.act('profile.set', { name: 'Ruth Lindqvist', bio: 'Started the collective to map every owl in the valley.' })
await alice.act('member.join', { profile: { name: 'Mira Aalto', bio: 'Dawn walker, sound recordist.' } })
await bob.act('member.join', { profile: { name: 'Jonas Weber', bio: 'Builds nest boxes.' } })
await carla.act('member.join', { profile: { name: 'Sofia Rossi', bio: 'Night shift at the library.' } })
await dmitri.act('member.join', { profile: { name: 'Dmitri Volkov' } })
const walk = await alice.post('Dawn chorus walk on Saturday', '## Dawn chorus walk\n\nMeeting at the **old oak by the north gate** at 5:30. Bring a thermos; we will log every call we hear and post the list here afterwards.\n\n- tawny owl\n- robin\n- wren', ['events'])
const boxes = await bob.post('Nest box map, version 2', 'Sixteen boxes now, three of them occupied. The map has coordinates and the date each box went up.\n\n| Box | Status |\n|---|---|\n| N-03 | occupied |\n| N-07 | occupied |\n| S-11 | occupied |', ['projects'])
const duet = await carla.post('Tawny owl duet behind the library', 'Heard a tawny owl pair duetting behind the library at 22:40. First time this autumn!', ['sightings'])
const spam = await dmitri.post('Cheap binoculars!!!', 'Buy now at a site you have never heard of.', [])
await bob.act('comment.create', { post: walk, text: 'Count me in, I will bring the spare recorder.' })
await carla.act('comment.create', { post: walk, text: 'Is the gate open that early?' })
await alice.act('comment.create', { post: walk, text: 'Yes, the warden opens it at 5.' })
for (const who of [bob, carla, dmitri]) await who.act('like.set', { target: walk, on: true })
for (const who of [alice, carla]) await who.act('like.set', { target: boxes, on: true })
await alice.act('like.set', { target: duet, on: true })
await bob.act('mod.hide', { target: spam, reason: 'spam' }) // rejected: Bob is not a moderator
if (owner) {
  await owner.act('badge.grant', { member: alice.id, badge: 'founding' })
  await owner.act('badge.grant', { member: bob.id, badge: 'founding' })
  await owner.act('badge.grant', { member: carla.id, badge: 'warden' })
}
await sleep(3000)
await carla.act('mod.hide', { target: spam, reason: 'Advertising, not about owls.' }) // accepted: Warden carries Moderator
await alice.act('profile.set', { bio: 'Dawn walker, sound recordist. Ask me about spectrograms.' })
console.log('seeded')
