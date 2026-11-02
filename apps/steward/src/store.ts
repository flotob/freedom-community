// The steward's local working copy. The ledger on Swarm is the truth; this file only
// saves the steward from replaying everything on restart.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { State } from '@freedom-community/protocol'

export interface StoreData {
  genesisRef: string | null
  state: State
  /** Next journal index to read, per member. */
  cursors: Record<string, number>
  /** Next ledger page index. */
  ledgerPage: number
  /** Content and SOC re-stamps still to do (retried until they succeed). */
  pendingAdopt: string[]
  pendingRestamp: { owner: string; index: number }[]
  views: Record<string, string>
  /** Next feed index per view topic (skips feed lookups). */
  viewIndex: Record<string, number>
  /** Shape of the published views; a steward with a newer shape republishes them all. */
  viewFormat?: number
  /** Recent outcomes per journal author, newest last (published in member views). */
  receipts?: Record<string, Receipt[]>
  /** Notifications per member, newest last (published as inbox/<owner>). */
  inbox?: Record<string, { id: number; at: number; kind: string; actor: string | null; subject: string | null; target: unknown }[]>
  inboxSeq?: number
  /** Quests whose sealed solutions and answers have been revealed (after closing). */
  revealed?: Record<string, true>
}

/** What became of one journal entry: the app's "pending" resolves against these. */
export interface Receipt { index: number; type: string; ok: boolean; reason?: string; at: number }

export class Store {
  readonly path: string
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.path = join(dir, 'steward-state.json')
  }
  load(): StoreData | null {
    return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, 'utf8')) as StoreData) : null
  }
  save(data: StoreData): void {
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(data))
    renameSync(tmp, this.path)
  }
}
