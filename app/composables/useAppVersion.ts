// New app version (redeployment): state of the "Reload" banner,
// waiting service worker, periodic check of the served build.
// Pure logic and anti-loop guard: app/utils/appVersion.ts.
import { installedSwAction, isNewBuild, mayReloadForChunk } from '../utils/appVersion'
import { GET_DEADLINE_MS } from '../utils/requestGuards'

export const newVersionReady = ref(false)
export const newVersionDismissed = ref(false)
let swReg: ServiceWorkerRegistration | null = null
let applying = false
// True until our first explicit update check (checkNewVersion): a new SW
// found meanwhile comes from the page load itself, not from a deployment
// made while the app was in use.
let startup = true

function markNew() {
  newVersionReady.value = true
}

function watchInstalling(sw: ServiceWorker | null, atStartup: boolean) {
  sw?.addEventListener('statechange', () => {
    if (sw.state !== 'installed') return
    const action = installedSwAction(Boolean(navigator.serviceWorker.controller), atStartup)
    if (action === 'activate') sw.postMessage({ type: 'skip-waiting' })
    else if (action === 'banner') markNew()
  })
}

// Service worker: a new SW found during use stays "waiting" until Reload is
// clicked. One found at startup (waiting since the last visit, or installing
// because of this page load) is activated silently: the page was loaded from
// the network and already runs the new build, nothing is reloaded.
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    swReg = reg
    reg.waiting?.postMessage({ type: 'skip-waiting' })
    // updatefound may have fired before register() resolved.
    watchInstalling(reg.installing, true)
    reg.addEventListener('updatefound', () => watchInstalling(reg.installing, startup))
    startupBuildCheck()
  }).catch(() => {})
}

// The shell may have come from the SW cache (slow network) and be older than
// the served build: reload once, right away, before anything is typed.
async function startupBuildCheck() {
  try {
    const res = await fetch(`/_nuxt/builds/latest.json?${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(GET_DEADLINE_MS) })
    if (!res.ok || !isNewBuild(useRuntimeConfig().app.buildId, await res.json())) return
    let storage: Storage | null = null
    try { storage = sessionStorage } catch { /* unavailable */ }
    if (mayReloadForChunk(storage, Date.now())) applyNewVersion()
    else markNew()
  } catch { /* offline: the periodic check will catch up */ }
}

// Is the server serving a build other than the one running?
export async function checkNewVersion() {
  if (newVersionReady.value) return
  try {
    const res = await fetch(`/_nuxt/builds/latest.json?${Date.now()}`, { cache: 'no-store' })
    if (res.ok && isNewBuild(useRuntimeConfig().app.buildId, await res.json())) markNew()
  } catch { /* server unreachable: we will retry */ }
  startup = false
  try { await swReg?.update() } catch { /* same */ }
}

// Activates the new SW if it is waiting, then reloads (at the `hash` address if given).
// Drafts are already in localStorage (useDraft).
export async function applyNewVersion(hash?: string) {
  if (applying) return
  applying = true
  // New SW still installing: we wait for it to be ready.
  const installing = swReg?.installing
  if (installing) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5000)
      installing.addEventListener('statechange', () => { if (installing.state !== 'installing') { clearTimeout(timer); resolve() } })
    })
  }
  const waiting = swReg?.waiting
  if (waiting && 'serviceWorker' in navigator) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000)
      navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(timer); resolve() }, { once: true })
      waiting.postMessage({ type: 'skip-waiting' })
    })
  }
  if (hash !== undefined && location.hash !== hash) location.replace(location.pathname + location.search + hash)
  location.reload()
}
