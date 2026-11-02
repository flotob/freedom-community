// View documents: read-optimised JSON the app renders. Pure functions of the state;
// every view carries the ledger position and state hash it was built from.
import { stewardTopic, type State, type Post, type Quest, effectiveRoles } from '@freedom-community/protocol'

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
    leaderboards: c.leaderboards ?? [],
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
    posts: posts.map((p) => postCard(s, p)), journal: journal ?? null,
    submissions: Object.values(s.submissions ?? {}).filter((x) => x.author === owner).sort((a, b) => a.at - b.at).map((x) => ({ id: x.id, quest: x.quest, status: x.status, at: x.at })),
  }
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
export function questView(s: State, id: string, stamp: ViewStamp) {
  const q = s.quests?.[id]
  if (!q) return null
  const subs = Object.values(s.submissions ?? {}).filter((x) => x.quest === id && x.status !== 'disqualified').sort((a, b) => b.at - a.at)
  const feed = q.privacy === 'secret' ? [] : subs.map((x) => {
    const open = (q.privacy ?? 'public') === 'public' && !x.private
    return { id: x.id, author: x.author, name: s.members[x.author]?.profile.name ?? null, avatar: s.members[x.author]?.profile.avatar ?? null, status: x.status, at: x.at, text: open ? x.answer.text ?? null : null, image: open ? x.answer.image ?? null : null }
  })
  return { v: 0, kind: 'quest', ...stamp, quest: publicQuest(s, q), feed }
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

/** Which views an accepted action touches (by its type and target). */
export function dirtyFor(type: string, author: string, body: Record<string, unknown>, id: string, s?: State): string[] {
  const post = (body.post ?? body.target) as string | undefined
  switch (type) {
    case 'member.join': return ['community', 'members', `member/${author}`]
    case 'profile.set': return ['members', `member/${author}`, 'home']
    case 'post.create': return ['community', 'home', `post/${id}`, `member/${author}`]
    case 'post.edit': case 'post.withdraw': return ['community', 'home', `post/${post}`, `member/${author}`]
    case 'comment.create': return ['home', `post/${post}`]
    case 'like.set': case 'mod.hide': return ['community', 'home', `post/${post}`]
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
