// Global app state: live agents (WebSocket /ws/events), device
// settings, lock, API calls. Module singletons (client app).
import { createSocketProbe } from '~/utils/socketProbe'
import { GET_DEADLINE_MS, skipWhileBusy, withDeadline } from '~/utils/requestGuards'
import { DESK_QUERY, SLIM_QUERY, TABLET_QUERY, provesHardwareKeyboard } from '~/utils/layoutMode'
import type { AppConfig, AuthStatus, HerdrState, MachineConfig, MachineInfo, NamedSession, Pane, Quotas } from '#shared/types'
import { LOCAL, splitId } from '#shared/ids'
import { clearOffline, readHome, saveHome } from '~/utils/offlineCache'
import { leaseFromStatus, mayReadOffline, readOfflineAccess, setOfflineAccess, type OfflineAccess } from '~/utils/offlineAccess'
import { activeTerminalRenderer, parseTerminalRenderer } from '~/utils/terminalRenderer'
import type { ActiveTerminalRenderer } from '~/utils/terminalRenderer'
import { settleState } from '#shared/stateReady'
import { READY_SORTS, type ReadySort } from '#shared/spaces'
import { DEADLINE_WARNING_MS } from '#shared/sessionLimit'
import { readSessionSelection, selectSessions, writeSessionSelection } from '~/utils/sessionSelection'
import { effectiveTypingSpeed, encryptedTextActive, parseTypingSettings } from '~/utils/typewriter'
import { readHiddenAgents } from '~/utils/agentChoices'
import { checkNewVersion } from './useAppVersion'
import { migrateContentWidth } from '~/utils/contentWidth'
import { readQuotaDisplay } from '~/utils/quotas'
import { readShowShells } from '~/utils/terminalVisibility'
import { readHomeGrouping } from '~/utils/homeGrouping'
import { COMPACT_LIST_KEY, LEGACY_COMPACT_LIST_KEY, readCompactList } from '~/utils/compactCard'
import { paneFallback } from '~/utils/viewMode'
import { menuAsSheet } from '~/utils/menuRoute'
import { DEFAULT_QUOTE_MODE, QUOTE_MODE_KEY, migrateQuoteMode, type QuoteMode } from '~/utils/quoteTokens'
import { parseReplyStyle } from '~/utils/questionReply'
import { flag, settingsSync, syncedRef } from './useSyncedSettings'
import type { SettingsMap } from '#shared/settings'
import type { QuotaDisplay } from '~/utils/quotas'
import type { ContentWidth } from '~/utils/contentWidth'
import { PHONE_KEY_ORDER_KEY, readKeyOrder, writeKeyOrder, type PhoneKeyId } from '~/utils/keybarOrder'

const ls = {
  get(k: string) {
    try { return localStorage.getItem(k) }
    catch { return null }
  },
  set(k: string, v: string) {
    try { localStorage.setItem(k, v) }
    catch { /* stockage indisponible */ }
  },
  remove(k: string) {
    try { localStorage.removeItem(k) }
    catch { /* storage unavailable */ }
  },
}

