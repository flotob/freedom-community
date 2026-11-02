// Replay a community's ledger from Swarm alone and check every outcome and state hash.
// Needs no steward state and no keys: anyone can run it.
import { communityId, initialState, journalTopic, reduce, stateHash, stewardTopic, type State } from '@freedom-community/protocol'
import { Swarm } from './swarm.ts'
import type { LedgerEntry } from './steward.ts'

export interface AuditReport {
  community: string
  pages: number
  entries: number
  accepted: number
  rejected: number
  mismatches: { id: string; problem: string }[]
  finalStateHash: string | null
  state: State | null
  /** Next journal index per author, as the steward tracks it. */
  cursors: Record<string, number>
  /** Every replayed entry in ledger order. */
  log: { owner: string; index: number; type: string; ok: boolean; reason?: string; receivedAt: number }[]
}

/** Called for every replayed entry with the state before and after it (for derived data such as inboxes). */
export type ReplayHook = (prev: State, next: State, action: unknown, ctx: { author: string; id: string; at: number; ok: boolean }) => void

export async function audit(swarm: Swarm, steward: string, community: string, log = (..._a: unknown[]) => {}, onEntry?: ReplayHook): Promise<AuditReport> {
  const ledgerTopic = stewardTopic(community, 'ledger')
  const report: AuditReport = { community, pages: 0, entries: 0, accepted: 0, rejected: 0, mismatches: [], finalStateHash: null, state: null, cursors: {}, log: [] }
  const first = await swarm.readFeedPayload(steward, ledgerTopic, 0)
  if (!first) throw new Error('no ledger page 0')
  const page0 = JSON.parse(new TextDecoder().decode(first)) as { genesis: string }
  const genesis = await swarm.downloadJson<Record<string, unknown>>(page0.genesis)
  if (communityId(genesis) !== community) throw new Error('genesis does not hash to the community id')
  let state = initialState(genesis)
  const journal = journalTopic(String(genesis.origin))
  for (let p = 0; ; p++) {
    const raw = p === 0 ? first : await swarm.readFeedPayload(steward, ledgerTopic, p)
    if (!raw) break
    const page = JSON.parse(new TextDecoder().decode(raw)) as { c: string; page: number; entries: LedgerEntry[] }
    if (page.c !== community || page.page !== p) report.mismatches.push({ id: `page ${p}`, problem: 'page header mismatch' })
    report.pages += 1
    for (const e of page.entries) {
      report.entries += 1
      const [owner, idx] = e.id.split(':')
      const index = Number(idx)
      report.cursors[owner] = Math.max(report.cursors[owner] ?? 0, index + 1)
      const entry = await swarm.readJournal(owner, journal, index)
      if (!entry) { report.mismatches.push({ id: e.id, problem: 'journal entry missing' }); continue }
      if (entry.soc !== e.soc) report.mismatches.push({ id: e.id, problem: 'SOC address differs' })
      const r = reduce(state, entry.json, { author: owner, index, receivedAt: e.receivedAt, verdict: e.verdict })
      onEntry?.(state, r.state, entry.json, { author: owner, id: e.id, at: e.receivedAt, ok: r.outcome.ok })
      state = r.state
      if (r.outcome.ok !== e.ok || (!r.outcome.ok && r.outcome.reason !== e.reason)) report.mismatches.push({ id: e.id, problem: `outcome differs: replay ${JSON.stringify(r.outcome)}` })
      if (stateHash(state) !== e.stateHash) report.mismatches.push({ id: e.id, problem: 'state hash differs' })
      report.log.push({ owner, index, type: String((entry.json as { type?: string })?.type ?? '?'), ok: e.ok, reason: e.reason, receivedAt: e.receivedAt })
      if (r.outcome.ok) report.accepted += 1
      else report.rejected += 1
    }
    log(`page ${p}: ${page.entries.length} entries`)
  }
  report.finalStateHash = stateHash(state)
  report.state = state
  return report
}
