// S5: seal a quest answer to the steward's X25519 public key with WebCrypto only.
// Format v0: X25519 ECDH (ephemeral key) -> HKDF-SHA256 -> AES-256-GCM, AAD binds the context.
const INFO = new TextEncoder().encode('freedom-community/sealed-answer/v0')
const b64 = (u8) => btoa(String.fromCharCode(...u8))
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
window.s5 = {
  env() {
    return { secureContext: window.isSecureContext, subtle: Boolean(window.crypto?.subtle), origin: location.origin, protocol: location.protocol }
  },
  async seal(stewardPubB64, answer, aadText) {
    const subtle = crypto.subtle
    const stewardPub = await subtle.importKey('raw', unb64(stewardPubB64), { name: 'X25519' }, false, [])
    const eph = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])
    const shared = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: stewardPub }, eph.privateKey, 256))
    const epk = new Uint8Array(await subtle.exportKey('raw', eph.publicKey))
    const salt = new Uint8Array([...epk, ...unb64(stewardPubB64)])
    const hk = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
    const key = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: INFO }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt'])
    const nonce = crypto.getRandomValues(new Uint8Array(12))
    const aad = new TextEncoder().encode(aadText)
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, new TextEncoder().encode(answer)))
    return { v: 0, alg: 'X25519-HKDF-SHA256-A256GCM', epk: b64(epk), nonce: b64(nonce), ct: b64(ct), aad: aadText }
  },
}
document.getElementById('out').textContent = JSON.stringify(window.s5.env())
