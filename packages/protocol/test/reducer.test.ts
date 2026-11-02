import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce, stateHash, communityId, journalTopic, actionId, canonicalJson, can, type State } from '../src/index.ts'

const OWNER = '0x' + '1'.repeat(40)
const ALICE = '0x' + 'a'.repeat(40)
const BOB = '0x' + 'b'.repeat(40)
const MOD = '0x' + 'c'.repeat(40)
const REF = 'f'.repeat(64)
const HASH = 'e'.repeat(64)

const genesis = {
  protocol: 'freedom-community/v0',
  name: 'Test Commons',
  origin: 'bzz://' + '0'.repeat(64),
  steward: '0x' + '5'.repeat(40),
  createdAt: 1_000,
  roles: [
    { id: 'owner', name: 'Owner', permissions: ['*'] },
    { id: 'member', name: 'Member', permissions: ['post.create', 'comment.create', 'like.set', 'profile.set'] },
    { id: 'moderator', name: 'Moderator', permissions: ['mod.hide'] },
  ],
  defaultRoles: ['member'],
  owners: [OWNER],
  badges: [{ id: 'warden', name: 'Warden', roles: ['moderator'] }, { id: 'crown', name: 'Crown', roles: ['owner'] }],
  categories: [{ id: 'events', name: 'Events' }],
  settings: { public: true },
}
const C = communityId(genesis)

class Journal {
  state: State
  log: { entry: unknown; author: string; index: number; receivedAt: number }[] = []
  idx: Record<string, number> = {}
  t = 2_000
  constructor() { this.state = initialState(genesis) }
  act(author: string, type: string, body: unknown = {}) {
    const index = this.idx[author] ?? 0
    this.idx[author] = index + 1
    const entry = { v: 0, c: C, type, at: this.t, body }
    const ctx = { author, index, receivedAt: this.t++ }
    this.log.push({ entry, ...ctx })
    const r = reduce(this.state, entry, ctx)
    this.state = r.state
    return r.outcome
  }
}

const post = (title = 'Hello') => ({ title, excerpt: 'An excerpt', content: REF, contentHash: HASH, categories: ['events'] })

test('community id and journal topic are deterministic', () => {
  assert.equal(C, communityId(JSON.parse(canonicalJson(genesis))))
  assert.equal(journalTopic('bzz://abc'), journalTopic('bzz://abc'))
  assert.notEqual(journalTopic('bzz://abc'), journalTopic('bzz://abd'))
})

test('join, post, comment, like: happy path with adopt effects', () => {
  const j = new Journal()
  assert.deepEqual(j.act(ALICE, 'member.join', { profile: { name: 'Alice' } }), { ok: true, id: actionId(ALICE, 0), effects: [] })
  const p = j.act(ALICE, 'post.create', post())
  assert.equal(p.ok, true)
  assert.deepEqual(p.ok && p.effects, [{ kind: 'adopt', ref: REF }])
  j.act(BOB, 'member.join')
  assert.equal(j.act(BOB, 'comment.create', { post: p.id, text: 'Nice!' }).ok, true)
  assert.equal(j.act(BOB, 'like.set', { target: p.id, on: true }).ok, true)
  assert.equal(j.act(BOB, 'like.set', { target: p.id, on: true }).ok, true) // idempotent
  const s = j.state.posts[p.id]
  assert.deepEqual(s.likes, [BOB])
  assert.equal(s.comments.length, 1)
  j.act(BOB, 'like.set', { target: p.id, on: false })
  assert.deepEqual(j.state.posts[p.id].likes, [])
})

test('rejections carry reasons and still advance seq', () => {
  const j = new Journal()
  assert.deepEqual(j.act(ALICE, 'post.create', post()), { ok: false, id: actionId(ALICE, 0), reason: 'not-member' })
  j.act(ALICE, 'member.join')
  assert.equal((j.act(ALICE, 'member.join') as { reason: string }).reason, 'already-member')
  assert.equal((j.act(ALICE, 'post.create', { ...post(), categories: ['nope'] }) as { reason: string }).reason, 'unknown-category')
  assert.equal((j.act(ALICE, 'post.create', { excerpt: 'x' }) as { reason: string }).reason.startsWith('invalid-body'), true)
  assert.equal((j.act(ALICE, 'mod.hide', { target: actionId(ALICE, 0), reason: 'x' }) as { reason: string }).reason, 'not-permitted')
  assert.equal((j.act(ALICE, 'teleport') as { reason: string }).reason, 'unknown-action')
  const wrong = reduce(j.state, { v: 0, c: '0'.repeat(16), type: 'profile.set', at: 1, body: {} }, { author: ALICE, index: 99, receivedAt: 1 })
  assert.equal((wrong.outcome as { reason: string }).reason, 'wrong-community')
  assert.equal(j.state.seq, 7)
})

test('a badge carrying a role grants its permissions; revoking it takes them away', () => {
  const j = new Journal()
  j.act(ALICE, 'member.join')
  j.act(MOD, 'member.join')
  const p = j.act(ALICE, 'post.create', post())
  assert.equal(can(j.state, MOD, 'mod.hide'), false)
  assert.equal(j.act(OWNER, 'badge.grant', { member: MOD, badge: 'warden' }).ok, true)
  assert.equal(can(j.state, MOD, 'mod.hide'), true)
  assert.equal(j.act(MOD, 'mod.hide', { target: p.id, reason: 'off-topic' }).ok, true)
  assert.equal(j.state.posts[p.id].status, 'hidden')
  assert.equal(j.state.posts[p.id].hiddenReason, 'off-topic')
  j.act(OWNER, 'badge.revoke', { member: MOD, badge: 'warden' })
  assert.equal(can(j.state, MOD, 'mod.hide'), false)
})

