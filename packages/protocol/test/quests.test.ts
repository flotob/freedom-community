// Badges with scores, default badges, leaderboards and quests.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce, stateHash, communityId, type State, type Verdict } from '../src/index.ts'

const OWNER = '0x' + '1'.repeat(40)
const ALICE = '0x' + 'a'.repeat(40)
const BOB = '0x' + 'b'.repeat(40)
const REVIEWER = '0x' + 'c'.repeat(40)
const REF = 'f'.repeat(64)
const SEALED = { v: 0, alg: 'X25519-HKDF-SHA256-A256GCM', epk: 'AAAA', nonce: 'BBBB', ct: 'CCCC', aad: 'x' }

const genesis = {
  protocol: 'freedom-community/v0',
  name: 'Quest Commons',
  origin: 'bzz://' + '0'.repeat(64),
  steward: '0x' + '5'.repeat(40),
  createdAt: 1_000,
  roles: [
    { id: 'owner', name: 'Owner', permissions: ['*'] },
    { id: 'member', name: 'Member', permissions: ['profile.set', 'quest.submit'] },
    { id: 'reviewer', name: 'Reviewer', permissions: ['quest.review'] },
  ],
  defaultRoles: ['member'],
  owners: [OWNER],
  badges: [
    { id: 'explorer', name: 'Explorer', roles: [], default: true, settings: { decal_text: { text: '{value} pts', color: '#ffffff', background_color: null, x: 0.5, y: 0.5, scale: 1 } } },
    { id: 'owl', name: 'Owl expert', roles: [] },
    { id: 'novice', name: 'Novice', roles: [] },
    { id: 'reviewer', name: 'Reviewer badge', roles: ['reviewer'] },
  ],
  settings: { public: true },
}
const C = communityId(genesis)

class Journal {
  state: State
  log: { entry: unknown; author: string; index: number; receivedAt: number; verdict?: Verdict }[] = []
  idx: Record<string, number> = {}
  t = 2_000
  constructor() { this.state = initialState(genesis) }
  act(author: string, type: string, body: unknown = {}, verdict?: Verdict) {
    const index = this.idx[author] ?? 0
    this.idx[author] = index + 1
    const entry = { v: 0, c: C, type, at: this.t, body }
    const ctx = { author, index, receivedAt: this.t++, verdict }
    this.log.push({ entry, ...ctx })
    const r = reduce(this.state, entry, ctx)
    this.state = r.state
    return r.outcome
  }
}

function setup() {
  const j = new Journal()
  for (const m of [ALICE, BOB, REVIEWER]) assert.equal(j.act(m, 'member.join').ok, true)
  assert.equal(j.act(OWNER, 'badge.grant', { member: REVIEWER, badge: 'reviewer' }).ok, true)
  return j
}

test('a default badge is granted on join, with no score until one is set', () => {
  const j = setup()
  assert.deepEqual(j.state.members[ALICE].badges, ['explorer'])
  assert.equal(j.state.members[ALICE].scores, undefined)
  assert.equal(j.act(OWNER, 'badge.score', { member: ALICE, badge: 'owl', score: 5 }).reason, 'not-held')
  assert.equal(j.act(ALICE, 'badge.score', { member: ALICE, badge: 'explorer', score: 99 }).reason, 'not-permitted')
  assert.equal(j.act(OWNER, 'badge.score', { member: ALICE, badge: 'explorer', score: 7 }).ok, true)
  assert.deepEqual(j.state.members[ALICE].scores, { explorer: 7 })
})

test('a disabled badge refuses grants; revoking drops its score', () => {
  const j = setup()
  j.act(OWNER, 'badge.score', { member: ALICE, badge: 'explorer', score: 3 })
  assert.equal(j.act(OWNER, 'badge.revoke', { member: ALICE, badge: 'explorer' }).ok, true)
  assert.deepEqual(j.state.members[ALICE].scores, {})
  const badges = j.state.community.badges.map((b) => (b.id === 'owl' ? { ...b, enabled: false } : b))
  assert.equal(j.act(OWNER, 'community.update', { badges }).ok, true)
  assert.equal(j.act(OWNER, 'badge.grant', { member: ALICE, badge: 'owl' }).reason, 'badge-disabled')
})

