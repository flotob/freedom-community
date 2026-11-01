// Steward side of S5: open a sealed answer with node:crypto (no WebCrypto), mirroring seal.js.
import { createPrivateKey, createPublicKey, diffieHellman, hkdfSync, createDecipheriv, generateKeyPairSync } from 'node:crypto'
const INFO = Buffer.from('freedom-community/sealed-answer/v0')
export function stewardKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  return { privateKey, publicRawB64: raw.toString('base64') }
}
export function open(sealed, privateKey, stewardPubB64) {
  const epkRaw = Buffer.from(sealed.epk, 'base64')
  const epk = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), epkRaw]), format: 'der', type: 'spki' })
  const shared = diffieHellman({ privateKey, publicKey: epk })
  const salt = Buffer.concat([epkRaw, Buffer.from(stewardPubB64, 'base64')])
  const key = Buffer.from(hkdfSync('sha256', shared, salt, INFO, 32))
  const ct = Buffer.from(sealed.ct, 'base64')
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.nonce, 'base64'))
  d.setAAD(Buffer.from(sealed.aad))
  d.setAuthTag(ct.subarray(-16))
  return Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]).toString('utf8')
}
