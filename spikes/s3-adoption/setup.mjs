// Spike S3 setup: two blobs on a short-lived "member" batch. The steward adopts one
// (PUT /stewardship on the community batch); the other is the control. After the
// member batch expires, check.mjs expects the adopted blob to survive and the control to fade.
//   BEE_URL=... MEMBER_BATCH=<short-lived> COMMUNITY_BATCH=<long-lived> node setup.mjs
import { Bee } from '@ethersphere/bee-js'
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const bee = new Bee(process.env.BEE_URL || 'http://localhost:1733')
const { MEMBER_BATCH, COMMUNITY_BATCH } = process.env
const member = await (await fetch(`${bee.url}/stamps/${MEMBER_BATCH}`)).json()
const mk = async (label) => {
  const data = randomBytes(100 * 1024) // ~25 chunks plus intermediate chunks: tests re-stamping a whole tree
  const ref = (await bee.data.upload(MEMBER_BATCH, data)).reference.toHex()
  return { label, ref, sha256: (await import('node:crypto')).createHash('sha256').update(data).digest('hex'), bytes: data.length }
}
const adopted = await mk('adopted')
const control = await mk('control')
const t0 = Date.now()
await bee.pin.reuploadData(COMMUNITY_BATCH, adopted.ref)
adopted.restampMs = Date.now() - t0
const out = {
  at: new Date().toISOString(),
  memberBatch: MEMBER_BATCH,
  memberBatchExpiresApprox: new Date(Date.now() + member.batchTTL * 1000).toISOString(),
  communityBatch: COMMUNITY_BATCH,
  blobs: [adopted, control],
  // also from S7: a 10 KiB blob on the member batch that was re-stamped on the community batch
  extra: [{ label: 'adopted (S7)', ref: '4ed15972cc4fe60d3699d0480f25870f428544f94ccd5a168b31e732ed0ab2fa' }, { label: 'control (smoke test)', ref: 'ef133689e6aeea442883c135e76e6b6f0792af51c0bc6189de9bbe8736599d35' }],
}
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'setup.json'), JSON.stringify(out, null, 2) + '\n')
console.log(JSON.stringify(out, null, 2))
