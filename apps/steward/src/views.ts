// View documents: read-optimised JSON the app renders. Pure functions of the state;
// every view carries the ledger position and state hash it was built from.
import { stewardTopic, type State, type Post, effectiveRoles } from '@freedom-community/protocol'

export const PAGE_SIZE = 20

export interface ViewStamp { ledgerPage: number; stateHash: string; builtAt: number }

export function viewTopic(community: string, name: string): string {
  return stewardTopic(community, `view/${name}`)
}

const visible = (p: Post) => p.status === 'published'

function postCard(s: State, p: Post) {
  const author = s.members[p.author]
  return {
    id: p.id,
    author: p.author,
    authorName: author?.profile.name ?? null,
    authorAvatar: author?.profile.avatar ?? null,
    title: p.title ?? null,
    excerpt: p.excerpt,
    image: p.image ?? null,
    categories: p.categories,
    createdAt: p.createdAt,
    editedAt: p.editedAt ?? null,
    likeCount: p.likes.length,
    commentCount: p.comments.filter((c) => s.comments[c]?.status === 'published').length,
  }
}

export function communityView(s: State, stamp: ViewStamp) {
  const c = s.community
  return {
    v: 0, kind: 'community', ...stamp,
    id: c.id, name: c.name, origin: c.origin, steward: c.steward, theme: c.theme ?? null, public: c.public,
    categories: c.categories, badges: c.badges, roles: c.roles.map((r) => ({ id: r.id, name: r.name, permissions: r.permissions })),
    counts: { members: Object.keys(s.members).length, posts: Object.values(s.posts).filter(visible).length },
    homePages: Math.max(1, Math.ceil(Object.values(s.posts).filter(visible).length / PAGE_SIZE)),
  }
}

export function homeViews(s: State, stamp: ViewStamp) {
  const posts = Object.values(s.posts).filter(visible).sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
  const pages = Math.max(1, Math.ceil(posts.length / PAGE_SIZE))
  return Array.from({ length: pages }, (_, i) => ({
    name: `home/${i}`,
    doc: { v: 0, kind: 'home', ...stamp, page: i, pages, posts: posts.slice(i * PAGE_SIZE, (i + 1) * PAGE_SIZE).map((p) => postCard(s, p)) },
  }))
}

/** Markdown of a content reference, if the steward has it (checked against its hash). */
export type Bodies = (ref: string | undefined | null) => string | null

export function postView(s: State, id: string, stamp: ViewStamp, bodies: Bodies = () => null) {
  const p = s.posts[id]
  if (!p) return null
  const comments = p.comments.map((cid) => s.comments[cid]).filter(Boolean).map((c) => ({
    id: c.id, author: c.author, authorName: s.members[c.author]?.profile.name ?? null, createdAt: c.createdAt,
    status: c.status, hiddenReason: c.hiddenReason ?? null, text: c.status === 'published' ? c.text ?? null : null,
    content: c.status === 'published' ? c.content ?? null : null,
    body: c.status === 'published' ? bodies(c.content) : null, likeCount: c.likes.length,
  }))
  return {
    v: 0, kind: 'post', ...stamp, ...postCard(s, p), status: p.status, hiddenReason: p.hiddenReason ?? null,
    content: p.status === 'published' ? p.content : null, contentHash: p.contentHash,
    // The post's markdown, embedded so the app needs no second read (null if unavailable).
    body: p.status === 'published' ? bodies(p.content) : null,
    likes: p.likes, comments,
  }
}

export function membersView(s: State, stamp: ViewStamp) {
  const members = Object.values(s.members).sort((a, b) => a.joinedAt - b.joinedAt || (a.owner < b.owner ? -1 : 1))
  return {
    v: 0, kind: 'members', ...stamp,
    members: members.map((m) => ({ owner: m.owner, name: m.profile.name ?? null, avatar: m.profile.avatar ?? null, roles: effectiveRoles(s, m.owner), badges: m.badges, joinedAt: m.joinedAt })),
  }
}

/** How far the steward has read a member's journal, and what became of their recent entries. */
export interface JournalReceipt { next: number; recent: { index: number; type: string; ok: boolean; reason?: string; at: number }[] }

export function memberView(s: State, owner: string, stamp: ViewStamp, journal?: JournalReceipt) {
  const m = s.members[owner]
  // Someone whose join was refused still gets a view, so their app can say why.
  if (!m) return journal ? { v: 0, kind: 'member', ...stamp, owner, member: false, journal } : null
  const posts = Object.values(s.posts).filter((p) => p.author === owner && visible(p)).sort((a, b) => b.createdAt - a.createdAt)
  return {
    v: 0, kind: 'member', ...stamp, owner, member: true, profile: m.profile, roles: m.roles, effectiveRoles: effectiveRoles(s, owner), badges: m.badges, joinedAt: m.joinedAt,
    posts: posts.map((p) => postCard(s, p)), journal: journal ?? null,
  }
}

/** Which views an accepted action touches (by its type and target). */
export function dirtyFor(type: string, author: string, body: Record<string, unknown>, id: string): string[] {
  const post = (body.post ?? body.target) as string | undefined
  switch (type) {
    case 'member.join': return ['community', 'members', `member/${author}`]
    case 'profile.set': return ['members', `member/${author}`, 'home']
    case 'post.create': return ['community', 'home', `post/${id}`, `member/${author}`]
    case 'post.edit': case 'post.withdraw': return ['community', 'home', `post/${post}`, `member/${author}`]
    case 'comment.create': return ['home', `post/${post}`]
    case 'like.set': case 'mod.hide': return ['community', 'home', `post/${post}`]
    case 'role.grant': case 'role.revoke': case 'badge.grant': case 'badge.revoke': return ['members', `member/${body.member}`]
    case 'community.update': return ['community', 'members', 'home']
    default: return []
  }
}
