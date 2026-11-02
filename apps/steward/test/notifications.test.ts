// Who gets notified about what: derived from the state before and after each action.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { communityId, initialState, reduce, type State } from '@freedom-community/protocol'
import { notificationsFor } from '../src/views.ts'

const OWNER = '0x' + '1'.repeat(40), ALICE = '0x' + 'a'.repeat(40), BOB = '0x' + 'b'.repeat(40), CARLA = '0x' + 'c'.repeat(40)
const genesis = {
  protocol: 'freedom-community/v0', name: 'N', origin: 'bzz://' + '0'.repeat(64), steward: '0x' + '5'.repeat(40), createdAt: 1,
  roles: [{ id: 'owner', name: 'Owner', permissions: ['*'] }, { id: 'member', name: 'Member', permissions: ['post.create', 'comment.create'] }],
  defaultRoles: ['member'], owners: [OWNER], settings: { public: true },
}
const C = communityId(genesis)

function run() {
  let s: State = initialState(genesis)
  const idx: Record<string, number> = {}
  const notes: { to: string; kind: string }[] = []
  let t = 10
  const act = (author: string, type: string, body: unknown) => {
    const index = idx[author] ?? 0
    idx[author] = index + 1
    const entry = { v: 0, c: C, type, at: t, body }
    const r = reduce(s, entry, { author, index, receivedAt: t++ })
    if (r.outcome.ok) for (const n of notificationsFor(s, r.state, entry, { author, id: r.outcome.id })) notes.push({ to: n.to, kind: n.kind })
    s = r.state
    return r.outcome.id
  }
  return { act, notes, get s() { return s } }
}

test('comments, replies, mentions, follows, followed authors posting, hides', () => {
  const r = run()
  for (const m of [ALICE, BOB, CARLA]) r.act(m, 'member.join', {})
  r.act(BOB, 'follow.set', { member: ALICE, on: true })
  r.act(BOB, 'follow.set', { member: ALICE, on: true }) // already following: no second note
  const post = r.act(ALICE, 'post.create', { title: 'Owls', excerpt: `ask [@Carla](/users/${CARLA})`, content: 'f'.repeat(64), contentHash: 'e'.repeat(64), categories: [] })
  const top = r.act(BOB, 'comment.create', { post, text: 'nice' })
  r.act(CARLA, 'comment.create', { post, parent: top, text: 'agreed' })
  r.act(OWNER, 'mod.hide', { target: top, reason: 'x' })
  assert.deepEqual(r.notes, [
    { to: ALICE, kind: 'new_follower' },
    { to: CARLA, kind: 'mention_in_post' },
    { to: BOB, kind: 'followed_author_posted' },
    { to: ALICE, kind: 'comment_on_post' },
    { to: BOB, kind: 'reply_to_comment' },
    { to: ALICE, kind: 'comment_on_post' },
    { to: BOB, kind: 'comment_deleted' },
  ])
})
