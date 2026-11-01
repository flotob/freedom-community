// Drive a packaged Freedom Browser build for testing Swarm apps.
//
// Freedom accepts a CDP connection only when it is launched against a scratch
// profile (FREEDOM_TEST_USER_DATA), the same path its own packaged e2e suite uses
// (test-e2e/packaged-launch.js in solardev-xyz/freedom-browser). Onboarding goes
// through the real wizard UI; state reads use the chrome window's bridge APIs
// (window.ant, window.identity, window.publishSetup, ...), as Freedom's tests do.
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const DEBUG = process.env.FREEDOM_DRIVER_DEBUG === '1'
export const debug = (...a) => DEBUG && console.error(new Date().toISOString().slice(11, 23), '[driver]', ...a)

export async function until(fn, { timeout = 60_000, step = 1000, what = 'condition' } = {}) {
  const t0 = Date.now()
  let last
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) {
      last = e
    }
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`)
    await sleep(step)
  }
}

// Start a private Xvfb display unless one is already set.
export async function ensureDisplay() {
  if (process.env.DISPLAY) return null
  for (let n = 90; n < 140; n++) {
    if (existsSync(`/tmp/.X11-unix/X${n}`) || existsSync(`/tmp/.X${n}-lock`)) continue
    const xvfb = spawn('Xvfb', [`:${n}`, '-screen', '0', '1440x900x24', '-nolisten', 'tcp', '-noreset'], { stdio: 'ignore' })
    await until(() => existsSync(`/tmp/.X11-unix/X${n}`), { timeout: 10_000, step: 100, what: `Xvfb :${n}` })
    process.env.DISPLAY = `:${n}`
    return xvfb
  }
  throw new Error('no free X display')
}

// Launch Freedom with a scratch profile and attach over CDP.
// Returns { browser, win, child, quit }. `win` is the chrome window (renderer/index.html).
export async function launch({ exe, profileDir, logFile, env = {} }) {
  if (!exe) throw new Error('exe (Freedom AppImage or binary) required')
  mkdirSync(profileDir, { recursive: true })
  const xvfb = await ensureDisplay()
  const child = spawn(exe, ['--no-sandbox', '--remote-debugging-port=0'], {
    env: { ...process.env, FREEDOM_TEST_USER_DATA: profileDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own process group, so a dying test script can still take Freedom (and its antd) down
  })
  const killGroup = (sig = 'SIGTERM') => {
    try { process.kill(-child.pid, sig) } catch {}
    xvfb?.kill()
  }
  const onExit = () => killGroup()
  const onSignal = (sig) => { killGroup(); process.exit(sig === 'SIGINT' ? 130 : 143) }
  process.once('exit', onExit)
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  const log = logFile ? createWriteStream(logFile, { flags: 'a' }) : null
  let out = ''
  const ws = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Freedom printed no DevTools endpoint within 120 s')), 120_000)
    const onData = (d) => {
      out += d
      log?.write(d)
      const m = out.match(/DevTools listening on (ws:\/\/\S+)/)
      if (m) {
        clearTimeout(timer)
        resolve(m[1])
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('exit', (c, s) => reject(new Error(`Freedom exited during startup (${c ?? s}): ${out.slice(-1500)}`)))
  })
  child.once('exit', (c, s) => debug(`Freedom exited code=${c} signal=${s}`))
  const browser = await chromium.connectOverCDP(ws)
  const chrome = () =>
    browser.contexts().flatMap((c) => c.pages()).find((p) => /\/renderer\/index\.html(?:[?#]|$)/.test(p.url()))
  const win = await until(chrome, { timeout: 60_000, what: 'browser window' })
  await win.waitForLoadState('domcontentloaded')

  async function quit() {
    const exited = new Promise((r) =>
      child.exitCode !== null || child.signalCode !== null ? r(true) : child.once('exit', () => r(true))
    )
    // Fire and forget: the reply to Browser.close never arrives, because the app exits first.
    browser.newBrowserCDPSession().then((cdp) => cdp.send('Browser.close')).catch(() => {})
    const ok = await Promise.race([exited, sleep(90_000).then(() => false)])
    if (!ok) killGroup('SIGKILL')
    process.off('exit', onExit)
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    log?.end()
    if (xvfb) {
      xvfb.kill()
      delete process.env.DISPLAY
    }
  }
  return { browser, win, child, quit }
}

export async function antStatus(win) {
  return win.evaluate(() => window.ant.getStatus())
}

export async function waitAntRunning(win, timeout = 180_000) {
  return until(async () => (await antStatus(win)).status === 'running', { timeout, what: 'Ant node running' })
}

// GET on the profile's embedded Ant node, through Freedom's own bridge.
export async function antGet(win, endpoint) {
  const r = await win.evaluate((e) => window.ant.apiGet(e), endpoint)
  return typeof r === 'string' ? JSON.parse(r) : r
}

export async function hasVault(win) {
  return (await win.evaluate(() => window.identity.hasVault()))?.hasVault === true
}

// Create a new vault through the onboarding wizard UI (password path).
// Mirrors test-e2e/live/onboarding-identity.spec.js in freedom-browser.
export async function onboardWithPassword(win, password) {
  const dialogs = []
  win.on('dialog', (d) => {
    dialogs.push(d.message())
    d.dismiss().catch(() => {})
  })
  debug('ant running; opening wizard')
  await waitAntRunning(win)
  await win.evaluate(() => document.getElementById('onboarding-modal').showModal())
  await win.locator('[data-step="welcome"]').waitFor({ state: 'visible' })
  const createPassword = win.locator('[data-step="create-password"]')
  await until(
    async () => {
      if (await createPassword.isVisible()) return true
      await win.locator('[data-step="welcome"] [data-action="create"]:visible').first().click({ timeout: 5_000 })
      await createPassword.waitFor({ state: 'visible', timeout: 2_000 })
      return true
    },
    { timeout: 60_000, step: 500, what: 'create-password step' }
  )
  debug('create-password step')
  await win.fill('#create-password', password)
  await win.locator('#create-password-confirm').waitFor({ state: 'visible' })
  await win.fill('#create-password-confirm', password)
  await win.locator('[data-step="create-password"] [data-action="create-vault"]').click()
  const touchId = win.locator('[data-step="touch-id"]')
  const backup = win.locator('[data-step="backup"]')
  await until(async () => (await touchId.isVisible()) || (await backup.isVisible()), { what: 'backup step' })
  if (await touchId.isVisible()) await touchId.locator('[data-action="skip-touch-id"]').click()
  debug('backup step')
  await backup.waitFor({ state: 'visible' })
  await win.check('#backup-confirmed')
  await win.locator('[data-step="backup"] [data-action="continue-to-verify"]').click()
  debug('waiting for complete')
  await win.locator('[data-step="complete"]').waitFor({ state: 'visible', timeout: 120_000 })
  if (dialogs.length) throw new Error(`onboarding reported: ${dialogs.join(' | ')}`)
  await waitAntRunning(win)
  return win.evaluate(() => window.identity.getStatus())
}

// The vault auto-locks (15 min by default); unlock it with the profile password if needed.
export async function ensureUnlocked(win, password) {
  const unlocked = (await win.evaluate(() => window.identity.isUnlocked()))?.isUnlocked === true
  if (unlocked) return false
  const r = await win.evaluate((p) => window.identity.unlock(p), password)
  if (r && r.success === false) throw new Error(`unlock failed: ${r.error || JSON.stringify(r)}`)
  return true
}

// The profile's embedded Ant node API (read from the config Freedom writes for antd).
// Freedom's chrome bridge only exposes /health, /peers and /topology, so tests read
// the node directly on localhost. Freedom moves a profile's node to a free port when
// the default (1633) is taken and rewrites config.yaml on every start, so read it there.
export function nodeApiBase(profileDir) {
  const cfg = readFileSync(join(profileDir, 'ant-data', 'config.yaml'), 'utf8')
  const addr = cfg.match(/^api-addr:\s*"?([^"\s]+)"?/m)?.[1] || '127.0.0.1:1633'
  return `http://${addr.startsWith(':') ? '127.0.0.1' + addr : addr}`
}

