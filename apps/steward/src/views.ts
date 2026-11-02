// View documents: read-optimised JSON the app renders. Pure functions of the state;
// every view carries the ledger position and state hash it was built from.
import { stewardTopic, type State, type Post, type Quest, effectiveRoles } from '@freedom-community/protocol'

export const PAGE_SIZE = 20

export interface ViewStamp { ledgerPage: number; stateHash: string; builtAt: number }

export function viewTopic(community: string, name: string): string {
  return stewardTopic(community, `view/${name}`)
}

const visible = (p: Post) => p.status === 'published'
/** Home feed: home posts, plus posts from libraries that opt into the feed. */
const onHome = (s: State, p: Post) => visible(p) && (!p.library || !!s.libraries?.[p.library]?.postToFeed)

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
    leaderboards: c.leaderboards ?? [],
    plans: c.plans ?? [], treasury: c.treasury ?? null,
    counts: { members: Object.keys(s.members).length, posts: Object.values(s.posts).filter(visible).length, libraries: Object.values(s.libraries ?? {}).filter((l) => !l.archived).length },
    homePages: Math.max(1, Math.ceil(Object.values(s.posts).filter((p) => onHome(s, p)).length / PAGE_SIZE)),
  }
}

export function homeViews(s: State, stamp: ViewStamp) {
  const posts = Object.values(s.posts).filter((p) => onHome(s, p)).sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
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
    id: c.id, parent: c.parent ?? null, author: c.author, authorName: s.members[c.author]?.profile.name ?? null, authorAvatar: s.members[c.author]?.profile.avatar ?? null, createdAt: c.createdAt,
    status: c.status, hiddenReason: c.hiddenReason ?? null, text: c.status === 'published' ? c.text ?? null : null,
    content: c.status === 'published' ? c.content ?? null : null,
    body: c.status === 'published' ? bodies(c.content) : null, likeCount: c.likes.length,
  }))
  return {
    v: 0, kind: 'post', ...stamp, ...postCard(s, p), status: p.status, hiddenReason: p.hiddenReason ?? null,
    library: p.library ? { id: p.library, name: s.libraries?.[p.library]?.name ?? '' } : null,
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
    members: members.map((m) => ({
      owner: m.owner, name: m.profile.name ?? null, avatar: m.profile.avatar ?? null,
      // the card's line: the bio's opening, plain
      bio: m.profile.bio ? m.profile.bio.replace(/[#*_>`[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140) : null,
      roles: effectiveRoles(s, m.owner), badges: m.badges, joinedAt: m.joinedAt,
    })),
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
    scores: m.scores ?? {},
    badgeUntil: m.badgeUntil ?? {},
    follows: m.follows ?? [],
    followers: Object.values(s.members).filter((x) => x.follows?.includes(owner)).length,
    posts: posts.map((p) => postCard(s, p)), journal: journal ?? null,
    submissions: Object.values(s.submissions ?? {}).filter((x) => x.author === owner).sort((a, b) => a.at - b.at).map((x) => ({ id: x.id, quest: x.quest, status: x.status, at: x.at })),
  }
}

// ---- libraries -------------------------------------------------------------------

export function librariesView(s: State, stamp: ViewStamp) {
  const libs = Object.values(s.libraries ?? {}).filter((l) => !l.archived).sort((a, b) => a.createdAt - b.createdAt)
  return {
    v: 0, kind: 'libraries', ...stamp,
    libraries: libs.map((l) => ({ ...l, postCount: Object.values(s.posts).filter((p) => p.library === l.id && visible(p)).length })),
  }
}

export function libraryView(s: State, id: string, stamp: ViewStamp) {
  const l = s.libraries?.[id]
  if (!l) return null
  const posts = Object.values(s.posts).filter((p) => p.library === id && visible(p)).sort((a, b) => b.createdAt - a.createdAt)
  return { v: 0, kind: 'library', ...stamp, library: l, posts: posts.map((p) => postCard(s, p)) }
}

// ---- quests ----------------------------------------------------------------------

/** A quest as anyone may see it: never the sealed solutions, only whether there are some. */
function publicQuest(s: State, q: Quest) {
  const subs = Object.values(s.submissions ?? {}).filter((x) => x.quest === q.id)
  const { secret, ...rest } = q
  return {
    ...rest, hasSolutions: !!secret,
    counts: { submissions: subs.length, approved: subs.filter((x) => x.status === 'approved').length, pending: subs.filter((x) => x.status === 'pending').length },
    rewards: (q.rewards ?? []).map((r) => ({ ...r, badgeName: s.community.badges.find((b) => b.id === r.badge)?.name ?? r.badge })),
  }
}

export function questsView(s: State, stamp: ViewStamp) {
  const quests = Object.values(s.quests ?? {}).sort((a, b) => b.createdAt - a.createdAt)
  return { v: 0, kind: 'quests', ...stamp, quests: quests.map((q) => publicQuest(s, q)) }
}

/** The quest page: the quest and its feed (answers only where both quest and row are public and nothing is sealed). */
export function questView(s: State, id: string, stamp: ViewStamp, revealed = false) {
  const q = s.quests?.[id]
  if (!q) return null
  const subs = Object.values(s.submissions ?? {}).filter((x) => x.quest === id && x.status !== 'disqualified').sort((a, b) => b.at - a.at)
  const feed = q.privacy === 'secret' ? [] : subs.map((x) => {
    const open = (q.privacy ?? 'public') === 'public' && !x.private
    return { id: x.id, author: x.author, name: s.members[x.author]?.profile.name ?? null, avatar: s.members[x.author]?.profile.avatar ?? null, status: x.status, at: x.at, text: open ? x.answer.text ?? null : null, image: open ? x.answer.image ?? null : null }
  })
  return { v: 0, kind: 'quest', ...stamp, quest: publicQuest(s, q), feed, revealed }
}

/** Submissions waiting for a reviewer, with their answers (journals are public anyway; sealed ones stay sealed). */
export function reviewView(s: State, stamp: ViewStamp) {
  const rows = Object.values(s.submissions ?? {}).filter((x) => x.status === 'pending').sort((a, b) => a.at - b.at)
  return {
    v: 0, kind: 'review', ...stamp,
    rows: rows.map((x) => ({ id: x.id, quest: x.quest, questTitle: s.quests?.[x.quest]?.title ?? '', author: x.author, name: s.members[x.author]?.profile.name ?? null, at: x.at, text: x.answer.text ?? null, image: x.answer.image ?? null, sealed: !!x.answer.sealed })),
  }
}

// ---- leaderboards ------------------------------------------------------------------

/** One badge's holders by score (desc), then by joining order: ranks 1, 2, 3… with no ties. */
function ranking(s: State, badge: string) {
  return Object.values(s.members)
    .filter((m) => m.badges.includes(badge))
    .map((m) => ({ owner: m.owner, name: m.profile.name ?? null, avatar: m.profile.avatar ?? null, score: m.scores?.[badge] ?? 0, joinedAt: m.joinedAt }))
    .sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt || (a.owner < b.owner ? -1 : 1))
    .map(({ joinedAt: _j, ...e }, i) => ({ rank: i + 1, ...e }))
}