export const herdrState = shallowRef<HerdrState>({ ok: false, workspaces: [], panes: [] })
let fullState: HerdrState = herdrState.value
// Every open session's state, as the server follows them (herdrState keeps
// only the session each device shows): to find a pane in a session not shown.
export const allSessionsState = shallowRef<HerdrState>(fullState)
function loadSessionNames(): Record<string, string> {
  return readSessionSelection(ls.get('machineSessions'))
}
export const machineSessions = ref<Record<string, string>>(loadSessionNames())
function setSessionNames(names: Record<string, string>) {
  machineSessions.value = names
  ls.set('machineSessions', writeSessionSelection(names))
  herdrState.value = selectSessions(fullState, names)
}
export async function listMachineSessions(baseKey: string): Promise<NamedSession[]> {
  return (await api<{ sessions: NamedSession[] }>(`/api/sessions?machine=${encodeURIComponent(baseKey)}`)).sessions
}
export async function chooseMachineSession(baseKey: string, name: string) {
  const chosen = await api<{ session: NamedSession }>('/api/sessions', { machine: baseKey, name })
  setSessionNames({ ...machineSessions.value, [baseKey]: name })
  lastMachine.value = chosen.session.key
  syncPushLanguage().catch(() => {})
  await loadConfig()
}
const sessionTries = new Map<string, number>()
async function restoreMachineSessions() {
  for (const [baseKey, name] of Object.entries(machineSessions.value)) {
    if (!name || fullState.machines?.some(m => m.key === baseKey && m.session === name)) continue
    if (fullState.machines?.some(m => m.baseKey === baseKey && m.session === name)) continue
    const now = Date.now()
    if (now - (sessionTries.get(baseKey) || 0) < 10000) continue
    sessionTries.set(baseKey, now)
    api('/api/sessions', { machine: baseKey, name }).catch(() => {})
  }
}
async function checkSelectedSessions() {
  for (const [baseKey, name] of Object.entries(machineSessions.value)) {
    if (!name || fullState.machines?.some(m => m.key === baseKey && m.session === name)) continue
    try {
      const rows = await listMachineSessions(baseKey)
      if (!rows.some(s => s.name === name && s.running)) {
        const next = { ...machineSessions.value }
        delete next[baseKey]
        setSessionNames(next)
        syncPushLanguage().catch(() => {})
        if (lastMachine.value && !fullState.machines?.some(m => m.key === lastMachine.value && !m.baseKey)) lastMachine.value = baseKey
        toast(t('Session unavailable: back to the default session'))
      }
    } catch { /* machine temporarily unreachable */ }
  }
}
const checkSessionsTick = skipWhileBusy(checkSelectedSessions)
export const eventsOpen = ref(false)
export const netDown = ref(false)
export const cachedAt = ref<number | null>(null)
export const offlineView = computed(() => cachedAt.value !== null)
export const locked = ref(false)
export const appConfig = ref<AppConfig>({ kinds: ['claude', 'codex'], home: '', dirs: [], push: { enabled: false, key: null, devices: 0 } })
// Machine name (HOST_LABEL on the server): "<name> · herdr", otherwise "herdr".
export const hostLabel = ref('')
export const brandLabel = computed(() => 'wherdr')
export const curPane = ref<string | null>(null)
export const pageVisible = ref(true)
// Every visible wake, including pageshow/online with unchanged visibility.
export const socketWake = ref(0)

// Device settings.
// Display preferences without anything specific to the device are kept on the
// server and follow the user (shared/settings.ts, useSyncedSettings.ts); the
// others stay on this device.
export const showShells = syncedRef('showShells', readShowShells, flag.write)
export const showCounters = syncedRef('showCounters', flag.read(true), flag.write)
export const showQuotas = syncedRef('showQuotas', flag.read(true), flag.write)
// Existing devices keep Machine.
export const homeGrouping = syncedRef('homeGrouping', readHomeGrouping, v => v)
// Workspace cards remain the default; Board tasks keep their own grouping.
export const individualAgentList = syncedRef('individualAgentList', flag.read(false), flag.write)

