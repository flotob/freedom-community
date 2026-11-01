// The steward loop: ingest journals (doorbell + slow polling), reduce, append the ledger,
// publish views, adopt content. One community per steward.
import { randomBytes } from 'node:crypto'
import {
  communityId, doorbellTopic, initialState, journalTopic, reduce, stateHash, stewardTopic, normalizeAddress,
  type State,
} from '@freedom-community/protocol'
import { Swarm, type JournalEntry } from './swarm.ts'
import { Store, type StoreData } from './store.ts'
import { communityView, dirtyFor, homeViews, memberView, membersView, postView, viewTopic, type ViewStamp } from './views.ts'

export interface StewardOptions {
  swarm: Swarm
  genesis: Record<string, unknown>
  dataDir: string
  pollMs?: number
  canaryMs?: number
  log?: (...a: unknown[]) => void
}

export interface LedgerEntry { id: string; soc: string; receivedAt: number; ok: boolean; reason?: string; stateHash: string }

const PAGE_LIMIT = 3800 // bytes; a ledger page must fit one 4 KiB chunk

export class Steward {
  readonly swarm: Swarm
  readonly community: string
  readonly journal: string
  readonly ledgerTopic: string
  readonly doorbell: string
  private data: StoreData
  private store: Store
  private queue = new Set<string>()
  private pending: LedgerEntry[] = []
  private dirty = new Set<string>()
  private busy = false
  private timers: NodeJS.Timeout[] = []
  private sub: { cancel(): void } | null = null
  private canary: { nonce: string; sentAt: number } | null = null
  private canaryMisses = 0
  /** Journal chunks read this session, so re-stamping needs no second fetch. */
  private raw = new Map<string, JournalEntry>()
  readonly log: (...a: unknown[]) => void
  private opts: StewardOptions

  constructor(opts: StewardOptions) {
    this.opts = opts
    this.swarm = opts.swarm
    this.log = opts.log ?? ((...a) => console.log(new Date().toISOString(), '[steward]', ...a))
    this.community = communityId(opts.genesis)
    const origin = String(opts.genesis.origin)
    this.journal = journalTopic(origin)
    this.ledgerTopic = stewardTopic(this.community, 'ledger')
    this.doorbell = doorbellTopic(this.community)
    this.store = new Store(opts.dataDir)
    const saved = this.store.load()
    if (saved && !saved.viewIndex) saved.viewIndex = {}
    this.data = saved && saved.state.community.id === this.community
      ? saved
      : { genesisRef: null, state: initialState(opts.genesis), cursors: {}, ledgerPage: 0, pendingAdopt: [], pendingRestamp: [], views: {}, viewIndex: {} }
    if (normalizeAddress(String(opts.genesis.steward)) !== normalizeAddress(this.swarm.owner)) {
      throw new Error(`genesis steward ${opts.genesis.steward} is not this key (${this.swarm.owner})`)
    }
  }

  get state(): State { return this.data.state }

