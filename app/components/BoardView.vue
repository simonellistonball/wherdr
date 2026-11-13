<script setup lang="ts">
// The Board: herdr-projects 1.x tasks of every machine, in the groups of its
// board (Needs you, Ready to approve, Working, To do, Done), as columns of
// equal width. Done is history: hidden until its toggle in the column heads
// ("Done · 9") shows it (boardDone.ts). Two views of the same grid: "Global" mixes every
// machine's and repo's tasks; "By repo" cuts it into lanes, one per machine then
// per repo (1.x: `Alt+M` with `Alt+S`), aligned from one column to the next.
// On a phone (or a Board narrowed by the side panel): one group at a time, in
// tabs, with the lanes inside.
//
// Talking to agents happens in a side panel (BoardPanel), never in a box on the
// Board: a card opens its task's agent there; labelled buttons open a
// coordinator: the Coordinator (top bar), the machine
// coordinator (each machine's lane) and a repo's project coordinator (its lane;
// 1.x: `Space` on a heading). Every task opens the panel, including tasks
// without an agent. Its Task tab and optional sheet keep details and actions
// available. "+ New task" adds one (NewTaskSheet).
// A task archived from its sheet leaves the Board at once, with a toast that
// offers Restore for a few seconds; "Archived" lists the archived tasks, each
// one's sheet read-only with Restore (as in 1.x).
// A machine without herdr-projects 1.2.1+ says what to do instead
// (ProjectsUpgradeNote).
//
// Kept on this device: the machine shown and the phone's column. Kept on the
// server (they follow the user): the grouping, folded headings, Done shown or
// not. Nothing about the projects themselves: that is herdr-projects'.
import {
  type CoordinatorTarget, TASK_GROUPS, type TaskGroup, type TaskRow, groupCounts, sortTasks, taskKey,
} from '#shared/projectsTasks'
import { boardLayout } from '~/utils/boardLayout'
import type { SelectItem } from '@nuxt/ui'
import type { PanelTarget } from './BoardPanel.vue'
import type { SettingsTarget } from './BoardSettings.vue'
// The home list's machine groups (Settings › Machine bar); `machineGroups` here is the Board's lanes.
import { machineGroups as barGroups, machineBarPick, showMachineInBar } from '~/composables/useMachineBar'

const COLUMN_KEY = 'boardColumn'
const SCOPE_KEY = 'boardMachine'
const GROUPING_KEY = 'boardGrouping'
const FOLDS_KEY = 'boardFolds'

const router = useRouter()
const route = useRoute()
const backToOrigin = useViewBack()
const { board, cachedAt, error, reads, reload } = useTasksBoard()
// Nothing kept on this device and herdr-projects still being read: the Board's
// shapes after 300 ms (BoardSkeleton); past 10 s, said, with Retry.
const loading = computed(() => !board.value && !error.value && !offlineView.value)
const skeleton = useDelayedFlag(loading)
const slow = useDelayedFlag(loading, 10000, 0)
// Counts the Refresh button's clicks: the coordinator's Scheduled section reads
// again then, not on every 15 s poll (it may scan a large transcript).
const refreshes = ref(0)
const projectLinks = useBoardLinks()

const readStore = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const writeStore = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* storage unavailable */ } }

const ready = computed(() => (board.value?.machines || []).filter(m => m.status === 'ready'))
const machineLabel = (key: string) => boardMachineLabel(key, machineName(key), hostLabel.value || t('This machine'))
const readAt = (at?: number) => (at ? new Date(at).toLocaleTimeString(language === 'fr' ? 'fr-FR' : 'en-US', { hour: '2-digit', minute: '2-digit' }) : '')
// Machines Herdr answers on but where the Board cannot read herdr-projects.
const notes = computed(() => (board.value?.machines || []).filter(m => m.status === 'missing' || m.status === 'old' || m.status === 'shepherdr'))
const disabled = computed(() => (board.value?.machines || []).filter(m => m.status === 'disabled'))
const several = computed(() => (board.value?.machines.length || 0) > 1)

// ------------------------------------------------------------ what is shown
// Keep failed reads selectable, even before a machine has returned any tasks.
const boards = computed(() => (board.value?.machines || []).filter(m => m.status === 'ready' || m.status === 'error' || m.tasks.length || m.error || m.stale))
// The machine's key (the local one is ''), a machine group's ID (the home
// list's groups, edited in Settings), or SCOPE_ALL.
const scope = ref(boardScopeMachine(readStore(SCOPE_KEY)))
watch([machineBarPick, boards, barGroups], () => {
  const next = boardTabChoice.update(machineBarPick.value, boards.value.map(m => m.machine), barGroups.value)
  if (next !== undefined) scope.value = next
}, { immediate: true })
// A machine that went away, or a group deleted: every machine again. A group
// edited in Settings: its machines now.
const shownScope = computed<string>(() => boardShownScope(scope.value, boards.value.map(m => m.machine), barGroups.value))
// The machines shown (null: every machine).
const scopeMachines = computed<string[] | null>(() => boardScopeMachines(shownScope.value, barGroups.value))
const inScope = (machine: string): boolean => scopeMachines.value === null || scopeMachines.value.includes(machine)
// The machine named on each card: when the cards can come from several machines.
const namesOnCards = computed(() => several.value && (scopeMachines.value === null || scopeMachines.value.length > 1))
// The local machine is in it too, under its own value.
const scopeItems = computed<SelectItem[]>(() => boardScopeItems(boards.value.map(m => m.machine), machineLabel, tl('All machines', 'Toutes les machines'),
  barGroups.value, tl('Groups', 'Groupes'), tl('Machines', 'Machines')))
function pickScope(v: string) {
  scope.value = boardScopeMachine(v)
  boardTabChoice.manual(scope.value)
  writeStore(SCOPE_KEY, v)
}
const shownBoards = computed(() => boards.value.filter(m => inScope(m.machine)))

// `global` was stored as `status` before it was renamed.
type Grouping = 'repo' | 'global'
// Kept on the server, like Done and the folds below: they follow the user
// across devices (useSyncedSettings.ts).
const grouping = syncedRef<Grouping>(GROUPING_KEY, raw => (['global', 'status'].includes(raw || '') ? 'global' : 'repo'), g => g)
function pickGrouping(g: Grouping) {
  grouping.value = g
}

