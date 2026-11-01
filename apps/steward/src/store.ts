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
}

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
