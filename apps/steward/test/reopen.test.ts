// The doorbell re-opens itself after antd drops the subscription, with backoff.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { keepOpen, type Opener } from '../src/reopen.ts'

function fakeSwarm() {
  const subs: { onMessage: (t: string) => void; onError: (e: unknown) => void; cancelled: boolean }[] = []
  const open: Opener = (onMessage, onError) => {
    const s = { onMessage, onError, cancelled: false }
    subs.push(s)
    return { cancel: () => { s.cancelled = true } }
  }
  return { subs, open }
}

test('re-opens after a close, backing off and resetting on a message', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { subs, open } = fakeSwarm()
    const got: string[] = []
    const sub = keepOpen(open, (t) => got.push(t), () => {})
    assert.equal(subs.length, 1)

    subs[0].onError(new Error('doorbell subscription closed'))
    subs[0].onError(new Error('again')) // a second error on the same socket schedules nothing new
    mock.timers.tick(4_999)
    assert.equal(subs.length, 1)
    mock.timers.tick(1)
    assert.equal(subs.length, 2)
    assert.equal(subs[0].cancelled, true)

    subs[1].onError(new Error('closed')) // still failing: 10 s
    mock.timers.tick(9_999)
    assert.equal(subs.length, 2)
    mock.timers.tick(1)
    assert.equal(subs.length, 3)

    subs[2].onMessage('{"canary":"x"}') // working again: back to 5 s
    assert.deepEqual(got, ['{"canary":"x"}'])
    subs[2].onError(new Error('closed'))
    mock.timers.tick(5_000)
    assert.equal(subs.length, 4)

    sub.cancel()
    assert.equal(subs[3].cancelled, true)
  } finally {
    mock.timers.reset()
  }
})

test('backoff caps at 60 s', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { subs, open } = fakeSwarm()
    keepOpen(open, () => {}, () => {})
    for (const wait of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
      const n = subs.length
      subs[n - 1].onError(new Error('closed'))
      mock.timers.tick(wait - 1)
      assert.equal(subs.length, n)
      mock.timers.tick(1)
      assert.equal(subs.length, n + 1)
    }
  } finally {
    mock.timers.reset()
  }
})

test('cancel stops a pending re-open; errors from replaced sockets are ignored', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { subs, open } = fakeSwarm()
    const sub = keepOpen(open, () => {}, () => {})
    subs[0].onError(new Error('closed'))
    mock.timers.tick(5_000)
    assert.equal(subs.length, 2)
    subs[0].onError(new Error('late error from the old socket'))
    mock.timers.tick(60_000)
    assert.equal(subs.length, 2)

    subs[1].onError(new Error('closed'))
    sub.cancel()
    mock.timers.tick(60_000)
    assert.equal(subs.length, 2)
  } finally {
    mock.timers.reset()
  }
})

test('an error while opening still schedules a retry', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    let opens = 0
    const open: Opener = (_m, onError) => { opens++; if (opens === 1) onError(new Error('ECONNREFUSED')); return { cancel() {} } }
    keepOpen(open, () => {}, () => {})
    assert.equal(opens, 1)
    mock.timers.tick(5_000)
    assert.equal(opens, 2)
  } finally {
    mock.timers.reset()
  }
})