interface Card { key: string, machine: string, task: TaskRow, stale: boolean, readAt?: number }
const cardOf = (m: { machine: string, stale?: boolean, at?: number }, task: TaskRow): Card =>
  ({ key: `${m.machine}|${task.id}`, machine: m.machine, task, stale: Boolean(m.stale || task.stale), readAt: task.stale ? task.readAt : m.at })
// Tasks archived from here (`<machine>|<id>`): off the Board at once, before a
// read of the Board leaves them out; forgotten once a read does.
const archivedHere = shallowRef(new Set<string>())
const setArchivedHere = (key: string, on: boolean) => {
  const next = new Set(archivedHere.value)
  if (on) next.add(key)
  else next.delete(key)
  archivedHere.value = next
}
watch(board, (b) => {
  if (!b || !archivedHere.value.size) return
  const listed = new Set(b.machines.flatMap(m => m.tasks.filter(t => !t.archived).map(t => `${m.machine}|${t.id}`)))
  const kept = [...archivedHere.value].filter(k => listed.has(k))
  if (kept.length !== archivedHere.value.size) archivedHere.value = new Set(kept)
})
// A machine Herdr did not answer for keeps its last tasks, marked as older.
const allCards = computed<Card[]>(() => boards.value.flatMap(m => sortTasks(m.tasks.filter(t => !t.archived && !archivedHere.value.has(`${m.machine}|${t.id}`))).map(task => cardOf(m, task))))
const cards = computed(() => allCards.value.filter(c => inScope(c.machine)))
// Done: hidden until asked for; shown, its latest few until "N more".
const showDone = syncedRef(BOARD_DONE_KEY, boardDoneShown, boardDoneStored)
const showAll = ref(false)
const doneCount = computed(() => cards.value.filter(c => c.task.group === 'done').length)
function toggleDone() {
  showDone.value = !showDone.value
  if (!showDone.value) showAll.value = false
  // Phone: what was asked for comes into view.
  else if (!wide.value) selectColumn('done')
  haptic()
}
const doneToggleLabel = computed(() => (showDone.value
  ? tl('Hide done tasks', 'Masquer les tâches faites')
  : tl(`Show done tasks (${doneCount.value})`, `Afficher les tâches faites (${doneCount.value})`)))
const groups = computed(() => boardGroups(showDone.value))
const columns = computed(() => groups.value.map((id) => {
  const inGroup = cards.value.filter(c => c.task.group === id)
  // Done: the latest few of every machine shown, not of the first one.
  const all = id === 'done' ? doneNewestFirst(inGroup) : inGroup
  return { id, label: taskGroupLabel(id), total: all.length, ...boardCell(id, all, showAll.value, DONE_LATEST) }
}))
// As many columns as groups shown, of equal width.
const gridStyle = computed(() => ({ '--board-cols': `repeat(${columns.value.length}, minmax(0, 1fr))` }))

// Folded headings (`m:<machine>`, `r:<machine>|<repo>`).
const readFolds = (raw: string | null) => {
  try {
    const v: unknown = JSON.parse(raw || '[]')
    return new Set<string>(Array.isArray(v) ? v.map(String) : [])
  } catch { return new Set<string>() }
}
const folds = syncedRef(FOLDS_KEY, readFolds, v => JSON.stringify([...v].slice(-200)))
function fold(key: string) {
  const next = new Set(folds.value)
  if (!next.delete(key)) next.add(key)
  folds.value = next
}

// What a heading holds, in a few words: what needs you first; done last, and quietly.
function summary(rows: TaskRow[]): { main: string, done: string } {
  const c = groupCounts(rows)
  const parts = (['needs', 'ready', 'working', 'todo'] as const).filter(g => c[g]).map(g => `${c[g]} ${taskGroupLabel(g).toLowerCase()}`)
  const done = c.done ? tl(`${c.done} done`, `${c.done} fait${c.done > 1 ? 's' : ''}`) : ''
  return { main: parts.join(' · ') || (done ? '' : tl('no task', 'aucune tâche')), done }
}
const machineGroups = computed(() => shownBoards.value.map((m) => {
  const rows = m.tasks.filter(t => !t.archived && !archivedHere.value.has(`${m.machine}|${t.id}`))
  return {
    machine: m.machine,
    trouble: Boolean(m.status === 'error' || m.error || m.stale),
    error: m.error || tl('No answer yet', 'Pas encore de réponse'),
    at: m.at,
    summary: summary(rows),
    repos: [...new Set([...rows.map(t => t.repo), ...(projectLinks.value.find(b => b.machine === m.machine)?.repos || []).map(r => r.repo)])].sort().map(repo => {
      const tasks = sortTasks(rows.filter(t => t.repo === repo))
      // The board's groups in each repo's lane, under the Board's columns.
      const cols = groups.value.map((id) => {
        const all = tasks.filter(t => t.group === id).map(task => cardOf(m, task))
        return { id, label: taskGroupLabel(id), total: all.length, ...boardCell(id, all, showAll.value, DONE_LATEST_REPO) }
      })
      return { repo, summary: summary(tasks), cols }
    }),
  }
}))
// Each machine's repos, as its tasks show them: the choices of "+ New task".
const reposByMachine = computed(() => Object.fromEntries(boards.value.map(m => [m.machine, [...new Set(m.tasks.map(t => t.repo))].sort()])))

// Columns side by side need room: on a phone, or a Board narrowed by the side
// panel, one group at a time (tabs), in both views.
const root = ref<HTMLElement | null>(null)
const panelSizer = ref<HTMLElement | null>(null)
const width = ref(0)
const sideBySide = ref(false)
let sizes: ResizeObserver | null = null
onMounted(() => {
  if (!root.value || typeof ResizeObserver === 'undefined') return
  // Available space does not depend on whether the panel is currently docked:
  // measuring only the shrunken Board would make docking oscillate.
  sizes = new ResizeObserver(() => {
    const board = root.value!
    width.value = board.clientWidth
    sideBySide.value = boardLayout(window.innerWidth - board.getBoundingClientRect().left,
      panelSizer.value!.getBoundingClientRect().width).sideBySide
  })
  sizes.observe(root.value)
  sizes.observe(panelSizer.value!)
  sizes.observe(document.documentElement)
})
onUnmounted(() => sizes?.disconnect())
const dockPanel = computed(() => desk.value && sideBySide.value)
const wide = computed(() => desk.value && boardLayout(width.value, 0).wide)