test('leaderboards must rank an existing badge', () => {
  const j = setup()
  assert.equal(j.act(OWNER, 'community.update', { leaderboards: [{ id: 'top', name: 'Top', badge: 'nope' }] }).reason, 'unknown-badge')
  assert.equal(j.act(OWNER, 'community.update', { leaderboards: [{ id: 'top', name: 'Top owls', badge: 'explorer' }] }).ok, true)
})

test('a sealed quest: the steward verdict decides, the score lands once, tries are counted', () => {
  const j = setup()
  const create = j.act(OWNER, 'quest.create', { title: 'Which owl?', kind: 'text', secret: SEALED, tries: 2, rewards: [{ badge: 'explorer', score: 10 }, { badge: 'owl' }] })
  assert.equal(create.ok, true)
  const q = create.id
  assert.equal(j.act(ALICE, 'quest.create', { title: 'x', kind: 'text' }).reason, 'not-permitted')
  // wrong answer: rejected, a try used
  assert.equal(j.act(ALICE, 'quest.submit', { quest: q, answer: { sealed: SEALED } }, { approved: false }).ok, true)
  assert.equal(j.state.members[ALICE].scores, undefined)
  // right answer: approved, rewards paid
  const right = j.act(ALICE, 'quest.submit', { quest: q, answer: { sealed: SEALED } }, { approved: true })
  assert.equal(right.ok, true)
  assert.equal(j.state.submissions![right.id].status, 'approved')
  assert.deepEqual(j.state.members[ALICE].scores, { explorer: 10 })
  assert.deepEqual(j.state.members[ALICE].badges, ['explorer', 'owl'])
  // no third submission: already approved (and out of tries)
  assert.equal(j.act(ALICE, 'quest.submit', { quest: q, answer: { sealed: SEALED } }, { approved: true }).reason, 'already-submitted')
  // without a verdict, a sealed answer waits for a reviewer
  const pending = j.act(BOB, 'quest.submit', { quest: q, answer: { sealed: SEALED } })
  assert.equal(j.state.submissions![pending.id].status, 'pending')
})

test('manual review: approve pays, reversing takes the score back, approving again pays once more', () => {
  const j = setup()
  const q = j.act(OWNER, 'quest.create', { title: 'Photo of a pellet', kind: 'upload', rewards: [{ badge: 'explorer', score: 4 }] }).id
  assert.equal(j.act(ALICE, 'quest.submit', { quest: q, answer: { text: 'nope' } }).reason, 'answer-kind')
  const sub = j.act(ALICE, 'quest.submit', { quest: q, answer: { image: REF } }).id
  assert.equal(j.act(BOB, 'quest.review', { submission: sub, decision: 'approved' }).reason, 'not-permitted')
  assert.equal(j.act(REVIEWER, 'quest.review', { submission: sub, decision: 'approved' }).ok, true)
  assert.equal(j.state.members[ALICE].scores!.explorer, 4)
  assert.equal(j.act(REVIEWER, 'quest.review', { submission: sub, decision: 'approved' }).reason, 'unchanged')
  assert.equal(j.act(REVIEWER, 'quest.review', { submission: sub, decision: 'rejected' }).ok, true)
  assert.equal(j.state.members[ALICE].scores!.explorer, 0)
  assert.equal(j.act(REVIEWER, 'quest.review', { submission: sub, decision: 'approved' }).ok, true)
  assert.equal(j.state.members[ALICE].scores!.explorer, 4)
})