test('position reach: owners grant owner roles and owner badges; no one revokes an owner (davinci: once owner, always owner)', () => {
  const j = new Journal()
  j.act(ALICE, 'member.join')
  j.act(BOB, 'member.join')
  assert.equal(j.act(OWNER, 'role.grant', { member: ALICE, role: 'moderator' }).ok, true)
  // revoking reaches strictly weaker positions only: not even an owner revokes the owner role
  assert.equal((j.act(OWNER, 'role.revoke', { member: OWNER, role: 'owner' }) as { reason: string }).reason, 'out-of-reach')
  assert.equal(j.act(OWNER, 'badge.grant', { member: ALICE, badge: 'crown' }).ok, true)
  assert.equal(can(j.state, ALICE, 'community.manage'), true)
  // Alice now holds position 0 through the badge: she may grant the owner role too
  assert.equal(j.act(ALICE, 'role.grant', { member: BOB, role: 'owner' }).ok, true)
  assert.equal((j.act(ALICE, 'role.revoke', { member: BOB, role: 'owner' }) as { reason: string }).reason, 'out-of-reach')
})

test('position reach: a moderator-level role manager grants only weaker roles and badges', () => {
  const j = new Journal()
  for (const m of [ALICE, BOB]) j.act(m, 'member.join')
  const roles = [
    { id: 'owner', name: 'Owner', permissions: ['*'] },
    { id: 'admin', name: 'Admin', permissions: ['role.manage', 'badge.manage'] },
    { id: 'moderator', name: 'Moderator', permissions: ['mod.hide'] },
    { id: 'member', name: 'Member', permissions: ['post.create'] },
  ]
  const badges = [{ id: 'warden', name: 'Warden', roles: ['moderator'] }, { id: 'steward', name: 'Steward', roles: ['admin'] }]
  assert.equal(j.act(OWNER, 'community.update', { roles, badges }).ok, true)
  assert.equal(j.act(OWNER, 'role.grant', { member: ALICE, role: 'admin' }).ok, true)
  // an admin (position 1) grants moderator (2) but not admin (1) or owner (0)
  assert.equal(j.act(ALICE, 'role.grant', { member: BOB, role: 'moderator' }).ok, true)
  assert.equal((j.act(ALICE, 'role.grant', { member: BOB, role: 'admin' }) as { reason: string }).reason, 'out-of-reach')
  assert.equal((j.act(ALICE, 'role.grant', { member: BOB, role: 'owner' }) as { reason: string }).reason, 'out-of-reach')
  // badges carrying roles follow their roles' positions
  assert.equal(j.act(ALICE, 'badge.grant', { member: BOB, badge: 'warden' }).ok, true)
  assert.equal((j.act(ALICE, 'badge.grant', { member: BOB, badge: 'steward' }) as { reason: string }).reason, 'out-of-reach')
  // and she can't demote her own peer level either
  assert.equal(j.act(OWNER, 'role.grant', { member: BOB, role: 'admin' }).ok, true)
  assert.equal((j.act(ALICE, 'role.revoke', { member: BOB, role: 'admin' }) as { reason: string }).reason, 'out-of-reach')
  assert.equal(j.act(ALICE, 'role.revoke', { member: BOB, role: 'moderator' }).ok, true)
})

test('authors edit and withdraw their own posts only', () => {
  const j = new Journal()
  j.act(ALICE, 'member.join')
  j.act(BOB, 'member.join')
  const p = j.act(ALICE, 'post.create', post())
  assert.equal((j.act(BOB, 'post.edit', { post: p.id, title: 'mine now' }) as { reason: string }).reason, 'not-author')
  assert.equal((j.act(ALICE, 'post.edit', { post: p.id, content: REF }) as { reason: string }).reason, 'content-needs-hash')
  assert.equal(j.act(ALICE, 'post.edit', { post: p.id, title: 'Hello again' }).ok, true)
  assert.equal(j.state.posts[p.id].title, 'Hello again')
  assert.equal(j.act(ALICE, 'post.withdraw', { post: p.id }).ok, true)
  assert.equal((j.act(BOB, 'comment.create', { post: p.id, text: 'late' }) as { reason: string }).reason, 'unknown-target')
})

test('replaying the same log reaches the same state hash; any change diverges', () => {
  const j = new Journal()
  j.act(ALICE, 'member.join', { profile: { name: 'Alice' } })
  const p = j.act(ALICE, 'post.create', post())
  j.act(BOB, 'member.join')
  j.act(BOB, 'like.set', { target: p.id, on: true })
  j.act(OWNER, 'community.update', { name: 'Renamed', theme: { primary: '#123456' } })
  const replay = (log: typeof j.log) => log.reduce((s, e) => reduce(s, e.entry, e).state, initialState(genesis))
  assert.equal(stateHash(replay(j.log)), stateHash(j.state))
  const tampered = j.log.map((e, i) => (i === 3 ? { ...e, author: ALICE } : e))
  assert.notEqual(stateHash(replay(tampered)), stateHash(j.state))
})