// Phone: the group shown, kept on this device.
function readColumn(): TaskGroup {
  const v = readStore(COLUMN_KEY)
  return TASK_GROUPS.includes(v as TaskGroup) ? v as TaskGroup : 'needs'
}
const phoneColumn = ref<TaskGroup>(readColumn())
// Done hidden: its tab is gone, the first one shows.
const shownColumn = computed(() => boardPhoneColumn(phoneColumn.value, showDone.value))
function selectColumn(id: TaskGroup) {
  phoneColumn.value = id
  writeStore(COLUMN_KEY, id)
}

// ------------------------------------------------------------ one task
// Who the side panel talks to (BoardPanel): a task's agent or a coordinator.
const panel = shallowRef<PanelTarget | null>(null)
const picked = shallowRef<Card | null>(null)
const sheetOpen = ref(false)
function openSheet(c: Card) {
  picked.value = c
  sheetOpen.value = true
}
// A task opened (a card, the sidebar, a push): the sidebar and the Board show
// its machine. The sidebar's tab moves to it if it does not show it
// (showMachineInBar); the Board's scope too, then on the same tab or group as
// the sidebar. A scope that already shows it stays as it is.
function followTask(machine: string) {
  const pick = machineBarPick.value
  showMachineInBar(machine)
  const next = boardScopeFor(machine, shownScope.value, machineBarPick.value, barGroups.value)
  if (next === undefined && pick === machineBarPick.value) return
  // Kept as a choice of the tab now shown (the tracker sees it first), so that
  // the next read does not take it back.
  boardTabChoice.followTab(machineBarPick.value)
  scope.value = next ?? scope.value
  boardTabChoice.manual(scope.value)
  writeStore(SCOPE_KEY, boardScopeValue(scope.value))
}
// A card always opens the task panel. No agent yet: the panel explains
// setup failures and keeps the task's details and actions reachable.
// Phone: whether the current detail entry already shows this task. A link may
// name no machine: then it is the machine its panel resolved the task on.
function routeShowsTask(machine: string, id: string) {
  if (route.query.task !== id) return false
  const m = route.query.machine
  if (typeof m === 'string') return m === machine
  const p = panel.value
  return p?.kind === 'task' && p.id === id && p.machine === machine
}
function openCard(c: Card) {
  if (!desk.value && !routeShowsTask(c.machine, c.task.id)) {
    void router.push({ path: '/board', query: { machine: c.machine, task: c.task.id } })
  } else showTaskCard(c)
  haptic()
}
// Route/load watchers only resolve the requested card. In particular, a link
// without `machine` must not push a canonical detail on top of itself: native
// back would revisit the unresolved link and immediately push the detail again.
function showTaskCard(c: Card) {
  picked.value = c
  openTaskPanel(c.machine, c.task.id)
}
function openTaskPanel(machine: string, id: string) {
  const p = panel.value
  // Already shown (opened at once from the sidebar): the same panel, nothing reloads.
  if (!(p?.kind === 'task' && p.machine === machine && p.id === id) || opening.value?.mode) panel.value = { machine, kind: 'task', id, mode: opening.value?.id === id ? opening.value.mode : undefined }
  followTask(machine)
}
// The open task as the last read has it (its group or review may have moved on).
const pickedTask = computed(() => {
  const p = picked.value
  if (!p) return null
  return allCards.value.find(c => c.key === p.key)?.task
    || archivedCards.value.find(c => c.key === p.key)?.task
    || (archivedHere.value.has(p.key) ? { ...p.task, archived: true } : p.task)
})
// A push about a task opens it: `#/board?machine=<key>&task=<repo>/<n>`. The
// same id can be on two machines: only that machine's task opens (a link with
// no machine: the one card with that id). The kept board may predate the task,
// so nothing is concluded before a read of this visit; a machine that cannot be
// read keeps the request until it answers.
const opening = ref<{ machine: string | null, id: string, mode?: 'chat' | 'term' } | null>(null)
const waitNoted = ref(false)
// `#/board?machine=<key>` alone (a machine's menu on the home list): the Board
// filtered on that machine, as if picked here. The local machine is `machine=`.
watch(() => route.query, (q) => {
  if (q.coordinator || q.conversation || ('task' in q && q.task) || !('machine' in q)) return
  const m = q.machine
  if (typeof m === 'string' || m === null) pickScope(boardScopeValue(m ?? ''))
  router.replace({ query: {} })
}, { immediate: true })
watch(() => [route.query.task, route.query.machine, route.query.view, route.query.tab], ([id]) => {
  if (typeof id !== 'string' || !id) {
    if (!desk.value) {
      opening.value = null
      if (panel.value?.kind === 'task') panel.value = null
    }
    return
  }
  const machine = typeof route.query.machine === 'string' ? route.query.machine : null
  // `now`: from the sidebar, which knows the task is there.
  const now = route.query.now === '1'
  const view = route.query.view ?? route.query.tab
  opening.value = { machine, id, mode: view === 'chat' || view === 'term' ? view : undefined }
  waitNoted.value = false
  // Desktop keeps its existing local panel; phones keep a detail entry.
  if (desk.value) void router.replace({ query: {} })
  // Its panel opens now (from the sidebar, or a link to a task the kept board
  // has), with its shapes while it loads: the read below only confirms it, or
  // turns to the archived ones. Other links wait for that read.
  const kept = allCards.value.filter(x => x.task.id === id && (machine === null || x.machine === machine))
  if (kept.length === 1) showTaskCard(kept[0]!)
  else if (now && machine !== null) openTaskPanel(machine, id)
}, { immediate: true })
watch([opening, board, reads], () => {
  const want = opening.value
  if (!want || !board.value || !reads.value) return
  const hits = allCards.value.filter(x => x.task.id === want.id && (want.machine === null || x.machine === want.machine))
  const fresh = (machine: string) => board.value!.machines.some(m => m.machine === machine && m.status === 'ready' && !m.error && !m.stale)
  if (hits.length === 1) {
    showTaskCard(hits[0]!)
    opening.value = null
    return
  }
  if (want.machine !== null && !fresh(want.machine)) {
    // Its machine does not answer now: said once, tried again at each read.
    if (!waitNoted.value) toast(tl(`${machineLabel(want.machine)} cannot be read now: its task opens once it answers`, `${machineLabel(want.machine)} ne peut pas être lue pour l’instant : sa tâche s’ouvre dès qu’elle répond`), true)
    waitNoted.value = true
    return
  }
  opening.value = null
  // Not on the Board: maybe archived, whose sheet opens read-only with Restore.
  // The panel opened at once for it closes.
  const p = panel.value
  if (p?.kind === 'task' && p.id === want.id && (want.machine === null || p.machine === want.machine)) panel.value = null
  openArchived(want)
})
async function openArchived(want: { machine: string | null, id: string }) {
  const where = boards.value.filter(m => m.status === 'ready' && (want.machine === null || m.machine === want.machine)).map(m => m.machine)
  const found = (await Promise.all(where.map(m => api<{ machine: string, tasks: TaskRow[] }>(`/api/tasks/archived?machine=${encodeURIComponent(m)}`).catch(() => null))))
    .flatMap(r => (r ? r.tasks.filter(t => t.id === want.id).map(t => cardOf({ machine: r.machine }, t)) : []))
  if (found.length === 1) return openSheet(found[0]!)
  toast(tl('That task is no longer on the Board', 'Cette tâche n’est plus sur le Board'), true)
}

