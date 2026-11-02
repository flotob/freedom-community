// The one pure reducer: (state, action, ctx) -> (state, outcome). No I/O, no clock.
// The steward, the app (optimistic updates) and auditors all run this same function.
import { actionId, normalizeAddress } from './canonical.ts'
import { parseAction, type Action } from './schemas.ts'
import { addSorted, can, isOwnerRole, removeValue, type Comment, type Post, type Quest, type State, type Submission } from './state.ts'

export interface ReduceContext {
  /** The journal owner who signed the entry. */
  author: string
  /** The entry's journal index. */
  index: number
  /** The steward's receive time (ms); orders actions and stamps state. */
  receivedAt: number
  /**
   * The steward's verdict on a sealed quest answer (it alone can open it), recorded in the
   * ledger so a replay reaches the same state. Steward-attested: see docs/protocol.md.
   */
  verdict?: Verdict
}

export interface Verdict { approved: boolean; multiplier?: number }

export type Effect = { kind: 'adopt'; ref: string }
export type Outcome = { ok: true; id: string; effects: Effect[] } | { ok: false; id: string; reason: string }

/** Fold one raw journal entry. Never throws for bad input: it is a rejected outcome. */
export function reduce(state: State, entry: unknown, ctx: ReduceContext): { state: State; outcome: Outcome } {
  const author = normalizeAddress(ctx.author)
  const id = actionId(author, ctx.index)
  const next = structuredClone(state)
  next.seq += 1
  const reject = (reason: string) => ({ state: next, outcome: { ok: false as const, id, reason } })
  const parsed = parseAction(entry)
  if (!parsed.ok) return reject(parsed.reason)
  const action = parsed.action
  if (action.c !== state.community.id) return reject('wrong-community')
  const effects: Effect[] = []
  const reason = apply(next, action, { author, id, at: ctx.receivedAt, verdict: ctx.verdict }, effects)
  if (reason) return reject(reason)
  return { state: next, outcome: { ok: true, id, effects } }
}

type Ctx = { author: string; id: string; at: number; verdict?: Verdict }

/** The deepest a reply may sit (a top-level comment is depth 0), as in davinci. */
export const COMMENT_MAX_DEPTH = 4