// Compact list: one line per card (sidebar on a computer, home list on the phone).
// Read before the first render, so the list never changes density after it.
// Off by default; the 1.x value is dropped (see utils/compactCard.ts).
export const compactList = syncedRef(COMPACT_LIST_KEY, readCompactList, flag.write)
if (import.meta.client) {
  try { localStorage.removeItem(LEGACY_COMPACT_LIST_KEY) } catch { /* storage unavailable */ }
}
export const autoReorderReady = syncedRef('autoReorderReady', flag.read(true), flag.write)
// Sorting of Ready (see shared/spaces.ts sortReady).
export const readySort = syncedRef<ReadySort>('readySort', raw => ((READY_SORTS as readonly string[]).includes(raw || '') ? raw as ReadySort : 'herdr'), v => v)
export const quotaDisplay = syncedRef<QuotaDisplay>('quotaDisplay', readQuotaDisplay, v => v)
export const hiddenAgents = syncedRef<string[]>('hiddenAgents', readHiddenAgents, v => JSON.stringify(v), { deep: true })
// Content width on a computer; migration of the old preference.
export const contentWidth = ref<ContentWidth>(migrateContentWidth(ls.get('contentWidth'), ls.get('chatWidth')))
watch(contentWidth, (v) => {
  ls.set('contentWidth', v)
  if (import.meta.client) {
    try { localStorage.removeItem('chatWidth') } catch { /* stockage indisponible */ }
    document.documentElement.dataset.contentWidth = v
  }
}, { immediate: true })
// Independent settings; migration of the old modes on first read.
const savedTyping = parseTypingSettings(ls.get('typewriterSpeed'), ls.get('encryptedText'), ls.get('typewriterMode'), ls.get('typewriter'))
// Writes the new keys right at migration so as no longer to depend on the
// old values on the next launches.
if (import.meta.client) {
  ls.set('typewriterSpeed', savedTyping.speed)
  ls.set('encryptedText', savedTyping.encrypted ? '1' : '0')
}
export const typewriterSpeed = syncedRef('typewriterSpeed', raw => parseTypingSettings(raw, '0', null, null).speed, v => v)
export const encryptedText = syncedRef('encryptedText', flag.read(true), flag.write)
export const reducedMotion = ref(false)
if (import.meta.client) {
  const mq = matchMedia('(prefers-reduced-motion: reduce)')
  reducedMotion.value = mq.matches
  mq.addEventListener('change', (e) => { reducedMotion.value = e.matches })
}
export const typingSpeed = computed(() => effectiveTypingSpeed(typewriterSpeed.value, reducedMotion.value))
export const typewriterActive = computed(() => typingSpeed.value !== 'off')
export const encryptedActive = computed(() => encryptedTextActive(typewriterSpeed.value, encryptedText.value, reducedMotion.value))
// Quoted replies (utils/quoteTokens.ts): one mode for this device, tokens in
// the native field by default.
function savedQuoteMode(): QuoteMode {
  if (!import.meta.client) return DEFAULT_QUOTE_MODE
  try { return migrateQuoteMode(localStorage) }
  catch { return DEFAULT_QUOTE_MODE }
}
export const quoteMode = ref(savedQuoteMode())
watch(quoteMode, v => ls.set(QUOTE_MODE_KEY, v))
// How the questions and the points of an agent reply offer to be quoted
// (utils/questionReply.ts): an icon by default.
export const replyStyle = syncedRef('replyStyle', parseReplyStyle, v => v)
// Account quotas (read by QuotaStrip, also shown in the machine headers).
export const homeQuotas = ref<Quotas | null>(null)
export const fontSize = ref(Number(ls.get('fontSize')) || 12)
watch(fontSize, v => ls.set('fontSize', String(v)))
// Experimental touch physics is a device rendering preference, like the renderer.
export const smoothTouchScrolling = ref(ls.get('smoothTouchScrolling') === '1')
watch(smoothTouchScrolling, v => ls.set('smoothTouchScrolling', v ? '1' : '0'))

export const terminalRenderer = ref(parseTerminalRenderer(ls.get('terminalRenderer')))
watch(terminalRenderer, v => ls.set('terminalRenderer', v))
// OSC 52 copies of the agents written to this device's clipboard (on by default).
export const agentClipboard = ref(ls.get('agentClipboard') !== '0')
watch(agentClipboard, v => ls.set('agentClipboard', v ? '1' : '0'))
// Order of the phone key bar (utils/keybarOrder.ts), the same in the
// Conversation and the Terminal. The default order is not stored.
export const phoneKeyOrder = ref<PhoneKeyId[]>(readKeyOrder(ls.get(PHONE_KEY_ORDER_KEY)))
watch(phoneKeyOrder, (v) => {
  const raw = writeKeyOrder(v)
  if (raw === null) ls.remove(PHONE_KEY_ORDER_KEY)
  else ls.set(PHONE_KEY_ORDER_KEY, raw)
})
// The engine actually loaded in xterm; kept after the terminal view
// is closed so Settings can show the last observed result.
export const terminalRenderStatus = ref<ActiveTerminalRenderer | null>(null)
const webglAvailable = ref<boolean | null>(null)
export function reportTerminalRenderer(active: ActiveTerminalRenderer) {
  terminalRenderStatus.value = active
  if (active !== 'html') webglAvailable.value = active === 'webgl'
}
export function refreshTerminalRenderStatus() {
  if (terminalRenderer.value === 'html') {
    terminalRenderStatus.value = 'html'
    return
  }
  if (webglAvailable.value === null && import.meta.client) {
    try {
      const canvas = document.createElement('canvas')
      const gl = canvas.getContext('webgl2')
      webglAvailable.value = Boolean(gl)
      gl?.getExtension('WEBGL_lose_context')?.loseContext()
    } catch { webglAvailable.value = false }
  }
  terminalRenderStatus.value = activeTerminalRenderer(terminalRenderer.value, webglAvailable.value === true)
}
if (import.meta.client) {
  window.addEventListener('storage', (event) => {
    if (event.key === 'smoothTouchScrolling') smoothTouchScrolling.value = event.newValue === '1'
    if (event.key === PHONE_KEY_ORDER_KEY) phoneKeyOrder.value = readKeyOrder(event.newValue)
    if (event.key === 'terminalRenderer') {
      terminalRenderer.value = parseTerminalRenderer(event.newValue)
      refreshTerminalRenderStatus()
    }
  })
}
// Presentation mode per pane: only an explicit choice is remembered (the
// selector, Ctrl+`, the phone icons — 'chat' included, so switching back
// sticks); a pane without one follows the device default on a computer
// (defaultViewMode, chosen in Settings › Desktop), the conversation on the
// phone. A change of the default applies at once to the panes without one.
export type PaneViewMode = 'chat' | 'term'
function loadViewModes(): Record<string, PaneViewMode> {
  try {
    const v = JSON.parse(ls.get('viewModes') || '{}')
    return v && typeof v === 'object' ? v : {}
  } catch { return {} }
}
const viewModes = reactive(loadViewModes())
export const defaultViewMode = syncedRef<'chat' | 'term'>('defaultViewMode', raw => (raw === 'term' ? 'term' : 'chat'), v => v)
export const paneViewMode = (id: string): PaneViewMode =>
  (viewModes[id] === 'term' || viewModes[id] === 'chat' ? viewModes[id] : paneFallback({ desk: desk.value, defaultMode: defaultViewMode.value }))
