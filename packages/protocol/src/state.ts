// Community state: what the reducer folds the ledger into. Plain JSON, deterministic
// (sorted arrays, no Maps), so its canonical hash is the same for every replayer.
import { communityId, normalizeAddress } from './canonical.ts'
import { GenesisSchema, type Badge, type Category, type Genesis, type Leaderboard, type Plan, type Role, type Sealed } from './schemas.ts'

export interface Profile { name?: string; bio?: string; avatar?: string }

export interface Member {
  owner: string
  joinedAt: number
  roles: string[]
  badges: string[]
  profile: Profile
  /** Score per held badge; absent until a score is first set (keeps older state hashes). */
  scores?: Record<string, number>
  /** Members this member follows (sorted); absent until the first follow. */
  follows?: string[]
  /** Badges held for a limited time (plans): badge -> expiry (ms); absent until used. */
  badgeUntil?: Record<string, number>
}

export interface Quest {
  id: string
  author: string
  createdAt: number
  title: string
  description?: string
  kind: 'text' | 'mcq' | 'upload'
  options?: string[]
  multi?: boolean
  partial?: boolean
  secret?: Sealed
  autoApprove?: boolean
  opensAt?: number
  closesAt?: number
  closed?: boolean
  tries?: number
  rewards?: { badge: string; score?: number; action?: 'add' | 'remove' }[]
  prerequisites?: { badge: string; min?: number; max?: number; hide?: boolean }[]
  privacy?: 'public' | 'private' | 'secret'
  image?: string
}

export interface Library {
  id: string
  author: string
  createdAt: number
  name: string
  description?: string
  cover?: string
  /** Its posts also show in the home feed. */
  postToFeed?: boolean
  archived?: boolean
}

export type SubmissionStatus = 'pending' | 'approved' | 'rejected' | 'disqualified'

export interface Submission {
  id: string
  quest: string
  author: string
  at: number
  answer: { text?: string; image?: string; sealed?: true }
  private?: boolean
  status: SubmissionStatus
  /** Rewards were applied (each submission pays once). */
  paid?: boolean
  multiplier?: number
}

export type ItemStatus = 'published' | 'withdrawn' | 'hidden'

export interface Post {
  id: string
  author: string
  createdAt: number
  editedAt?: number
  title?: string
  excerpt: string
  content: string
  contentHash: string
  image?: string
  /** The library this post sits in; absent for a home-feed post. */
  library?: string
  categories: string[]
  status: ItemStatus
  hiddenReason?: string
  likes: string[]
  comments: string[]
}

export interface Comment {
  id: string
  post: string
  /** The comment this replies to; absent for a top-level comment. */
  parent?: string
  author: string
  createdAt: number
  text?: string
  content?: string
  contentHash?: string
  status: ItemStatus
  hiddenReason?: string
  likes: string[]
}

export interface State {
  v: 0
  community: {
    id: string
    name: string
    origin: string
    steward: string
    roles: Role[]
    defaultRoles: string[]
    badges: Badge[]
    categories: Category[]
    theme?: Record<string, string>
    public: boolean
    leaderboards?: Leaderboard[]
    plans?: Plan[]
    treasury?: string
  }
  members: Record<string, Member>
  posts: Record<string, Post>
  comments: Record<string, Comment>
  /** Absent until the first quest (keeps the state hashes of older ledgers). */
  quests?: Record<string, Quest>
  libraries?: Record<string, Library>
  /** Payments claimed for plans: tx hash -> member; absent until the first claim. */
  claims?: Record<string, string>
  submissions?: Record<string, Submission>
  /** Actions folded so far, accepted or not. */
  seq: number
}

export function initialState(genesisInput: unknown): State {
  const genesis: Genesis = GenesisSchema.parse(genesisInput)
  const members: Record<string, Member> = {}
  for (const owner of genesis.owners) {
    const o = normalizeAddress(owner)
    members[o] = { owner: o, joinedAt: genesis.createdAt, roles: ['owner'], badges: [], profile: {} }
  }
  return {
    v: 0,
    community: {
      id: communityId(genesisInput),
      name: genesis.name,
      origin: genesis.origin,
      steward: normalizeAddress(genesis.steward),
      roles: genesis.roles,
      defaultRoles: genesis.defaultRoles,
      badges: genesis.badges,
      categories: genesis.categories,
      theme: genesis.theme,
      public: genesis.settings.public,
    },
    members,
    posts: {},
    comments: {},
    seq: 0,
  }
}

/** Whether a held badge counts at time `at` (time-limited plan badges expire). */
export function badgeActive(m: Member, badge: string, at?: number): boolean {
  const until = m.badgeUntil?.[badge]
  return until === undefined || at === undefined || at < until
}

/** A member's own roles plus the roles their (unexpired) badges carry at time `at`. */
export function effectiveRoles(state: State, owner: string, at?: number): string[] {
  const m = state.members[owner]
  if (!m) return []
  const roles = new Set(m.roles)
  for (const badgeId of m.badges) {
    if (!badgeActive(m, badgeId, at)) continue
    for (const r of state.community.badges.find((b) => b.id === badgeId)?.roles ?? []) roles.add(r)
  }
  return [...roles].sort()
}

export function can(state: State, owner: string, permission: string, at?: number): boolean {
  const roles = effectiveRoles(state, owner, at)
  return state.community.roles.some((r) => roles.includes(r.id) && (r.permissions.includes('*') || r.permissions.includes(permission)))
}

export function isOwnerRole(state: State, roleId: string): boolean {
  return state.community.roles.find((r) => r.id === roleId)?.permissions.includes('*') ?? false
}

/** Insert into a sorted array, keeping it sorted and unique. */
export function addSorted(list: string[], value: string): string[] {
  return list.includes(value) ? list : [...list, value].sort()
}

export function removeValue(list: string[], value: string): string[] {
  return list.filter((v) => v !== value)
}