  async start(): Promise<void> {
    if (!this.data.genesisRef) {
      this.data.genesisRef = await this.swarm.uploadJson(this.opts.genesis, 'genesis.json')
      this.dirty.add('community')
      this.save()
      this.log('genesis published', this.data.genesisRef, 'community', this.community)
    }
    this.subscribe()
    const poll = this.opts.pollMs ?? 30_000
    this.timers.push(setInterval(() => this.tick('poll'), poll))
    if (this.opts.canaryMs) this.timers.push(setInterval(() => { if (this.canary && Date.now() - this.canary.sentAt > 60_000) void this.ringCanary(); else if (!this.canary) void this.ringCanary() }, this.opts.canaryMs))
    await this.tick('start')
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t)
    this.sub?.cancel()
  }

  private subscribe(): void {
    this.sub?.cancel()
    this.sub = this.swarm.subscribeDoorbell(this.doorbell, (text) => this.onDoorbell(text), (e) => this.log('doorbell error', String((e as Error)?.message ?? e)))
    this.log('doorbell subscribed', this.doorbell)
    // antd's lurker tails live: a ring sent before it is resident is lost, so give it time.
    this.canary = null
    if (this.opts.canaryMs) setTimeout(() => void this.ringCanary(), 20_000)
  }

  private onDoorbell(text: string): void {
    let msg: { owner?: string; canary?: string }
    try { msg = JSON.parse(text) } catch { return }
    if (msg.canary && this.canary?.nonce === msg.canary) {
      this.log(`canary back after ${Date.now() - this.canary.sentAt} ms`)
      this.canary = null
      this.canaryMisses = 0
      return
    }
    if (typeof msg.owner === 'string' && /^0x[0-9a-fA-F]{40}$/.test(msg.owner)) {
      this.queue.add(normalizeAddress(msg.owner))
      void this.tick('doorbell')
    }
  }

  private async ringCanary(): Promise<void> {
    if (this.canary) {
      this.canaryMisses += 1
      this.log(`canary missed (${this.canaryMisses}); re-subscribing`)
      this.subscribe() // rings a fresh canary 20 s later
      return
    }
    this.canary = { nonce: randomBytes(6).toString('hex'), sentAt: Date.now() }
    await this.swarm.ringDoorbell(this.doorbell, JSON.stringify({ canary: this.canary.nonce })).catch((e) => this.log('canary send failed', String(e)))
  }

  /** Read new journal entries for the queued owners (doorbell) or everyone (poll). */
  async tick(reason: string): Promise<void> {
    if (this.busy) { if (reason !== 'poll') setTimeout(() => this.tick(reason), 500); return }
    this.busy = true
    try {
      const owners = reason === 'doorbell' ? [...this.queue] : [...new Set([...Object.keys(this.state.members), ...this.queue])]
      this.queue.clear()
      for (const owner of owners.sort()) await this.ingest(owner)
      await this.flush()
      await this.retryPending()
    } catch (e) {
      this.log('tick failed', String((e as Error)?.stack ?? e))
    } finally {
      this.busy = false
    }
  }

  private async ingest(owner: string): Promise<void> {
    for (;;) {
      const index = this.data.cursors[owner] ?? 0
      const entry = await this.swarm.readJournal(owner, this.journal, index).catch((e) => { this.log('read failed', owner, index, String(e)); return null })
      if (!entry) return
      // Strangers get one way in: a join. Anything else from a non-member is not even recorded.
      if (!this.state.members[owner] && (entry.json as { type?: string })?.type !== 'member.join') {
        this.data.cursors[owner] = index + 1
        continue
      }
      this.apply(entry)
    }
  }

  private apply(entry: JournalEntry): void {
    const receivedAt = Date.now()
    const { state, outcome } = reduce(this.state, entry.json, { author: entry.owner, index: entry.index, receivedAt })
    this.data.state = state
    this.data.cursors[entry.owner] = entry.index + 1
    const hash = stateHash(state)
    this.pending.push(outcome.ok
      ? { id: outcome.id, soc: entry.soc, receivedAt, ok: true, stateHash: hash }
      : { id: outcome.id, soc: entry.soc, receivedAt, ok: false, reason: outcome.reason, stateHash: hash })
    this.data.pendingRestamp.push({ owner: entry.owner, index: entry.index })
    this.raw.set(`${entry.owner}:${entry.index}`, entry)
    if (outcome.ok) {
      for (const e of outcome.effects) this.data.pendingAdopt.push(e.ref)
      const j = entry.json as { type: string; body?: Record<string, unknown> }
      for (const v of dirtyFor(j.type, entry.owner, j.body ?? {}, outcome.id)) this.dirty.add(v)
    }
    this.log(outcome.ok ? 'accepted' : `rejected (${outcome.reason})`, outcome.id, (entry.json as { type?: string })?.type)
  }

  /** Write pending ledger entries as pages, then republish dirty views, then save. */
  private async flush(): Promise<void> {
    while (this.pending.length) {
      const page = { v: 0, c: this.community, genesis: this.data.genesisRef, page: this.data.ledgerPage, entries: [] as LedgerEntry[] }
      while (this.pending.length && JSON.stringify({ ...page, entries: [...page.entries, this.pending[0]] }).length <= PAGE_LIMIT) {
        page.entries.push(this.pending.shift()!)
      }
      if (!page.entries.length) throw new Error('ledger entry too large for a page')
      await this.swarm.writeFeedPayload(this.ledgerTopic, page.page, JSON.stringify(page))
      this.log(`ledger page ${page.page} (${page.entries.length} entries)`)
      this.data.ledgerPage += 1
      this.save()
    }
    if (this.dirty.size) await this.publishViews()
    this.save()
  }

  private stamp(): ViewStamp {
    return { ledgerPage: this.data.ledgerPage - 1, stateHash: stateHash(this.state), builtAt: Date.now() }
  }

  private async publishViews(): Promise<void> {
    const s = this.state
    const stamp = this.stamp()
    const names = new Set<string>()
    for (const d of this.dirty) {
      if (d.startsWith('post/')) {
        const id = d.slice(5)
        names.add(`post/${s.comments[id]?.post ?? id}`)
      } else names.add(d)
    }
    this.dirty.clear()
    const docs: { name: string; doc: unknown }[] = []
    for (const name of names) {
      if (name === 'community') docs.push({ name, doc: communityView(s, stamp) })
      else if (name === 'home') docs.push(...homeViews(s, stamp))
      else if (name === 'members') docs.push({ name, doc: membersView(s, stamp) })
      else if (name.startsWith('post/')) { const doc = postView(s, name.slice(5), stamp); if (doc) docs.push({ name, doc }) }
      else if (name.startsWith('member/')) { const doc = memberView(s, name.slice(7), stamp); if (doc) docs.push({ name, doc }) }
    }
    await Promise.all(docs.map(async ({ name, doc }) => {
      const topic = viewTopic(this.community, name)
      const index = this.data.viewIndex[topic] ?? (await this.swarm.nextFeedIndex(topic))
      this.data.views[name] = await this.swarm.publishJson(topic, doc, index)
      this.data.viewIndex[topic] = index + 1
    }))
    this.log(`views published: ${docs.map((d) => d.name).join(', ')}`)
  }

  private async retryPending(): Promise<void> {
    const adopt = [...new Set(this.data.pendingAdopt)]
    this.data.pendingAdopt = []
    for (const ref of adopt) {
      await this.swarm.adopt(ref).catch((e) => { this.data.pendingAdopt.push(ref); this.log('adopt failed (will retry)', ref, String(e)) })
    }
    const restamp = this.data.pendingRestamp
    this.data.pendingRestamp = []
    for (const r of restamp) {
      const key = `${r.owner}:${r.index}`
      const entry = this.raw.get(key) ?? (await this.swarm.readJournal(r.owner, this.journal, r.index).catch(() => null))
      if (!entry) { this.data.pendingRestamp.push(r); continue }
      const ok = await this.swarm.restampSoc(entry).then(() => true, (e) => { this.log('re-stamp failed (will retry)', r, String(e)); return false })
      if (ok) this.raw.delete(key)
      else this.data.pendingRestamp.push(r)
    }
    this.save()
  }

  private save(): void { this.store.save(this.data) }
}
