// Canonical JSON, hashing and the topic derivations every party must agree on.
import { keccak_256 } from '@noble/hashes/sha3'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'

export const PROTOCOL = 'freedom-community/v0'

/** JSON with object keys sorted recursively and no whitespace; `undefined` fields are dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v !== undefined) out[key] = sortDeep(v)
    }
    return out
  }
  return value
}

export function keccakHex(input: string | Uint8Array): string {
  return bytesToHex(keccak_256(typeof input === 'string' ? utf8ToBytes(input) : input))
}

export function sha256Hex(input: string | Uint8Array): string {
  return bytesToHex(sha256(typeof input === 'string' ? utf8ToBytes(input) : input))
}

/** A community's id: the first 16 hex chars of keccak256(canonical genesis). */
export function communityId(genesis: unknown): string {
  return keccakHex(canonicalJson(genesis)).slice(0, 16)
}

/** The topic Freedom uses for a page's feed named `name` (S1: keccak256("<origin>/<name>")). */
export function originFeedTopic(origin: string, name: string): string {
  return keccakHex(`${origin}/${name}`)
}

export function journalTopic(origin: string): string {
  return originFeedTopic(origin, 'journal')
}

/** A steward feed: ledger, view/<name>, ... */
export function stewardTopic(community: string, name: string): string {
  return keccakHex(`${PROTOCOL}/${community}/${name}`)
}

/** The community doorbell's GSOC topic string (Freedom derives the address from it, S2). */
export function doorbellTopic(community: string): string {
  return `${PROTOCOL}/${community}/doorbell`
}

/** keccak256 over the canonical state: what every ledger entry commits to. */
export function stateHash(state: unknown): string {
  return keccakHex(canonicalJson(state))
}

export function normalizeAddress(addr: string): string {
  const a = addr.toLowerCase().replace(/^0x/, '')
  if (!/^[0-9a-f]{40}$/.test(a)) throw new Error(`not an address: ${addr}`)
  return `0x${a}`
}

/** An action's id: `<owner>:<journal index>`. */
export function actionId(owner: string, index: number): string {
  return `${normalizeAddress(owner)}:${index}`
}