test('quest windows, prerequisites, removal rewards and disqualification', () => {
  const j = setup()
  const later = j.act(OWNER, 'quest.create', { title: 'Later', kind: 'text', opensAt: 1e12, autoApprove: true }).id
  assert.equal(j.act(ALICE, 'quest.submit', { quest: later, answer: { text: 'hi' } }).reason, 'quest-not-open')
  const gated = j.act(OWNER, 'quest.create', { title: 'Experts only', kind: 'text', autoApprove: true, prerequisites: [{ badge: 'explorer', min: 5 }], rewards: [{ badge: 'novice', action: 'remove' }] }).id
  assert.equal(j.act(ALICE, 'quest.submit', { quest: gated, answer: { text: 'hi' } }).reason, 'prerequisite-unmet')
  j.act(OWNER, 'badge.grant', { member: ALICE, badge: 'novice' })
  j.act(OWNER, 'badge.score', { member: ALICE, badge: 'explorer', score: 5 })
  assert.equal(j.act(ALICE, 'quest.submit', { quest: gated, answer: { text: 'hi' } }).ok, true)
  assert.equal(j.state.members[ALICE].badges.includes('novice'), false)
  // a disqualified member can't try again; a closed quest takes nothing
  const q = j.act(OWNER, 'quest.create', { title: 'Essay', kind: 'text', tries: 5 }).id
  const sub = j.act(BOB, 'quest.submit', { quest: q, answer: { text: 'copied' } }).id
  j.act(REVIEWER, 'quest.review', { submission: sub, decision: 'disqualified' })
  assert.equal(j.act(BOB, 'quest.submit', { quest: q, answer: { text: 'again' } }).reason, 'disqualified')
  assert.equal(j.act(OWNER, 'quest.update', { quest: q, close: true }).ok, true)
  assert.equal(j.act(ALICE, 'quest.submit', { quest: q, answer: { text: 'late' } }).reason, 'quest-closed')
  assert.equal(j.act(OWNER, 'quest.create', { title: 'Pick', kind: 'mcq', options: ['A', 'a'] }).reason, 'duplicate-options')
})

test('a replay with the recorded verdicts reaches the same state hash', () => {
  const j = setup()
  const q = j.act(OWNER, 'quest.create', { title: 'Which owl?', kind: 'text', secret: SEALED, rewards: [{ badge: 'explorer', score: 10 }] }).id
  j.act(ALICE, 'quest.submit', { quest: q, answer: { sealed: SEALED } }, { approved: true })
  let s = initialState(genesis)
  for (const e of j.log) s = reduce(s, e.entry, { author: e.author, index: e.index, receivedAt: e.receivedAt, verdict: e.verdict }).state
  assert.equal(stateHash(s), stateHash(j.state))
  // without the verdict the replay diverges: the ledger must carry it
  let s2 = initialState(genesis)
  for (const e of j.log) s2 = reduce(s2, e.entry, { author: e.author, index: e.index, receivedAt: e.receivedAt }).state
  assert.notEqual(stateHash(s2), stateHash(j.state))
})

test('replies nest under a comment on the same post, down to depth 4', () => {
  const j = new Journal()
  for (const m of [ALICE, BOB]) j.act(m, 'member.join')
  const roles = [...genesis.roles.map((r) => (r.id === 'member' ? { ...r, permissions: [...r.permissions, 'post.create', 'comment.create'] } : r))]
  assert.equal(j.act(OWNER, 'community.update', { roles }).ok, true)
  const post = j.act(ALICE, 'post.create', { excerpt: 'x', content: REF, contentHash: 'e'.repeat(64), categories: [] }).id
  const other = j.act(ALICE, 'post.create', { excerpt: 'y', content: REF, contentHash: 'e'.repeat(64), categories: [] }).id
  let parent = j.act(BOB, 'comment.create', { post, text: 'top' }).id
  assert.equal(j.state.comments[parent].parent, undefined)
  assert.equal(j.act(BOB, 'comment.create', { post: other, parent, text: 'wrong post' }).reason, 'unknown-target')
  for (let d = 1; d <= 4; d++) parent = j.act(ALICE, 'comment.create', { post, parent, text: `depth ${d}` }).id
  assert.equal(j.state.comments[parent].parent !== undefined, true)
  assert.equal(j.act(BOB, 'comment.create', { post, parent, text: 'depth 5' }).reason, 'too-deep')
})