export function leaderboardsView(s: State, stamp: ViewStamp) {
  return { v: 0, kind: 'leaderboards', ...stamp, leaderboards: (s.community.leaderboards ?? []).map((l) => ({ ...l, top: ranking(s, l.badge).slice(0, 5) })) }
}

export function leaderboardView(s: State, id: string, stamp: ViewStamp) {
  const l = s.community.leaderboards?.find((x) => x.id === id)
  if (!l) return null
  return { v: 0, kind: 'leaderboard', ...stamp, ...l, badgeName: s.community.badges.find((b) => b.id === l.badge)?.name ?? l.badge, entries: ranking(s, l.badge) }
}

// ---- notifications ------------------------------------------------------------------

/** davinci's notification kinds that this protocol can produce. */
export type NoteKind = 'comment_on_post' | 'reply_to_comment' | 'mention_in_post' | 'mention_in_comment' | 'followed_author_posted' | 'new_follower' | 'quest_approved' | 'quest_rejected' | 'quest_disqualified' | 'post_deleted' | 'comment_deleted'
export type NoteTarget = { type: 'post'; slug: string; commentId: string | null } | { type: 'quest'; id: string } | { type: 'user'; id: string }
export interface Note { to: string; kind: NoteKind; actor: string | null; subject: string | null; target: NoteTarget | null }
export interface InboxItem extends Omit<Note, 'to'> { id: number; at: number }

const mentioned = (text: string | undefined) => [...new Set([...(text ?? '').matchAll(/\/users\/(0x[0-9a-f]{40})/gi)].map((m) => m[1].toLowerCase()))]