// ------------------------------------------------------------ archived
// "Archived": each machine's archived tasks, read when it is opened (and again
// after an archive or a restore from here), newest first.
const showArchived = ref(false)
const archivedBoards = shallowRef<{ machine: string, tasks: TaskRow[], error?: string }[]>([])
const archivedLoading = ref(false)
let archivedSeq = 0
async function loadArchived() {
  if (!showArchived.value) return
  const id = ++archivedSeq
  archivedLoading.value = true
  const where = boards.value.filter(m => m.status === 'ready').map(m => m.machine)
  const got = await Promise.all(where.map(machine => api<{ machine: string, tasks: TaskRow[] }>(`/api/tasks/archived?machine=${encodeURIComponent(machine)}`)
    .then(r => ({ machine, tasks: r.tasks }))
    .catch((e: Error) => ({ machine, tasks: [] as TaskRow[], error: e.message }))))
  if (id !== archivedSeq) return
  archivedBoards.value = got
  archivedLoading.value = false
}
function toggleArchived() {
  showArchived.value = !showArchived.value
  if (showArchived.value) loadArchived()
}
const archivedCards = computed<Card[]>(() => archivedBoards.value
  .filter(m => inScope(m.machine))
  .flatMap(m => m.tasks.map(t => cardOf({ machine: m.machine }, t))))
const archivedErrors = computed(() => archivedBoards.value.filter(m => m.error && inScope(m.machine)))

// Archived from its sheet: off the Board now, its agent's panel closed (the
// agent ends with its space), and a few seconds to take it back.
function onArchived(machine: string, task: TaskRow) {
  // A closed bead stays on the Board, in Done.
  const beads = task.backend === 'beads'
  if (!beads) setArchivedHere(`${machine}|${task.id}`, true)
  const p = panel.value
  if (p?.kind === 'task' && p.machine === machine && p.id === task.id) panel.value = null
  const name = taskKey(task.id, task.repoKey)
  toast(beads ? tl(`${name} closed`) : tl(`${name} archived`, `${name} archivée`), false, undefined, {
    label: beads ? tl('Reopen') : tl('Restore', 'Restaurer'), icon: 'i-lucide-archive-restore', run: () => restoreTask(machine, task),
  })
  reload().then(loadArchived)
}
async function restoreTask(machine: string, task: TaskRow) {
  try {
    await api('/api/tasks/action', { machine, id: task.id, action: 'restore' })
    haptic()
    toast(task.backend === 'beads' ? tl(`${taskKey(task.id, task.repoKey)} reopened`) : tl(`${taskKey(task.id, task.repoKey)} restored`, `${taskKey(task.id, task.repoKey)} restaurée`))
    onRestored(machine, task)
  } catch (e) { toast((e as Error).message, true) }
}
function onRestored(machine: string, task: TaskRow) {
  setArchivedHere(`${machine}|${task.id}`, false)
  archivedBoards.value = archivedBoards.value.map(m => (m.machine === machine ? { ...m, tasks: m.tasks.filter(t => t.id !== task.id) } : m))
  reload().then(loadArchived)
}

// ------------------------------------------------------------ new task
const newOpen = ref(false)
const newFor = ref<{ machine?: string, repo?: string }>({})
function newTask(machine?: string, repo?: string) {
  newFor.value = { machine: machine ?? (scopeMachines.value?.length === 1 ? scopeMachines.value[0] : panel.value?.machine), repo }
  newOpen.value = true
}
function added() { setTimeout(reload, 1500) }

