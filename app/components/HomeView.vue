<script setup lang="ts">
// Agent list, grouped by state; sidebar on a computer.
// Several machines: one section per machine (like Herdr's sidebar),
// collapsible, with its connection state; the state groups
// inside. A single machine: the previous list, without a header.
// Quotas: those shared by all machines at the top; the Claude account specific
// to a machine (different accounts) and its install banner under its header.
// One row per Herdr space (shared/spaces.ts): a space with a single tab and
// a single pane keeps its agent's card; otherwise a space card, sorted
// by its most urgent pane.
// Terminals: a shell space is a row like any other, sorted in
// Ready ("Show terminals" setting).
// herdr-projects (shared/boardLinks.ts): each machine's Coordinator and machine
// coordinator at its top, then one group per repo as Herdr's sidebar draws it
// (the repo's space, its project coordinator, its tasks' spaces), then the
// state groups of everything else.
import { skipWhileBusy } from '~/utils/requestGuards'
import type { MachineInfo, NamedSession, Pane } from '#shared/types'
import { type ReadySort, type Row, readyLists, rowGroup, sortReady, spaceRows } from '#shared/spaces'
import { spaceTitle } from '#shared/displayTitles'
import { type BoardCard, type CoordinatorLevel, boardSections, countedPanes } from '#shared/boardLinks'
import { homeCounts, withBoardGroups } from '#shared/homeCounts'
import { claudeApiShown, claudeSuggestion, machineQuotaRows, quotaRows, tabQuotaRows } from '~/utils/quotas'
import { longPress } from '~/utils/longPress'
import { LIST_DEFAULT, LIST_MAX, LIST_MIN, LIST_RAIL, clampListWidth, listWidthCss, readListCollapsed, readListWidth, saveListCollapsed, saveListWidth } from '~/utils/sideWidth'
import { headerFold } from '~/utils/headerFold'
import { quietPeriodEnd } from '~/utils/quietPeriodEnd'
import { listMode } from '~/utils/layoutMode'
import pkg from '../../package.json'
import { dropMachineKey, shiftMachineKey } from '#shared/machineOrder'
import { stateEntries, stateMachines } from '~/utils/homeGrouping'
import { BAR_ALL } from '~/utils/machineBar'
import { individualAgentRows, individualAgentTitle, isIndividualAgentRow } from '~/utils/homeAgentRows'
import type { AwakeState, SleepAssertion, AwakeMode } from '../../server/utils/awake'
const emit = defineEmits<{ search: [] }>()
useQuotaLoader()
onMounted(loadUpdate)

const everOpen = ref(false)
watch(eventsOpen, (v) => { if (v) everOpen.value = true })

const st = herdrState
const agents = computed(() => st.value.panes.filter(p => p.agent))
const fileLinks = useBoardLinks()
// The Board's own list (herdr-projects' CLI): where each task stands, for its
// card and the counters, as the Board shows it (shared/homeCounts.ts).
const { board: tasksBoard } = useTasksBoard()
const boardLinks = computed(() => withBoardGroups(fileLinks.value, tasksBoard.value))
// Old notification exceptions keyed by a coordinator's pane move to its identity.
useNotificationRekey()
// What the counters count: a board task's helpers (reviewer, planner,
// attempts) count once, as its row on the list.
const counted = computed(() => countedPanes(agents.value, boardLinks.value))
// Counters follow the selected machine or group; unreachable machines stay out.
const baseOfPane = (p: Pane) => { const m = machineInfo(p.machine); return m ? m.baseKey ?? m.key : p.machine || '' }
// A board task counts by its state on the Board, once; other agents by their own.
const counts = computed(() => {
  const sel = machineBarSelection.value
  return homeCounts(agents.value, boardLinks.value, tasksBoard.value,
    p => !paneStale(p) && (sel === null || sel.includes(baseOfPane(p))),
    m => sel === null || sel.includes(m))
})

const conn = computed(() => {
  if (offlineView.value) return { ok: false, text: t('offline'), idle: false }
  if (!eventsOpen.value) return { ok: false, text: everOpen.value ? t('offline — reconnecting…') : t('connecting…'), idle: !everOpen.value }
  if (!st.value.ok) return { ok: false, text: t('Herdr unavailable'), idle: false }
  // Server version (update check), the app's own until it answers.
  return { ok: true, text: `wherdr ${updateInfo.value?.current || pkg.version} · herdr ${st.value.version || ''}`.trim(), idle: false }
})

// "Dashboard"-style counters: always all three, zeros dimmed.
const stats = computed(() => ([
  ['blocked', counts.value.blocked, t('your turn')],
  ['working', counts.value.working, t('working')],
  ['done', counts.value.ready, t('ready')],
] as [string, number, string][]).map(([s, n, label]) => ({ s, n, label })))

// Herdr's order stays that of each repository list. The Ready group may
// show unread before read, and be sorted differently (readySort).
function groupsOf(list: Row[], group = rowGroup) {
  return ([
    { key: 'blocked', title: t('Your turn'), list: list.filter(r => group(r) === 'blocked') },
    { key: 'working', title: t('Working'), list: list.filter(r => group(r) === 'working') },
    { key: 'ready', title: tl('Ready', 'Prêts'), list: list.filter(r => group(r) === 'ready') },
  ] as const).filter(g => g.list.length).map(g => ({ ...g, lists: g.key === 'ready' ? readyLists(g.list, autoReorderReady.value).map(l => sortReady(l, readySort.value, rowTitle)) : [g.list] }))
}
const rowTitle = (r: Row) => isIndividualAgentRow(r) ? individualAgentTitle(r.lead) : spaceTitle(r.lead, st.value.workspaces.find(w => w.id === r.lead.workspace))
const standaloneRows = (rows: Row[]) => individualAgentList.value ? individualAgentRows(rows) : rows
// Sort menu of the Ready group; sorted other than in Herdr's order, the
// list can no longer be reordered manually.
const READY_SORT_LABELS: Record<ReadySort, [string, string]> = {
  herdr: ['Herdr order', 'i-lucide-grip-vertical'], recent: ['Recent activity', 'i-lucide-clock'], name: ['Name', 'i-lucide-arrow-down-a-z'],
}
const readySortItems = computed(() => [[
  { type: 'label' as const, label: t('Sort ready') },
  ...(Object.keys(READY_SORT_LABELS) as ReadySort[]).map(s => ({
    label: t(READY_SORT_LABELS[s][0]), icon: READY_SORT_LABELS[s][1], type: 'checkbox' as const,
    checked: readySort.value === s, onUpdateChecked: () => { readySort.value = s },
  })),
]])
// Rows of a machine: its coordinators, its repo groups, then the state groups
// of its other spaces, shells included, in Herdr's order. A repo's own space
// (a shell) heads its group whatever "Show terminals" says.
const livePanes = computed(() => new Set(st.value.panes.map(p => p.id)))
function listOf(rows: Row[]) {
  const b = boardSections(rows, st.value.workspaces, boardLinks.value, livePanes.value, k => machineInfo(k)?.baseKey ?? k)
  return {
    coordinators: b.coordinators,
    projects: b.projects,
    groups: groupsOf(standaloneRows(b.others).filter(r => r.lead.agent || showShells.value)),
  }
}
// Each kind of coordinator with its own icon and label (coordinatorKind).
function coordinatorCard(level: CoordinatorLevel, local = true, machine = '', repo = ''): BoardCard {
  const k = coordinatorKind(level, local, machine, repo)
  return { tag: '', name: k.name, icon: k.icon, hint: k.hint, coordinator: true }
}
const soloLocal = computed(() => machineInfo(machineBaseKeys.value[0] ?? '')?.local ?? true)
const soloName = computed(() => machineName(machineBaseKeys.value[0] ?? '') || hostLabel.value)
const soloSelected = computed(() => machineBarSelection.value === null || machineBarSelection.value.includes(machineBaseKeys.value[0] ?? ''))
const solo = computed(() => listOf(soloSelected.value ? spaceRows(st.value) : []))

