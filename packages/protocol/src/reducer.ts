// The one pure reducer: (state, action, ctx) -> (state, outcome). No I/O, no clock.
// The steward, the app (optimistic updates) and auditors all run this same function.
import { actionId, normalizeAddress } from './canonical.ts'
import { parseAction, type Action } from './schemas.ts'
import { addSorted, can, isOwnerRole, removeValue, type Comment, type Post, type State } from './state.ts'

export interface ReduceContext {
  /** The journal owner who signed the entry. */
  author: string
  /** The entry's journal index. */
  index: number
  /** The steward's receive time (ms); orders actions and stamps state. */
  receivedAt: number
}

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
  const reason = apply(next, action, { author, id, at: ctx.receivedAt }, effects)
  if (reason) return reject(reason)
  return { state: next, outcome: { ok: true, id, effects } }
}

type Ctx = { author: string; id: string; at: number }

// Returns a rejection reason, or null after mutating `s` in place (s is already a copy).
function apply(s: State, a: Action, ctx: Ctx, effects: Effect[]): string | null {
  const me = s.members[ctx.author]
  if (a.type === 'member.join') {
    if (me) return 'already-member'
    if (!s.community.public) return 'closed'
    s.members[ctx.author] = { owner: ctx.author, joinedAt: ctx.at, roles: [...s.community.defaultRoles].sort(), badges: [], profile: a.body.profile ?? {} }
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
      member.badges = a.type === 'badge.grant' ? addSorted(member.badges, badge.id) : removeValue(member.badges, badge.id)
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
      return null
    }
  }
}

function lastHolder(s: State, roleId: string, owner: string): boolean {
  return !Object.values(s.members).some((m) => m.owner !== owner && m.roles.includes(roleId))
}