// ------------------------------------------------------------ the panel
function talkTo(machine: string, to: CoordinatorTarget) {
  if (coordWhy(machine)) return
  if (!desk.value) {
    void router.push({ path: '/board', query: { machine, ...(to.kind === 'project' ? { coordinator: to.repo } : { conversation: to.kind }) } })
    return
  }
  panel.value = { machine, kind: 'coordinator', to }
  haptic()
}
// New opens the same panel, including an unregistered repository path.
watch(() => [route.query.coordinator, route.query.conversation], ([repo, conversation]) => {
  const to: CoordinatorTarget | null = typeof repo === 'string' && repo
    ? { kind: 'project', repo } : conversation === 'main' || conversation === 'machine' ? { kind: conversation } : null
  if (!to) {
    if (!desk.value && panel.value?.kind === 'coordinator') panel.value = null
    return
  }
  panel.value = { machine: typeof route.query.machine === 'string' ? route.query.machine : '', kind: 'coordinator', to, freshProject: to.kind === 'project' }
  if (desk.value) void router.replace({ query: {} })
}, { immediate: true })
const coordLabel = (machine: string, to: CoordinatorTarget) => coordinatorLabel(to, machineLabel(machine))
const MACHINE_COORDS: CoordinatorTarget[] = [{ kind: 'machine' }]
// The main Coordinator is an entry point for all work, independent of task filters.
// A beads board has no coordinators (shared/beadsTasks.ts).
const coordMachines = computed(() => (board.value?.machines || []).filter(m => m.backend !== 'beads'))
const isBeads = (machine: string) => (board.value?.machines || []).some(m => m.machine === machine && m.backend === 'beads')
const projectsBoards = computed(() => ready.value.filter(m => m.backend !== 'beads'))
const coordWhy = (machine: string) => {
  const m = coordMachines.value.find(m => m.machine === machine)
  return m ? coordinatorUnavailable(m, offlineView.value) : tl('Machine unavailable', 'Machine indisponible')
}
const coordHint = (machine: string, to: CoordinatorTarget) => [coordinatorDescription(to), coordWhy(machine)].filter(Boolean).join(' ')
// Several hosts: the "Coordinator" button asks which machine's.
const coordItems = computed(() => [coordMachines.value.map(m => ({
  label: machineLabel(m.machine),
  description: coordHint(m.machine, { kind: 'main' }),
  disabled: Boolean(coordWhy(m.machine)),
  icon: 'i-lucide-server',
  onSelect: () => talkTo(m.machine, { kind: 'main' }),
}))])
const noCoordinator = computed(() => Boolean(board.value) && coordMachines.value.length > 0 && !coordMachines.value.some(m => !coordWhy(m.machine)))
const talking = (machine: string, to: CoordinatorTarget) => {
  const p = panel.value
  if (!p || p.kind !== 'coordinator' || p.machine !== machine || p.to.kind !== to.kind) return false
  return to.kind !== 'project' || (p.to.kind === 'project' && p.to.repo === to.repo)
}
const panelTask = computed(() => {
  const p = panel.value
  return p?.kind === 'task' ? allCards.value.find(c => c.machine === p.machine && c.task.id === p.id)?.task || picked.value?.task || null : null
})
// The task open in the panel: its card is selected (and its conversation in
// the sidebar, via boardOpenTask), and brought into view.
// The panel covers the Board (phone, narrow window): once it closes, the card
// of the task it showed stays marked, so the way back shows where it was.
const lastTask = ref('')
const openKey = computed(() => (panel.value?.kind === 'task' ? `${panel.value.machine}|${panel.value.id}` : ''))
const markedKey = computed(() => openKey.value || (panel.value || dockPanel.value ? '' : lastTask.value))
watch(panel, (p) => {
  boardOpenTask.value = p?.kind === 'task' ? { machine: p.machine, id: p.id } : null
  if (p) lastTask.value = openKey.value
}, { immediate: true })
onUnmounted(() => { boardOpenTask.value = null })
watch(() => [markedKey.value, allCards.value.find(c => c.key === markedKey.value)?.task.group] as const, ([key, group]) => {
  if (!key || !group) return
  // Phone, or a Board narrowed by the panel: its group's tab (not kept on the device).
  if (!wide.value && TASK_GROUPS.includes(group) && (group !== 'done' || showDone.value)) phoneColumn.value = group
  nextTick(() => root.value?.querySelector<HTMLElement>('.task-card.sel')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }))
}, { immediate: true })
// Its machine left Herdr's list: the panel closes. One that does not answer
// keeps it, with what is being written: nothing goes elsewhere on its own.
watch(board, (b) => {
  if (panel.value && b && !b.machines.some(m => m.machine === panel.value!.machine)) panel.value = null
})
// The project's coordinator on the task's own machine.
function askCoordinator(machine: string, task: TaskRow) {
  talkTo(machine, { kind: 'project', repo: task.repo })
}
// The task agent conversation, separate from its project coordinator.
function chatWith(machine: string, task: TaskRow) {
  if (!desk.value) {
    // Its panel already open (the sheet over it): switching to the chat stays the
    // same detail entry, so one back still leaves the task.
    const to = { path: '/board', query: { machine, task: task.id, view: 'chat' } }
    void (routeShowsTask(machine, task.id) ? router.replace(to) : router.push(to))
    return
  }
  panel.value = { machine, kind: 'task', id: task.id, chat: true }
  haptic()
}
// The panel's task, from its "Task" button or once its agent is gone.
function panelSheet() {
  const p = panel.value
  if (p?.kind !== 'task') return
  const c = allCards.value.find(x => x.machine === p.machine && x.task.id === p.id) || picked.value
  if (!c) return
  // No agent to show: the sheet replaces the panel.
  openSheet(c)
}
// One panel per target: nothing of one coordinator or task (a reply on its
// way, a message being written) carries over to another.
const panelKey = computed(() => {
  const p = panel.value
  if (!p) return ''
  return p.kind === 'task' ? `t|${p.machine}|${p.id}` : `c|${p.machine}|${p.to.kind}|${p.to.kind === 'project' ? p.to.repo : ''}`
})
// Its agent is gone: its sheet, while the task is on the Board (an archived
// one, whose space herdr-projects just closed, is not opened again).
function panelNoAgent() {
  const p = panel.value
  if (p?.kind === 'task' && allCards.value.some(c => c.machine === p.machine && c.task.id === p.id)) panelSheet()
  panel.value = null
}

// ------------------------------------------------------------ board settings
// Board settings (BoardSettings): from the ⚙ beside the machine filter (the
// machines it shows; several: the screen asks which), a repo heading (that
// repo's entry), or a link `#/board?settings=<machine or group>` (the home
// list's machine bar). It takes the side panel's place.
const settings = shallowRef<SettingsTarget | null>(null)
function openSettings(scope: string, repo?: string) {
  const machines = boardSettingsMachines(scope, ready.value.map(m => m.machine), barGroups.value)
  settings.value = { machines, ...(repo ? { repo } : {}) }
  panel.value = null
  haptic()
}
watch(panel, (p) => { if (p) settings.value = null })
// The link's scope, opened once the Board knows its machines.
const settingsFor = ref<string | null>(null)
watch(() => route.query.settings, (v) => {
  if (v === undefined || Array.isArray(v)) return
  settingsFor.value = v ?? ''
  router.replace({ query: {} })
}, { immediate: true })
watch([settingsFor, board], ([scope, b]) => {
  if (scope === null || !b) return
  settingsFor.value = null
  openSettings(scope)
}, { immediate: true })
// Each machine's repos: those of its tasks and those linked to its board.
const settingsRepos = computed(() => Object.fromEntries(boards.value.map(m => [m.machine,
  [...new Set([...m.tasks.map(t => t.repo), ...(projectLinks.value.find(b => b.machine === m.machine)?.repos || []).map(r => r.repo)])].filter(Boolean).sort()])))
const settingsReachable = (machine: string) => ready.value.some(m => m.machine === machine)

function panelBackLabel() {
  return !desk.value && (route.query.task || route.query.coordinator || route.query.conversation) && history.state?.back === '/' ? t('Back') : undefined
}

function closePanel() {
  if (!desk.value && (route.query.task || route.query.coordinator || route.query.conversation)) backToOrigin()
  else panel.value = null
}

function back() {
  const from = (history.state as { back?: unknown } | null)?.back
  if (typeof from === 'string' && from.startsWith('/') && from !== '/board') router.back()
  else navigateTo('/', { replace: true })
}
</script>

