// Wire formats: the genesis document and the actions members write to their journals.
import { z } from 'zod'
import { PROTOCOL } from './canonical.ts'

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((a) => a.toLowerCase())
const ref = z.string().regex(/^[0-9a-f]{64}([0-9a-f]{64})?$/) // plain or encrypted Swarm reference
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const actionIdSchema = z.string().regex(/^0x[0-9a-f]{40}:\d+$/)
const shortText = (max: number) => z.string().max(max)
const slug = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,39}$/)

export const RoleSchema = z.object({
  id: slug,
  name: shortText(60),
  permissions: z.array(z.string().max(60)).max(100),
})
// New fields are optional without defaults: a default would change the parsed state, and
// so the state hash of every ledger entry written before the field existed.
const unit = z.number().min(0).max(1)
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/)
/** The membership card decal, davinci's BadgeSettings shape (an image is a Swarm ref). */
export const DecalSchema = z.object({
  decal_text: z.object({ text: shortText(100).nullable(), color, background_color: color.nullable(), x: unit, y: unit, scale: z.number().min(0.25).max(4) }).optional(),
  decal_image: z.object({ ref: ref.nullable(), x: unit, y: unit, scale: z.number().min(0.25).max(4) }).optional(),
})
export const BadgeSchema = z.object({
  id: slug,
  name: shortText(60),
  description: shortText(500).optional(),
  icon: ref.optional(),
  roles: z.array(slug).max(20).default([]),
  /** Card decal; `{value}` in the text shows the member's score in this badge. */
  settings: DecalSchema.optional(),
  /** Where the icon shows on the card (decals always render). */
  visibility: z.enum(['everywhere', 'back_only', 'hidden']).optional(),
  /** Granted to everyone who joins from now on. */
  default: z.boolean().optional(),
  /** false: no new grants (holders keep it). */
  enabled: z.boolean().optional(),
})
/** A leaderboard ranks one badge's scores. */
export const LeaderboardSchema = z.object({ id: slug, name: shortText(200), description: shortText(500).optional(), badge: slug })
export const CategorySchema = z.object({ id: slug, name: shortText(40), color: z.string().max(20).optional() })
export const ThemeSchema = z.record(z.string().max(40), z.string().max(200))

export const GenesisSchema = z.object({
  protocol: z.literal(PROTOCOL),
  name: shortText(80),
  origin: z.string().max(200),
  steward: address,
  createdAt: z.number().int().nonnegative(),
  roles: z.array(RoleSchema).min(1).max(50),
  defaultRoles: z.array(slug).max(10),
  owners: z.array(address).min(1).max(20),
  badges: z.array(BadgeSchema).max(200).default([]),
  categories: z.array(CategorySchema).max(100).default([]),
  theme: ThemeSchema.optional(),
  settings: z.object({ public: z.boolean().default(true) }).default({ public: true }),
})
export type Genesis = z.infer<typeof GenesisSchema>
export type Role = z.infer<typeof RoleSchema>
export type Badge = z.infer<typeof BadgeSchema>
export type Category = z.infer<typeof CategorySchema>
export type Leaderboard = z.infer<typeof LeaderboardSchema>

/** Sealed to the steward's X25519 key (X25519 -> HKDF-SHA256 -> AES-256-GCM); AAD binds the context. */
export const SealedSchema = z.object({
  v: z.literal(0),
  alg: z.literal('X25519-HKDF-SHA256-A256GCM'),
  epk: z.string().max(64),
  nonce: z.string().max(32),
  ct: z.string().max(4000),
  aad: z.string().max(200),
})
export type Sealed = z.infer<typeof SealedSchema>

const RewardSchema = z.object({ badge: slug, score: z.number().int().min(-1_000_000).max(1_000_000).optional(), action: z.enum(['add', 'remove']).optional() })
const PrerequisiteSchema = z.object({ badge: slug, min: z.number().int().optional(), max: z.number().int().optional(), hide: z.boolean().optional() })
const QuestFields = {
  title: shortText(200),
  description: shortText(10_000).optional(),
  /** text: an answer (judged by sealed solutions, or reviewed); mcq: options; upload: an image, reviewed. */
  kind: z.enum(['text', 'mcq', 'upload']),
  options: z.array(shortText(200)).min(2).max(20).optional(),
  multi: z.boolean().optional(),
  partial: z.boolean().optional(),
  /** The solutions (text) or correct options (mcq), sealed to the steward: {solutions?: string[], correct?: string[]}. */
  secret: SealedSchema.optional(),
  autoApprove: z.boolean().optional(),
  opensAt: z.number().int().nonnegative().optional(),
  closesAt: z.number().int().nonnegative().optional(),
  /** Submissions allowed per member (default 1). */
  tries: z.number().int().min(1).max(100).optional(),
  rewards: z.array(RewardSchema).max(10).optional(),
  prerequisites: z.array(PrerequisiteSchema).max(10).optional(),
  privacy: z.enum(['public', 'private', 'secret']).optional(),
  image: ref.optional(),
}