export async function nodeGet(profileDir, path) {
  const r = await fetch(nodeApiBase(profileDir) + path)
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`)
  return r.json()
}

export async function profileInfo(win, profileDir) {
  const wallet = await nodeGet(profileDir, '/wallet').catch((e) => ({ error: String(e) }))
  const stamps = await nodeGet(profileDir, '/stamps').catch(() => ({ stamps: [] }))
  const active = await win.evaluate(() => window.wallet.getActiveAddress()).catch(() => null)
  return {
    vault: await win.evaluate(() => window.identity.getStatus()),
    nodeWallet: wallet.walletAddress,
    nodeBalances: { xDAI: wallet.nativeTokenBalance, xBZZ: wallet.bzzBalance, chequebook: wallet.chequebookContractAddress },
    userWallet: active?.address || null,
    stamps: (stamps.stamps || []).map((s) => ({ id: s.batchID, depth: s.depth, usable: s.usable, ttlDays: +(s.batchTTL / 86400).toFixed(2) })),
  }
}

// Open a URL in the active tab through the address bar, as a user would.
export async function navigate(win, url) {
  const input = win.locator('[data-test="address-input"]')
  await input.fill(url)
  await input.press('Enter')
}

// Run JavaScript in the active tab's page (the visible <webview>), as Freedom's own
// e2e tests do. `source` is an expression; a returned promise is awaited.
export async function tabEval(win, source) {
  return win.evaluate(
    (src) => {
      const wv = document.querySelector('webview:not(.hidden)')
      if (!wv || typeof wv.executeJavaScript !== 'function') throw new Error('no active webview')
      return wv.executeJavaScript(src, true)
    },
    source
  )
}

export async function tabUrl(win) {
  return win.evaluate(() => document.querySelector('webview:not(.hidden)')?.getURL?.() || null)
}

// Approve the permission-manifest consent sheet if it is showing.
export async function approveManifestSheet(win, timeout = 60_000) {
  const allow = win.locator('#swarm-manifest-allow')
  await allow.waitFor({ state: 'visible', timeout })
  await allow.click()
}