const topQuotas = computed(() => (showQuotas.value ? quotaRows(homeQuotas.value, hiddenAgents.value) : []))
// Claude on API billing (no quota): a label instead of gauges.
const topApi = computed(() => showQuotas.value && claudeApiShown(homeQuotas.value, null, hiddenAgents.value))
const machineApi = (key: string) => showQuotas.value && claudeApiShown(homeQuotas.value, key, hiddenAgents.value)
// Claude quotas to install or update on a machine: never a block in the list,
// only two items in its "…" menu (Settings › Agents, or don't suggest again).
function claudeHint(m: MachineInfo) {
  if (!showQuotas.value || m.status !== 'online') return null
  const key = baseKeyOf(m)
  const kinds = appConfig.value.machines?.find(c => c.key === key)?.kinds ?? (multiMachine.value ? [] : appConfig.value.kinds)
  const has = kinds.includes('claude') || agents.value.some(p => p.agent === 'claude' && baseOfPane(p) === key)
  return claudeSuggestion(homeQuotas.value, key, has, hiddenAgents.value)
}

// ------------------------------------------------------------ machines
const STATE_LABEL: Record<MachineInfo['status'], string> = { online: 'online', connecting: 'reconnecting…', offline: 'offline' }
const visibleKeys = machineBaseKeys
const draggingMachine = ref<string | null>(null)
const dropMachine = ref<string | null>(null)
const dropAfter = ref(false)
onMounted(loadMachineOrder)
watch(() => machines.value.map(m => m.baseKey ?? m.key).join('|'), loadMachineOrder)
function shiftMachine(key: string, direction: -1 | 1) {
  const next = shiftMachineKey(visibleKeys.value, key, direction)
  if (!next) return
  haptic()
  saveMachineOrder(next)
}
// The local machine's key is '': we compare draggingMachine with null.
function onMachineDrop(key: string, event: DragEvent) {
  event.preventDefault()
  const next = dropMachineKey(visibleKeys.value, draggingMachine.value, key, dropAfter.value)
  draggingMachine.value = null
  dropMachine.value = null
  if (next) saveMachineOrder(next)
}
function onMachineDragOver(key: string, event: DragEvent) {
  if (draggingMachine.value === null || draggingMachine.value === key) return
  event.preventDefault()
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  dropMachine.value = key
  dropAfter.value = event.clientY > rect.top + rect.height / 2
}
function onMachineDragStart(key: string, event: DragEvent) {
  draggingMachine.value = key
  // Empty data may cancel the drag depending on the browser.
  event.dataTransfer?.setData('text/plain', key || 'local')
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}
function onMachineDragEnd() { draggingMachine.value = null; dropMachine.value = null }
const sections = computed(() => {
  if (!multiMachine.value) return null
  const only = machineBarSelection.value
  const selected = orderedMachines.value.filter(m => only === null || only.includes(baseKeyOf(m)))
  if (only) selected.sort((a, b) => only.indexOf(baseKeyOf(a)) - only.indexOf(baseKeyOf(b)))
  return selected.map((m) => {
    const mine = (p: Pane) => (p.machine || '') === m.key
    const a = agents.value.filter(mine)
    const c = counted.value.filter(mine)
    return {
      m,
      name: machineName(m.key),
      state: t(STATE_LABEL[m.status]),
      agents: a,
      counted: c,
      ...listOf(spaceRows(st.value, m.key)),
      waiting: c.filter(p => p.status === 'blocked').length,
      collapsed: collapsedMachines.value.includes(m.key),
      quotas: showQuotas.value && m.status === 'online' ? machineQuotaRows(homeQuotas.value, m.baseKey ?? m.key, hiddenAgents.value) : [],
      api: m.status === 'online' && machineApi(m.baseKey ?? m.key),
    }
  })
})
// State mode includes online machines only. The bar's selected base keys
// also cover named sessions; iterating them preserves the selected group order.
const stateShown = computed(() => stateMachines(machines.value.length ? orderedMachines.value : [soloMachine.value], machineBarSelection.value))
// What belongs to one machine stays reachable in State mode: its "…" menu
// (sessions, keep awake, board, plugins, Claude quotas) on its chip, and its
// own quotas under the row; offline or reconnecting machines keep their state
// and last known agent count on one line at the bottom.
const stateMachineChips = computed(() => stateShown.value.online.map(m => ({
  m, name: machineName(m.key) || m.label || t('This machine'),
  awake: awakeByMachine.value[m.key]?.active ? awakeByMachine.value[m.key] : undefined,
  claude: claudeHint(m),
  quotas: showQuotas.value ? machineQuotaRows(homeQuotas.value, baseKeyOf(m), hiddenAgents.value) : [],
  api: machineApi(baseKeyOf(m)),
})))
const stateAway = computed(() => stateShown.value.away.map(m => ({
  m, name: machineName(m.key) || m.label || t('This machine'), state: t(STATE_LABEL[m.status]),
  known: counted.value.filter(p => (p.machine || '') === m.key).length,
})))
const stateCards = computed(() => {
  return stateShown.value.online.flatMap(m => {
    const b = boardSections(spaceRows(st.value, m.key), st.value.workspaces, boardLinks.value, livePanes.value, k => machineInfo(k)?.baseKey ?? k)
    return stateEntries({ ...b, others: standaloneRows(b.others) }, showShells.value).map(e => ({
      ...e,
      machine: machineName(m.key) || m.label,
      board: e.member ? memberCard(e.member) : e.level ? coordinatorCard(e.level, m.local, machineName(m.key) || m.label, e.repo) : null,
    }))
  })
})
const stateCardByKey = computed(() => new Map(stateCards.value.map(c => [c.row.key, c])))
const stateGroups = computed(() => groupsOf(stateCards.value.map(c => c.row), r => {
  const group = stateCardByKey.value.get(r.key)?.board?.group
  return group ? group === 'needs' ? 'blocked' : group === 'working' ? 'working' : 'ready' : rowGroup(r)
}))
// Machine bar: "All", then each machine (a named session counts as its machine),
// with its state and the number of agents the list counts.
const barEntries = computed(() => machineBarShown.value.map((id) => {
  if (id === BAR_ALL) return { id, label: t('All'), status: null, title: undefined, n: counted.value.length }
  const group = machineGroups.value.find(g => g.id === id)
  if (group) return { id, label: group.name, status: null, title: group.name, n: counted.value.filter(p => group.machines.includes(baseOfPane(p))).length }
  // A single machine Herdr's state does not list: the one shown in the session row.
  const listed = machines.value.filter(m => baseKeyOf(m) === id)
  const mine = listed.length ? listed : id === soloMachine.value.key ? [soloMachine.value] : []
  const keys = new Set(mine.map(m => m.key))
  const status: MachineInfo['status'] = mine.some(m => m.status === 'online') ? 'online' : mine.some(m => m.status === 'connecting') ? 'connecting' : 'offline'
  const label = (listed.length ? machineName(listed[0]!.key) : mine[0]?.label) || id || t('This machine')
  return { id, label, status, title: `${label} · ${t(STATE_LABEL[status])}`, n: counted.value.filter(p => keys.has(p.machine || '')).length }
}))
// The machine a bar item stands for (a named session counts as its machine):
// the base machine itself when Herdr lists it, else its first session.
function barMachine(id: string): MachineInfo | null {
  if (id === BAR_ALL || machineGroups.value.some(g => g.id === id)) return null
  const listed = machines.value.filter(m => baseKeyOf(m) === id)
  return listed.find(m => m.key === id) ?? listed[0] ?? (id === soloMachine.value.key ? soloMachine.value : null)
}
// Right click (computer) or long press (phone) on a bar item: a machine's
// actions (those of its "…" menu), a group's settings. "All" has none.
function barMenuItems(id: string): MenuItem[] {
  const group = machineGroups.value.find(g => g.id === id)
  if (group) {
    return [
      { label: tl('Group settings', 'Réglages du groupe'), icon: 'i-lucide-settings-2', run: () => navigateTo({ path: '/settings', query: { section: 'appearance', group: group.id } }) },
      // The Board settings of one of its machines: the screen asks which.
      { label: tl('Board settings', 'Réglages du board'), icon: 'i-lucide-settings', run: () => navigateTo({ path: '/board', query: { settings: group.id } }) },
    ]
  }
  const m = barMachine(id)
  return m ? machineMenuItems(m) : []
}
function onBarMenu(id: string, open: boolean) {
  const m = barMachine(id)
  if (open && m?.status === 'online') loadPluginActions(multiMachine.value ? m.key : '')
}
let barPressed: { id: string, label: string } | null = null
const barLp = longPress({
  onPress: () => {
    const items = barPressed ? barMenuItems(barPressed.id) : []
    if (!barPressed || !items.length) return
    haptic()
    onBarMenu(barPressed.id, true)
    openMenu(items, barPressed.label)
  },
})
// Touch or narrow screen only: otherwise the floating context menu handles it.
function onBarDown(e: PointerEvent, id: string, label: string) {
  if (!sheetMenus.value) return
  barPressed = { id, label }
  barLp.down(e)
}
// A tab showing one machine only: its section without the header (the tab
// already names it), its quotas together at the top. A group or "All" keeps
// the machine headers, even with a single machine in it. State mode has its own
// machine chips and quotas.
const soloTab = computed(() => {
  const pick = machineBarPick.value
  if (homeGrouping.value !== 'machine' || !sections.value || sections.value.length !== 1 || pick === null || !barMachine(pick)) return null
  return sections.value[0]!
})
const listQuotas = computed(() => (soloTab.value ? tabQuotaRows(topQuotas.value, soloTab.value.quotas) : topQuotas.value))
const listApi = computed(() => topApi.value || Boolean(soloTab.value?.api))
const homeRoot = ref<HTMLElement | null>(null)
const homeScroll = ref<HTMLElement | null>(null)
const swipeDirection = useHomeSwipe(homeRoot, () => barEntries.value.map(b => b.id), () => machineBarPick.value, id => pickBar(id))
function retireHomeContent(el: Element) {
  ;(el as HTMLElement).inert = true
  el.setAttribute('aria-hidden', 'true')
}
const switchMachineConversation = useMachineConversation()
function pickBar(id: string, event?: MouseEvent) {
  if (barLp.swallowClick()) return
  if (id === machineBarPick.value) homeScroll.value?.scrollTo({ top: 0 })
  haptic()
  pickMachineBar(id)
  switchMachineConversation()
  // A folded machine opens: shown alone, it would only be a heading.
  if (id !== BAR_ALL) {
    const selected = machineGroups.value.find(g => g.id === id)?.machines ?? [id]
    const keys = machines.value.filter(m => selected.includes(baseKeyOf(m))).map(m => m.key)
    if (keys.some(k => collapsedMachines.value.includes(k))) collapsedMachines.value = collapsedMachines.value.filter(k => !keys.includes(k))
  }
  const button = event?.currentTarget as HTMLElement | null
  requestAnimationFrame(() => (button ?? Array.from(homeRoot.value?.querySelectorAll<HTMLElement>('.machine-bar-item') ?? []).find(b => b.dataset.barId === id))?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }))
}
// A mouse wheel scrolls the bar sideways when it overflows (narrow sidebar).
function onBarWheel(e: WheelEvent) {
  const bar = e.currentTarget as HTMLElement
  if (!e.deltaY || Math.abs(e.deltaX) > Math.abs(e.deltaY) || bar.scrollWidth <= bar.clientWidth) return
  e.preventDefault()
  bar.scrollLeft += e.deltaY
}
function toggleMachine(key: string) {
  haptic()
  const c = collapsedMachines.value
  collapsedMachines.value = c.includes(key) ? c.filter(k => k !== key) : [...c, key]
}
const renamingMachine = ref<MachineInfo | null>(null)
const machineLabel = ref('')
const awakeByMachine = ref<Record<string, AwakeState>>({})
const awakeTarget = ref<MachineInfo | null>(null)
const awakeBusy = ref(false)
const awakeLid = ref(false)
const diagnosticTarget = ref<MachineInfo | null>(null)
const assertions = ref<SleepAssertion[]>([])
const diagnosticBusy = ref(false)
const eveningPast = computed(() => Boolean(awakeTarget.value && awakeByMachine.value[awakeTarget.value.key]?.eveningPast))
const awakeOpen = computed({ get: () => Boolean(awakeTarget.value), set: v => { if (!v) awakeTarget.value = null } })
const diagnosticOpen = computed({ get: () => Boolean(diagnosticTarget.value), set: v => { if (!v) diagnosticTarget.value = null } })
const awakeUrl = (key: string, diagnostic = false) => `/api/machine/awake?key=${encodeURIComponent(key)}${diagnostic ? '&diagnostic=1' : ''}`
async function refreshAwake(m: MachineInfo) {
  if (m.status !== 'online') return
  try { awakeByMachine.value[m.key] = await api<AwakeState>(awakeUrl(m.key)) }
  catch { /* the machine may disappear between two polls */ }
}
let awakeTimer: ReturnType<typeof setInterval> | undefined
// A tick starts nothing while the last round is still out (utils/requestGuards.ts).
const awakeTick = skipWhileBusy(() => Promise.all(awakeMachines().map(refreshAwake)))
onMounted(() => { awakeTimer = setInterval(() => { if (document.visibilityState === 'visible') awakeTick() }, 30000) })
onBeforeUnmount(() => clearInterval(awakeTimer))
function openAwake(m: MachineInfo) {
  awakeTarget.value = m
  awakeLid.value = awakeByMachine.value[m.key]?.lid || false
  refreshAwake(m)
}
async function chooseAwake(mode: AwakeMode | 'off') {
  const m = awakeTarget.value
  if (!m || awakeBusy.value) return
  awakeBusy.value = true
  try {
    awakeByMachine.value[m.key] = await api<AwakeState>('/api/machine/awake', { key: m.key, mode, lid: mode === 'off' ? false : awakeLid.value })
    awakeTarget.value = null
  } catch (e) { toast((e as Error).message, true) }
  finally { awakeBusy.value = false }
}
async function openDiagnostic(m: MachineInfo) {
  diagnosticTarget.value = m
  diagnosticBusy.value = true
  assertions.value = []
  try {
    const result = await api<AwakeState & { assertions: SleepAssertion[] }>(awakeUrl(m.key, true))
    awakeByMachine.value[m.key] = result
    assertions.value = result.assertions
  } catch (e) { toast((e as Error).message, true) }
  finally { diagnosticBusy.value = false }
}
function durationLabel(seconds: number) {
  if (seconds < 60) return tl('less than a minute', 'moins d’une minute')
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`
  return `${Math.floor(seconds / 3600)} h ${Math.floor(seconds % 3600 / 60)} min`
}
function extendLabel(state?: AwakeState) {
  if (!state?.until) return ''
  const at = new Date(Math.max(state.until, Date.now()) + 3600000).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })
  return tl(`Until ${at}`, `Jusqu’à ${at}`)
}
function awakeLabel(state?: AwakeState) {
  if (!state?.active) return ''
  return state.until ? tl(`Awake until ${fmtTime(state.until)}`, `Éveillé jusqu’à ${fmtTime(state.until)}`) : tl('Awake until turned off', 'Éveillé jusqu’à désactivation')
}
const savingMachine = ref(false)
const sessionTarget = ref<MachineInfo | null>(null)
const sessionRows = ref<NamedSession[]>([])
const sessionsLoading = ref(false)
const sessionOpen = computed({ get: () => Boolean(sessionTarget.value), set: (v: boolean) => { if (!v) sessionTarget.value = null } })
const soloMachine = computed<MachineInfo>(() => machines.value[0] || {
  key: '', label: hostLabel.value || 'herdr', local: true, status: st.value.ok ? 'online' : 'offline',
  error: null, session: st.value.session || 'default',
})
// A single machine: the state lists no machines, we probe the machine alone.
const awakeMachines = () => machines.value.length ? machines.value : [soloMachine.value]
watch(() => awakeMachines().map(m => `${m.key}:${m.status}`).join('|'), () => {
  for (const m of awakeMachines()) refreshAwake(m)
}, { immediate: true })
const baseKeyOf = (m: MachineInfo) => m.baseKey ?? m.key
async function openSessions(m: MachineInfo) {
  sessionTarget.value = m
  sessionsLoading.value = true
  sessionRows.value = []
  try { sessionRows.value = await listMachineSessions(baseKeyOf(m)) }
  catch (err) { toast((err as Error).message, true) }
  finally { sessionsLoading.value = false }
}
async function selectSession(s: NamedSession) {
  const m = sessionTarget.value
  if (!m || !s.running) return
  sessionsLoading.value = true
  try {
    await chooseMachineSession(baseKeyOf(m), s.name)
    sessionTarget.value = null
    await navigateTo('/')
  } catch (err) { toast((err as Error).message, true) }
  finally { sessionsLoading.value = false }
}
const renameMachineOpen = computed({
  get: () => Boolean(renamingMachine.value),
  set: (open: boolean) => { if (!open) renamingMachine.value = null },
})
const connectionMachine = ref<MachineInfo | null>(null)
const connectionInfo = computed(() => machines.value.find(m => m.key === connectionMachine.value?.key) ?? connectionMachine.value)
const connectionOpen = computed({ get: () => !!connectionMachine.value, set: (v: boolean) => { if (!v) connectionMachine.value = null } })
function machineMenuItems(m: MachineInfo): MenuItem[] {
  const items: MenuItem[] = [{ label: t('Herdr sessions'), icon: 'i-lucide-layers', run: () => openSessions(m) }, { label: t('Rename'), icon: 'i-lucide-pencil', run: () => {
    renamingMachine.value = m
    machineLabel.value = m.label
  } }]
  if (!m.local) items.push({ label: t('Connection status'), icon: 'i-lucide-plug', run: () => { connectionMachine.value = m } })
  if (multiMachine.value) {
    const key = baseKeyOf(m)
    const at = visibleKeys.value.indexOf(key)
    if (at > 0) items.push({ label: t('Move up'), icon: 'i-lucide-arrow-up', run: () => shiftMachine(key, -1) })
    if (at >= 0 && at < visibleKeys.value.length - 1) items.push({ label: t('Move down'), icon: 'i-lucide-arrow-down', run: () => shiftMachine(key, 1) })
    if (machineOrder.value.length) items.push({ label: t('Reset order'), icon: 'i-lucide-rotate-ccw', run: () => saveMachineOrder([]) })
  }
  // The Board, already filtered on this machine (its board is the base machine's).
  items.push({ label: t('Open the board'), icon: 'i-lucide-square-kanban', run: () => navigateTo({ path: '/board', query: { machine: baseKeyOf(m) } }) })
  items.push({ label: tl('Board settings', 'Réglages du board'), icon: 'i-lucide-settings', run: () => navigateTo({ path: '/board', query: { settings: baseKeyOf(m) } }) })
  if (m.status === 'online' && awakeByMachine.value[m.key]?.supported) {
    items.push({ label: t('Keep awake'), icon: 'i-lucide-sun', run: () => openAwake(m) })
    if (awakeByMachine.value[m.key]?.platform === 'mac') items.push({ label: t('What prevents sleep'), icon: 'i-lucide-list-filter', run: () => openDiagnostic(m) })
  }
  // Global actions of this machine's Herdr plugins (a single machine: loaded under '').
  const pluginKey = multiMachine.value ? m.key : ''
  if (m.status === 'online' && machinePluginActions(pluginKey).length) {
    items.push({ label: t('Plugin actions'), icon: 'i-lucide-puzzle', run: () => openPluginMenu({ machine: pluginKey }) })
  }
  const hint = claudeHint(m)
  if (hint) {
    items.push(
      { kind: 'separator' },
      {
        label: hint.state === 'outdated' ? tl('Update Claude quotas', 'Mettre à jour les quotas Claude') : tl('Set up Claude quotas', 'Configurer les quotas Claude'),
        desc: tl('In Settings › Agents', 'Dans Réglages › Agents'),
        icon: 'i-lucide-gauge',
        run: () => navigateTo({ path: '/settings', query: { section: 'agents' } }),
      },
      { label: tl('Don’t suggest again', 'Ne plus proposer'), icon: 'i-lucide-eye-off', run: async () => {
        if (await dismissClaudeQuotas([hint.key])) toast(tl('Claude quotas stay in Settings › Agents.', 'Les quotas Claude restent dans Réglages › Agents.'))
      } },
    )
  }
  return items
}
const machineMenu = (m: MachineInfo) => toDropdown(machineMenuItems(m))
// Plugin actions of each online machine (a single one: the local one).
const onlineKeys = computed(() => JSON.stringify(multiMachine.value ? machines.value.filter(m => m.status === 'online').map(m => m.key) : (st.value.ok ? [''] : [])))
watch(onlineKeys, (keys) => { for (const k of JSON.parse(keys) as string[]) loadPluginActions(k) }, { immediate: true })
// Quiet mode active: no header button (the header keeps its shape), a discreet line in
// the list instead, and an entry in the header "…" menu when it shows. Both open the
// notification settings.
const quietLabel = computed(() => tl('Notifications silenced — open settings', 'Notifications en silence — ouvrir les réglages'))
const quietSettings = '/settings?section=notifications'
const quietHint = computed(() => {
  const cur = quietCurrent.value
  if (!cur) return ''
  const end = quietPeriodEnd(cur.quiet, quietNow.value)
  if (end.kind === 'manual') return tl('Notifications silenced', 'Notifications en silence')
  const time = fmtTime(end.at)
  if (end.kind === 'today') return tl(`Notifications silenced until ${time}`, `Notifications en silence jusqu’à ${time}`)
  if (end.kind === 'tomorrow') return tl(`Notifications silenced until tomorrow ${time}`, `Notifications en silence jusqu’à demain ${time}`)
  const day = new Date(end.at).toLocaleDateString(language, { weekday: 'short', day: 'numeric', month: 'short' })
  return tl(`Notifications silenced until ${day} ${time}`, `Notifications en silence jusqu’au ${day} ${time}`)
})
const onQuietVisible = () => { if (document.visibilityState === 'visible') refreshQuiet() }
onMounted(() => { refreshQuiet(); document.addEventListener('visibilitychange', onQuietVisible) })
onBeforeUnmount(() => document.removeEventListener('visibilitychange', onQuietVisible))
// A single machine: its "…" menu (Open the board, keep awake, plugin actions) is on its session row.
// Header buttons: when the list is too narrow, the secondary ones move into a "…" menu
// (settings first, then the board).
const titleRow = ref<HTMLElement | null>(null)
const titleRowWidth = ref(0)
let titleRowObserver: ResizeObserver | null = null
onMounted(() => {
  titleRowObserver = new ResizeObserver(([e]) => { titleRowWidth.value = e?.contentRect.width ?? 0 })
  if (titleRow.value) titleRowObserver.observe(titleRow.value)
})
onBeforeUnmount(() => titleRowObserver?.disconnect())
// First to fold first.
const headerFoldable = ['settings', 'board']
const headerFolded = computed(() => {
  if (!titleRowWidth.value) return new Set<string>()
  const total = headerFoldable.length + 1 + (desk.value ? 1 : 0)
  return new Set(headerFoldable.slice(0, headerFold(titleRowWidth.value, total, headerFoldable.length)))
})
function headerMenuItems(): MenuItem[] {
  const f = headerFolded.value
  return [
    ...(quietCurrent.value ? [{ label: quietLabel.value, icon: 'i-lucide-bell-off', run: () => navigateTo(quietSettings) }] : []),
    ...(f.has('board') ? [{ label: t('Board'), icon: 'i-lucide-square-kanban', run: () => navigateTo('/board') }] : []),
    ...(f.has('settings') ? [{ label: t('Settings'), icon: 'i-lucide-settings-2', run: () => navigateTo('/settings') }] : []),
  ]
}
async function saveMachine() {
  if (!renamingMachine.value || savingMachine.value) return
  const label = machineLabel.value.replace(/\s+/g, ' ').trim()
  if (!label) return
  savingMachine.value = true
  try {
    await api('/api/machine/rename', { key: baseKeyOf(renamingMachine.value), label })
    renamingMachine.value = null
    await loadConfig()
    toast(t('Machine renamed'))
  } catch (err) { toast((err as Error).message, true) }
  finally { savingMachine.value = false }
}

// Reorder: connected, and the machine online.
function canReorder(machine: string) {
  // Dragging a pane must not silently reorder its whole workspace.
  if (individualAgentList.value) return false
  if (offlineView.value || !eventsOpen.value || !st.value.ok) return false
  return !multiMachine.value || machines.value.some(m => m.key === machine && m.status === 'online')
}

function newAgent() {
  haptic()
  newAgentOpen.value = true
}
function openSearch() { emit('search') }

// Sidebar width (computer): handle on its right edge
// (drag, keyboard arrows; double-click = default width), clamped,
// kept on the device. It sets --side, which the right-hand views follow.
// Collapsed, the list leaves a narrow column: show it, search, launch
// an agent and the state counters.
const listWidth = ref<number | null>(null)
const listDrag = ref(false)
const listCollapsed = ref(false)
// Tablet in portrait (slim): the list stays a narrow column; opened, it
// slides over the agent (drawer) and closes once a choice is made.
const drawerOpen = listDrawer
const mode = computed(() => listMode({ desk: desk.value, slim: slim.value, collapsed: listCollapsed.value, drawerOpen: drawerOpen.value }))
const rail = computed(() => mode.value === 'rail')
const drawer = computed(() => mode.value === 'drawer')
const homeRoute = useRoute()
// On the home page there is no agent to show: the list opens there.
const atHome = () => homeRoute.path === '/' || homeRoute.path === ''
watch(() => homeRoute.fullPath, () => { drawerOpen.value = slim.value && atHome() }, { immediate: true })
watch(slim, (v) => { drawerOpen.value = v && atHome() })
function onDrawerKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && drawer.value) { e.preventDefault(); setListCollapsed(true) }
}
// The agent already open: no route change, close on the tap itself.
function onDrawerPick(e: MouseEvent) {
  if (drawer.value && (e.target as Element | null)?.closest('.card')) drawerOpen.value = false
}
onMounted(() => {
  listWidth.value = readListWidth()
  listCollapsed.value = readListCollapsed()
  window.addEventListener('keydown', onDrawerKey)
})
onUnmounted(() => window.removeEventListener('keydown', onDrawerKey))
watch([listWidth, rail, slim], ([w, r, narrow]) => {
  const root = document.documentElement.style
  if (r || narrow) root.setProperty('--side', `${LIST_RAIL}px`)
  else if (w === null) root.removeProperty('--side')
  else root.setProperty('--side', listWidthCss(w))
}, { immediate: import.meta.client })
// The original button disappears with its column: the focus goes to the opposite one.
function setListCollapsed(collapsed: boolean) {
  if (slim.value) drawerOpen.value = !collapsed
  else {
    listCollapsed.value = collapsed
    saveListCollapsed(collapsed)
  }
  nextTick(() => document.querySelector<HTMLElement>(`#home ${collapsed ? '.home-rail' : '.home-top'} .rail-toggle`)?.focus())
}
function listNow() { return document.getElementById('home')?.getBoundingClientRect().width || LIST_DEFAULT }
function onListGrab(e: PointerEvent) {
  if (e.button !== 0) return
  const handle = e.currentTarget as HTMLElement
  e.preventDefault()
  const x0 = e.clientX
  const w0 = listNow()
  handle.setPointerCapture(e.pointerId)
  listDrag.value = true
  const move = (ev: PointerEvent) => { listWidth.value = clampListWidth(w0 + ev.clientX - x0, window.innerWidth) }
  const up = () => {
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', up)
    handle.removeEventListener('pointercancel', up)
    listDrag.value = false
    saveListWidth(listWidth.value)
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', up)
  handle.addEventListener('pointercancel', up)
}
function onListKey(e: KeyboardEvent) {
  const step = e.shiftKey ? 64 : 16
  const d = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
  if (e.key === 'Home' || e.key === 'Enter') { e.preventDefault(); return resetListWidth() }
  if (!d) return
  e.preventDefault()
  listWidth.value = clampListWidth(listNow() + d, window.innerWidth)
  saveListWidth(listWidth.value)
}
function resetListWidth() {
  listWidth.value = null
  saveListWidth(null)
}
</script>

<template>
  <section ref="homeRoot" id="home" class="view" :class="{ resizing: listDrag, rail, drawer, 'list-compact': compactList }" @click.capture="onDrawerPick">
    <!-- Collapsed list (computer): narrow column, the rest of the list is hidden. -->
    <nav v-if="rail" class="home-rail" :aria-label="t('Agents')">
      <AppLogo class="home-logo" :class="conn.idle ? '' : conn.ok ? 'ok' : 'bad'" :title="conn.text" />
      <UTooltip :text="t('Show list')" :content="{ side: 'right' }">
        <UButton icon="i-lucide-panel-left-open" color="neutral" variant="ghost" size="lg" class="icon-btn rail-toggle" :aria-label="t('Show list')" aria-expanded="false" aria-controls="home" @click="setListCollapsed(false)" />
      </UTooltip>
      <UTooltip :text="tl('Search agents and conversations', 'Rechercher agents et conversations')" :kbds="shortcutKbds('search-all')" :content="{ side: 'right' }">
        <UButton icon="i-lucide-search" color="neutral" variant="ghost" size="lg" class="icon-btn" :aria-label="tl('Search agents and conversations', 'Rechercher agents et conversations')" @click="openSearch" />
      </UTooltip>
      <UTooltip :text="t('New')" :kbds="shortcutKbds('new-space')" :content="{ side: 'right' }">
        <UButton icon="i-lucide-plus" color="neutral" variant="ghost" size="lg" class="icon-btn" :aria-label="t('New')" :disabled="!eventsOpen || offlineView" @click="newAgent" />
      </UTooltip>
      <UTooltip :text="t('Board')" :kbds="shortcutKbds('board')" :content="{ side: 'right' }">
        <UButton icon="i-lucide-square-kanban" color="neutral" variant="ghost" size="lg" class="icon-btn" :aria-label="t('Board')" to="/board" />
      </UTooltip>
      <UTooltip :text="t('Settings')" :kbds="shortcutKbds('settings')" :content="{ side: 'right' }">
        <UButton icon="i-lucide-settings-2" color="neutral" variant="ghost" size="lg" class="icon-btn" :aria-label="t('Settings')" to="/settings" />
      </UTooltip>
      <ul v-if="agents.length" class="rail-stats">
        <li v-for="c in stats" :key="c.s" class="rail-stat" :class="[c.s, { zero: !c.n }]" :title="`${c.n} ${c.label}`">
          <i aria-hidden="true" /><b>{{ c.n }}</b><span class="sr-only">{{ c.label }}</span>
        </li>
      </ul>
      <!-- Quiet mode: a small state mark under the counters, not a button among the
           rail's actions, so the rail keeps its shape. -->
      <UTooltip v-if="quietHint" :text="quietHint" :content="{ side: 'right' }">
        <NuxtLink :to="quietSettings" class="rail-quiet" :aria-label="quietLabel"><UIcon name="i-lucide-bell-off" /></NuxtLink>
      </UTooltip>
    </nav>
    <header class="home-top">
      <p class="eyebrow">
        <AppLogo class="home-logo" :class="conn.idle ? '' : conn.ok ? 'ok' : 'bad'" />
        <NuxtLink v-if="conn.ok" to="/settings?section=about" class="home-version" :title="t('About')">{{ conn.text }}</NuxtLink>
        <span v-else>{{ conn.text }}</span>
      </p>
      <div ref="titleRow" class="home-title-row">
        <h1 class="display">{{ t('Agents') }}</h1>
        <div class="home-actions">
          <UTooltip :text="tl('Search agents and conversations', 'Rechercher agents et conversations')" :kbds="shortcutKbds('search-all')" :disabled="!desk">
            <UButton icon="i-lucide-search" color="neutral" variant="ghost" size="lg" class="icon-btn" :aria-label="tl('Search agents and conversations', 'Rechercher agents et conversations')" @click="openSearch" />
          </UTooltip>
          <UTooltip v-if="!headerFolded.has('board')" :text="t('Board')" :kbds="shortcutKbds('board')" :disabled="!desk">
            <UButton icon="i-lucide-square-kanban" color="neutral" variant="ghost" size="lg" class="icon-btn" :aria-label="t('Board')" to="/board" />
          </UTooltip>
          <UTooltip v-if="!headerFolded.has('settings')" :text="t('Settings')" :kbds="shortcutKbds('settings')" :disabled="!desk">
            <UButton
              icon="i-lucide-settings-2" color="neutral" variant="ghost" size="lg" class="icon-btn"
              :aria-label="t('Settings')" to="/settings"
            />
          </UTooltip>
          <SpaceMenu v-if="headerFolded.size" :items="headerMenuItems" size="lg" :label="t('Options')" />
          <UTooltip v-if="desk" :text="t('Collapse list')">
            <UButton icon="i-lucide-panel-left-close" color="neutral" variant="ghost" size="lg" class="icon-btn rail-toggle" :aria-label="t('Collapse list')" aria-expanded="true" aria-controls="home" @click="setListCollapsed(true)" />
          </UTooltip>
        </div>
      </div>
    </header>

    <nav v-if="barEntries.length" class="machine-bar" :aria-label="tl('Machines shown', 'Machines affichées')" @wheel="onBarWheel">
      <UContextMenu
        v-for="b in barEntries" :key="b.id" :disabled="sheetMenus || b.id === BAR_ALL"
        :items="sheetMenus || b.id === BAR_ALL ? [] : toDropdown(barMenuItems(b.id))" :ui="{ content: 'hw-dropdown' }"
        @update:open="(o: boolean) => onBarMenu(b.id, o)"
      >
        <button
          type="button" class="machine-bar-item" :class="[b.status, { on: b.id === machineBarPick }]" :data-bar-id="b.id"
          :aria-pressed="b.id === machineBarPick" :title="b.title"
          @pointerdown="onBarDown($event, b.id, b.label)" @pointermove="barLp.move" @pointerup="barLp.cancel" @pointercancel="barLp.cancel"
          @contextmenu="sheetMenus && $event.preventDefault()" @click="pickBar(b.id, $event)"
        >
          <UIcon v-if="machineGroups.some(g => g.id === b.id)" name="i-lucide-group" class="machine-bar-group" aria-hidden="true" />
          <i v-if="b.status" class="machine-bar-state" aria-hidden="true" />
          <span class="machine-bar-label">{{ b.label }}</span>
          <b class="machine-bar-count">{{ b.n }}</b>
        </button>
      </UContextMenu>
      <span class="machine-bar-indicator" aria-hidden="true" />
    </nav>
    <div class="home-content">
    <Transition :name="swipeDirection < 0 ? 'home-next' : 'home-prev'" @before-leave="retireHomeContent">
    <div :key="machineBarPick ?? BAR_ALL" ref="homeScroll" class="scroll">
      <OfflineNote v-if="(offlineView && cachedAt) || netDown" class="home-offline" :label="offlineView && cachedAt ? t('Last known state') : undefined" :at="cachedAt" date-style="medium" />
      <div v-if="eventsOpen && !st.ok" class="notice">
        {{ t('The Herdr server is not responding') }}{{ st.error ? tl(`: ${t(st.error)}`, ` : ${t(st.error)}`) : '' }}.<br>
        {{ hostLabel ? tl(`Run herdr on ${hostLabel} to start it.`, `Lance herdr sur ${hostLabel} pour le démarrer.`) : tl('Run herdr on the server to start it.', 'Lance herdr sur le serveur pour le démarrer.') }}
      </div>
      <!-- A tab showing one machine: no header, so its state and session stay here. -->
      <div v-if="soloTab && (soloTab.m.status !== 'online' || (soloTab.m.session && soloTab.m.session !== 'default') || awakeByMachine[soloTab.m.key]?.active)" class="machine-tab-info">
        <p v-if="soloTab.m.status !== 'online'" class="machine-tab-offline" :class="soloTab.m.status" role="status">
          <i aria-hidden="true" />
          <span><b>{{ soloTab.m.status === 'offline' ? tl(`${soloTab.name} is offline`, `${soloTab.name} est hors ligne`) : tl(`${soloTab.name}: reconnecting…`, `${soloTab.name} : reconnexion…`) }}</b>
            <small v-if="soloTab.m.error">{{ t(soloTab.m.error) }}</small></span>
        </p>
        <p v-if="(soloTab.m.session && soloTab.m.session !== 'default') || awakeByMachine[soloTab.m.key]?.active" class="machine-tab-meta">
          <span v-if="soloTab.m.session && soloTab.m.session !== 'default'" class="machine-tab-session"><UIcon name="i-lucide-layers" />{{ soloTab.m.session }}</span>
          <span v-if="awakeByMachine[soloTab.m.key]?.active" class="machine-awake"><UIcon name="i-lucide-sun" />{{ awakeLabel(awakeByMachine[soloTab.m.key]) }}</span>
        </p>
      </div>
      <div v-if="homeGrouping === 'machine' && !multiMachine && soloSelected" class="solo-machine-row"><button type="button" class="solo-session-row" :aria-label="t('Herdr sessions')" @click="openSessions(soloMachine)">
        <span><UIcon name="i-lucide-layers" />{{ soloMachine.label }}</span>
        <b>{{ soloMachine.session || 'default' }}<UIcon name="i-lucide-chevron-right" /></b>
      </button><UDropdownMenu :items="machineMenu(soloMachine)" :content="{ align: 'end' }" :ui="{ content: 'hw-dropdown' }"><UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" :aria-label="t('Options')" class="solo-machine-options" /></UDropdownMenu></div>
      <p v-if="homeGrouping === 'machine' && !multiMachine && soloSelected && awakeByMachine[soloMachine.key]?.active" class="machine-awake"><UIcon name="i-lucide-sun" />{{ awakeLabel(awakeByMachine[soloMachine.key]) }}</p>
      <NuxtLink v-if="quietHint" :to="quietSettings" class="home-quiet" :aria-label="quietLabel"><UIcon name="i-lucide-bell-off" /><span>{{ quietHint }}</span></NuxtLink>

      <div v-if="showCounters && agents.length" class="stats">
        <div v-for="c in stats" :key="c.s" class="stat" :class="[c.s, { zero: !c.n }]">
          <b>{{ c.n }}</b>
          <span><i />{{ c.label }}</span>
        </div>
      </div>
      <QuotaStrip :rows="listQuotas" :api="listApi" :class="{ 'after-stats': showCounters && agents.length }" />

      <OpenNetworkBanner />
      <UpdateBanner v-if="updateBanner" :info="updateBanner" dismissible />

      <p v-if="machineBarSelection?.length === 0" class="machine-empty">{{ tl('No machines in this group.', 'Aucune machine dans ce groupe.') }}</p>
      <template v-if="homeGrouping === 'state'">
        <ul v-if="stateMachineChips.length" class="state-machines" :aria-label="tl('Online machines', 'Machines en ligne')">
          <li v-for="c in stateMachineChips" :key="c.m.key" class="state-machine" :data-machine="c.m.key || 'local'">
            <UDropdownMenu :items="machineMenu(c.m)" :content="{ align: 'start', sideOffset: 6 }" :ui="{ content: 'hw-dropdown' }" @update:open="(o: boolean) => { if (o) loadPluginActions(multiMachine ? c.m.key : '') }">
              <button type="button" class="state-machine-chip" :aria-label="`${t('Options')} : ${c.name}`" :title="c.m.target ? `ssh ${c.m.target}` : c.name">
                <i class="state-machine-dot" aria-hidden="true" />
                <span class="state-machine-name">{{ c.name }}</span>
                <small v-if="c.m.session && c.m.session !== 'default'" class="state-machine-session">{{ c.m.session }}</small>
                <span v-if="c.awake" class="machine-awake" :title="awakeLabel(c.awake)"><UIcon name="i-lucide-sun" /><span>{{ c.awake.until ? fmtTime(c.awake.until) : '∞' }}</span></span>
                <UIcon v-if="c.claude" name="i-lucide-gauge" class="state-machine-claude" role="img" :aria-label="c.claude.state === 'outdated' ? tl('Update Claude quotas', 'Mettre à jour les quotas Claude') : tl('Set up Claude quotas', 'Configurer les quotas Claude')" />
                <UIcon name="i-lucide-ellipsis" class="state-machine-more" aria-hidden="true" />
              </button>
            </UDropdownMenu>
          </li>
        </ul>
        <template v-for="c in stateMachineChips" :key="`q-${c.m.key}`">
          <div v-if="c.quotas.length || c.api" class="state-machine-quotas">
            <p class="state-machine-quotas-label">{{ c.name }}</p>
            <QuotaStrip :rows="c.quotas" :api="c.api" class="machine-quotas" />
          </div>
        </template>
        <section v-for="g in stateGroups" :key="g.key" class="agent-group state-group" :class="g.key">
          <h2 class="group-title"><span>{{ g.title }}</span><span class="count">{{ g.list.length }}</span>
            <UDropdownMenu v-if="g.key === 'ready'" :items="readySortItems" :content="{ align: 'end' }" :ui="{ content: 'hw-dropdown' }">
              <UButton :icon="READY_SORT_LABELS[readySort][1]" color="neutral" variant="ghost" size="xs" class="group-sort" :aria-label="`${t('Sort ready')} : ${t(READY_SORT_LABELS[readySort][0])}`" />
            </UDropdownMenu>
          </h2>
          <template v-for="(cards, i) in g.lists" :key="i">
            <p v-if="g.key === 'ready' && g.lists.length > 1" class="ready-subgroup-label">{{ t(i === 0 ? 'Unread' : 'Read') }}</p>
            <div class="card-list">
              <AgentCard v-for="r in cards" :key="r.key" :pane="r.lead" :row="r" :board="stateCardByKey.get(r.key)?.board" :machine-badge="stateCardByKey.get(r.key)?.machine" :project-badge="stateCardByKey.get(r.key)?.repo" />
            </div>
          </template>
        </section>
        <p v-if="stateMachineChips.length && !stateGroups.length" class="machine-empty state-empty">{{ t('No agents yet.') }}</p>
        <div v-if="stateAway.length" class="state-away" role="group" :aria-label="tl('Machines not connected', 'Machines non connectées')">
          <UDropdownMenu v-for="a in stateAway" :key="a.m.key" :items="machineMenu(a.m)" :content="{ align: 'start', sideOffset: 6 }" :ui="{ content: 'hw-dropdown' }">
            <button type="button" class="state-away-item" :class="a.m.status" :data-machine="a.m.key || 'local'"
              :aria-label="`${t('Options')} : ${a.name} · ${a.state}`"
              :title="[`${a.name} · ${a.state}`, a.known ? tl(`${a.known} known agents`, `${a.known} agents connus`) : '', a.m.error ? t(a.m.error) : ''].filter(Boolean).join(' — ')"
            >
              <i class="state-machine-dot" aria-hidden="true" />
              <span class="state-machine-name">{{ a.name }}</span>
              <span class="state-away-state">{{ a.state }}</span>
              <b v-if="a.known" class="state-away-known">{{ a.known }}</b>
            </button>
          </UDropdownMenu>
        </div>
      </template>
      <!-- A single machine: the previous list. -->
      <template v-else-if="!sections">
        <section v-if="solo.coordinators.length" class="agent-group coordinators">
          <h2 class="group-title"><span>{{ tl('Coordinators', 'Coordinateurs') }}</span><span class="count">{{ solo.coordinators.length }}</span></h2>
          <div class="card-list">
            <AgentCard v-for="c in solo.coordinators" :key="c.row.key" :pane="c.row.lead" :row="c.row" :board="coordinatorCard(c.level, soloLocal, soloName)" />
          </div>
        </section>
        <ProjectGroup v-for="x in solo.projects" :key="x.id" :group="x" />
        <section v-for="g in solo.groups" :key="g.key" class="agent-group" :class="g.key">
          <h2 class="group-title"><span>{{ g.title }}</span><span class="count">{{ g.list.length }}</span>
            <UDropdownMenu v-if="g.key === 'ready'" :items="readySortItems" :content="{ align: 'end' }" :ui="{ content: 'hw-dropdown' }">
              <UButton :icon="READY_SORT_LABELS[readySort][1]" color="neutral" variant="ghost" size="xs" class="group-sort" :aria-label="`${t('Sort ready')} : ${t(READY_SORT_LABELS[readySort][0])}`" />
            </UDropdownMenu></h2>
          <template v-for="(cards, i) in g.lists" :key="i">
            <p v-if="g.key === 'ready' && g.lists.length > 1" class="ready-subgroup-label">{{ t(i === 0 ? 'Unread' : 'Read') }}</p>
            <ReorderList :disabled="!canReorder('') || (g.key === 'ready' && readySort !== 'herdr')">
              <AgentCard v-for="r in cards" :key="r.key" :pane="r.lead" :row="r" />
            </ReorderList>
          </template>
        </section>

        <div v-if="st.ok && !agents.length" class="empty hw-grid">
          <div class="empty-box">
            <div class="empty-art">&gt;_</div>
            <p>{{ t('No agents yet.') }}</p>
            <p class="muted">{{ t('Start one here, or from') }} <code>herdr</code> {{ t('in a terminal.') }}</p>
          </div>
        </div>
      </template>

      <!-- Several machines: one section per machine. -->
      <template v-else>
        <section
          v-for="s in sections" :key="s.m.key" class="machine" :class="[s.m.status, { collapsed: s.collapsed, 'machine-drop-before': dropMachine === baseKeyOf(s.m) && !dropAfter, 'machine-drop-after': dropMachine === baseKeyOf(s.m) && dropAfter }]"
          :data-machine="s.m.key || 'local'"
          @dragover="onMachineDragOver(baseKeyOf(s.m), $event)"
          @dragleave="(e: DragEvent) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) dropMachine = null }"
          @drop="onMachineDrop(baseKeyOf(s.m), $event)"
        >
          <div v-if="!soloTab" class="machine-row">
            <button v-if="desk" type="button" class="machine-grip" draggable="true"
              :aria-label="tl(`Move ${s.name} — up and down arrows`, `Déplacer ${s.name} — flèches haut et bas`)"
              :title="t('Drag to reorder')"
              @dragstart="onMachineDragStart(baseKeyOf(s.m), $event)" @dragend="onMachineDragEnd"
              @keydown.up.prevent="shiftMachine(baseKeyOf(s.m), -1)" @keydown.down.prevent="shiftMachine(baseKeyOf(s.m), 1)"
            ><UIcon name="i-lucide-grip-vertical" /></button>
            <button
              type="button" class="machine-head" :aria-expanded="!s.collapsed"
              :title="s.m.target ? `ssh ${s.m.target}` : undefined" @click="toggleMachine(s.m.key)"
            >
              <UIcon name="i-lucide-chevron-down" class="machine-chev" />
              <UIcon :name="s.m.local ? 'i-lucide-server' : 'i-lucide-laptop'" class="machine-icon" />
              <span class="machine-ident">
                <span class="machine-name">{{ s.name }}<small v-if="s.m.session && s.m.session !== 'default'" class="machine-session">{{ s.m.session }}</small></span>
                <MachineLocalBadge v-if="s.m.local" />
              </span>
              <span v-if="awakeByMachine[s.m.key]?.active" class="machine-awake" :title="awakeLabel(awakeByMachine[s.m.key])"><UIcon name="i-lucide-sun" /><span>{{ awakeByMachine[s.m.key]?.until ? fmtTime(awakeByMachine[s.m.key]!.until!) : '∞' }}</span></span>
              <span class="machine-state"><i />{{ s.state }}</span>
              <span class="machine-count">
                <b v-if="s.waiting && s.collapsed" class="machine-waiting">{{ s.waiting }}</b>
                {{ s.counted.length }}
              </span>
            </button>
            <UDropdownMenu :items="machineMenu(s.m)" :content="{ align: 'end', sideOffset: 6 }" :ui="{ content: 'hw-dropdown' }" @update:open="(o: boolean) => { if (o && s.m.status === 'online') loadPluginActions(s.m.key) }">
              <UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" size="lg" class="machine-options icon-btn" :aria-label="`${t('Options')} : ${s.name}`" />
            </UDropdownMenu>
          </div>
          <p v-if="!soloTab && s.m.status !== 'online' && s.m.error" class="machine-error">{{ t(s.m.error) }}</p>

          <div v-if="soloTab || !s.collapsed" class="machine-body">
            <QuotaStrip v-if="!soloTab" :rows="s.quotas" :api="s.api" class="machine-quotas" />
            <section v-if="s.coordinators.length" class="agent-group coordinators">
              <h2 class="group-title"><span>{{ tl('Coordinators', 'Coordinateurs') }}</span><span class="count">{{ s.coordinators.length }}</span></h2>
              <div class="card-list">
                <AgentCard v-for="c in s.coordinators" :key="c.row.key" :pane="c.row.lead" :row="c.row" :board="coordinatorCard(c.level, s.m.local, s.name)" />
              </div>
            </section>
            <ProjectGroup v-for="x in s.projects" :key="x.id" :group="x" :machine="s.m.key" />
            <section v-for="g in s.groups" :key="g.key" class="agent-group" :class="g.key">
              <h2 class="group-title"><span>{{ g.title }}</span><span class="count">{{ g.list.length }}</span>
            <UDropdownMenu v-if="g.key === 'ready'" :items="readySortItems" :content="{ align: 'end' }" :ui="{ content: 'hw-dropdown' }">
              <UButton :icon="READY_SORT_LABELS[readySort][1]" color="neutral" variant="ghost" size="xs" class="group-sort" :aria-label="`${t('Sort ready')} : ${t(READY_SORT_LABELS[readySort][0])}`" />
            </UDropdownMenu></h2>
              <template v-for="(cards, i) in g.lists" :key="i">
                <p v-if="g.key === 'ready' && g.lists.length > 1" class="ready-subgroup-label">{{ t(i === 0 ? 'Unread' : 'Read') }}</p>
                <ReorderList :disabled="!canReorder(s.m.key) || (g.key === 'ready' && readySort !== 'herdr')">
                  <AgentCard v-for="r in cards" :key="r.key" :pane="r.lead" :row="r" />
                </ReorderList>
              </template>
            </section>

            <p v-if="!s.agents.length && !s.groups.length && !s.projects.length && !s.coordinators.length" class="machine-empty">
              {{ s.m.status === 'online' ? t('No agents on this machine.') : t('No known agents.') }}
            </p>
          </div>
        </section>
      </template>
    </div>
    </Transition>
    </div>

    <div class="fab-wrap">
      <UButton class="fab hw-cta" icon="i-lucide-plus" color="primary" variant="solid" size="xl" :disabled="!eventsOpen || offlineView" @click="newAgent">
        {{ t('New') }}
      </UButton>
    </div>
    <AppSheet v-model:open="connectionOpen" :title="t('Connection status')" screen>
      <MachineConnection v-if="connectionInfo" :machine="connectionInfo" />
    </AppSheet>
    <AppSheet v-model:open="renameMachineOpen" :title="t('Rename machine')" screen>
      <form id="rename-machine-form" class="rename" @submit.prevent="saveMachine">
        <UInput v-model="machineLabel" maxlength="40" size="xl" class="w-full" :placeholder="t('Machine name')" autofocus />
      </form>
      <template #footer>
        <div class="rename-actions">
          <UButton color="neutral" variant="ghost" class="sheet-btn" @click="renameMachineOpen = false">{{ t('Cancel') }}</UButton>
          <UButton type="submit" form="rename-machine-form" color="primary" variant="solid" class="sheet-btn hw-cta" :loading="savingMachine" :disabled="!machineLabel.trim()">{{ t('Save') }}</UButton>
        </div>
      </template>
    </AppSheet>
    <AppSheet v-model:open="sessionOpen" :title="t('Herdr sessions')" screen>
      <p class="session-intro">{{ t('Session shown on this device') }} · {{ sessionTarget?.label }}</p>
      <p v-if="sessionsLoading" class="session-intro">{{ t('Loading…') }}</p>
      <div v-else class="session-list">
        <button v-for="s in sessionRows" :key="s.name" type="button" class="session-choice" :disabled="!s.running"
          :aria-current="sessionTarget?.session === s.name ? 'true' : undefined" @click="selectSession(s)">
          <span><b>{{ s.name }}</b><small>{{ t(s.running ? 'running' : 'stopped') }}</small></span>
          <UIcon v-if="sessionTarget?.session === s.name" name="i-lucide-check" />
        </button>
        <p v-if="!sessionRows.length" class="session-intro">{{ t('No sessions found.') }}</p>
      </div>
    </AppSheet>
    <AppSheet v-model:open="awakeOpen" :title="t('Keep awake')" screen>
      <p class="session-intro">{{ awakeTarget?.label }} · {{ awakeLabel(awakeTarget ? awakeByMachine[awakeTarget.key] : undefined) || t('Normal sleep') }}</p>
      <p v-if="awakeTarget && awakeByMachine[awakeTarget.key]?.battery" class="session-intro"><UIcon name="i-lucide-battery" /> {{ awakeByMachine[awakeTarget.key]?.battery?.percent }} % · {{ awakeByMachine[awakeTarget.key]?.battery?.source === 'ac' ? t('Power adapter') : t('Battery') }}</p>
      <label v-if="awakeTarget && awakeByMachine[awakeTarget.key]?.platform === 'mac'" class="awake-lid"><input v-model="awakeLid" type="checkbox" :disabled="awakeByMachine[awakeTarget.key]?.battery?.source !== 'ac'"> {{ t('Closed lid (power adapter only)') }}</label>
      <div class="session-list">
        <button v-if="awakeTarget && awakeByMachine[awakeTarget.key]?.active && awakeByMachine[awakeTarget.key]?.until" class="session-choice" type="button" :disabled="awakeBusy" @click="chooseAwake('extend')"><span><b>{{ t('Extend by one hour') }}</b><small>{{ extendLabel(awakeByMachine[awakeTarget.key]) }}</small></span><UIcon name="i-lucide-plus" /></button>
        <button v-for="choice in [{ mode: 'hour', label: t('1 hour') }, { mode: 'fourHours', label: t('4 hours') }, { mode: 'evening', label: t('Until tonight (8 pm)') }, { mode: 'untilOff', label: t('Until turned off') }]" :key="choice.mode" class="session-choice" type="button" :disabled="awakeBusy || (choice.mode === 'evening' && eveningPast)" @click="chooseAwake(choice.mode as AwakeMode)"><span><b>{{ choice.label }}</b><small v-if="choice.mode === 'evening' && eveningPast">{{ t('It is already past 8 pm on this machine') }}</small></span><UIcon name="i-lucide-chevron-right" /></button>
        <button v-if="awakeTarget && awakeByMachine[awakeTarget.key]?.active" class="session-choice" type="button" :disabled="awakeBusy" @click="chooseAwake('off')"><b>{{ t('Turn off') }}</b><UIcon name="i-lucide-x" /></button>
      </div>
      <p class="awake-note">{{ tl('Closing a Mac lid on battery puts it to sleep. A sleeping machine cannot be woken remotely.', 'Sur batterie, fermer le capot met le Mac en veille. Une machine endormie ne peut pas être réveillée à distance.') }}</p>
    </AppSheet>
    <AppSheet v-model:open="diagnosticOpen" :title="t('What prevents sleep')" screen>
      <p v-if="diagnosticBusy" class="session-intro">{{ t('Loading…') }}</p>
      <div v-else class="session-list">
        <div v-for="(a, i) in assertions" :key="i" class="session-choice awake-assertion"><span><b>{{ a.ours ? t('wherdr · Keep awake') : a.name }}</b><small>{{ a.kind }} · {{ durationLabel(a.seconds) }}</small></span></div>
        <p v-if="!assertions.length" class="session-intro awake-empty">{{ t('No app is preventing sleep.') }}</p>
      </div>
    </AppSheet>
    <Teleport to="body">
      <div
        v-if="desk && !rail && !slim" class="list-handle" :class="{ dragging: listDrag }" role="separator" aria-orientation="vertical" tabindex="0"
        :aria-label="t('List width')" :aria-valuenow="listWidth ?? LIST_DEFAULT" :aria-valuemin="LIST_MIN" :aria-valuemax="LIST_MAX"
        :title="t('Drag to resize · double-click: default width')"
        @pointerdown="onListGrab" @dblclick="resetListWidth" @keydown="onListKey"
      />
    </Teleport>
  </section>
</template>
