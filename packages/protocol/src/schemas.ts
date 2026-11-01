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
export const BadgeSchema = z.object({
  id: slug,
  name: shortText(60),
  description: shortText(500).optional(),
  icon: ref.optional(),
  roles: z.array(slug).max(20).default([]),
})
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
  }),
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
