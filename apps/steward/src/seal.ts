// Sealed quest data (spike S5's format): X25519 ECDH with an ephemeral key, HKDF-SHA256,
// AES-256-GCM, with AAD binding the context. Members seal answers and quest managers seal
// solutions to the steward's seal key, which is derived from the steward key, so a
// restarted (or replacement) steward with the same key can still open everything.
import { createPrivateKey, createPublicKey, createDecipheriv, diffieHellman, hkdfSync, type KeyObject } from 'node:crypto'
import type { Sealed } from '@freedom-community/protocol'

const INFO = Buffer.from('freedom-community/sealed-answer/v0')
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex')
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex')

export interface SealKey { privateKey: KeyObject; publicB64: string }

/** The steward's X25519 seal key: HKDF(steward key, "freedom-community/v0/seal-key"). */
export function sealKeyFrom(stewardKeyHex: string): SealKey {
  const seed = Buffer.from(hkdfSync('sha256', Buffer.from(stewardKeyHex.replace(/^0x/, ''), 'hex'), Buffer.alloc(0), Buffer.from('freedom-community/v0/seal-key'), 32))
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_X25519, seed]), format: 'der', type: 'pkcs8' })
  const publicB64 = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
  return { privateKey, publicB64 }
}

/** The AES key of one sealed message (what a reveal publishes: it opens this message only). */
export function sealedAesKey(sealed: Sealed, key: SealKey, aad: string): Buffer {
  if (sealed.aad !== aad) throw new Error(`sealed for "${sealed.aad}", expected "${aad}"`)
  const epkRaw = Buffer.from(sealed.epk, 'base64')
  const epk = createPublicKey({ key: Buffer.concat([SPKI_X25519, epkRaw]), format: 'der', type: 'spki' })
  const shared = diffieHellman({ privateKey: key.privateKey, publicKey: epk })
  const salt = Buffer.concat([epkRaw, Buffer.from(key.publicB64, 'base64')])
  return Buffer.from(hkdfSync('sha256', shared, salt, INFO, 32))
}

/** Open a sealed message with its AES key (anyone can, once a reveal publishes the key). */
export function openWithAesKey(sealed: Sealed, aesKey: Buffer): string {
  const ct = Buffer.from(sealed.ct, 'base64')
  const d = createDecipheriv('aes-256-gcm', aesKey, Buffer.from(sealed.nonce, 'base64'))
  d.setAAD(Buffer.from(sealed.aad))
  d.setAuthTag(ct.subarray(-16))
  return Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]).toString('utf8')
}

/** Open a sealed payload; throws unless its AAD is exactly `aad` and it authenticates. */
export function openSealed(sealed: Sealed, key: SealKey, aad: string): string {
  return openWithAesKey(sealed, sealedAesKey(sealed, key, aad))
}

/** AAD of a member's sealed answer: bound to the community, the quest and the author. */
export const answerAad = (community: string, quest: string, author: string) => `${community}/quest/${quest}/${author.toLowerCase()}`
/** AAD of a quest's sealed solutions: bound to the community and the quest's author. */
export const secretAad = (community: string, author: string) => `${community}/quest-secret/${author.toLowerCase()}`

export { judgeAnswer as judge } from '@freedom-community/protocol'
