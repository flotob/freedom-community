// The steward's view of Swarm: journals in, ledger and views out, adoption of content.
// Everything goes through one Bee-compatible node API (antd in production).
import { Bee, PrivateKey, Topic, Identifier, Bytes } from '@ethersphere/bee-js'
import { Binary } from 'cafe-utility'

const hex = (u8: Uint8Array) => Buffer.from(u8).toString('hex')
const strip = (h: string) => h.toLowerCase().replace(/^0x/, '')

export interface JournalEntry {
  owner: string
  index: number
  soc: string
  json: unknown
  /** The raw SOC chunk (id | sig | span | payload), kept for re-stamping. */
  raw: Uint8Array
}

export class Swarm {
  readonly url: string
  readonly batch: string
  readonly bee: Bee
  readonly key: PrivateKey
  readonly owner: string

  constructor(url: string, batch: string, keyHex: string) {
    this.url = url
    this.batch = batch
    this.bee = new Bee(url)
    this.key = new PrivateKey(strip(keyHex))
    this.owner = '0x' + this.key.publicKey().address().toHex()
  }

  /** Sequence-feed identifier: keccak256(topic || uint64be(index)). */
  static feedIdentifier(topicHex: string, index: number): Uint8Array {
    const idx = new Uint8Array(8)
    new DataView(idx.buffer).setBigUint64(0, BigInt(index))
    return Binary.keccak256(Binary.concatBytes(Binary.hexToUint8Array(strip(topicHex)), idx))
  }

  socAddress(owner: string, topicHex: string, index: number): string {
    return this.bee.calculateSingleOwnerChunkAddress(Swarm.feedIdentifier(topicHex, index), strip(owner)).toHex()
  }

  /** One journal entry, verified (the SOC's signature must recover `owner`), or null if absent. */
  async readJournal(owner: string, topicHex: string, index: number): Promise<JournalEntry | null> {
    const soc = this.socAddress(owner, topicHex, index)
    const r = await fetch(`${this.url}/chunks/${soc}`, { signal: AbortSignal.timeout(30_000) })
    if (r.status === 404 || r.status === 500) return null // not found (antd answers 500 for a retrieval miss)
    if (!r.ok) throw new Error(`GET /chunks/${soc} -> ${r.status}`)
    const raw = new Uint8Array(await r.arrayBuffer())
    const chunk = this.bee.unmarshalSingleOwnerChunk(raw, soc)
    if (chunk.owner.toHex() !== strip(owner)) throw new Error(`SOC ${soc} not signed by ${owner}`)
    let json: unknown
    try {
      json = JSON.parse(new TextDecoder().decode(chunk.payload.toUint8Array()))
    } catch {
      json = { invalid: true }
    }
    return { owner: '0x' + strip(owner), index, soc, json, raw }
  }

  /** Re-upload a member's SOC with the community batch, so it outlives their batch. */
  async restampSoc(entry: JournalEntry): Promise<void> {
    const id = entry.raw.subarray(0, 32)
    const sig = entry.raw.subarray(32, 97)
    const body = entry.raw.subarray(97) // span || payload
    const r = await fetch(`${this.url}/soc/${strip(entry.owner)}/${hex(id)}?sig=${hex(sig)}`, {
      method: 'POST',
      headers: { 'swarm-postage-batch-id': this.batch, 'content-type': 'application/octet-stream' },
      body,
      signal: AbortSignal.timeout(60_000),
    })
    if (!r.ok && r.status !== 409) throw new Error(`re-stamp SOC ${entry.soc} -> ${r.status} ${await r.text()}`)
  }

  /** Re-stamp a content tree on the community batch (PUT /stewardship, S3). */
  async adopt(ref: string): Promise<void> {
    await this.bee.pin.reuploadData(this.batch, ref)
  }

  /** Append a payload (<= 4 KiB) to one of the steward's sequence feeds at an explicit index. */
  async writeFeedPayload(topicHex: string, index: number, payload: Uint8Array | string): Promise<string> {
    const r = await this.bee.feed.makeWriter(strip(topicHex), this.key).uploadPayload(this.batch, payload, { index })
    return r.reference.toHex()
  }

  /** Publish a JSON document as a file and point the feed at it (views). */
  async publishJson(topicHex: string, doc: unknown, index?: number, name = 'view.json'): Promise<string> {
    const file = await this.bee.file.upload(this.batch, JSON.stringify(doc), name, { contentType: 'application/json' })
    // An explicit index skips the feed lookup, which costs seconds per update.
    await this.bee.feed.makeWriter(strip(topicHex), this.key).uploadReference(this.batch, file.reference, index === undefined ? {} : { index })
    return file.reference.toHex()
  }

  async readFeedPayload(owner: string, topicHex: string, index: number): Promise<Uint8Array | null> {
    try {
      const r = await this.bee.feed.makeReader(strip(topicHex), strip(owner)).downloadPayload({ index })
      return r.payload.toUint8Array()
    } catch {
      return null
    }
  }

  /** The next free index of one of our own feeds (one lookup; used when not tracked locally). */
  async nextFeedIndex(topicHex: string): Promise<number> {
    try {
      const r = await this.bee.feed.makeReader(strip(topicHex), strip(this.owner)).downloadPayload()
      return Number(r.feedIndexNext?.toBigInt() ?? r.feedIndex.toBigInt() + 1n)
    } catch {
      return 0
    }
  }

  async readFeedJson<T>(owner: string, topicHex: string): Promise<T | null> {
    try {
      const r = await this.bee.feed.makeReader(strip(topicHex), strip(owner)).downloadReference()
      return JSON.parse((await this.bee.file.download(r.reference)).data.toUtf8()) as T
    } catch {
      return null
    }
  }

  async createFeedManifest(topicHex: string, owner = this.owner): Promise<string> {
    return (await this.bee.feed.createManifest(this.batch, strip(topicHex), strip(owner))).toHex()
  }

  async uploadJson(doc: unknown, name: string): Promise<string> {
    return (await this.bee.file.upload(this.batch, JSON.stringify(doc), name, { contentType: 'application/json' })).reference.toHex()
  }

  async downloadJson<T>(ref: string): Promise<T> {
    return JSON.parse((await this.bee.file.download(ref)).data.toUtf8()) as T
  }

  /** GSOC doorbell, derived from the topic exactly as Freedom does (S2). */
  doorbellCoordinates(topic: string) {
    const utf8 = (s: string) => new TextEncoder().encode(s)
    const identifier = new Identifier(Binary.keccak256(utf8(topic)))
    const signer = this.bee.messaging.gsocMine(Binary.keccak256(utf8('freedom-gsoc-v1:' + topic)), identifier, 12)
    return { identifier, signer, owner: signer.publicKey().address() }
  }

  subscribeDoorbell(topic: string, onMessage: (text: string) => void, onError: (e: unknown) => void) {
    const { identifier, owner } = this.doorbellCoordinates(topic)
    let cancelled = false
    const sub = this.bee.messaging.gsocSubscribe(owner, identifier, {
      onMessage: (m) => onMessage(new Bytes(m).toUtf8()),
      onError: (e) => { if (!cancelled) onError(e) },
      onClose: () => { if (!cancelled) onError(new Error('doorbell subscription closed')) },
    })
    return { cancel: () => { cancelled = true; sub.cancel() } }
  }

  async ringDoorbell(topic: string, text: string): Promise<void> {
    const { identifier, signer } = this.doorbellCoordinates(topic)
    await this.bee.messaging.gsocSend(this.batch, signer, identifier, text)
  }
}

export { Topic }