// Returns a rejection reason, or null after mutating `s` in place (s is already a copy).
function apply(s: State, a: Action, ctx: Ctx, effects: Effect[]): string | null {
  const me = s.members[ctx.author]
  if (a.type === 'member.join') {
    if (me) return 'already-member'
    if (!s.community.public) return 'closed'
    const defaults = s.community.badges.filter((b) => b.default && b.enabled !== false).map((b) => b.id).sort()
    s.members[ctx.author] = { owner: ctx.author, joinedAt: ctx.at, roles: [...s.community.defaultRoles].sort(), badges: defaults, profile: a.body.profile ?? {} }
    if (a.body.profile?.avatar) effects.push({ kind: 'adopt', ref: a.body.profile.avatar })
    return null
  }
  if (!me) return 'not-member'
  const need = (perm: string) => (can(s, ctx.author, perm) ? null : 'not-permitted')

  switch (a.type) {
    case 'profile.set': {
      const denied = need('profile.set')
      if (denied) return denied
      me.profile = { ...me.profile, ...a.body }
      if (a.body.avatar) effects.push({ kind: 'adopt', ref: a.body.avatar })
      return null
    }
    case 'post.create': {
      const denied = need('post.create')
      if (denied) return denied
      const bad = a.body.categories.find((c) => !s.community.categories.some((k) => k.id === c))
      if (bad) return 'unknown-category'
      const post: Post = { id: ctx.id, author: ctx.author, createdAt: ctx.at, title: a.body.title, excerpt: a.body.excerpt, content: a.body.content, contentHash: a.body.contentHash, image: a.body.image, categories: a.body.categories, status: 'published', likes: [], comments: [] }
      s.posts[ctx.id] = post
      effects.push({ kind: 'adopt', ref: a.body.content })
      if (a.body.image) effects.push({ kind: 'adopt', ref: a.body.image })
      return null
    }
    case 'post.edit': {
      const post = s.posts[a.body.post]
      if (!post) return 'unknown-target'
      if (post.author !== ctx.author) return 'not-author'
      if (post.status !== 'published') return 'not-editable'
      if (!can(s, ctx.author, 'post.create')) return 'not-permitted'
      if ((a.body.content === undefined) !== (a.body.contentHash === undefined)) return 'content-needs-hash'
      if (a.body.categories?.some((c) => !s.community.categories.some((k) => k.id === c))) return 'unknown-category'
      for (const k of ['title', 'excerpt', 'content', 'contentHash', 'categories'] as const) {
        if (a.body[k] !== undefined) (post as unknown as Record<string, unknown>)[k] = a.body[k]
      }
      post.editedAt = ctx.at
      if (a.body.content) effects.push({ kind: 'adopt', ref: a.body.content })
      return null
    }
    case 'post.withdraw': {
      const post = s.posts[a.body.post]
      if (!post) return 'unknown-target'
      if (post.author !== ctx.author) return 'not-author'
      if (post.status !== 'published') return 'not-editable'
      post.status = 'withdrawn'
      return null
    }
    case 'comment.create': {
      const denied = need('comment.create')
      if (denied) return denied
      const post = s.posts[a.body.post]
      if (!post || post.status !== 'published') return 'unknown-target'
      const comment: Comment = { id: ctx.id, post: post.id, author: ctx.author, createdAt: ctx.at, status: 'published', likes: [] }
      if (a.body.parent !== undefined) {
        const parent = s.comments[a.body.parent]
        if (!parent || parent.post !== post.id || parent.status !== 'published') return 'unknown-target'
        let depth = 1
        for (let c = parent; c.parent; c = s.comments[c.parent]) depth++
        if (depth > COMMENT_MAX_DEPTH) return 'too-deep'
        comment.parent = parent.id
      }
      if ('text' in a.body) comment.text = a.body.text
      else {
        comment.content = a.body.content
        comment.contentHash = a.body.contentHash
        effects.push({ kind: 'adopt', ref: a.body.content })
      }
      s.comments[ctx.id] = comment
      post.comments = [...post.comments, ctx.id]
      return null
    }
    case 'like.set': {
      const denied = need('like.set')
      if (denied) return denied
      const target = s.posts[a.body.target] ?? s.comments[a.body.target]
      if (!target || target.status !== 'published') return 'unknown-target'
      target.likes = a.body.on ? addSorted(target.likes, ctx.author) : removeValue(target.likes, ctx.author)
      return null
    }
    case 'mod.hide': {
      const denied = need('mod.hide')
      if (denied) return denied
      const target = s.posts[a.body.target] ?? s.comments[a.body.target]
      if (!target) return 'unknown-target'
      if (target.status === 'hidden') return 'already-hidden'
      target.status = 'hidden'
      target.hiddenReason = a.body.reason
      return null
    }
    case 'role.grant':
    case 'role.revoke': {
      const denied = need('role.manage')
      if (denied) return denied
      const member = s.members[a.body.member]
      if (!member) return 'unknown-member'
      if (!s.community.roles.some((r) => r.id === a.body.role)) return 'unknown-role'
      // Only an all-powerful member hands out or takes away all-powerful roles.
      if (isOwnerRole(s, a.body.role) && !can(s, ctx.author, '*')) return 'not-permitted'
      if (a.type === 'role.grant') {
        member.roles = addSorted(member.roles, a.body.role)
        return null
      }
      if (isOwnerRole(s, a.body.role) && lastHolder(s, a.body.role, member.owner)) return 'last-owner'
      member.roles = removeValue(member.roles, a.body.role)
      return null
    }
    case 'badge.grant':
    case 'badge.revoke': {
      const denied = need('badge.manage')
      if (denied) return denied
      const member = s.members[a.body.member]
      if (!member) return 'unknown-member'
      const badge = s.community.badges.find((b) => b.id === a.body.badge)
      if (!badge) return 'unknown-badge'
      // A badge carrying an all-powerful role is an owner grant in disguise.
      if (badge.roles.some((r) => isOwnerRole(s, r)) && !can(s, ctx.author, '*')) return 'not-permitted'
      if (a.type === 'badge.grant') {
        if (badge.enabled === false) return 'badge-disabled'
        member.badges = addSorted(member.badges, badge.id)
      } else detachBadge(member, badge.id)
      return null
    }
    case 'badge.score': {
      const denied = need('badge.score')
      if (denied) return denied
      const member = s.members[a.body.member]
      if (!member) return 'unknown-member'
      if (!member.badges.includes(a.body.badge)) return 'not-held'
      member.scores = { ...member.scores, [a.body.badge]: a.body.score }
      return null
    }
    case 'quest.create': {
      const denied = need('quest.manage')
      if (denied) return denied
      const bad = questProblem(s, a.body)
      if (bad) return bad
      const quest: Quest = { id: ctx.id, author: ctx.author, createdAt: ctx.at, ...stripUndefined(a.body) } as Quest
      s.quests = { ...s.quests, [ctx.id]: quest }
      if (quest.image) effects.push({ kind: 'adopt', ref: quest.image })
      return null
    }
    case 'quest.update': {
      const denied = need('quest.manage')
      if (denied) return denied
      const quest = s.quests?.[a.body.quest]
      if (!quest) return 'unknown-target'
      if (questClosed(quest, ctx.at)) return 'quest-closed'
      const { quest: _q, close, ...fields } = a.body as Record<string, unknown> & { quest: string; close?: boolean }
      const patch = stripUndefined(fields) as Partial<Quest>
      if (patch.kind && patch.kind !== quest.kind && Object.values(s.submissions ?? {}).some((x) => x.quest === quest.id)) return 'kind-fixed'
      const merged = { ...quest, ...patch }
      const bad = questProblem(s, merged)
      if (bad) return bad
      if (close) merged.closed = true
      s.quests![quest.id] = merged
      if (patch.image) effects.push({ kind: 'adopt', ref: patch.image })
      return null
    }
    case 'quest.submit': {
      const denied = need('quest.submit')
      if (denied) return denied
      const quest = s.quests?.[a.body.quest]
      if (!quest) return 'unknown-target'
      if (quest.opensAt !== undefined && ctx.at < quest.opensAt) return 'quest-not-open'
      if (questClosed(quest, ctx.at)) return 'quest-closed'
      for (const p of quest.prerequisites ?? []) {
        const score = me.scores?.[p.badge] ?? 0
        if (!me.badges.includes(p.badge) || (p.min !== undefined && score < p.min) || (p.max !== undefined && score > p.max)) return 'prerequisite-unmet'
      }
      const mine = Object.values(s.submissions ?? {}).filter((x) => x.quest === quest.id && x.author === ctx.author)
      if (mine.some((x) => x.status === 'disqualified')) return 'disqualified'
      if (mine.some((x) => x.status === 'pending' || x.status === 'approved')) return 'already-submitted'
      if (mine.length >= (quest.tries ?? 1)) return 'no-tries-left'
      const answer = a.body.answer
      if (quest.kind === 'upload' && !('image' in answer)) return 'answer-kind'
      if (quest.kind !== 'upload' && 'image' in answer) return 'answer-kind'
      const sub: Submission = {
        id: ctx.id, quest: quest.id, author: ctx.author, at: ctx.at,
        answer: 'sealed' in answer ? { sealed: true } : 'text' in answer ? { text: answer.text } : { image: answer.image },
        status: 'pending',
      }
      if (a.body.private) sub.private = true
      // Judging: auto-approve; a sealed answer to a quest with sealed solutions takes the
      // steward's verdict; everything else waits for a reviewer.
      if (quest.autoApprove) sub.status = 'approved'
      else if (quest.secret && 'sealed' in answer && ctx.verdict) {
        sub.status = ctx.verdict.approved ? 'approved' : 'rejected'
        if (ctx.verdict.multiplier && ctx.verdict.multiplier > 1) sub.multiplier = Math.min(ctx.verdict.multiplier, 20)
      }
      s.submissions = { ...s.submissions, [ctx.id]: sub }
      if (sub.status === 'approved') pay(s, sub, quest)
      if ('image' in answer) effects.push({ kind: 'adopt', ref: answer.image })
      return null
    }
    case 'quest.review': {
      const denied = need('quest.review')
      if (denied) return denied
      const sub = s.submissions?.[a.body.submission]
      if (!sub) return 'unknown-target'
      const quest = s.quests![sub.quest]
      if (sub.status === a.body.decision) return 'unchanged'
      if (sub.paid) takeBack(s, sub, quest)
      sub.status = a.body.decision
      if (sub.status === 'approved') pay(s, sub, quest)
      return null
    }
    case 'community.update': {
      const denied = need('community.manage')
      if (denied) return denied
      if (a.body.roles && !can(s, ctx.author, '*')) return 'not-permitted'
      if (a.body.roles && !a.body.roles.some((r) => r.permissions.includes('*'))) return 'needs-owner-role'
      if (a.body.name !== undefined) s.community.name = a.body.name
      if (a.body.theme !== undefined) s.community.theme = a.body.theme
      if (a.body.categories !== undefined) s.community.categories = a.body.categories
      if (a.body.badges !== undefined) s.community.badges = a.body.badges
      if (a.body.roles !== undefined) s.community.roles = a.body.roles
      if (a.body.leaderboards !== undefined) {
        const badges = a.body.badges ?? s.community.badges
        if (a.body.leaderboards.some((l) => !badges.some((b) => b.id === l.badge))) return 'unknown-badge'
        s.community.leaderboards = a.body.leaderboards
      }
      return null
    }
  }
}

