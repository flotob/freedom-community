// S1 test page: writes journal entries through Freedom's window.swarm feed API.
const out = document.getElementById('out')
const log = (...a) => { out.textContent += '\n' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') }
const call = (method, params) => window.swarm.request({ method, params })

window.s1 = {
  async capabilities() {
    if (!window.swarm?.isFreedomBrowser) throw new Error('not running in Freedom Browser')
    const caps = await call('swarm_getCapabilities')
    log('capabilities', caps)
    return caps
  },
  async connect() {
    const r = await call('swarm_requestAccess')
    log('access', r)
    return r
  },
  async createFeed(name) {
    const r = await call('swarm_createFeed', { name })
    log('feed', r)
    return r
  },
  async identity() {
    const r = await call('swarm_getSigningIdentity').catch((e) => ({ error: e.message, code: e.code }))
    log('identity', r)
    return r
  },
  // Write one journal entry; returns the entry, the feed index and the time the write took.
  async write(name, i) {
    const entry = { v: 0, kind: 'post', seq: i, at: Date.now(), body: `test entry ${i} ${Math.random().toString(16).slice(2, 10)}` }
    const data = JSON.stringify(entry)
    const t0 = performance.now()
    const r = await call('swarm_writeFeedEntry', { name, data })
    const ms = Math.round(performance.now() - t0)
    log('write', { index: r.index, ms })
    return { entry: data, index: r.index, writeMs: ms, doneAt: Date.now() }
  },
  async read(name, index) {
    const r = await call('swarm_readFeedEntry', index === undefined ? { name } : { name, index })
    return r
  },
}
log('window.swarm present:', Boolean(window.swarm), 'freedom:', Boolean(window.swarm?.isFreedomBrowser))
