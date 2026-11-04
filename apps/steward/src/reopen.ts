// Keeps a subscription open. When it errors or closes (antd restarted, socket dropped),
// it is re-opened after a backoff instead of waiting for the canary to notice: 5 s,
// doubling to 60 s while it keeps failing, back to 5 s once a message arrives.
// Canary accounting is left alone, so a doorbell that is open but deaf still shows up
// as missed canaries.

export interface Subscription { cancel(): void }
export type Opener = (onMessage: (text: string) => void, onError: (e: unknown) => void) => Subscription

export function keepOpen(
  open: Opener,
  onMessage: (text: string) => void,
  log: (...a: unknown[]) => void,
  { minMs = 5_000, maxMs = 60_000 }: { minMs?: number; maxMs?: number } = {},
): Subscription {
  let current: Subscription | null = null
  let timer: NodeJS.Timeout | null = null
  let delay = minMs
  let stopped = false
  const start = () => {
    let mine: Subscription | null = null
    let failed = false
    const onError = (e: unknown) => {
      log('doorbell error', String((e as Error)?.message ?? e))
      if (mine === null) { failed = true; return } // failed while opening
      retry(mine)
    }
    mine = open((text) => { delay = minMs; onMessage(text) }, onError)
    current = mine
    if (failed) retry(mine)
  }
  const retry = (sub: Subscription) => {
    if (stopped || sub !== current || timer) return
    const wait = delay
    delay = Math.min(delay * 2, maxMs)
    timer = setTimeout(() => {
      timer = null
      if (stopped || sub !== current) return
      sub.cancel()
      start()
      log(`doorbell re-opened after ${wait} ms`)
    }, wait)
  }
  start()
  return {
    cancel() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      current?.cancel()
    },
  }
}