<template>
  <section id="board" ref="root" class="view board-view" :class="{ 'with-panel': (panel || settings) && dockPanel, narrow: !wide, 'board-cached': cachedAt }">
    <div ref="panelSizer" class="board-panel-sizer" aria-hidden="true" />
    <header class="top bar board-top">
      <UButton icon="i-lucide-chevron-left" color="neutral" variant="ghost" size="lg" class="icon-btn" :aria-label="t('Back')" @click="back" />
      <h2>{{ t('Board') }}</h2>
      <UButton
        v-if="ready.length" icon="i-lucide-plus" color="primary" variant="outline" size="md" class="board-new" :disabled="offlineView"
        :aria-label="tl('New task', 'Nouvelle tâche')" @click="newTask()"
      >
        <span class="board-new-label">{{ tl('New task', 'Nouvelle tâche') }}</span>
      </UButton>
      <CoordinatorHint v-if="coordMachines.length === 1" :text="coordHint(coordMachines[0]!.machine, { kind: 'main' })">
        <UButton color="neutral" variant="outline" size="md" class="board-coord board-top-coord" :icon="!wide ? 'i-lucide-message-square-text' : undefined"
          :class="{ on: talking(coordMachines[0]!.machine, { kind: 'main' }) }" :disabled="Boolean(coordWhy(coordMachines[0]!.machine))"
          @click="talkTo(coordMachines[0]!.machine, { kind: 'main' })"
          :aria-label="coordLabel(coordMachines[0]!.machine, { kind: 'main' })"><span class="board-coord-label">{{ coordLabel(coordMachines[0]!.machine, { kind: 'main' }) }}</span></UButton>
      </CoordinatorHint>
      <UDropdownMenu v-else-if="coordMachines.length > 1" :items="coordItems" :content="{ align: 'end', sideOffset: 6 }" :ui="{ content: 'hw-dropdown board-coord-menu', itemLabel: 'whitespace-normal', itemDescription: 'whitespace-normal' }">
        <CoordinatorHint :text="coordinatorDescription({ kind: 'main' })">
          <UButton color="neutral" variant="outline" size="md" class="board-coord board-top-coord" :icon="!wide ? 'i-lucide-message-square-text' : undefined" :aria-label="coordinatorLabel({ kind: 'main' }, '')" trailing-icon="i-lucide-chevron-down">
            <span class="board-coord-label">{{ coordinatorLabel({ kind: 'main' }, '') }}</span>
          </UButton>
        </CoordinatorHint>
      </UDropdownMenu>
      <UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" size="lg" class="icon-btn board-filter" :aria-label="tl('Refresh', 'Actualiser')" :disabled="offlineView" @click="refreshes++; reload()" />
    </header>
    <!-- Each machine's main Coordinator: its Autopilot. -->
    <div v-if="coordMachines.length && !offlineView" class="board-autopilots">
      <div v-for="m in coordMachines" :key="m.machine">
        <span v-if="coordMachines.length > 1" class="board-autopilots-machine">{{ machineLabel(m.machine) }}</span>
        <CoordinatorAutopilot :machine="m.machine" :to="{ kind: 'main' }" :disabled="Boolean(coordWhy(m.machine))" />
      </div>
    </div>
    <div v-if="error" class="notice board-notice">{{ error }}</div>
    <p v-else-if="slow" class="board-empty board-slow" role="status">
      {{ tl('herdr-projects is not answering', 'herdr-projects ne répond pas') }} ·
      <button type="button" class="board-retry" @click="reload">{{ t('Retry') }}</button>
    </p>
    <BoardSkeleton v-else-if="skeleton" :wide="wide" :groups="columns.map(c => c.id)" />

    <div v-if="noCoordinator || notes.length || disabled.length" class="board-notes">
      <p v-if="noCoordinator" class="board-note" role="status">{{ tl('No Coordinator can be reached now. See each machine’s availability.', 'Aucun Coordinateur n’est joignable pour l’instant. Consulte la disponibilité de chaque machine.') }}</p>
      <ProjectsUpgradeNote
        v-for="m in notes" :key="m.machine" :status="m.status as 'missing' | 'old' | 'shepherdr'" :version="m.version || null"
        :machine="several ? (machineName(m.machine) || hostLabel || t('This machine')) : undefined"
      />
      <p v-for="m in disabled" :key="m.machine" class="board-note">{{ tl(`herdr-projects is disabled in Herdr${several ? ` on ${machineName(m.machine)}` : ''}: herdr plugin enable herdr-projects`, `herdr-projects est désactivé dans Herdr${several ? ` sur ${machineName(m.machine)}` : ''} : herdr plugin enable herdr-projects`) }}</p>
    </div>

    <template v-if="boards.length && !skeleton">
      <div class="board-tools">
        <USelect
          v-if="boards.length > 1" :model-value="boardScopeValue(shownScope)" :items="scopeItems" size="sm" class="board-scope" :aria-label="tl('Machines shown', 'Machines affichées')"
          @update:model-value="pickScope(String($event))"
        />
        <!-- The board kept on this device, until the read answers: in this row, so nothing moves. -->
        <span v-if="cachedAt" class="cached-tag board-cached-tag" role="status" :title="tl(`Kept on this device, as read at ${readAt(cachedAt)}; being read again`, `Gardé sur cet appareil, lu à ${readAt(cachedAt)} ; relecture en cours`)">
          <span class="cached-tag-word">{{ `${tl('Read at', 'Lu à')} ` }}</span>{{ readAt(cachedAt) }}
        </span>
        <UButton
          v-if="projectsBoards.length" icon="i-lucide-settings" color="neutral" variant="outline" size="sm" class="icon-btn board-settings-open" :class="{ on: settings && !settings.repo }"
          :disabled="offlineView" :aria-label="tl('Board settings', 'Réglages du board')" :title="tl('Board settings', 'Réglages du board')" @click="openSettings(shownScope)"
        />
        <div class="board-grouping" role="group" :aria-label="tl('View', 'Vue')">
          <button type="button" :class="{ on: grouping === 'global' }" :aria-pressed="grouping === 'global'" @click="pickGrouping('global')">{{ tl('Global', 'Global') }}</button>
          <button type="button" :class="{ on: grouping === 'repo' }" :aria-pressed="grouping === 'repo'" @click="pickGrouping('repo')">{{ tl('By repo', 'Par dépôt') }}</button>
        </div>
        <div v-if="projectsBoards.length" class="board-grouping board-archived-toggle">
          <button type="button" :class="{ on: showArchived }" :aria-pressed="showArchived" :disabled="offlineView" @click="toggleArchived">
            <UIcon name="i-lucide-archive" />{{ tl('Archived', 'Archivées') }}
          </button>
        </div>
      </div>

      <!-- Phone, or a Board narrowed by the panel: one group at a time, in both views. -->
      <div v-if="!wide" class="board-seg tasks" :style="{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr)) auto` }" role="group" :aria-label="t('Board')">
        <button
          v-for="col in columns" :key="col.id" type="button" class="board-seg-btn" :class="[col.id, { on: shownColumn === col.id }]"
          :aria-pressed="shownColumn === col.id" @click="selectColumn(col.id)"
        >
          <span>{{ col.label }}</span><b>{{ col.total }}</b>
        </button>
        <!-- Done, hidden: its toggle shows it (as a tab); shown: the same place hides it. -->
        <button
          type="button" class="board-seg-btn board-done-toggle" :class="{ shown: showDone }" :aria-pressed="showDone"
          :aria-label="doneToggleLabel" :title="doneToggleLabel" @click="toggleDone"
        >
          <template v-if="showDone"><UIcon name="i-lucide-eye-off" class="board-done-icon" /></template>
          <template v-else><span>{{ taskGroupLabel('done') }}</span><b><UIcon name="i-lucide-eye" class="board-done-icon" />{{ doneCount }}</b></template>
        </button>
      </div>

      <!-- The same grid in both views: columns of equal width. "By repo" cuts it into lanes. -->
      <div class="board-grid" :class="{ desk: wide, lanes: grouping === 'repo' }" :style="gridStyle">
        <div v-if="wide" class="board-grid-head">
          <h3 v-for="(col, i) in columns" :key="col.id" class="board-col-head" :class="col.id">
            <span>{{ col.label }}</span><span class="pp-count">{{ col.total }}</span>
            <!-- At the end of the heads: "Done · 9" shows Done, "Hide" on its head hides it. -->
            <button
              v-if="i === columns.length - 1" type="button" class="board-done-toggle" :class="{ shown: showDone }" :aria-pressed="showDone"
              :aria-label="doneToggleLabel" :title="doneToggleLabel" @click="toggleDone"
            >
              <UIcon :name="showDone ? 'i-lucide-eye-off' : 'i-lucide-eye'" class="board-done-icon" />
              <span>{{ showDone ? tl('Hide', 'Masquer') : `${taskGroupLabel('done')} · ${doneCount}` }}</span>
            </button>
          </h3>
        </div>

        <template v-if="grouping === 'repo' || machineGroups.some(m => m.trouble)">
          <section v-for="mg in machineGroups.filter(m => grouping === 'repo' || m.trouble)" :key="mg.machine || 'local'" class="board-machine" :data-machine="mg.machine || 'local'">
            <div class="board-head machine" :class="{ talking: talking(mg.machine, { kind: 'main' }) || talking(mg.machine, { kind: 'machine' }) }">
              <button type="button" class="board-fold" :aria-expanded="!folds.has(`m:${mg.machine}`)" :aria-label="tl('Fold', 'Replier')" @click="fold(`m:${mg.machine}`)">
                <UIcon :name="folds.has(`m:${mg.machine}`) ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'" />
              </button>
              <p class="board-head-name"><b>{{ machineLabel(mg.machine) }}</b><span class="board-head-sum">{{ mg.summary.main }}<span v-if="mg.summary.done" class="board-head-done">{{ mg.summary.main ? ' · ' : '' }}{{ mg.summary.done }}</span></span>
                <CoordinatorHint v-if="mg.trouble" :text="mg.error">
                  <span class="board-machine-error" role="status">{{ mg.at ? tl(`unreachable · read at ${readAt(mg.at)}`, `injoignable · lu à ${readAt(mg.at)}`) : tl('unreachable', 'injoignable') }}</span>
                </CoordinatorHint>
              </p>
              <div v-if="!isBeads(mg.machine)" class="board-head-actions">
                <CoordinatorHint v-for="to in MACHINE_COORDS" :key="to.kind" :text="coordHint(mg.machine, to)">
                  <UButton
                    color="neutral" variant="outline" size="sm" class="board-coord" :class="{ on: talking(mg.machine, to) }"
                    :disabled="Boolean(coordWhy(mg.machine))" :aria-description="coordWhy(mg.machine) || undefined" @click="talkTo(mg.machine, to)"
                  >
                    {{ coordLabel(mg.machine, to) }}
                  </UButton>
                </CoordinatorHint>
                <CoordinatorAutopilot :machine="mg.machine" :to="{ kind: 'machine' }" :disabled="Boolean(coordWhy(mg.machine))" compact />
              </div>
            </div>
            <template v-if="grouping === 'repo' && !folds.has(`m:${mg.machine}`)">
              <section v-for="rg in mg.repos" :key="rg.repo" class="board-repo" :data-repo="rg.repo">
                <div class="board-head repo" :class="{ talking: talking(mg.machine, { kind: 'project', repo: rg.repo }) }">
                  <button type="button" class="board-fold" :aria-expanded="!folds.has(`r:${mg.machine}|${rg.repo}`)" :aria-label="tl('Fold', 'Replier')" @click="fold(`r:${mg.machine}|${rg.repo}`)">
                    <UIcon :name="folds.has(`r:${mg.machine}|${rg.repo}`) ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'" />
                  </button>
                  <p class="board-head-name"><b>{{ rg.repo }}</b><span class="board-head-sum">{{ rg.summary.main }}<span v-if="rg.summary.done" class="board-head-done">{{ rg.summary.main ? ' · ' : '' }}{{ rg.summary.done }}</span></span></p>
                  <div class="board-head-actions">
                    <template v-if="!isBeads(mg.machine)">
                    <CoordinatorHint :text="coordHint(mg.machine, { kind: 'project', repo: rg.repo })">
                      <UButton
                        color="neutral" variant="outline" size="sm" class="board-coord" :class="{ on: talking(mg.machine, { kind: 'project', repo: rg.repo }) }"
                        :disabled="Boolean(coordWhy(mg.machine))" :aria-description="coordWhy(mg.machine) || undefined" @click="talkTo(mg.machine, { kind: 'project', repo: rg.repo })"
                      >
                        {{ coordLabel(mg.machine, { kind: 'project', repo: rg.repo }) }}
                      </UButton>
                    </CoordinatorHint>
                    <CoordinatorAutopilot :machine="mg.machine" :to="{ kind: 'project', repo: rg.repo }" :disabled="Boolean(coordWhy(mg.machine))" compact />
                    <RepoArchiveMenu :machine="mg.machine" :repo="rg.repo" :machine-label="machineLabel(mg.machine)"
                      :tasks="boards.find(m => m.machine === mg.machine)?.tasks || []" :disabled="offlineView || !settingsReachable(mg.machine) || mg.trouble"
                      @refresh="reload().then(loadArchived)" />
                    <UButton
                      icon="i-lucide-settings" color="neutral" variant="outline" size="sm" class="board-head-add board-repo-settings" :disabled="offlineView || !settingsReachable(mg.machine)"
                      :aria-label="tl(`Repository settings: ${rg.repo}`, `Réglages du dépôt : ${rg.repo}`)" :title="tl('Repository settings', 'Réglages du dépôt')" @click="openSettings(mg.machine, rg.repo)"
                    />
                    </template>
                    <UButton
                      icon="i-lucide-plus" color="neutral" variant="outline" size="sm" class="board-head-add" :disabled="offlineView"
                      :aria-label="tl(`New task in ${rg.repo}`, `Nouvelle tâche dans ${rg.repo}`)" @click="newTask(mg.machine, rg.repo)"
                    />
                  </div>
                </div>
                <!-- Its lane: one cell under each of the Board's columns. -->
                <div v-if="!folds.has(`r:${mg.machine}|${rg.repo}`)" class="board-repo-cols board-cells">
                  <section
                    v-for="col in rg.cols" v-show="wide || shownColumn === col.id" :key="col.id" class="board-repo-col" :class="[col.id, { none: !col.total }]"
                    :data-group="col.id" :aria-label="col.label"
                  >
                    <div class="board-repo-col-body">
                      <TaskCard v-for="c in col.cards" :key="c.key" :task="c.task" :stale="c.stale" :read-at="readAt(c.readAt)" :selected="c.key === markedKey" @open="openCard(c)" />
                      <p v-if="!wide && !col.total" class="board-empty">{{ t('Nothing here') }}</p>
                      <button v-if="col.hidden" type="button" class="board-more" @click="showAll = true">
                        {{ tl(`Show all (${col.hidden} more)`, `Tout afficher (${col.hidden} de plus)`) }}
                      </button>
                    </div>
                  </section>
                </div>
              </section>
              <p v-if="!mg.repos.length" class="board-empty board-machine-empty">{{ isBeads(mg.machine) ? tl('No beads issue yet: add one.') : tl('No task yet: talk to the Coordinator at the top, or add one.', 'Aucune tâche : parle au Coordinateur en haut, ou ajoutes-en une.') }}</p>
            </template>
          </section>
        </template>

        <div v-if="grouping === 'global'" class="board-cols board-cells">
          <section v-for="col in columns" v-show="wide || shownColumn === col.id" :key="col.id" class="board-col" :class="col.id" :aria-label="col.label">
            <div class="board-col-body">
              <TaskCard
                v-for="c in col.cards" :key="c.key" :task="c.task" :machine="namesOnCards ? machineName(c.machine) : undefined"
                :stale="c.stale" :read-at="readAt(c.readAt)" :selected="c.key === markedKey" @open="openCard(c)"
              />
              <p v-if="!col.cards.length" class="board-empty">{{ t('Nothing here') }}</p>
              <button v-if="col.hidden" type="button" class="board-more" @click="showAll = true">
                {{ tl(`Show all (${col.hidden} more)`, `Tout afficher (${col.hidden} de plus)`) }}
              </button>
            </div>
          </section>
        </div>

        <!-- Archived tasks: each opens its sheet, read-only with Restore. -->
        <section v-if="showArchived" class="board-archived" :aria-label="tl('Archived tasks', 'Tâches archivées')">
          <h3 class="board-col-head archived"><span>{{ tl('Archived', 'Archivées') }}</span><span class="pp-count">{{ archivedCards.length }}</span></h3>
          <p v-for="m in archivedErrors" :key="m.machine" class="board-note error">
            <b v-if="several">{{ machineLabel(m.machine) }} · </b>{{ m.error }}
          </p>
          <div class="board-archived-body">
            <TaskCard
              v-for="c in archivedCards" :key="c.key" :task="c.task" :machine="namesOnCards ? machineName(c.machine) : undefined"
              @open="openSheet(c)"
            />
          </div>
          <p v-if="archivedLoading && !archivedCards.length" class="board-empty">{{ t('Loading…') }}</p>
          <p v-else-if="!archivedCards.length" class="board-empty">{{ t('Nothing here') }}</p>
        </section>
      </div>
    </template>
    <BoardPanel
      v-if="panel" :key="panelKey" :overlay="!dockPanel" :back-label="panelBackLabel()" :target="panel" :task="panelTask"
      :refresh="reload" :refresh-key="refreshes" :machine-label="machineLabel(panel.machine)" :reachable="ready.some(m => m.machine === panel!.machine)"
      @archived="onArchived" @restored="onRestored" @changed="reload" @close="closePanel" @sheet="panelSheet" @no-agent="panelNoAgent" @coordinator="askCoordinator"
      @retarget="to => { if (panel?.kind === 'coordinator') panel = { machine: panel.machine, kind: 'coordinator', to } }"
    />
    <BoardSettings
      v-if="settings && !panel" :overlay="!dockPanel" :key="JSON.stringify(settings)" :target="settings" :repos="settingsRepos" :machine-label="machineLabel"
      :reachable="settingsReachable" @close="settings = null" @changed="reload()"
    />
    <TaskSheet
      v-model:open="sheetOpen" :task="pickedTask" :machine="picked?.machine ?? ''" :reachable="ready.some(m => m.machine === (picked?.machine ?? ''))"
      :refresh="reload" @archived="onArchived" @restored="onRestored" @chat="chatWith" @coordinator="askCoordinator"
    />
    <NewTaskSheet v-model:open="newOpen" :machines="ready.map(m => m.machine)" :repos="reposByMachine" :machine="newFor.machine" :repo="newFor.repo" @added="added" />
  </section>
</template>

<style scoped>
.board-machine-error { display: inline-block; padding: 3px 5px; border: 1px solid currentColor; color: var(--rose); font: 500 10px/1.4 var(--mono); text-transform: uppercase; }
.board-head.machine .board-head-name { flex-wrap: wrap; }

.board-autopilots { display: flex; flex-wrap: wrap; gap: 8px 16px; padding: 10px 16px; border-bottom: 1px solid var(--line); }
.board-autopilots > div { display: flex; align-items: center; gap: 8px; min-width: 0; max-width: 100%; }
.board-autopilots-machine { font: 500 10.5px/1.2 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
</style>
