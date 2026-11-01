// Create (or reopen) named Freedom test profiles and print their wallet addresses.
// New profiles go through the real onboarding wizard with a random password; the
// password and recovery phrase are saved to SECRETS (mode 600), never printed.
//
//   FREEDOM_EXE=/path/Freedom-0.8.8.AppImage PROFILES_DIR=/root/freedom-test/profiles \
//   SECRETS=$HOME/.config/freedom-test/profiles.json node onboard.mjs member-a member-b
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, hasVault, onboardWithPassword, ensureUnlocked, profileInfo, waitAntRunning, sleep } from './driver.mjs'

const exe = process.env.FREEDOM_EXE
const dir = process.env.PROFILES_DIR || '/root/freedom-test/profiles'
const secretsPath = process.env.SECRETS
if (!exe || !secretsPath) throw new Error('set FREEDOM_EXE and SECRETS')
const names = process.argv.slice(2)
if (!names.length) throw new Error('usage: onboard.mjs <profile> [...]')

const secrets = existsSync(secretsPath) ? JSON.parse(readFileSync(secretsPath, 'utf8')) : {}
const save = () => writeFileSync(secretsPath, JSON.stringify(secrets, null, 2) + '\n', { mode: 0o600 })

for (const name of names) {
  const profileDir = join(dir, name)
  const app = await launch({ exe, profileDir, logFile: join(dir, `${name}.log`) })
  try {
    await waitAntRunning(app.win)
    if (!(await hasVault(app.win))) {
      const password = `Fc-${randomBytes(18).toString('base64url')}!7`
      await onboardWithPassword(app.win, password)
      const m = await app.win.evaluate((p) => window.identity.exportMnemonic(p), password)
      if (!m?.success) throw new Error(`mnemonic export failed: ${m?.error}`)
      secrets[name] = { profileDir, password, mnemonic: m.mnemonic, createdAt: new Date().toISOString() }
      save()
      console.log(`${name}: onboarded`)
    } else {
      if (!secrets[name]) throw new Error(`${name} has a vault but no saved password`)
      await ensureUnlocked(app.win, secrets[name].password)
      console.log(`${name}: existing vault`)
    }
    const info = await profileInfo(app.win, profileDir)
    secrets[name].nodeWallet = info.nodeWallet
    secrets[name].userWallet = info.userWallet
    save()
    console.log(JSON.stringify({ name, nodeWallet: info.nodeWallet, userWallet: info.userWallet, nodeBalances: info.nodeBalances, stamps: info.stamps, vault: { hasVault: info.vault.hasVault, beeInjected: info.vault.beeInjected } }))
  } finally {
    await app.quit()
    await sleep(5000) // let the profile's locks and the node's API port go before the next launch
  }
}