/** Who to notify about one accepted action, from the state before and after it (pure). */
export function notificationsFor(prev: State, next: State, action: unknown, ctx: { author: string; id: string }): Note[] {
  const a = action as { type?: string; body?: Record<string, unknown> }
  const b = a?.body ?? {}
  const notes: Note[] = []
  const add = (to: string | undefined, kind: NoteKind, subject: string | null, target: NoteTarget | null, actor: string | null = ctx.author) => {
    if (to && to !== ctx.author && next.members[to]) notes.push({ to, kind, actor, subject, target })
  }
  const titleOf = (postId: string) => next.posts[postId]?.title ?? next.posts[postId]?.excerpt.slice(0, 60) ?? ''
  switch (a?.type) {
    case 'comment.create': {
      const c = next.comments[ctx.id]
      if (!c) break
      const post = next.posts[c.post]
      const target: NoteTarget = { type: 'post', slug: c.post, commentId: c.id }
      const parentAuthor = c.parent ? next.comments[c.parent]?.author : undefined
      if (parentAuthor) add(parentAuthor, 'reply_to_comment', titleOf(c.post), target)
      if (post && post.author !== parentAuthor) add(post.author, 'comment_on_post', titleOf(c.post), target)
      for (const m of mentioned(c.text)) if (m !== post?.author && m !== parentAuthor) add(m, 'mention_in_comment', titleOf(c.post), target)
      break
    }
    case 'post.create': {
      const p = next.posts[ctx.id]
      if (!p) break
      const target: NoteTarget = { type: 'post', slug: p.id, commentId: null }
      const ments = mentioned(`${p.title ?? ''} ${p.excerpt}`)
      for (const m of ments) add(m, 'mention_in_post', titleOf(p.id), target)
      for (const f of Object.values(next.members)) if (f.follows?.includes(ctx.author) && !ments.includes(f.owner)) add(f.owner, 'followed_author_posted', titleOf(p.id), target)
      break
    }
    case 'follow.set':
      if (b.on && !prev.members[ctx.author]?.follows?.includes(String(b.member))) add(String(b.member), 'new_follower', null, { type: 'user', id: ctx.author })
      break
    case 'mod.hide': {
      const t = String(b.target)
      if (next.posts[t]) add(next.posts[t].author, 'post_deleted', titleOf(t), null)
      else if (next.comments[t]) add(next.comments[t].author, 'comment_deleted', titleOf(next.comments[t].post), { type: 'post', slug: next.comments[t].post, commentId: null })
      break
    }
    case 'quest.submit': {
      const sub = next.submissions?.[ctx.id]
      if (sub && (sub.status === 'approved' || sub.status === 'rejected')) {
        const kind = sub.status === 'approved' ? 'quest_approved' : 'quest_rejected'
        notes.push({ to: sub.author, kind, actor: null, subject: next.quests?.[sub.quest]?.title ?? '', target: { type: 'quest', id: sub.quest } })
      }
      break
    }
    case 'quest.review': {
      const sub = next.submissions?.[String(b.submission)]
      if (!sub) break
      const kind = sub.status === 'approved' ? 'quest_approved' : sub.status === 'rejected' ? 'quest_rejected' : 'quest_disqualified'
      add(sub.author, kind, next.quests?.[sub.quest]?.title ?? '', { type: 'quest', id: sub.quest }, null)
      break
    }
  }
  return notes
}

export function inboxView(owner: string, items: InboxItem[], stamp: ViewStamp) {
  return { v: 0, kind: 'inbox', ...stamp, owner, items: [...items].reverse() }
}

/** The library views a post's change touches (a comment's post, too). */
function libraryOf(s: State | undefined, target: string | undefined): string[] {
  if (!s || !target) return []
  const lib = (s.posts[target] ?? s.posts[s.comments[target]?.post ?? ''])?.library
  return lib ? ['libraries', `library/${lib}`] : []
}

/** Which views an accepted action touches (by its type and target). */
export function dirtyFor(type: string, author: string, body: Record<string, unknown>, id: string, s?: State): string[] {
  const post = (body.post ?? body.target) as string | undefined
  switch (type) {
    case 'member.join': return ['community', 'members', `member/${author}`]
    case 'profile.set': return ['members', `member/${author}`, 'home']
    case 'post.create': return ['community', 'home', `post/${id}`, `member/${author}`, ...(body.library ? ['libraries', `library/${body.library}`] : [])]
    case 'post.edit': case 'post.withdraw': return ['community', 'home', `post/${post}`, `member/${author}`, ...libraryOf(s, post)]
    case 'comment.create': return ['home', `post/${post}`, ...libraryOf(s, post)]
    case 'like.set': case 'mod.hide': return ['community', 'home', `post/${post}`, ...libraryOf(s, post)]
    case 'library.create': return ['community', 'libraries', `library/${id}`]
    case 'follow.set': return [`member/${author}`, `member/${body.member}`]
    case 'plan.claim': return ['members', `member/${author}`, 'leaderboards']
    case 'library.update': return ['community', 'libraries', `library/${body.library}`, 'home']
    case 'role.grant': case 'role.revoke': return ['members', `member/${body.member}`]
    case 'badge.grant': case 'badge.revoke': case 'badge.score': return ['members', `member/${body.member}`, 'leaderboards']
    case 'community.update': return ['community', 'members', 'home', 'leaderboards', ...(s?.quests ? ['quests'] : [])]
    case 'quest.create': return ['quests', `quest/${id}`]
    case 'quest.update': return ['quests', `quest/${body.quest}`]
    case 'quest.submit': return ['quests', `quest/${body.quest}`, 'review', `member/${author}`, 'members', 'leaderboards']
    case 'quest.review': {
      const sub = s?.submissions?.[body.submission as string]
      return ['quests', 'review', 'members', 'leaderboards', ...(sub ? [`quest/${sub.quest}`, `member/${sub.author}`] : [])]
    }
    default: return []
  }
}