export function setPaneViewMode(id: string, m: PaneViewMode) {
  viewModes[id] = m
  ls.set('viewModes', JSON.stringify(viewModes))
}
// Vanished panes: we forget their tab, but only for online
// machines (a machine not yet reconnected has not listed its panes yet).
function pruneViewModes(s: HerdrState) {
  if (!s.ok) return
  const alive = new Set(fullState.panes.map(p => p.id))
  const online = new Set([LOCAL, ...(fullState.machines || []).filter(m => m.status === 'online').map(m => m.key)])
  let changed = false
  for (const id of Object.keys(viewModes)) {
    if (!alive.has(id) && online.has(splitId(id).machine)) { delete viewModes[id]; changed = true }
  }
  if (changed) ls.set('viewModes', JSON.stringify(viewModes))
}
watch(herdrState, pruneViewModes)
export const lastKind = ref(ls.get('lastKind') || '')
watch(lastKind, v => ls.set('lastKind', v))

// Computer (≥ 900 px, or a tablet in portrait): list as a sidebar, agent on
// the right. Slim: narrower than 1024 px, the list slides over the agent
// (utils/layoutMode.ts).
export const desk = ref(false)
export const slim = ref(false)
// Slim: the list opened over the agent (HomeView; backdrop in app.vue).
export const listDrawer = ref(false)
// Tablet (shortest side ≥ 700 px, or a touch tablet's screen while the
// on-screen keyboard shortens the window) and hardware keyboard seen (a key an
// on-screen keyboard does not send); forgotten on a touch, when the message
// field loses focus, or when the on-screen keyboard shows.
export const tablet = ref(false)
export const hardwareKeyboard = ref(false)
if (import.meta.client) {
  const tq = matchMedia(TABLET_QUERY)
  tablet.value = tq.matches
  tq.addEventListener('change', () => { tablet.value = tq.matches })
  window.addEventListener('keydown', (e) => { if (provesHardwareKeyboard(e)) hardwareKeyboard.value = true }, true)
  // The proof only covers the current typing: a touch (the on-screen keyboard,
  // possibly floating, may be next) or leaving the message field forgets it.
  const forget = () => { hardwareKeyboard.value = false }
  window.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') forget() }, true)
  window.addEventListener('touchstart', forget, { capture: true, passive: true })
  window.addEventListener('focusout', (e) => { if ((e.target as Element | null)?.closest?.('.prompt')) forget() }, true)
}
if (import.meta.client) {
  const mq = matchMedia(DESK_QUERY)
  const narrow = matchMedia(SLIM_QUERY)
  const read = () => { desk.value = mq.matches; slim.value = mq.matches && narrow.matches }
  read()
  mq.addEventListener('change', read)
  narrow.addEventListener('change', read)
}
// Touch screen (phone, tablet): menus open as the bottom sheet, even on a
// computer layout (utils/menuRoute.ts).
export const coarse = ref(false)
if (import.meta.client) {
  const mq = matchMedia('(pointer: coarse)')
  coarse.value = mq.matches
  mq.addEventListener('change', () => { coarse.value = mq.matches })
}
export const sheetMenus = computed(() => menuAsSheet({ desk: desk.value, coarse: coarse.value }))

