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
import { sha256Hex } from '@freedom-community/protocol'
import { audit } from './audit.ts'
import { answerAad, judge, openSealed, secretAad, type SealKey } from './seal.ts'
import { inboxView, leaderboardView, leaderboardsView, libraryView, librariesView, notificationsFor, questView, questsView, reviewView, type InboxItem } from './views.ts'
import type { Verdict } from '@freedom-community/protocol'

export interface StewardOptions {
  swarm: Swarm
  genesis: Record<string, unknown>
  dataDir: string
  pollMs?: number
  canaryMs?: number
  log?: (...a: unknown[]) => void
  /** Opens sealed quest answers and solutions (derived from the steward key). */
  sealKey?: SealKey
  /** How often to publish the `status` view (node and steward health); 0 disables it. */
  statusMs?: number
  /** This process's name in the status view (the liveness lease); random if unset. */
  instance?: string
  /** Wait as a standby while another instance's status is younger than this (default 3 status intervals). */
  takeoverMs?: number
}

export interface LedgerEntry { id: string; soc: string; receivedAt: number; ok: boolean; reason?: string; stateHash: string; verdict?: Verdict }

const PAGE_LIMIT = 3800 // bytes; a ledger page must fit one 4 KiB chunk
/** 1: views as bzz files. 2: views as raw blobs, post bodies embedded. 3: member views carry journal receipts. 4: member cards carry a bio line. 5: the index view. 6: seal key, quests, leaderboards. 7: community view lists leaderboards. 8: genesis view. 9: comments carry parent and avatar. 10: libraries. 11: follows, inboxes. */
const VIEW_FORMAT = 11
const RECEIPTS_KEPT = 20
const INBOX_KEPT = 50
/** Bodies larger than this stay out of views; the app reads them itself. */
const MAX_BODY_BYTES = 256 * 1024

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
  private lastCanary: { at: number; ms: number } | null = null
  private lastTickAt = 0
  private readonly startedAt = Date.now()
  readonly instance: string
  /** False while another instance holds the lease: nothing is written. */
  private active = false
  /** No usable local state at startup: rebuild it from the ledger before doing anything. */
  private fresh: boolean
  /** Journal chunks read this session, so re-stamping needs no second fetch. */
  private raw = new Map<string, JournalEntry>()
  /** Post and comment bodies by content reference (null: unavailable or hash mismatch). */
  private bodies = new Map<string, string | null>()
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
    this.instance = opts.instance ?? randomBytes(4).toString('hex')
    this.store = new Store(opts.dataDir)
    const saved = this.store.load()
    if (saved && !saved.viewIndex) saved.viewIndex = {}
    this.fresh = !(saved && saved.state.community.id === this.community)
    this.data = saved && !this.fresh
      ? saved
      : { genesisRef: null, state: initialState(opts.genesis), cursors: {}, ledgerPage: 0, pendingAdopt: [], pendingRestamp: [], views: {}, viewIndex: {} }
    if (normalizeAddress(String(opts.genesis.steward)) !== normalizeAddress(this.swarm.owner)) {
      throw new Error(`genesis steward ${opts.genesis.steward} is not this key (${this.swarm.owner})`)
    }
  }

  get state(): State { return this.data.state }

  /**
   * The status view doubles as a lease: the active steward republishes it every few
   * minutes. Returns the other instance that holds it, if its status is fresh.
   */
  private async leaseHolder(): Promise<{ instance: string; ageMs: number; everyMs: number } | null> {
    const doc = await this.swarm.readFeedJson<{ at?: number; writer?: { instance?: string; statusEveryMs?: number; released?: boolean } }>(this.swarm.owner, viewTopic(this.community, 'status'))
    const instance = doc?.writer?.instance
    if (!doc?.at || !instance || instance === this.instance || doc.writer?.released) return null
    const everyMs = doc.writer?.statusEveryMs ?? 300_000
    const ageMs = Date.now() - doc.at
    return ageMs < (this.opts.takeoverMs ?? 3 * everyMs) ? { instance, ageMs, everyMs } : null
  }

  async start(): Promise<void> {
    // Another steward with this key is active: wait as a standby until its lease lapses.
    for (let holder = await this.leaseHolder(); holder; holder = await this.leaseHolder()) {
      this.log(`standby: instance ${holder.instance} is active (status ${Math.round(holder.ageMs / 1000)} s old); checking again in 15 s`)
      await new Promise((r) => setTimeout(r, 15_000))
    }
    // The ledger may have moved on without us (another instance, or a crash before saving).
    if (!this.fresh && (await this.swarm.readFeedPayload(this.swarm.owner, this.ledgerTopic, this.data.ledgerPage))) {
      this.log(`the ledger is past our saved page ${this.data.ledgerPage}: replaying it instead of trusting the local state`)
      this.fresh = true
      this.data = { genesisRef: null, state: initialState(this.opts.genesis), cursors: {}, ledgerPage: 0, pendingAdopt: [], pendingRestamp: [], views: {}, viewIndex: {} }
    }
    this.active = true
    if (this.fresh) await this.recover()
    else if ((!this.data.receipts || !this.data.inbox) && this.data.genesisRef) await this.rebuildDerived()
    if ((this.data.viewFormat ?? 1) !== VIEW_FORMAT) {
      if (this.data.genesisRef) this.log(`view format ${this.data.viewFormat ?? 1} -> ${VIEW_FORMAT}: republishing every view`)
      this.allViewsDirty()
      this.data.viewFormat = VIEW_FORMAT
    }
    if (!this.data.genesisRef) {
      this.data.genesisRef = await this.swarm.uploadJson(this.opts.genesis, 'genesis.json')
      this.dirty.add('community')
      this.save()
      this.log('genesis published', this.data.genesisRef, 'community', this.community)
    }
    this.subscribe()
    const poll = this.opts.pollMs ?? 30_000
    this.timers.push(setInterval(() => this.tick('poll'), poll))
    if (this.opts.statusMs) {
      this.timers.push(setInterval(() => void this.publishStatus(), this.opts.statusMs))
      setTimeout(() => void this.publishStatus(), 30_000)
    }
    if (this.opts.canaryMs) this.timers.push(setInterval(() => { if (this.canary && Date.now() - this.canary.sentAt > 60_000) void this.ringCanary(); else if (!this.canary) void this.ringCanary() }, this.opts.canaryMs))
    await this.tick('start')
  }

  /**
   * The ledger on Swarm is the truth; the local file is a cache. Without it, replay our own
   * ledger exactly as an auditor would, and refuse to run if the replay disagrees with it.
   */
  private async recover(): Promise<void> {
    const first = await this.swarm.readFeedPayload(this.swarm.owner, this.ledgerTopic, 0)
    if (!first) return // a new community
    this.log('no local state: replaying our ledger from Swarm')
    this.data.inbox = {}
    this.data.inboxSeq = 0
    const r = await audit(this.swarm, this.swarm.owner, this.community, (...a) => this.log(...a), (prev, next, action, c) => { if (c.ok) this.notify(prev, next, action, c.author, c.id, c.at) })
    if (r.mismatches.length || !r.state) throw new Error(`ledger replay disagrees with the ledger (${JSON.stringify(r.mismatches.slice(0, 3))}); not starting`)
    this.data.genesisRef = (JSON.parse(new TextDecoder().decode(first)) as { genesis: string }).genesis
    this.data.state = r.state
    this.data.ledgerPage = r.pages
    this.data.cursors = r.cursors
    this.data.receipts = {}
    for (const e of r.log) this.receipt(e.owner, { index: e.index, type: e.type, ok: e.ok, reason: e.reason, at: e.receivedAt })
    // Views may lag the ledger if the previous run died between the two: rebuild them all.
    this.allViewsDirty()
    this.fresh = false
    this.save()
    this.log(`recovered: ${r.pages} ledger pages, ${r.entries} entries, state ${r.finalStateHash}`)
  }

  /** A state saved before receipts or inboxes existed: take them from a ledger replay. */
  private async rebuildDerived(): Promise<void> {
    this.data.inbox = {}
    this.data.inboxSeq = 0
    const r = await audit(this.swarm, this.swarm.owner, this.community, () => {}, (prev, next, action, c) => { if (c.ok) this.notify(prev, next, action, c.author, c.id, c.at) })
    if (r.mismatches.length) throw new Error(`ledger replay disagrees with the ledger (${JSON.stringify(r.mismatches.slice(0, 3))}); not starting`)
    this.data.receipts = {}
    for (const e of r.log) this.receipt(e.owner, { index: e.index, type: e.type, ok: e.ok, reason: e.reason, at: e.receivedAt })
    for (const owner of Object.keys(this.data.inbox)) this.dirty.add(`inbox/${owner}`)
    this.save()
    this.log(`receipts and inboxes rebuilt from ${r.entries} ledger entries`)
  }

  /** Append the notifications an accepted action causes to their recipients' inboxes. */
  private notify(prev: State, next: State, action: unknown, author: string, id: string, at: number): void {
    for (const n of notificationsFor(prev, next, action, { author, id })) {
      const { to, ...rest } = n
      const box = ((this.data.inbox ??= {})[to] ??= [])
      box.push({ id: (this.data.inboxSeq = (this.data.inboxSeq ?? 0) + 1), at, ...rest })
      if (box.length > INBOX_KEPT) box.splice(0, box.length - INBOX_KEPT)
      this.dirty.add(`inbox/${to}`)
    }
  }

  /** Remember an outcome for the author's member view (their app resolves "pending" with it). */
  private receipt(owner: string, r: { index: number; type: string; ok: boolean; reason?: string; at: number }): void {
    const all = (this.data.receipts ??= {})
    all[owner] = [...(all[owner] ?? []), r].slice(-RECEIPTS_KEPT)
    this.dirty.add(`member/${owner}`)
  }

  private allViewsDirty(): void {
    this.dirty.add('community').add('home').add('members').add('leaderboards').add('genesis')
    if (this.state.libraries) {
      this.dirty.add('libraries')
      for (const id of Object.keys(this.state.libraries)) this.dirty.add(`library/${id}`)
    }
    if (this.state.quests) {
      this.dirty.add('quests').add('review')
      for (const id of Object.keys(this.state.quests)) this.dirty.add(`quest/${id}`)
    }
    for (const id of Object.keys(this.state.posts)) this.dirty.add(`post/${id}`)
    for (const id of Object.keys(this.state.members)) this.dirty.add(`member/${id}`)
  }

  /** Fetch (once) the bodies the given references point at, checking each against its hash. */
  private async loadBodies(items: { ref?: string | null; hash?: string | null }[]): Promise<void> {
    await Promise.all(items.filter((i) => i.ref && !this.bodies.has(i.ref)).map(async ({ ref, hash }) => {
      try {
        const bytes = await this.swarm.readContent(ref!)
        const text = new TextDecoder().decode(bytes)
        const ok = bytes.length <= MAX_BODY_BYTES && (!hash || sha256Hex(text) === hash)
        if (!ok) this.log('body not embedded', ref, bytes.length > MAX_BODY_BYTES ? 'too large' : 'hash mismatch')
        this.bodies.set(ref!, ok ? text : null)
        // Images the body shows (bzz://<ref>) are content too: re-stamp them with the community batch.
        if (ok) for (const m of text.matchAll(/bzz:\/\/([0-9a-f]{64})/g)) this.data.pendingAdopt.push(m[1])
      } catch (e) {
        this.log('body read failed (will retry with the next view build)', ref, String(e))
      }
    }))
  }

  /**
   * The `status` view: the steward's own health and its node's, for the dashboard page.
   * Nothing in it is secret: balances and batches are public on chain.
   */
  /** On shutdown: publish a final status that releases the lease, so a standby takes over at once. */
  async release(): Promise<void> {
    if (!this.active) return
    this.released = true
    await this.publishStatus(true)
    this.active = false
  }
  private released = false

  private async publishStatus(final = false): Promise<void> {
    if (!this.active) return
    // Someone else published a status after ours: they hold the lease now; step down.
    const holder = await this.leaseHolder().catch(() => null)
    if (!final && holder && holder.ageMs < (this.opts.statusMs ?? 300_000)) {
      this.log(`instance ${holder.instance} published a newer status: stepping down to standby`)
      this.active = false
      this.stop()
      void this.start()
      return
    }
    const get = async <T>(path: string): Promise<T | null> => {
      try {
        const r = await fetch(`${this.swarm.url}${path}`, { signal: AbortSignal.timeout(20_000) })
        return r.ok ? ((await r.json()) as T) : null
      } catch {
        return null
      }
    }
    const [health, topology, wallet, chain, stamps] = await Promise.all([
      get<{ version?: string }>('/health'),
      get<{ connected?: number; population?: number; depth?: number }>('/topology'),
      get<{ bzzBalance?: string; nativeTokenBalance?: string; walletAddress?: string; chequebookContractAddress?: string }>('/wallet'),
      get<{ currentPrice?: string; block?: number }>('/chainstate'),
      get<{ stamps?: { batchID: string; label?: string; depth: number; utilization: number; usable: boolean; batchTTL: number }[] }>('/stamps'),
    ])
    const doc = {
      v: 0, kind: 'status', ...this.stamp(), at: Date.now(),
      steward: { ...this.status(), startedAt: this.startedAt, uptimeS: Math.round((Date.now() - this.startedAt) / 1000) },
      writer: { instance: this.instance, statusEveryMs: this.opts.statusMs ?? 300_000, ...(this.released ? { released: true } : {}) },
      node: {
        version: health?.version ?? null,
        connected: topology?.connected ?? null, population: topology?.population ?? null, depth: topology?.depth ?? null,
        wallet: wallet ? { bzz: wallet.bzzBalance ?? null, xdai: wallet.nativeTokenBalance ?? null, address: wallet.walletAddress ?? null, chequebook: wallet.chequebookContractAddress ?? null } : null,
        price: chain?.currentPrice ?? null, block: chain?.block ?? null,
        stamps: (stamps?.stamps ?? []).map((b) => ({ batchID: b.batchID, label: b.label ?? '', depth: b.depth, utilization: b.utilization, usable: b.usable, ttlDays: Math.round((b.batchTTL / 86400) * 10) / 10, community: b.batchID === this.swarm.batch })),
      },
    }
    try {
      const topic = viewTopic(this.community, 'status')
      const index = this.data.viewIndex[topic] ?? (await this.swarm.nextFeedIndex(topic))
      this.data.views.status = await this.swarm.publishJson(topic, doc, index)
      this.data.viewIndex[topic] = index + 1
      await this.publishIndex(this.stamp())
      this.save()
    } catch (e) {
      this.log('status publish failed', String(e))
    }
  }

  status() {
    return {
      community: this.community,
      steward: this.swarm.owner,
      ledgerPage: this.data.ledgerPage,
      stateHash: stateHash(this.state),
      members: Object.keys(this.state.members).length,
      posts: Object.keys(this.state.posts).length,
      lastTickAt: this.lastTickAt,
      lastCanary: this.lastCanary,
      canaryMisses: this.canaryMisses,
      pendingAdopt: this.data.pendingAdopt.length,
      pendingRestamp: this.data.pendingRestamp.length,
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    this.sub?.cancel()
    this.sub = null
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
      this.lastCanary = { at: Date.now(), ms: Date.now() - this.canary.sentAt }
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
    if (!this.active) return
    if (this.busy) { if (reason !== 'poll') setTimeout(() => this.tick(reason), 500); return }
    this.busy = true
    try {
      const owners = reason === 'doorbell' ? [...this.queue] : [...new Set([...Object.keys(this.state.members), ...this.queue])]
      this.queue.clear()
      for (const owner of owners.sort()) await this.ingest(owner)
      await this.flush()
      await this.retryPending()
      this.lastTickAt = Date.now()
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
    const verdict = this.verdictFor(entry)
    const prev = this.state
    const { state, outcome } = reduce(this.state, entry.json, { author: entry.owner, index: entry.index, receivedAt, verdict })
    this.data.state = state
    this.data.cursors[entry.owner] = entry.index + 1
    this.receipt(entry.owner, { index: entry.index, type: String((entry.json as { type?: string })?.type ?? '?'), ok: outcome.ok, reason: outcome.ok ? undefined : outcome.reason, at: receivedAt })
    const hash = stateHash(state)
    this.pending.push(outcome.ok
      ? { id: outcome.id, soc: entry.soc, receivedAt, ok: true, stateHash: hash, ...(verdict ? { verdict } : {}) }
      : { id: outcome.id, soc: entry.soc, receivedAt, ok: false, reason: outcome.reason, stateHash: hash })
    this.data.pendingRestamp.push({ owner: entry.owner, index: entry.index })
    this.raw.set(`${entry.owner}:${entry.index}`, entry)
    if (outcome.ok) {
      for (const e of outcome.effects) this.data.pendingAdopt.push(e.ref)
      const j = entry.json as { type: string; body?: Record<string, unknown> }
      for (const v of dirtyFor(j.type, entry.owner, j.body ?? {}, outcome.id, state)) this.dirty.add(v)
      this.notify(prev, state, entry.json, entry.owner, outcome.id, receivedAt)
    }
    this.log(outcome.ok ? 'accepted' : `rejected (${outcome.reason})`, outcome.id, (entry.json as { type?: string })?.type)
  }

  /** Solutions opened so far, per quest. */
  private secrets = new Map<string, { solutions?: string[]; correct?: string[] } | null>()

  /**
   * The verdict on a sealed answer, if this is one and the steward can judge it. Nothing
   * here is trusted by the reducer beyond approve/reject; a replay takes it from the ledger.
   */
  private verdictFor(entry: JournalEntry): Verdict | undefined {
    const j = entry.json as { type?: string; body?: { quest?: string; answer?: { sealed?: unknown } } }
    if (j?.type !== 'quest.submit' || !j.body?.answer?.sealed || !this.opts.sealKey || typeof j.body.quest !== 'string') return undefined
    const quest = this.state.quests?.[j.body.quest]
    if (!quest?.secret) return undefined
    try {
      if (!this.secrets.has(quest.id)) {
        try {
          this.secrets.set(quest.id, JSON.parse(openSealed(quest.secret, this.opts.sealKey, secretAad(this.community, quest.author))))
        } catch (e) {
          this.log('quest secret unreadable', quest.id, String(e))
          this.secrets.set(quest.id, null)
        }
      }
      const secret = this.secrets.get(quest.id)
      if (!secret) return undefined // reviewers decide
      const opened = JSON.parse(openSealed(j.body.answer.sealed as never, this.opts.sealKey, answerAad(this.community, quest.id, entry.owner)))
      return judge(quest, secret, opened)
    } catch (e) {
      // an answer sealed for someone else's submission, or garbage: a wrong answer
      this.log('sealed answer rejected', `${entry.owner}:${entry.index}`, String((e as Error).message ?? e))
      return { approved: false }
    }
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
      } else if (d === 'leaderboards') {
        names.add('leaderboards')
        for (const l of s.community.leaderboards ?? []) names.add(`leaderboard/${l.id}`)
      } else names.add(d)
    }
    this.dirty.clear()
    const docs: { name: string; doc: unknown }[] = []
    for (const name of names) {
      if (name === 'community') docs.push({ name, doc: { ...communityView(s, stamp), sealKey: this.opts.sealKey?.publicB64 ?? null } })
      else if (name === 'genesis') docs.push({ name, doc: this.opts.genesis }) // self-certifying: hashes to the community id
      else if (name === 'quests') docs.push({ name, doc: questsView(s, stamp) })
      else if (name === 'libraries') docs.push({ name, doc: librariesView(s, stamp) })
      else if (name.startsWith('inbox/')) docs.push({ name, doc: inboxView(name.slice(6), (this.data.inbox?.[name.slice(6)] ?? []) as InboxItem[], stamp) })
      else if (name.startsWith('library/')) { const doc = libraryView(s, name.slice(8), stamp); if (doc) docs.push({ name, doc }) }
      else if (name === 'review') docs.push({ name, doc: reviewView(s, stamp) })
      else if (name === 'leaderboards') docs.push({ name, doc: leaderboardsView(s, stamp) })
      else if (name.startsWith('leaderboard/')) { const doc = leaderboardView(s, name.slice(12), stamp); if (doc) docs.push({ name, doc }) }
      else if (name.startsWith('quest/')) { const doc = questView(s, name.slice(6), stamp); if (doc) docs.push({ name, doc }) }
      else if (name === 'home') docs.push(...homeViews(s, stamp))
      else if (name === 'members') docs.push({ name, doc: membersView(s, stamp) })
      else if (name.startsWith('post/')) {
        const p = s.posts[name.slice(5)]
        if (p) await this.loadBodies([{ ref: p.content, hash: p.contentHash }, ...p.comments.map((c) => ({ ref: s.comments[c]?.content, hash: s.comments[c]?.contentHash }))])
        const doc = postView(s, name.slice(5), stamp, (ref) => (ref ? this.bodies.get(ref) ?? null : null))
        if (doc) docs.push({ name, doc })
      }
      else if (name.startsWith('member/')) {
        const owner = name.slice(7)
        const recent = this.data.receipts?.[owner]
        const doc = memberView(s, owner, stamp, recent ? { next: this.data.cursors[owner] ?? 0, recent } : undefined)
        if (doc) docs.push({ name, doc })
      }
    }
    await Promise.all(docs.map(async ({ name, doc }) => {
      const topic = viewTopic(this.community, name)
      const index = this.data.viewIndex[topic] ?? (await this.swarm.nextFeedIndex(topic))
      this.data.views[name] = await this.swarm.publishJson(topic, doc, index)
      this.data.viewIndex[topic] = index + 1
    }))
    this.log(`views published: ${docs.map((d) => d.name).join(', ')}`)
    if (docs.length) await this.publishIndex(stamp)
  }

  /**
   * The `index` view: every view's latest feed index. A latest-entry lookup costs seconds
   * in a light node, an exact-index read a fraction of that, so the app reads this once and
   * then reads the other views by index.
   */
  private async publishIndex(stamp: ViewStamp): Promise<void> {
    const views: Record<string, number> = {}
    for (const name of Object.keys(this.data.views)) {
      const next = this.data.viewIndex[viewTopic(this.community, name)]
      if (next !== undefined) views[name] = next - 1
    }
    const topic = viewTopic(this.community, 'index')
    const index = this.data.viewIndex[topic] ?? (await this.swarm.nextFeedIndex(topic))
    await this.swarm.publishJson(topic, { v: 0, kind: 'index', ...stamp, views }, index)
    this.data.viewIndex[topic] = index + 1
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
