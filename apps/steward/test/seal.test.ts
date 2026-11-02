// Sealed answers: seal with WebCrypto exactly as a page does, open with node:crypto as the
// steward does, and judge.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { answerAad, judge, openSealed, sealKeyFrom } from '../src/seal.ts'

const INFO = new TextEncoder().encode('freedom-community/sealed-answer/v0')
const b64 = (u8: Uint8Array) => Buffer.from(u8).toString('base64')

async function seal(pubB64: string, text: string, aad: string) {
  const subtle = crypto.subtle
  const pub = Buffer.from(pubB64, 'base64')
  const stewardPub = await subtle.importKey('raw', pub, { name: 'X25519' }, false, [])
  const eph = (await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: stewardPub }, eph.privateKey, 256))
  const epk = new Uint8Array(await subtle.exportKey('raw', eph.publicKey))
  const hk = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  const key = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array([...epk, ...pub]), info: INFO }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt'])
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode(aad) }, key, new TextEncoder().encode(text)))
  return { v: 0 as const, alg: 'X25519-HKDF-SHA256-A256GCM' as const, epk: b64(epk), nonce: b64(nonce), ct: b64(ct), aad }
}

const key = sealKeyFrom('11'.repeat(32))
const ALICE = '0x' + 'a'.repeat(40)
const BOB = '0x' + 'b'.repeat(40)

test('the seal key is derived from the steward key, stably', () => {
  assert.equal(sealKeyFrom('11'.repeat(32)).publicB64, key.publicB64)
  assert.notEqual(sealKeyFrom('22'.repeat(32)).publicB64, key.publicB64)
})

test('a page-sealed answer opens for the steward, bound to quest and author', async () => {
  const aad = answerAad('c0ffee', 'q1', ALICE)
  const sealed = await seal(key.publicB64, JSON.stringify({ text: 'Tawny Owl ' }), aad)
  assert.deepEqual(JSON.parse(openSealed(sealed, key, aad)), { text: 'Tawny Owl ' })
  // Bob copying Alice's ciphertext into his own submission: wrong AAD
  assert.throws(() => openSealed(sealed, key, answerAad('c0ffee', 'q1', BOB)), /sealed for/)
  // a tampered AAD field fails authentication
  assert.throws(() => openSealed({ ...sealed, aad: answerAad('c0ffee', 'q1', BOB) }, key, answerAad('c0ffee', 'q1', BOB)))
})

test('judging: text by trimmed lower-case equality; mcq single, exact set, partial with de-duplicated picks', () => {
  assert.deepEqual(judge({ kind: 'text' }, { solutions: ['tawny owl'] }, { text: '  Tawny OWL ' }), { approved: true })
  assert.deepEqual(judge({ kind: 'text' }, { solutions: ['tawny owl'] }, { text: 'barn owl' }), { approved: false })
  const mcq = { kind: 'mcq', options: ['A', 'B', 'C'] }
  assert.equal(judge(mcq, { correct: ['B'] }, { selected: ['B'] }).approved, true)
  assert.equal(judge(mcq, { correct: ['B'] }, { selected: ['B', 'C'] }).approved, false)
  assert.equal(judge({ ...mcq, multi: true }, { correct: ['A', 'B'] }, { selected: ['A'] }).approved, false)
  assert.equal(judge({ ...mcq, multi: true }, { correct: ['A', 'B'] }, { selected: ['B', 'A'] }).approved, true)
  // partial: duplicates don't multiply the reward
  assert.deepEqual(judge({ ...mcq, multi: true, partial: true }, { correct: ['A', 'B'] }, { selected: ['A', 'A', 'A'] }), { approved: true, multiplier: 1 })
  assert.deepEqual(judge({ ...mcq, multi: true, partial: true }, { correct: ['A', 'B'] }, { selected: ['A', 'B'] }), { approved: true, multiplier: 2 })
  assert.equal(judge(mcq, { correct: ['B'] }, { selected: ['Z'] }).approved, false)
})