export const currentPane = computed<Pane | undefined>(() => herdrState.value.panes.find(p => p.id === curPane.value))

// ---------------------------------------------------------------- machines
// Several machines (Herdr SSH profiles): `machines` is only sent if
// there are at least two; with a single one, the app stays exactly as before.
export const machines = computed<MachineInfo[]>(() => herdrState.value.machines || [])
export const multiMachine = computed(() => machines.value.length > 1 || Boolean(machines.value[0]?.baseKey))
export const machineInfo = (key: string | null | undefined) => machines.value.find(m => m.key === (key || ''))
// `uname -s` of a pane's machine ('Darwin' = macOS); the local one from the config.
export const machineOs = (key: string | null | undefined) => machineInfo(key)?.os || (key ? undefined : appConfig.value.os)
// Reveal and Open apply to panes on macOS.
export const canOpenOnMachine = (p: Pane | null | undefined) => Boolean(p?.cwd && machineOs(p.machine) === 'Darwin')
// Machines offered by the "New agent" sheet (null
// with a single machine); online according to the live state (the config may
// have been read before the connection).
export const machineChoices = computed(() => (multiMachine.value ? (appConfig.value.machines || []).filter(m => machines.value.some(s => s.key === m.key)) : null))
export const machineOnline = (m: MachineConfig) => m.local || (machineInfo(m.key)?.status === 'online' && Boolean(m.home))
export const machineStateOf = (m: MachineConfig) => (m.local ? 'online' : machineInfo(m.key)?.status || 'offline')
export const machineName = (key: string | null | undefined) => {
  const m = machineInfo(key)
  return m ? m.label || t('This machine') : ''
}
// Pane of an unreachable machine: its last state, grayed out.
export const paneStale = (p: Pane | null | undefined) => {
  const m = p ? machineInfo(p.machine) : undefined
  return Boolean(m && m.status !== 'online')
}
function readList(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw || '[]')
    return Array.isArray(v) ? v.map(String) : []
  } catch { return [] }
}
// Collapsed machine sections (kept on the server, like the other home settings).
export const collapsedMachines = syncedRef<string[]>('collapsedMachines', readList, v => JSON.stringify(v), { deep: true })
// Collapsed repo groups of the home list, `<machine>|<group id>`.
export const collapsedRepos = syncedRef<string[]>('collapsedRepos', readList, v => JSON.stringify(v.slice(-200)), { deep: true })
// Last machine chosen in "New".
export const lastMachine = ref(ls.get('lastMachine') || '')
watch(lastMachine, v => ls.set('lastMachine', v))

// ---------------------------------------------------------------- toasts
type Toaster = ReturnType<typeof useToast>
let toaster: Toaster | null = null
export function setToaster(t: Toaster) { toaster = t }
// `detail`: an extra, smaller line (output of a plugin action…).
export function clearToast() { toaster?.clear() }
// `action`: one button in it (Restore after Archive…), the toast then stays a
// few seconds longer; a tap runs it and closes the toast.
export interface ToastAction { label: string, icon?: string, run: () => void }
export const ACTION_TOAST_MS = 6000
export function toast(msg: string, err = false, detail?: string, action?: ToastAction) {
  if (!toaster) return
  toaster.clear()
  toaster.add({
    title: msg,
    description: detail || undefined,
    color: err ? 'error' : 'neutral',
    class: err ? 'hw-toast-error' : undefined,
    icon: err ? 'i-lucide-circle-alert' : undefined,
    duration: action ? ACTION_TOAST_MS : (err ? 4200 : 2600) + (detail ? 2400 : 0),
    close: false,
    ...(action
      ? { orientation: 'horizontal' as const, actions: [{ label: action.label, icon: action.icon, color: 'neutral' as const, variant: 'outline' as const, size: 'xs' as const, class: 'hw-toast-action', onClick: () => action.run() }] }
      : {}),
  })
}

// A toast with one button (`fn` runs in the tap: a user gesture, which iOS
// Safari asks for before writing the clipboard).
export function toastAction(msg: string, label: string, fn: () => void) {
  if (!toaster) return
  toaster.clear()
  toaster.add({
    title: msg,
    color: 'neutral',
    duration: 10000,
    close: false,
    orientation: 'horizontal',
    actions: [{ label, color: 'primary', variant: 'solid', onClick: fn }],
  })
}

