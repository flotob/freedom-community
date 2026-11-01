// S2 test page: ring a GSOC doorbell through Freedom's window.swarm messaging API.
const out = document.getElementById('out')
const call = (method, params) => window.swarm.request({ method, params })
window.s2 = {
  async connect() { return call('swarm_requestAccess') },
  async ring(topic, data) {
    const t0 = performance.now()
    const r = await call('swarm_sendGsoc', { topic, data })
    const ms = Math.round(performance.now() - t0)
    out.textContent += `\nrang ${r.address} in ${ms} ms`
    return { address: r.address, sendMs: ms, doneAt: Date.now() }
  },
}