test('libraries: managers create them, permitted members post into them', () => {
  const j = new Journal()
  j.act(ALICE, 'member.join')
  const roles = genesis.roles.map((r) => (r.id === 'member' ? { ...r, permissions: [...r.permissions, 'post.create'] } : r))
  j.act(OWNER, 'community.update', { roles })
  assert.equal(j.act(ALICE, 'library.create', { name: 'Field guides' }).reason, 'not-permitted')
  const lib = j.act(OWNER, 'library.create', { name: 'Field guides', description: 'Owls by call.', cover: REF }).id
  assert.equal(j.state.libraries![lib].name, 'Field guides')
  const body = { excerpt: 'x', content: REF, contentHash: 'e'.repeat(64), categories: [], library: lib }
  assert.equal(j.act(ALICE, 'post.create', body).reason, 'not-permitted')
  const ok = j.act(OWNER, 'post.create', body)
  assert.equal(ok.ok, true)
  assert.equal(j.state.posts[ok.id].library, lib)
  j.act(OWNER, 'library.update', { library: lib, archived: true })
  assert.equal(j.act(OWNER, 'post.create', body).reason, 'unknown-target')
})

test('follows: any member may follow another, not themselves', () => {
  const j = new Journal()
  for (const m of [ALICE, BOB]) j.act(m, 'member.join')
  assert.equal(j.state.members[ALICE].follows, undefined)
  assert.equal(j.act(ALICE, 'follow.set', { member: BOB, on: true }).ok, true)
  assert.deepEqual(j.state.members[ALICE].follows, [BOB])
  assert.equal(j.act(ALICE, 'follow.set', { member: ALICE, on: true }).reason, 'self')
  assert.equal(j.act(ALICE, 'follow.set', { member: '0x' + '9'.repeat(40), on: true }).reason, 'unknown-member')
  j.act(ALICE, 'follow.set', { member: BOB, on: false })
  assert.deepEqual(j.state.members[ALICE].follows, [])
})

test('plans: a verified payment grants a badge for its days, once per transaction; expired badges carry no roles', () => {
  const j = new Journal()
  j.act(ALICE, 'member.join')
  const badges = [...genesis.badges, { id: 'supporter', name: 'Supporter', roles: ['reviewer'] }]
  const TX = '0x' + 'ab'.repeat(32)
  assert.equal(j.act(OWNER, 'community.update', { badges, plans: [{ id: 'sup', name: 'Supporter', badge: 'supporter', price: '10000000000000000', days: 30 }], treasury: '0x' + '7'.repeat(40) }).ok, true)
  assert.equal(j.act(ALICE, 'plan.claim', { plan: 'sup', tx: TX }).reason, 'unverified')
  assert.equal(j.act(ALICE, 'plan.claim', { plan: 'sup', tx: TX }, { approved: false }).reason, 'payment-not-found')
  const t0 = j.t
  assert.equal(j.act(ALICE, 'plan.claim', { plan: 'sup', tx: TX }, { approved: true }).ok, true)
  assert.equal(j.state.members[ALICE].badgeUntil!.supporter, t0 + 30 * 86_400_000)
  assert.equal(j.act(ALICE, 'plan.claim', { plan: 'sup', tx: TX.toUpperCase().replace('0X', '0x') }, { approved: true }).reason, 'already-claimed')
  // the badge's role counts while the plan runs, not after
  const sub = j.act(OWNER, 'quest.create', { title: 'q', kind: 'text' }).id
  assert.equal(j.act(BOB, 'member.join').ok, true)
  const s2 = j.act(BOB, 'quest.submit', { quest: sub, answer: { text: 'x' } }).id
  assert.equal(j.act(ALICE, 'quest.review', { submission: s2, decision: 'approved' }).ok, true)
  j.t = t0 + 31 * 86_400_000
  assert.equal(j.act(ALICE, 'quest.review', { submission: s2, decision: 'rejected' }).reason, 'not-permitted')
})