const ProfileSchema = z.object({ name: shortText(60).optional(), bio: shortText(2000).optional(), avatar: ref.optional() })

/** Body schema per action type. */
export const ACTION_BODIES = {
  'member.join': z.object({ profile: ProfileSchema.optional() }),
  'profile.set': ProfileSchema,
  'post.create': z.object({
    title: shortText(200).optional(),
    excerpt: shortText(1000),
    content: ref,
    contentHash: hash,
    categories: z.array(slug).max(5).default([]),
    image: ref.optional(),
  }),
  'post.edit': z.object({
    post: actionIdSchema,
    title: shortText(200).optional(),
    excerpt: shortText(1000).optional(),
    content: ref.optional(),
    contentHash: hash.optional(),
    categories: z.array(slug).max(5).optional(),
  }),
  'post.withdraw': z.object({ post: actionIdSchema }),
  'comment.create': z.union([
    z.object({ post: actionIdSchema, text: shortText(2048) }),
    z.object({ post: actionIdSchema, content: ref, contentHash: hash }),
  ]),
  'like.set': z.object({ target: actionIdSchema, on: z.boolean() }),
  'mod.hide': z.object({ target: actionIdSchema, reason: z.string().min(1).max(500) }),
  'role.grant': z.object({ member: address, role: slug }),
  'role.revoke': z.object({ member: address, role: slug }),
  'badge.grant': z.object({ member: address, badge: slug }),
  'badge.revoke': z.object({ member: address, badge: slug }),
  'community.update': z.object({
    name: shortText(80).optional(),
    theme: ThemeSchema.optional(),
    categories: z.array(CategorySchema).max(100).optional(),
    badges: z.array(BadgeSchema).max(200).optional(),
    roles: z.array(RoleSchema).min(1).max(50).optional(),
    leaderboards: z.array(LeaderboardSchema).max(50).optional(),
  }),
  /** Set a member's score in a badge they hold. */
  'badge.score': z.object({ member: address, badge: slug, score: z.number().int().min(-1_000_000_000).max(1_000_000_000) }),
  'quest.create': z.object(QuestFields),
  'quest.update': z.object({ quest: actionIdSchema, ...Object.fromEntries(Object.entries(QuestFields).map(([k, v]) => [k, v.optional()])), close: z.boolean().optional() }),
  'quest.submit': z.object({
    quest: actionIdSchema,
    answer: z.union([z.object({ sealed: SealedSchema }), z.object({ text: shortText(10_000) }), z.object({ image: ref })]),
    private: z.boolean().optional(),
  }),
  'quest.review': z.object({ submission: actionIdSchema, decision: z.enum(['approved', 'rejected', 'disqualified']) }),
} as const

export type ActionType = keyof typeof ACTION_BODIES
export const ACTION_TYPES = Object.keys(ACTION_BODIES) as ActionType[]

export const EnvelopeSchema = z.object({
  v: z.literal(0),
  c: z.string().regex(/^[0-9a-f]{16}$/),
  type: z.string().max(40),
  at: z.number().int().nonnegative(),
  body: z.unknown(),
})

export type Action = { [K in ActionType]: { v: 0; c: string; type: K; at: number; body: z.infer<(typeof ACTION_BODIES)[K]> } }[ActionType]

/** Parse a journal entry into a typed action, or explain why not. */
export function parseAction(input: unknown): { ok: true; action: Action } | { ok: false; reason: string } {
  const env = EnvelopeSchema.safeParse(input)
  if (!env.success) return { ok: false, reason: 'invalid-envelope' }
  const schema = (ACTION_BODIES as Record<string, z.ZodType>)[env.data.type]
  if (!schema) return { ok: false, reason: 'unknown-action' }
  const body = schema.safeParse(env.data.body ?? {})
  if (!body.success) return { ok: false, reason: `invalid-body:${body.error.issues[0]?.path.join('.') || 'body'}` }
  return { ok: true, action: { ...env.data, body: body.data } as Action }
}
