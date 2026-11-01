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
}

export async function audit(swarm: Swarm, steward: string, community: string, log = (..._a: unknown[]) => {}): Promise<AuditReport> {
  const ledgerTopic = stewardTopic(community, 'ledger')
  const report: AuditReport = { community, pages: 0, entries: 0, accepted: 0, rejected: 0, mismatches: [], finalStateHash: null, state: null }
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
      const entry = await swarm.readJournal(owner, journal, index)
      if (!entry) { report.mismatches.push({ id: e.id, problem: 'journal entry missing' }); continue }
      if (entry.soc !== e.soc) report.mismatches.push({ id: e.id, problem: 'SOC address differs' })
      const r = reduce(state, entry.json, { author: owner, index, receivedAt: e.receivedAt })
      state = r.state
      if (r.outcome.ok !== e.ok || (!r.outcome.ok && r.outcome.reason !== e.reason)) report.mismatches.push({ id: e.id, problem: `outcome differs: replay ${JSON.stringify(r.outcome)}` })
      if (stateHash(state) !== e.stateHash) report.mismatches.push({ id: e.id, problem: 'state hash differs' })
      if (r.outcome.ok) report.accepted += 1
      else report.rejected += 1
    }
    log(`page ${p}: ${page.entries.length} entries`)
  }
  report.finalStateHash = stateHash(state)
  report.state = state
  return report
}