/** Rewards land once per submission: badges granted or removed, scores added (times the multiplier). */
function pay(s: State, sub: Submission, quest: Quest): void {
  const member = s.members[sub.author]
  if (!member || sub.paid) return
  const mult = sub.multiplier ?? 1
  for (const r of quest.rewards ?? []) {
    const badge = s.community.badges.find((b) => b.id === r.badge)
    if (r.action === 'remove') {
      detachBadge(member, r.badge)
      continue
    }
    if (!badge || badge.enabled === false) continue
    member.badges = addSorted(member.badges, badge.id)
    if (r.score) member.scores = { ...member.scores, [badge.id]: (member.scores?.[badge.id] ?? 0) + r.score * mult }
  }
  sub.paid = true
}

/** A reviewer reversing an approval takes back the scores it paid (badges stay). */
function takeBack(s: State, sub: Submission, quest: Quest): void {
  const member = s.members[sub.author]
  const mult = sub.multiplier ?? 1
  for (const r of quest.rewards ?? []) {
    if (r.action === 'remove' || !r.score || !member?.badges.includes(r.badge)) continue
    member.scores = { ...member.scores, [r.badge]: (member.scores?.[r.badge] ?? 0) - r.score * mult }
  }
  delete sub.paid
}

function detachBadge(member: { badges: string[]; scores?: Record<string, number> }, badge: string): void {
  member.badges = removeValue(member.badges, badge)
  if (member.scores && badge in member.scores) {
    const { [badge]: _gone, ...rest } = member.scores
    member.scores = rest
  }
}

function questClosed(q: Quest, at: number): boolean {
  return !!q.closed || (q.closesAt !== undefined && at >= q.closesAt)
}

function questProblem(s: State, q: { kind: string; options?: string[]; closesAt?: number; opensAt?: number; rewards?: { badge: string }[]; prerequisites?: { badge: string; min?: number; max?: number }[] }): string | null {
  if (q.kind === 'mcq' && (!q.options || q.options.length < 2)) return 'mcq-needs-options'
  if (q.options && new Set(q.options.map((o) => o.trim().toLowerCase())).size !== q.options.length) return 'duplicate-options'
  if (q.opensAt !== undefined && q.closesAt !== undefined && q.closesAt <= q.opensAt) return 'closes-before-opening'
  for (const r of [...(q.rewards ?? []), ...(q.prerequisites ?? [])]) if (!s.community.badges.some((b) => b.id === r.badge)) return 'unknown-badge'
  for (const p of q.prerequisites ?? []) if (p.min !== undefined && p.max !== undefined && p.min > p.max) return 'min-above-max'
  return null
}

function stripUndefined<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

function lastHolder(s: State, roleId: string, owner: string): boolean {
  return !Object.values(s.members).some((m) => m.owner !== owner && m.roles.includes(roleId))
}