// ---------------------------------------------------------------- API
export class ApiError extends Error {
  code?: string
  status: number
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

// A GET also ends after GET_DEADLINE_MS (utils/requestGuards.ts): a stalled
// connection must not keep reads open for ever.
export async function api<T = Record<string, unknown>>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const deadline = body === undefined ? withDeadline(signal, GET_DEADLINE_MS) : null
  const sig = deadline?.signal ?? signal
  const opts: RequestInit = body === undefined
    ? { signal: sig }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: sig }
  let r: Response
  let data: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    r = await fetch(path, opts)
    // Aborted mid-body (deadline): a failure, not an empty answer (`{}` from the
    // status check would read as "lock off").
    data = await r.json().catch(() => { sig?.throwIfAborted(); return {} })
  } finally { deadline?.done() }
  // Session expired or app locked: back through the passkey, but only once the
  // server confirms it (a single 401 is not enough to drop the user's screen).
  if (r.status === 401 && data.code === 'locked' && !path.startsWith('/api/auth/')) confirmLock()
  // Erreurs de Herdr transmises telles quelles (en anglais) : message traduit par code.
  const known = data.code === 'agent_not_ready' ? 'The agent isn’t ready in this pane (stopped or still starting).' : null
  // herdr-projects' own refusal (a wait in a circle, an unknown task…): its words as they are,
  // never pieced together from the dictionary's templates.
  if (!r.ok && data.code === 'projects_failed' && data.error) throw new ApiError(String(data.error), r.status, data.code)
  if (!r.ok) throw new ApiError(t(known || data.error || `HTTP ${r.status}`), r.status, data.code)
  return data as T
}

if (import.meta.client) {
  settingsSync.setTransport({
    get: async () => (await api<{ settings: SettingsMap }>('/api/settings')).settings,
    post: async (patch, migrate) => (await api<{ settings: SettingsMap }>('/api/settings', { settings: patch, migrate })).settings,
  })
}

// A file from the server saved on this device under `name` (/api/files/download):
// fetched first, so a refusal is an error to show rather than a saved error page.
export async function saveFile(path: string, name: string) {
  const r = await fetch(path)
  if (!r.ok) {
    const data = await r.json().catch(() => ({}))
    if (r.status === 401 && data.code === 'locked') confirmLock()
    throw new ApiError(t(data.error || `HTTP ${r.status}`), r.status, data.code)
  }
  const href = URL.createObjectURL(await r.blob())
  const a = document.createElement('a')
  a.href = href
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoked once the browser has taken the file.
  setTimeout(() => URL.revokeObjectURL(href), 60_000)
}

// Current agent folder in its default editor, on the agent's machine (the
// "Open" action of /api/reveal with the folder path; macOS only, checked
// server-side). Shared by ChatView's "Open" menu and the Mod+Alt+O shortcut.
export async function openFolderOnMachine(pane: Pane) {
  try {
    const r = await api<{ machine: string }>('/api/reveal', { pane_id: pane.id, path: pane.cwd, mode: 'open' })
    toast(tl(`Opened in the editor on ${r.machine}`, `Ouvert dans l’éditeur sur ${r.machine}`))
  } catch (err) {
    toast((err as Error).message, true)
  }
}

export async function loadConfig() {
  try {
    appConfig.value = await api<AppConfig>('/api/config')
    if (appConfig.value.hostLabel !== undefined) hostLabel.value = appConfig.value.hostLabel
  }
  catch { /* keep the previous one */ }
}

// ---------------------------------------------------------------- live state
let evWs: WebSocket | null = null
let evRetry = 0
// Reconnection after a cut: the server may have restarted (see settleState).
let everOpen = false
let settleUntil = 0
const SETTLE_MS = 30000
let lastStateAt: number | null = null
let evTimer: ReturnType<typeof setTimeout> | undefined
let netTimer: ReturnType<typeof setTimeout> | undefined
const wsBase = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`

// "Connection lost" banner: shown if the server stays unreachable for more than
// 2.5 s (a lightning reconnection does not flicker).
function setNetDown(down: boolean) {
  if (!down) {
    clearTimeout(netTimer)
    netTimer = undefined
    netDown.value = false
    return
  }
  // Already shown or about to be: the following attempts do not push the delay back.
  if (netDown.value || netTimer) return
  netTimer = setTimeout(() => {
    netTimer = undefined
    netDown.value = true
  }, 2500)
}

function normalize(s: HerdrState): HerdrState {
  // A question on screen (e.g. Codex's folder trust, which Herdr
  // sees as "idle"): for the user, the agent is waiting for their answer.
  // Same for a recognized waiting screen (Codex hooks, login…).
  for (const p of s.panes) if (((p.prompt && p.prompt.options) || knownScreen(p)) && p.status !== 'working') p.status = 'blocked'
  return s
}

const eventProbe = createSocketProbe(() => evWs)
let evHandshake: ReturnType<typeof setTimeout> | undefined
export function recoverEvents() {
  connectEvents()
  return eventProbe.recover(() => { if (!document.hidden && !locked.value) reconnectEvents() })
}
export function reconnectEvents() {
  eventProbe.cancel()
  clearTimeout(evHandshake)
  clearTimeout(evTimer)
  if (evWs) { try { evWs.onclose = null; evWs.close() } catch { /* ignore */ } evWs = null }
  evRetry = 0
  connectEvents()
}

export function connectEvents() {
  clearTimeout(evTimer)
  if (locked.value) return
  if (evWs && evWs.readyState <= 1) return
  clearTimeout(evHandshake)
  eventProbe.cancel()
  const ws = new WebSocket(`${wsBase()}/ws/events`)
  evWs = ws
  // A CONNECTING socket fires nothing: no open, no close, no retry. If the
  // network is not actually back yet, the handshake hangs and the app would
  // sit offline forever -- close it on a deadline so onclose retries.
  evHandshake = setTimeout(() => {
    if (evWs === ws && ws.readyState === 0) { try { ws.close() } catch { /* ignore */ } }
  }, 6000)
  ws.onopen = () => {
    if (evWs !== ws) return
    clearTimeout(evHandshake)
    evRetry = 0
    eventsOpen.value = true
    if (everOpen) {
      settleUntil = Date.now() + SETTLE_MS
      // Reconnection = often a redeployment: we check right away whether
      // a new version is served ("Reload" banner).
      checkNewVersion()
    }
    everOpen = true
    sendViewing()
    restoreMachineSessions()
    // Settings kept on the server: changes made offline go out, then the
    // server's values apply (the first time, this device's are sent).
    settingsSync.load()
  }
  ws.onmessage = (e) => {
    try {
      if (evWs !== ws) return
      const data = JSON.parse(e.data)
      if (data?.type === 'pong') { eventProbe.pong(ws); return }
      // Settings changed on another device (or another tab).
      if (data?.type === 'settings') { settingsSync.receive(data.settings || {}); return }
      const got = normalize(data) as HerdrState
      // Server just restarted, state still partial: we keep the whole
      // display, the "reconnecting" banner stays in place.
      const state = settleState(lastStateAt ? fullState : null, got, Date.now() < settleUntil)
      if (!state) return
      setNetDown(false)
      if (!state.ok && herdrState.value.ok && lastStateAt) {
        cachedAt.value = lastStateAt
        return
      }
      fullState = state
      allSessionsState.value = fullState
      herdrState.value = selectSessions(state, machineSessions.value)
      restoreMachineSessions()
      lastStateAt = Date.now()
      cachedAt.value = null
      if (state.ok && mayReadOffline(readOfflineAccess())) saveHome(herdrState.value)
    }
    catch { /* message illisible */ }
  }
  ws.onclose = () => {
    if (evWs !== ws) return
    clearTimeout(evHandshake)
    evWs = null
    eventsOpen.value = false
    eventProbe.cancel()
    if (herdrState.value.ok && lastStateAt) cachedAt.value = lastStateAt
    // Refused because of the lock (session expired) rather than a network cut?
    confirmLock()
    if (locked.value) return
    setNetDown(true)
    evTimer = setTimeout(connectEvents, Math.min(8000, 500 * 2 ** evRetry++))
  }
}
export function retryEvents() {
  evRetry = 0
  clearTimeout(evTimer)
  connectEvents()
}

// Visible, focused and recently used: renew a 30-second server lease.
let notificationActivityAt = Date.now()
let notificationLastSentAt = 0
let notificationLastVisible = false
export function noteNotificationActivity() {
  notificationActivityAt = Date.now()
  if (!notificationLastVisible || notificationActivityAt - notificationLastSentAt >= 1000) sendViewing()
}
export function sendViewing() {
  notificationLastSentAt = Date.now()
  const visible = pageVisible.value && document.hasFocus() && Date.now() - notificationActivityAt < 120_000
  notificationLastVisible = visible
  if (evWs && evWs.readyState === 1) evWs.send(JSON.stringify({ type: 'viewing', pane: curPane.value, visible }))
}
watch(curPane, sendViewing)

// Icon badge: agents waiting or finished.
watch(herdrState, (s) => {
  const n = s.panes.filter(p => p.status === 'blocked' || p.status === 'done').length
  const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>, clearAppBadge?: () => Promise<void> }
  try {
    if (n && nav.setAppBadge) nav.setAppBadge(n).catch(() => {})
    else if (nav.clearAppBadge) nav.clearAppBadge().catch(() => {})
  } catch { /* not supported */ }
})

// Shows the lock screen only when the server itself says the session is
// invalid; a network error or an odd answer leaves the app as it is.
// resume: the app opens, reloads or comes back to the foreground. Only then does
// the server end a session past its maximum duration (never in the middle of use).
export async function confirmLock({ resume = false } = {}) {
  try {
    const st = await api<AuthStatus>(resume ? '/api/auth/status?resume=1' : '/api/auth/status')
    if (st.enabled && !st.unlocked) return showLock()
    const access = leaseFromStatus(st)
    setOfflineAccess(access)
    if (resume) warnDeadline(access)
  } catch { /* unreachable: not a reason to lock */ }
}

// Last hours before the maximum duration: say once that the next opening asks
// for the passkey again.
let deadlineWarned = false
function warnDeadline(access: OfflineAccess) {
  if (deadlineWarned || !access.deadline || access.deadline - Date.now() > DEADLINE_WARNING_MS) return
  deadlineWarned = true
  toast(t('The passkey will be asked again the next time the app opens.'))
}

// ---------------------------------------------------------------- verrouillage
let booted = false
let sessionsTimer: ReturnType<typeof setInterval> | undefined
export function boot() {
  if (booted) return
  booted = true
  locked.value = false
  connectEvents()
  sessionsTimer ||= setInterval(checkSessionsTick, 30000)
  loadConfig()
  syncPushLanguage().catch(() => {})
}
export function showLock() {
  locked.value = true
  herdrState.value = { ok: false, workspaces: [], panes: [] }
  fullState = herdrState.value
  allSessionsState.value = fullState
  cachedAt.value = null
  setOfflineAccess(null)
  clearOffline()
  // Nothing must talk to the server any more until it is unlocked.
  eventProbe.cancel()
  clearTimeout(evHandshake)
  const ws = evWs
  evWs = null
  if (ws) {
    ws.onclose = null
    try { ws.close() }
    catch { /* already closed */ }
  }
  eventsOpen.value = false
  clearTimeout(evTimer)
  setNetDown(false)
  booted = false
}

// App opening or back in the foreground: a server that accepts the connection
// but never answers (phone on a tailnet whose wherdr host is gone) counts as
// unreachable past this delay, so the last known state shows and the live
// connection keeps retrying. Unlock and Settings wait for the answer.
const STATUS_WAIT_MS = 3000

// resume: see confirmLock.
export async function start({ resume = false } = {}) {
  let access = readOfflineAccess()
  // The last known state is read while the server is asked (it shows only once
  // the answer allows it): one round trip less before the home list.
  const early = mayReadOffline(access) ? readHome() : null
  try {
    const st = resume
      ? await api<AuthStatus>('/api/auth/status?resume=1', undefined, AbortSignal.timeout(STATUS_WAIT_MS))
      : await api<AuthStatus>('/api/auth/status')
    if (st.hostLabel !== undefined) hostLabel.value = st.hostLabel
    if (st.enabled && !st.unlocked) return showLock()
    access = leaseFromStatus(st)
    setOfflineAccess(access)
    if (resume) warnDeadline(access)
  } catch {
    // Server unreachable with an expired lease: hide the cache, unless the live
    // connection is up (a transient HTTP error; the next check retries).
    if (access?.enabled && !mayReadOffline(access) && !eventsOpen.value) return showLock()
  }
  if (mayReadOffline(access)) {
    const saved = await (early || readHome())
    if (saved && !eventsOpen.value) {
      fullState = saved.state
      allSessionsState.value = fullState
      herdrState.value = selectSessions(fullState, machineSessions.value)
      cachedAt.value = saved.at
    }
  }
  boot()
}
