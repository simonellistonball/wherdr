<script setup lang="ts">
import { desk as desktop } from '~/composables/useHerdr'
// Task panels own their compact header, role tabs and board failure banner.
// The banner says where the task stands now: a failure it has moved on from
// (failureStale) is history in the Task tab, never its title or its buttons.
// Coordinators keep their own startup/delivery lifecycle.
import { type CoordinatorStatus, type CoordinatorTarget, type TaskDetails, type TaskPanes, type TaskRow, TELL_MAX, coordinatorPhase, coordinatorSubject, taskActions, taskCanFix, taskCanApproveAnyway, taskCanSendReview, reviewFindingsBrief, taskKey, type TaskCommand, finishCase } from '#shared/projectsTasks'
import { PANEL_MIN, PANEL_MAX, clampPanelWidth, panelWidthCss, readPanelWidth, savePanelWidth } from '~/utils/sideWidth'
import { visibleAgentKinds } from '~/utils/agentChoices'
import { finishHint, finishLabel, finishOffered, finishQuestion, finishTitle, limitHint } from '~/utils/taskFinish'
import { limitStopOf } from '#shared/taskLimits'
import { blockChoices, blockKind, blockKindLabel, offersAlways, permissionReply, questionMessage } from '~/utils/blockNotice'
import { reviewerWait } from '~/utils/reviewerWait'
import { taskActivity } from '#shared/taskActivity'
import { defaultViewMode, type PaneViewMode, allSessionsState, chooseMachineSession } from '~/composables/useHerdr'
import { useAutopilot } from '~/composables/useAutopilot'

export type PanelTarget =
  | { machine: string, kind: 'task', id: string, chat?: boolean, mode?: PaneViewMode }
  | { machine: string, kind: 'coordinator', to: CoordinatorTarget, freshProject?: boolean }

// `reachable`: its machine's board answers now (a message waits while it does not).
const props = defineProps<{ overlay?: boolean, backLabel?: string, target: PanelTarget, task: TaskRow | null, machineLabel: string, reachable?: boolean, refresh?: () => Promise<unknown>, refreshKey?: number }>()
const desk = computed(() => desktop.value && !props.overlay)
// A switch's action: the Scheduled section reads the Autopilot again.
const { actions: autopilotActions } = useAutopilot()
const launchAgent = ref('__default')
const launchModel = ref('')
const launchEffort = ref('__default')
const launchChoices = computed(() => {
  const key = props.target.machine
  const cfg = machineChoices.value?.find(m => m.key === key)
  return [{ label: tl('Default', 'Par défaut'), value: '__default' },
    ...visibleAgentKinds(cfg?.kinds || appConfig.value.kinds || [], hiddenAgents.value).filter(k => k !== 'shell').map(k => ({ label: kindLabel(k), value: k }))]
})
const effortChoices = computed(() => [{ label: tl('Default', 'Par défaut'), value: '__default' }, ...['low', 'medium', 'high', 'xhigh', 'max'].map(value => ({ label: value, value }))])
const emit = defineEmits<{ retarget: [to: CoordinatorTarget], coordinator: [machine: string, task: TaskRow], close: [], sheet: [], noAgent: [], changed: [], archived: [machine: string, task: TaskRow], restored: [machine: string, task: TaskRow] }>()

// ------------------------------------------------------------ a task's agent
const taskPane = ref<string | null>(null)
const details = ref<(TaskDetails & Partial<TaskPanes>) | null>(null)
const loading = ref(false)
const failed = ref('')
// No pane, but herdr-projects passes a reply on (`tell`): the field shown instead.
const tellOnly = ref(false)
const canTell = (d: TaskDetails) => Boolean(props.task) && taskActions(props.task!, d).tell
let seq = 0
// `again`: the same task moved on (a closing note, a report): the agent stays shown.
async function loadTask(again = false) {
  const t = props.target
  if (t.kind !== 'task') return
  const n = ++seq
  if (!again) {
    taskPane.value = null
    details.value = null
    failed.value = ''
    loading.value = true
  }
  try {
    const d = await api<TaskDetails & TaskPanes>(`/api/tasks/details?machine=${encodeURIComponent(t.machine)}&id=${encodeURIComponent(t.id)}`)
    if (n !== seq) return
    details.value = d
    if (!d.pane) {
      tellOnly.value = canTell(d)
      taskPane.value = null
      return
    }
    tellOnly.value = false
    taskPane.value = d.pane
  } catch (e) {
    if (n === seq && !again) failed.value = (e as Error).message
  } finally {
    if (n === seq) loading.value = false
  }
}
watch(() => props.target.kind === 'task' ? `${props.target.machine}|${props.target.id}` : '', (k) => { if (k) loadTask() }, { immediate: true })
// Its details still being read (opened at once from the sidebar): the shapes of
// its header, tabs and conversation after 300 ms, none for a quick read.
const skeleton = useDelayedFlag(computed(() => props.target.kind === 'task' && loading.value && !details.value))
watch(() => (props.task ? `${props.task.stage}|${props.task.group}|${props.task.state}|${props.task.msg}` : ''), (k, was) => { if (k && was && k !== was) loadTask(true) })

// A reply to a task with no pane: herdr-projects passes it on (`tell`). The
// panel is one per task, so a late answer never lands on another one.
const reply = ref('')
const telling = ref(false)
// `said`: an answer picked in the banner, sent as it is; else the field's text.
async function tell(said?: string) {
  const t = props.target
  const text = (said ?? reply.value).trim()
  if (t.kind !== 'task' || !text || telling.value || !props.reachable) return
  telling.value = true
  try {
    await api('/api/tasks/tell', { machine: t.machine, id: t.id, text })
    haptic()
    // In `reviewneeds`, 1.x passes it to the reviewer (flow/talk.rs), not the worker.
    toast(toReviewer.value ? tl('Sent to the reviewer', 'Envoyé au relecteur') : tl('Sent to the task’s agent', 'Envoyé à l’agent de la tâche'))
    if (said === undefined) reply.value = ''
    // Its agent may be back on a pane: its conversation then shows here.
    loadTask(true)
  } catch (e) { toast((e as Error).message, true) }
  finally { telling.value = false }
}

const full = ref(false)
const taskOpen = ref(true)
const actionBusy = ref(false)
const actionError = ref('')
const agentPane = computed(() => herdrState.value.panes.find(p => p.id === taskPane.value))
const identity = computed(() => {
  const saved = details.value?.identity || props.task?.identity
  return { agent: agentPane.value?.agent || saved?.agent || details.value?.agent || props.task?.app || '', reviewer: reviewing.value ? saved?.reviewer || reviewerAgent.value?.agent || '' : '', from: saved?.from || '' }
})
// Working: an agent running, or the board waiting for CI or for its turn (as its card says).
const activity = computed(() => (props.target.kind === 'task' && props.task ? taskActivity(props.task) : null))
const activityClass = computed(() => (activity.value && activity.value.kind !== 'running' ? `activity-${activity.value.kind}` : ''))
const reviewing = computed(() => ['reviewing', 'reviewneeds'].includes(details.value?.stage || props.task?.stage || ''))
const conversation = computed(() => Boolean(agentPane.value && hasChat(agentPane.value))
  && !(props.task?.stage === 'failed' && ['start', 'setup', 'attempts'].includes(details.value?.failureStage || '')))
const agentHint = computed(() => agentPane.value ? tl(`Agent: ${statusLabel(agentPane.value)}`, `Agent : ${statusLabel(agentPane.value)}`) : tl('Agent not running', 'Agent arrêté'))
const taskPermissions = computed(() => props.task ? taskActions(props.task, details.value) : null)
const canFix = computed(() => props.task && taskCanFix(props.task, details.value))
const canAnyway = computed(() => props.task && taskCanApproveAnyway(props.task, details.value))
// A failed review: sending it back to the agent comes first, as 1.x asks it.
const canSendReview = computed(() => Boolean(props.task && taskCanSendReview(props.task, details.value)))
const reviewBrief = computed(() => (canSendReview.value ? reviewFindingsBrief(details.value?.findings) : null))
// Who a message reaches now: the reviewer while it shows a dialog (`reviewneeds`).
const toReviewer = computed(() => (details.value?.stage || props.task?.stage) === 'reviewneeds')
const disabled = computed(() => Boolean(actionBusy.value || offlineView.value || !props.reachable || props.task?.stale))
// Finish: a limit, no summary, or a row stuck at "Finishing" with its agent at rest.
const finishKind = computed(() => (props.task ? finishCase(props.task) : null))
const limitRequest = ref(0)
async function openWorkLimit() {
  choose('task')
  await nextTick()
  limitRequest.value++
}
const canFinish = computed(() => Boolean(props.task && taskPermissions.value?.finish && finishOffered(props.task, agentPane.value?.status ?? null)))
const stuck = computed(() => canFinish.value && finishKind.value === 'stuck')
const limitStop = computed(() => (finishKind.value === 'limit' ? limitStopOf(details.value?.limits, props.task?.msg) : null))
const needs = computed(() => props.task?.group === 'needs')
// Its failure, unless the task moved on since (a later stage, its agent started again).
const failureNow = computed(() => (details.value && !details.value.failureStale ? details.value : null))
const choosingAttempt = computed(() => props.task?.stage === 'pick')
const failureTitle = computed(() => choosingAttempt.value ? tl('Choose an attempt', 'Choisis un essai') : failureNow.value?.failureTitle || details.value?.msg || props.task?.msg || agentPane.value?.prompt?.question || tl('Your answer is needed', 'Ta réponse est attendue'))
const failureDetail = computed(() => failureNow.value?.failureDetail || failureNow.value?.failure || '')

// ------------------------------------------------- the one-line "Needs you"
// A wait its agent reported (`report --kind`), with no failure to show: one
// line (its kind, its words, folded) and the actions that answer that kind.
// Only a sign-in keeps "Open terminal": a question or a permission is answered
// by a message, in the field below or with one tap.
const waitKind = computed(() => (needs.value && !choosingAttempt.value && !failureNow.value?.failureTitle && !failureDetail.value ? blockKind(props.task?.kind) : null))
const waitText = computed(() => failureTitle.value)
// The agent's own question (`report --state blocked`): a message answers it.
const asks = computed(() => props.task?.stage === 'asks')
const answerable = computed(() => Boolean(waitKind.value && waitKind.value !== 'auth' && asks.value))
// One tap sends the answer, through herdr-projects (`tell`).
const canTap = computed(() => answerable.value && Boolean(taskPermissions.value?.tell))
const choices = computed(() => (canTap.value && waitKind.value === 'question' ? blockChoices(waitText.value) : []))
const permissionTaps = computed(() => canTap.value && waitKind.value === 'permission')
const always = computed(() => offersAlways(waitText.value))
const tapOff = computed(() => telling.value || disabled.value)
const waitOpen = ref(false)
const waitEl = ref<HTMLElement | null>(null)
// Its text is cut: the line offers to unfold it.
const waitCut = ref(false)
function measureWait() {
  const el = waitEl.value
  if (el && !waitOpen.value) waitCut.value = el.scrollWidth > el.clientWidth + 1
}
watch(waitEl, (el, _, onCleanup) => {
  if (!el || typeof ResizeObserver === 'undefined') return
  const ro = new ResizeObserver(measureWait)
  ro.observe(el)
  onCleanup(() => ro.disconnect())
})
watch(waitText, () => { waitOpen.value = false; nextTick(measureWait) })
const panelEl = ref<HTMLElement | null>(null)
// Waits for what the conversation tab shows, as it opens.
async function inPanel<T>(find: (root: HTMLElement) => T | null): Promise<T | null> {
  for (let i = 0; i < 60; i++) {
    await nextTick()
    const root = panelEl.value?.querySelector<HTMLElement>('.board-panel-body')
    const got = root ? find(root) : null
    if (got) return got
    await new Promise(r => setTimeout(r, 50))
  }
  return null
}
// Reply…: into the conversation's field (or the one herdr-projects passes on).
async function replyHere() {
  choose('chat')
  const field = await inPanel(root => root.querySelector<HTMLElement>('.composer textarea, #board-panel-tell'))
  field?.focus()
}
// See ↓: the conversation's message that asks it, scrolled to and lit up.
const canSee = computed(() => Boolean(waitKind.value && taskPane.value && conversation.value))
async function seeQuestion() {
  choose('chat')
  const el = await inPanel(root => questionMessage(root, waitText.value))
  if (!el) return
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  el.classList.remove('msg-lit')
  void el.offsetWidth
  el.classList.add('msg-lit')
  setTimeout(() => el.classList.remove('msg-lit'), 2600)
}

// The board's severity words (gate.rs), in the reader's language.
function severityLabel(s: string) {
  switch (s) {
    case 'critical': return tl('Critical', 'Critique')
    case 'major': return tl('Major', 'Majeur')
    case 'minor': return tl('Minor', 'Mineur')
    case 'trivial': return tl('Trivial', 'Trivial')
    default: return s || tl('Finding', 'Remarque')
  }
}

function tabLabel(tab: TaskPanelTab) {
  return tab === 'settings' ? tl('Settings', 'Réglages') : tab === 'chat' || tab === 'term' ? t('Agent') : tab === 'reviewer' ? tl('Reviewer', 'Relecteur') : tl('Task', 'Tâche')
}

// ------------------------------------------------- a reviewer that needs you
// 1.x `reviewneeds`: the dialog is on the reviewer's pane, not the agent's
// (done by then). The banner opens the reviewer's pane in its own tab, says
// plainly when wherdr cannot reach it, and when the dialog is gone already.
const reviewerAsks = computed(() => needs.value && (props.task?.stage === 'reviewneeds' || details.value?.stage === 'reviewneeds'))
// Its pane, while Herdr shows it.
const reviewerPane = computed(() => {
  const id = details.value?.reviewer?.pane
  return id && herdrState.value.panes.some(p => p.id === id) ? id : null
})
const reviewerAgent = computed(() => herdrState.value.panes.find(p => p.id === reviewerPane.value))
const reviewerHint = computed(() => reviewerAgent.value ? tl(`Reviewer: ${statusLabel(reviewerAgent.value)}`, `Relecteur : ${statusLabel(reviewerAgent.value)}`) : tl('Reviewer', 'Relecteur'))
// Only once its details say so too: until then, nothing said of its pane.
const rvWait = computed(() => (reviewerAsks.value && details.value?.stage === 'reviewneeds'
  ? reviewerWait({ stage: 'reviewneeds', reviewer: details.value.reviewer, panes: herdrState.value.panes, everywhere: allSessionsState.value.panes, live: herdrState.value.ok && props.reachable !== false })
  : null))
// The session its pane is open in, when this device shows another one.
const reviewerSession = computed(() => {
  if (!reviewing.value || reviewerPane.value || !allSessionsState.value.ok) return null
  const p = allSessionsState.value.panes.find(x => x.id === details.value?.reviewer?.pane)
  const m = p && allSessionsState.value.machines?.find(x => x.key === (p.machine || ''))
  return m ? { baseKey: m.baseKey ?? m.key, name: m.session || 'default' } : null
})
const switching = ref(false)
// Shown on this device instead: its pane, then its dialog, are there.
async function showReviewerSession() {
  const s = reviewerSession.value
  if (!s || switching.value) return
  switching.value = true
  try {
    await chooseMachineSession(s.baseKey, s.name)
    choose('reviewer', true)
  } catch (e) { toast((e as Error).message, true) }
  finally { switching.value = false }
}
const rvWords = computed(() => {
  switch (rvWait.value) {
    case 'quiet': return tl('The reviewer shows no dialog now: the board moves on by itself in a few seconds.', 'Le relecteur n’affiche plus de dialogue : le tableau reprend tout seul dans quelques secondes.')
    case 'gone': return tl('The reviewer’s pane is closed: no dialog is left to answer. If the task stays here, stop it from the Task tab.', 'Le pane du relecteur est fermé : plus aucun dialogue à répondre. Si la tâche reste bloquée ici, arrête-la depuis l’onglet Tâche.')
    case 'hidden': return reviewerSession.value
      ? tl(`The reviewer runs in the session “${reviewerSession.value.name}”, which this device does not show. Switch to it to answer.`, `Le relecteur tourne dans la session « ${reviewerSession.value.name} », que cet appareil n’affiche pas. Passe sur cette session pour répondre.`)
      : tl('The reviewer runs in a session this device does not show.', 'Le relecteur tourne dans une session que cet appareil n’affiche pas.')
    case 'away': return tl(`wherdr cannot reach the reviewer’s pane. Answer it on ${props.machineLabel}, in the task’s space: its Reviewer tab.`, `wherdr ne peut pas joindre le pane du relecteur. Réponds-y sur ${props.machineLabel}, dans l’espace de la tâche : son onglet Reviewer.`)
    default: return ''
  }
})
// Each role follows Default pane view until its bar selects a mode.
// Without a readable conversation, the terminal is the only mode.
const reviewerChoice = ref<PaneViewMode | null>(null)
const reviewerMode = computed<PaneViewMode>(() => reviewerAgent.value && hasChat(reviewerAgent.value) ? reviewerChoice.value ?? defaultViewMode.value : 'term')
watch(reviewerPane, () => { reviewerChoice.value = null })

// The panel owns view selection. A task with nothing to talk to
// (never started, no pane) opens on the task, its other
// tabs hidden; a tab picked by hand stays while it is offered (taskPanelTab.ts).
const choiceKey = computed(() => (props.target.kind === 'task' ? `${props.target.machine}|${props.target.id}` : ''))
const choice = ref<TaskPanelTab | null>(taskPanelChoice(choiceKey.value))
// Its details read once (or failed): until then no tab is picked.
const settled = computed(() => !loading.value || details.value !== null)
const views = computed(() => ({
  chat: Boolean(taskPane.value) || tellOnly.value || Boolean(failureDetail.value && !needs.value),
  term: Boolean(taskPane.value),
  reviewer: Boolean(reviewerPane.value),
  // Its settings are herdr-projects' (`show --json`): none for a beads issue.
  settings: props.target.kind === 'task' && props.task?.backend !== 'beads',
}))
const tabs = computed(() => taskPanelTabs(views.value))
// Keep chat/term as internal destinations for existing links and shortcuts.
// They share one visible Agent tab; its selection also remembers the mode.
const agentChoice = ref<PaneViewMode | null>(choice.value === 'chat' || choice.value === 'term' ? choice.value : null)
const agentMode = computed<PaneViewMode>(() => agentPane.value && !hasChat(agentPane.value) ? 'term' : agentChoice.value ?? defaultViewMode.value)
const selected = computed(() => taskPanelTab(views.value, choice.value ?? (views.value.term ? agentMode.value : null)))
const navigationTabs = computed<TaskPanelTab[]>(() => [
  'task', ...(views.value.chat || views.value.term ? ['chat' as const] : []),
  ...(views.value.reviewer ? ['reviewer' as const] : []), ...(views.value.settings ? ['settings' as const] : []),
])
function tabSelected(tab: TaskPanelTab) {
  return tab === 'chat' ? selected.value === 'chat' || selected.value === 'term' : selected.value === tab
}
function chooseAgentMode(mode: PaneViewMode) {
  agentChoice.value = mode
  choose(mode, true)
}
// The banner's way to another tab, never to the one already shown.
const jump = computed(() => agentPane.value && !hasChat(agentPane.value)
  ? selected.value === 'term' || selected.value === 'chat' ? null : 'term'
  : needsJumpTab(tabs.value, selected.value))
function choose(tab: TaskPanelTab, force = false) {
  if (!force && tab === selected.value) return
  if (tab === 'chat' || tab === 'term') agentChoice.value = tab
  choice.value = tab
  setTaskPanelChoice(choiceKey.value, tab)
}
// "Open the chat" from a task's sheet asks for its conversation.
watch(() => props.target, (t) => { if (t.kind === 'task' && (t.mode || t.chat)) choose(t.mode ?? 'chat', true) }, { immediate: true })
// A choice no longer offered (its agent gone) is dropped: once an agent starts
// again, its conversation is the default view again.
watch([tabs, settled], () => {
  if (settled.value && !failed.value && choice.value && !tabs.value.includes(choice.value)) {
    choice.value = null
    setTaskPanelChoice(choiceKey.value, null)
  }
})
const noticeKey = computed(() => JSON.stringify([details.value?.summary, details.value?.review, details.value?.findings]))
const seenNote = ref('')
const newNote = computed(() => Boolean(details.value?.summary || details.value?.review) && noticeKey.value !== seenNote.value)
watch([selected, noticeKey], () => { if (selected.value === 'task') seenNote.value = noticeKey.value })
function archivedTask(machine: string, task: TaskRow) { emit('archived', machine, task); emit('close') }
function restoredTask(machine: string, task: TaskRow) { emit('restored', machine, task) }
async function refreshTask() {
  if (props.refresh) await props.refresh()
  else emit('changed')
  await loadTask(true)
}
async function taskAction(action: TaskCommand | 'approve' | 'anyway') {
  const target = props.target
  if (target.kind !== 'task' || disabled.value) return
  if (action === 'anyway' && !canAnyway.value) return
  if (action === 'fix' && !canFix.value) return
  if (action === 'review' && !canSendReview.value) return
  if (action === 'finish' && (!canFinish.value || !await askConfirm(finishQuestion(props.task?.title || details.value?.title || '', props.task?.chat), finishLabel(props.task?.chat), 'primary'))) return
  if ((action === 'approve' || action === 'anyway') && !await askConfirm(
    action === 'anyway' ? tl('Approve despite the failed review or checks? This merges the work.', 'Approuver malgré la relecture ou les contrôles en échec ? Cela fusionne le travail.') : tl('Approve this task?', 'Approuver cette tâche ?'),
    action === 'anyway' ? tl('Approve anyway', 'Approuver quand même') : tl('Approve', 'Approuver'), 'primary')) return
  if (props.target !== target || disabled.value) return
  actionBusy.value = true
  actionError.value = ''
  try {
    await api(action === 'approve' || action === 'anyway' ? '/api/tasks/approve' : '/api/tasks/action', {
      machine: target.machine, id: target.id,
      ...(action === 'approve' || action === 'anyway' ? { anyway: action === 'anyway' } : { action }),
    })
    haptic()
    await refreshTask()
  } catch (e) { actionError.value = (e as Error).message }
  finally { actionBusy.value = false }
}

// ------------------------------------------------------------ a coordinator
// `gen` changes with the target: what comes back for an earlier one is dropped.
let gen = 0
const coordPane = ref<string | null>(null)
const coordLoaded = ref(false)
// What herdr-projects said of it last: its state, why its start failed, its name.
const coordState = ref('')
const coordError = ref('')
const coordQueued = ref<number | null>(null)
let poll: ReturnType<typeof setTimeout> | undefined
let tries = 0
// `look` numbers each lookup: only the latest one's answer counts. Two lookups
// of the same coordinator can come back in any order; an earlier one's answer
// (a pane, "none", a failure, its retry) is dropped.
let look = 0
async function lookCoordinator(g: number) {
  const t = props.target
  if (t.kind !== 'coordinator' || g !== gen) return
  clearTimeout(poll)
  const n = ++look
  const latest = () => g === gen && n === look
  try {
    const q = new URLSearchParams({ machine: t.machine, kind: t.to.kind, ...(t.to.kind === 'project' ? { repo: t.to.repo } : {}) })
    const r = await api<Partial<CoordinatorStatus>>(`/api/tasks/coordinator?${q}`)
    if (!latest()) return
    coordPane.value = r.pane ?? null
    coordState.value = r.state ?? ''
    coordError.value = r.error ?? ''
    coordQueued.value = r.queued ?? null
    // Starting (or just told to): asked again until it has a pane. A pane Herdr
    // does not show (yet, or any more): asked again too, for the one it has now.
    // A failed start is not tried again by itself: nothing to wait for.
    const phase = coordinatorPhase({ pane: coordPane.value, state: coordState.value, error: coordError.value })
    const unseen = Boolean(r.pane) && herdrState.value.ok && !herdrState.value.panes.some(p => p.id === r.pane)
    if ((unseen || phase === 'starting' || (sent.value && phase === 'idle')) && ++tries <= 40) poll = setTimeout(() => lookCoordinator(g), 3000)
  } catch {
    if (latest() && sent.value && ++tries <= 40) poll = setTimeout(() => lookCoordinator(g), 3000)
  } finally {
    if (latest()) coordLoaded.value = true
  }
}
onUnmounted(() => { gen++; clearTimeout(poll) })
// The coordinator's pane once Herdr shows it.
const coordShown = computed(() => (coordPane.value && herdrState.value.panes.some(p => p.id === coordPane.value) ? coordPane.value : null))
// Asked again while none is shown and Herdr's agents change (its pane closed,
// a coordinator restarted or started from Herdr), and when its machine is back.
function relook() {
  if (props.target.kind !== 'coordinator') return
  tries = 0
  lookCoordinator(gen)
}
let settle: ReturnType<typeof setTimeout> | undefined
watch(() => (props.target.kind === 'coordinator' && coordLoaded.value && !coordShown.value
  ? herdrState.value.panes.filter(p => p.agent).map(p => p.id).join(' ')
  : null), (k, was) => {
  if (k === null || was === null || k === was) return
  clearTimeout(settle)
  settle = setTimeout(relook, 800)
})
// The pane it had closed: asked at once for the one it has now.
watch(() => props.target.kind === 'coordinator' && Boolean(coordPane.value) && herdrState.value.ok && !coordShown.value, (lost) => {
  if (lost) { clearTimeout(settle); settle = setTimeout(relook, 800) }
})
watch(() => props.reachable, (r, was) => { if (r && was === false) relook() })
onUnmounted(() => clearTimeout(settle))

const paneId = computed(() => (props.target.kind === 'task' ? taskPane.value : coordShown.value))
// A task's agent that closes while shown: back to its sheet.
const gone = computed(() => props.target.kind === 'task' && Boolean(taskPane.value) && herdrState.value.ok
  && !herdrState.value.panes.some(p => p.id === taskPane.value))
watch(gone, (g) => { if (g) loadTask(true) })

// ------------------------------------------------------------ who it is
// The same name as the Board button that opened it (coordinatorLabel).
const coordSubject = computed(() => (props.target.kind === 'coordinator' ? coordinatorSubject(props.target.to, props.machineLabel) : ''))
const coordName = computed(() => (props.target.kind === 'coordinator' ? coordinatorLabel(props.target.to, props.machineLabel) : ''))
// "The Coordinator", "the devbox coordinator", "the web coordinator", in a sentence.
const coordThe = computed(() => {
  const s = coordSubject.value
  return s ? tl(`The ${s} coordinator`, `Le coordinateur ${s}`) : tl('The Coordinator', 'Le Coordinateur')
})
// Not shown (its conversation is): what the panel says instead.
const coordPhase = computed(() => coordinatorPhase({ pane: coordPane.value, state: coordState.value, error: coordError.value }))
// herdr-projects 1.2.1: status_words.rs COORDINATOR_UNSENT (pump.rs keeps it after exit).
const COORDINATOR_UNSENT = 'your message sits unsent in its box. Go into it and press enter.'
const coordDeliveryFailed = computed(() => coordError.value === COORDINATOR_UNSENT)
const coordFailureTitle = computed(() => coordDeliveryFailed.value
  ? tl('Message could not be sent', 'Envoi du message impossible')
  : tl('Could not start', 'Démarrage impossible'))
const coordQueueNotice = computed(() => {
  const n = coordQueued.value
  if (n === null) return tl('The message queue status is unavailable.', 'L’état de la file de messages est indisponible.')
  if (n === 0) return tl('No message is waiting.', 'Aucun message en attente.')
  return n === 1
    ? tl('1 message still waiting: it goes in once it runs.', '1 message attend toujours : il part dès qu’il tourne.')
    : tl(`${n} messages still waiting: they go in once it runs.`, `${n} messages attendent toujours : ils partent dès qu’il tourne.`)
})
const repo = computed(() => {
  const t = props.target
  if (t.kind === 'task') return props.task?.repo || t.id.split('/')[0] || ''
  return t.to.kind === 'project' ? t.to.repo : ''
})
const taskLabel = computed(() => {
  const t = props.target
  return t.kind === 'task' ? taskKey(t.id, props.task?.repoKey) : ''
})

// ------------------------------------------------------------ a coordinator not started
const first = ref('')
const starting = ref(false)
const sent = ref(false)
const retrying = ref(false)
watch(() => JSON.stringify(props.target), () => {
  gen++
  clearTimeout(poll)
  clearTimeout(settle)
  tries = 0
  first.value = ''
  sent.value = false
  starting.value = false
  retrying.value = false
  coordPane.value = null
  coordLoaded.value = false
  coordState.value = ''
  coordError.value = ''
  coordQueued.value = null
  lookCoordinator(gen)
}, { immediate: true })
async function start() {
  const t = props.target
  const text = first.value.trim()
  if (t.kind !== 'coordinator' || !text || starting.value || !props.reachable) return
  const g = gen
  starting.value = true
  try {
    const r = await api<{ repo?: string }>('/api/tasks/coordinator', { machine: t.machine, text, to: t.to, ...(t.freshProject && launchAgent.value !== '__default' ? { start: { agent: launchAgent.value + (launchModel.value.trim() ? `/${launchModel.value.trim()}` : ''), ...(launchEffort.value !== '__default' ? { effort: launchEffort.value } : {}) } } : {}) })
    haptic()
    // Another coordinator is shown now: its field and its words stay as they are.
    if (g !== gen) return
    first.value = ''
    refreshBoardLinks()
    // A folder the board did not know: added under a name, the coordinator's key from now on.
    if (t.to.kind === 'project' && r.repo && r.repo !== t.to.repo) { emit('changed'); emit('retarget', { kind: 'project', repo: r.repo }); return }
    emit('changed')
    sent.value = true
    // herdr-projects queued the words and cleared any earlier failure.
    coordState.value = 'starting'
    coordError.value = ''
    tries = 0
    lookCoordinator(g)
  } catch (e) {
    toast((e as Error).message, true)
    if (g === gen) lookCoordinator(g)
  }
  finally { if (g === gen) starting.value = false }
}
// Try again, once what stopped it is fixed: started again with the words
// still waiting (`coordinator restart`), nothing typed again.
async function retry() {
  const t = props.target
  if (t.kind !== 'coordinator' || retrying.value || !props.reachable) return
  const g = gen
  retrying.value = true
  try {
    await api('/api/tasks/coordinator', { machine: t.machine, to: t.to, restart: true })
    haptic()
    if (g !== gen) return
    sent.value = true
    coordState.value = 'starting'
    coordError.value = ''
    tries = 0
    lookCoordinator(g)
  } catch (e) { if (g === gen) toast((e as Error).message, true) }
  finally { if (g === gen) retrying.value = false }
}

// Escape closes it on a computer, unless a sheet or a field has it.
function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !desktop.value || e.defaultPrevented) return
  if (document.querySelector('.hw-sheet')) return
  emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))

// Match the navigation divider, with drag direction reversed on the right.
const panelWidth = ref<number | null>(null)
const panelDrag = ref(false)
let stopResize: (() => void) | undefined
onMounted(() => { panelWidth.value = readPanelWidth() })
watch(panelWidth, width => {
  document.documentElement.style.setProperty('--board-panel-w', panelWidthCss(width))
}, { immediate: import.meta.client })
onUnmounted(() => {
  stopResize?.()
  document.documentElement.style.removeProperty('--board-panel-w')
})
function panelNow() { return panelEl.value?.getBoundingClientRect().width || PANEL_MIN }
function setPanelWidth(width: number) {
  const board = document.getElementById('board')
  panelWidth.value = clampPanelWidth(width, window.innerWidth - (board?.getBoundingClientRect().left || 0))
}
function resetPanelWidth() { panelWidth.value = null; savePanelWidth(null) }
function onPanelGrab(e: PointerEvent) {
  if (e.button !== 0) return
  e.preventDefault()
  stopResize?.()
  const handle = e.currentTarget as HTMLElement
  const x0 = e.clientX
  const w0 = panelNow()
  handle.setPointerCapture(e.pointerId)
  panelDrag.value = true
  const move = (event: PointerEvent) => setPanelWidth(w0 + x0 - event.clientX)
  const up = () => {
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', up)
    handle.removeEventListener('pointercancel', up)
    handle.removeEventListener('lostpointercapture', up)
    panelDrag.value = false
    savePanelWidth(panelWidth.value)
    stopResize = undefined
  }
  stopResize = up
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', up)
  handle.addEventListener('pointercancel', up)
  handle.addEventListener('lostpointercapture', up)
}
function onPanelWidthKey(e: KeyboardEvent) {
  if (e.key === 'Home' || e.key === 'Enter') { e.preventDefault(); return resetPanelWidth() }
  const step = e.shiftKey ? 64 : 16
  const delta = e.key === 'ArrowLeft' ? step : e.key === 'ArrowRight' ? -step : 0
  if (!delta) return
  e.preventDefault()
  setPanelWidth(panelNow() + delta)
  savePanelWidth(panelWidth.value)
}

// Keyboard open (iPhone): the panel fits the visible part, as the agent view does.
const style = computed(() => (!desk.value && kbOpen.value ? { height: `${vvHeight.value}px`, top: `${vvTop.value}px` } : {}))
</script>

<template>
  <aside ref="panelEl" class="board-panel" :class="{ desk, expanded: full, resizing: panelDrag }" :style="style" :data-kind="target.kind" :aria-label="tl('Conversation', 'Conversation')">
    <div v-if="desk && !full" class="list-handle panel-handle" :class="{ dragging: panelDrag }"
      role="separator" aria-orientation="vertical" tabindex="0" :aria-label="t('Ticket panel width')"
      :aria-valuenow="panelWidth ?? Math.round(panelNow())" :aria-valuemin="PANEL_MIN" :aria-valuemax="PANEL_MAX"
      :title="t('Drag to resize · double-click: default width')"
      @pointerdown="onPanelGrab" @dblclick="resetPanelWidth" @keydown="onPanelWidthKey" />
    <header class="board-panel-head" :class="activityClass">
      <UButton
        v-if="!desk" icon="i-lucide-chevron-left" color="neutral" variant="ghost" size="lg" class="icon-btn board-panel-back"
        :aria-label="backLabel || tl('Back to the Board', 'Retour au Board')" @click="emit('close')"
      />
      <div class="board-panel-who">
        <p class="board-panel-path">
          <span class="board-panel-machine"><UIcon name="i-lucide-server" />{{ machineLabel }}</span>
          <span v-if="repo" class="board-panel-repo">{{ repo }}</span><span v-if="target.kind === 'task' && identity.agent" :title="agentHint">· {{ identity.agent }}</span>
        </p>
        <p class="board-panel-name">
          <template v-if="target.kind === 'task'">
            <AgentAvatar :agent="identity.agent" :title="agentHint" />
            <TaskKey :value="taskLabel" /><span v-if="details?.title || task?.title || !skeleton" class="board-panel-title" :title="details?.title || task?.title">{{ details?.title || task?.title }}</span><i v-else class="board-panel-title skel-title" aria-hidden="true" /><span v-if="task" class="task-state" :class="task.group">{{ taskGroupLabel(task.group) }}</span>
          </template>
          <template v-else>
            <UIcon name="i-lucide-message-square-text" class="board-panel-coord-icon" />
            <span class="board-panel-title">{{ coordName }}</span>
          </template>
        </p>
        <span v-if="target.kind === 'task' && task?.chat" class="task-chip">{{ tl('Conversation', 'Conversation') }}</span>
        <TaskActivityBadge v-if="target.kind === 'task'" :activity="activity" />
        <TaskAgentMark v-if="target.kind === 'task'" :identity="identity" />
        <p v-if="target.kind === 'coordinator'" class="board-panel-purpose">{{ coordinatorDescription(target.to) }}</p>
      </div>
      <template v-if="target.kind === 'task'">
        <UButton v-if="desk" :icon="full ? 'i-lucide-minimize' : 'i-lucide-maximize'" color="neutral" variant="ghost" class="icon-btn" :aria-label="full ? tl('Exit full screen', 'Quitter le plein écran') : tl('Full screen', 'Plein écran')" @click="full = !full" />
        <UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" class="icon-btn board-panel-sheet" :aria-label="tl('Task details and actions', 'Fiche et actions de la tâche')" @click="emit('sheet')" />
      </template>
      <UButton
        v-if="desk" icon="i-lucide-x" color="neutral" variant="ghost" size="md" class="icon-btn board-panel-close"
        :aria-label="t('Close')" @click="emit('close')"
      />
    </header>

    <div v-if="target.kind === 'coordinator'" class="board-panel-autopilot">
      <CoordinatorAutopilot :key="JSON.stringify(target)" :machine="target.machine" :to="target.to" :disabled="!reachable" />
    </div>
    <nav v-if="target.kind === 'task' && settled" class="board-panel-tabs" :aria-label="tl('Task views', 'Vues de la tâche')">
      <button v-for="tab in navigationTabs" :key="tab" type="button" :class="{ on: tabSelected(tab), 'board-panel-tab-reviewer': tab === 'reviewer', asks: tab === 'reviewer' && rvWait === 'open' }" :aria-pressed="tabSelected(tab)" :aria-label="tabLabel(tab)" :aria-description="tab === 'task' && newNote ? tl('New task details', 'Nouveaux détails de la tâche') : undefined" :title="tab === 'task' || tab === 'settings' ? undefined : tab === 'reviewer' ? reviewerHint : agentHint" @click="tab === 'chat' ? choose(agentChoice ?? agentMode) : choose(tab)">
        {{ tabLabel(tab) }}<i v-if="tab === 'task' && newNote" class="task-new" aria-hidden="true" />
      </button>
    </nav>
    <div v-else-if="target.kind === 'task' && skeleton" class="board-panel-tabs skel-tabs" aria-hidden="true"><i /><i /><i /></div>
    <div v-if="target.kind === 'task' && reviewing && selected === 'chat' && agentMode === 'chat'" class="task-review-context">
      <span>{{ tl(`Agent · ${kindLabel(identity.agent)}’s conversation. The review runs separately.`, `Agent · conversation de ${kindLabel(identity.agent)}. La relecture tourne séparément.`) }}</span>
      <button v-if="reviewerAgent && !offlineView" type="button" @click="reviewerChoice = 'term'; choose('reviewer')">{{ tl('Open reviewer terminal', 'Ouvrir le terminal du relecteur') }}</button>
      <button v-else-if="reviewerSession && !offlineView" type="button" @click="showReviewerSession">{{ tl('Switch to the reviewer session', 'Passer à la session du relecteur') }}</button>
    </div>
    <section v-if="target.kind === 'task' && (needs || stuck)" class="task-needs" :class="{ 'task-needs-wait': waitKind }" :data-kind="waitKind || undefined" role="alert">
      <div v-if="waitKind" class="task-needs-line" :class="{ open: waitOpen }">
        <span class="task-needs-type">{{ blockKindLabel(waitKind) }}</span>
        <h3 ref="waitEl" class="task-needs-text" :title="waitOpen ? undefined : waitText"><LinkedText :text="waitText" /></h3>
        <button v-if="waitCut || waitOpen" type="button" class="task-needs-more" :aria-expanded="waitOpen" :aria-label="waitOpen ? tl('Show less', 'Réduire') : tl('Show all', 'Tout afficher')" @click="waitOpen = !waitOpen">
          <UIcon :name="waitOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" />
        </button>
        <button v-if="canSee" type="button" class="task-needs-see" @click="seeQuestion">{{ tl('See ↓', 'Voir ↓') }}</button>
      </div>
      <template v-else>
        <h3 v-if="needs">{{ tl('Needs you', 'À toi') }} · <LinkedText :text="failureTitle" /></h3>
        <h3 v-else>{{ tl('Finishing', 'Fin en cours') }} · {{ tl('its agent is at rest', 'son agent est au repos') }}</h3>
        <pre v-if="failureDetail"><LinkedText :text="failureDetail" /></pre>
        <p v-if="failureNow?.failureNext"><LinkedText :text="failureNow.failureNext" /></p>
        <p v-if="rvWords" class="task-needs-reviewer" :data-wait="rvWait">{{ rvWords }}</p>
      </template>
      <div v-if="reviewBrief?.list.length" class="task-needs-findings">
        <span class="task-needs-findings-head">{{ tl('Review findings', 'Remarques de relecture') }}</span>
        <ul>
          <li v-for="(f, i) in reviewBrief.list" :key="i" :data-severity="f.severity || undefined">
            <span class="task-needs-severity">{{ severityLabel(f.severity) }}</span><span class="task-needs-subject">{{ f.title }}</span>
          </li>
        </ul>
        <button v-if="reviewBrief.more" type="button" class="task-needs-findings-more" @click="choose('task')">{{ tl(`+${reviewBrief.more} more in Task`, `+${reviewBrief.more} de plus dans Tâche`) }}</button>
      </div>
      <p v-if="canFinish && finishKind" class="task-finish-why">{{ finishKind === 'limit' ? limitHint(limitStop) : finishHint(finishKind) }}</p>
      <div class="task-needs-actions">
        <UButton v-if="choosingAttempt && selected !== 'task'" @click="choose('task')">{{ tl('Choose an attempt', 'Choisis un essai') }}</UButton>
        <UButton v-if="canSendReview" class="task-needs-review" color="primary" icon="i-lucide-undo-2" :disabled="disabled" @click="taskAction('review')">{{ tl('Send the review back to the agent', 'Renvoyer les remarques à l’agent') }}</UButton>
        <UButton v-if="taskPermissions?.retry" :disabled="disabled" @click="taskAction('retry')">{{ finishKind === 'limit' ? tl('Continue', 'Continuer') : tl('Retry', 'Réessayer') }}</UButton>
        <UButton v-if="finishKind === 'limit'" :disabled="disabled" @click="openWorkLimit">{{ tl('Raise limit', 'Relever la limite') }}</UButton>
        <UButton v-if="canFinish" class="task-finish" :title="finishTitle(task?.chat)" :aria-description="finishTitle(task?.chat)" :disabled="disabled" @click="taskAction('finish')">{{ finishKind === 'limit' && !task?.chat ? tl('Take as is', 'Prendre tel quel') : finishLabel(task?.chat) }}</UButton>
        <UButton v-if="canFix" :disabled="disabled" @click="taskAction('fix')">{{ tl('Send the error to the agent', 'Envoyer l’erreur à l’agent') }}</UButton>
        <UButton v-if="taskPermissions?.delegate" :disabled="disabled" @click="taskAction('delegate')">{{ tl('Start again', 'Relancer') }}</UButton>
        <template v-if="permissionTaps">
          <UButton class="task-needs-allow" color="primary" :disabled="tapOff" @click="tell(permissionReply('allow'))">{{ tl('Allow', 'Autoriser') }}</UButton>
          <UButton v-if="always" class="task-needs-always" :disabled="tapOff" @click="tell(permissionReply('always'))">{{ tl('Always allow', 'Toujours autoriser') }}</UButton>
          <UButton class="task-needs-refuse" :disabled="tapOff" @click="tell(permissionReply('refuse'))">{{ tl('Refuse', 'Refuser') }}</UButton>
        </template>
        <UButton v-for="c in choices" :key="c.reply" class="task-needs-choice" :title="c.label" :disabled="tapOff" @click="tell(c.reply)">{{ c.label }}</UButton>
        <UButton v-if="answerable && !choices.length && !permissionTaps" class="task-needs-reply" icon="i-lucide-corner-down-left" :disabled="offlineView" @click="replyHere">{{ tl('Reply…', 'Répondre…') }}</UButton>
        <template v-if="reviewerAsks">
          <UButton v-if="(rvWait === 'open' || rvWait === 'quiet') && selected !== 'reviewer'" class="task-needs-reviewer-open" :color="rvWait === 'open' ? 'primary' : undefined" :disabled="offlineView" @click="choose('reviewer')">{{ tl('Open the reviewer', 'Ouvrir le relecteur') }}</UButton>
          <UButton v-else-if="rvWait === 'hidden' && reviewerSession" class="task-needs-reviewer-session" color="primary" :loading="switching" :disabled="offlineView" @click="showReviewerSession">{{ tl('Switch to that session', 'Passer à cette session') }}</UButton>
          <UButton v-else-if="(rvWait === 'gone' || rvWait === 'away') && selected !== 'task'" class="task-needs-task" @click="choose('task')">{{ tl('Task actions', 'Actions de la tâche') }}</UButton>
        </template>
        <template v-else-if="!answerable">
          <UButton v-if="jump === 'term' && (!waitKind || waitKind === 'auth')" class="task-needs-term" :disabled="offlineView || !reachable" @click="choose('term')">{{ tl('Open terminal', 'Ouvrir le terminal') }}</UButton>
          <UButton v-else-if="jump === 'chat' && waitKind !== 'auth'" class="task-needs-chat" @click="choose('chat')">{{ tl('Answer in the conversation', 'Répondre dans la conversation') }}</UButton>
        </template>
        <UButton v-if="canAnyway" class="task-needs-anyway" :color="canSendReview ? 'neutral' : undefined" :variant="canSendReview ? 'outline' : undefined" :disabled="disabled" @click="taskAction('anyway')">{{ tl('Approve anyway', 'Approuver quand même') }}</UButton>
        <UButton v-else-if="taskPermissions?.approve" :disabled="disabled" @click="taskAction('approve')">{{ tl('Approve', 'Approuver') }}</UButton>
      </div>
      <p v-if="!reachable">{{ tl('Machine unavailable', 'Machine indisponible') }}</p>
      <p v-if="actionError" class="error">{{ actionError }}</p>
    </section>

    <CoordinatorScheduled v-if="target.kind === 'coordinator'" :machine="target.machine" :target="target.to" :refresh-key="(refreshKey ?? 0) + autopilotActions" />

    <div class="board-panel-body">
      <p v-if="target.kind === 'task' && settled && failed && selected === 'task'" class="board-note error">{{ failed }}</p>
      <TaskSettings v-if="target.kind === 'task' && settled" v-show="selected === 'settings'" :machine="target.machine" :id="target.id" :active="selected === 'settings'" :reachable="reachable" />
      <TaskSheet :limit-request="limitRequest" v-if="target.kind === 'task' && settled && selected === 'task'" v-model:open="taskOpen" embedded :task="task" :machine="target.machine" :reachable="reachable" :refresh="refreshTask" @chat="choose('chat')" @coordinator="(machine, task) => emit('coordinator', machine, task)" @archived="archivedTask" @restored="restoredTask" />
      <template v-else-if="selected === 'settings'" />
      <template v-else-if="target.kind === 'task' && selected === 'reviewer' && reviewerPane">
        <div class="board-panel-reviewer-bar">
          <span class="board-panel-reviewer-who">{{ tl('Reviewer', 'Relecteur') }}<template v-if="reviewerAgent"> · {{ statusLabel(reviewerAgent) }}</template></span>
          <button v-if="reviewerAgent && hasChat(reviewerAgent)" type="button" class="board-panel-reviewer-mode" @click="reviewerChoice = reviewerMode === 'chat' ? 'term' : 'chat'">{{ reviewerMode === 'chat' ? t('Terminal') : t('Conversation') }}</button>
        </div>
        <AgentView :key="`reviewer-${reviewerPane}`" :pane-id="reviewerPane" cell active embedded :selected-mode="reviewerMode" @update:selected-mode="reviewerChoice = $event" />
      </template>
      <template v-else-if="target.kind === 'task' && paneId && (selected === 'term' || conversation || !agentPane || !hasChat(agentPane))">
        <div class="board-panel-reviewer-bar board-panel-agent-bar">
          <span class="board-panel-reviewer-who">{{ t('Agent') }}<template v-if="agentPane"> · {{ kindLabel(agentPane.agent) }} · {{ statusLabel(agentPane) }}</template></span>
          <button v-if="agentPane && hasChat(agentPane)" type="button" class="board-panel-reviewer-mode" @click="chooseAgentMode(agentMode === 'chat' ? 'term' : 'chat')">{{ agentMode === 'chat' ? t('Terminal') : t('Conversation') }}</button>
        </div>
        <AgentView :key="paneId" :pane-id="paneId" cell active embedded :selected-mode="agentMode" @update:selected-mode="chooseAgentMode" />
      </template>
      <AgentView v-else-if="paneId && target.kind === 'coordinator'" :key="paneId" :pane-id="paneId" cell active />
      <div v-else-if="target.kind === 'task' && loading" class="chat-list skeleton board-panel-skel" role="status" :aria-label="t('Loading…')">
        <ChatSkeleton v-if="skeleton" :agent="identity.agent" />
      </div>
      <p v-else-if="failed" class="board-note error board-panel-wait">{{ failed }}</p>
      <div v-else-if="target.kind === 'task'" class="board-panel-start task-setup">
        <h3>{{ details?.failureStage === 'setup' || details?.failureStage === 'start' ? tl('Setup output', 'Sortie du démarrage') : tl('No agent conversation yet', 'Pas encore de conversation avec l’agent') }}</h3>
        <pre v-if="failureDetail && !needs">{{ failureDetail }}</pre>
        <p>{{ tl('The terminal stays available when the task has a pane. Task details and actions are in the Task tab.', 'Le terminal reste accessible quand la tâche a un pane. Les détails et actions sont dans l’onglet Tâche.') }}</p>
        <form v-if="tellOnly" class="board-panel-first board-panel-tell" @submit.prevent="tell()">
          <label for="board-panel-tell">{{ toReviewer
            ? tl('The reviewer is waiting for an answer: herdr-projects passes your reply on to it.', 'Le relecteur attend une réponse : herdr-projects lui transmet ta réponse.')
            : task?.stage === 'plan'
            ? tl('Its agent is not running now: your words send the plan back, through herdr-projects.', 'Son agent ne tourne pas en ce moment : tes mots renvoient le plan, par herdr-projects.')
            : tl('Its agent is not running now: herdr-projects passes your reply on.', 'Son agent ne tourne pas en ce moment : herdr-projects lui transmet ta réponse.') }}</label>
          <p v-if="!reachable" class="board-panel-away" role="status">
            {{ tl(`${machineLabel} cannot be reached now.`, `${machineLabel} est injoignable pour l’instant.`) }}
          </p>
          <UTextarea id="board-panel-tell" v-model="reply" :rows="3" autoresize :maxlength="TELL_MAX" :placeholder="tl('Message', 'Message')" :disabled="offlineView" />
          <UButton type="submit" color="primary" icon="i-lucide-send" :loading="telling" :disabled="!reply.trim() || offlineView || !reachable">{{ t('Send') }}</UButton>
        </form>
      </div>
      <p v-else-if="target.kind === 'coordinator' && !coordLoaded" class="board-empty board-panel-wait">{{ t('Loading…') }}</p>
      <div v-else-if="target.kind === 'coordinator'" class="board-panel-start">
        <section v-if="coordPhase === 'failed'" class="board-panel-failed" role="alert" :aria-label="coordFailureTitle">
          <h4><UIcon name="i-lucide-octagon-alert" />{{ coordFailureTitle }}</h4>
          <p class="board-panel-failed-what">{{ coordDeliveryFailed
            ? tl(`The message was not sent to ${coordName} on ${machineLabel}.`, `Le message destiné à ${coordName} n’a pas été envoyé sur ${machineLabel}.`)
            : tl(`${coordThe} could not start on ${machineLabel}.`, `${coordThe} n’a pas pu démarrer sur ${machineLabel}.`) }}</p>
          <p class="board-panel-failed-why">{{ coordError }}</p>
          <p class="board-panel-failed-next">{{ tl('Fix this on the machine, then try again.', 'Corrige cela sur la machine, puis réessaie.') }} {{ coordQueueNotice }}</p>
          <p v-if="!reachable" class="board-panel-away" role="status">
            {{ tl(`${machineLabel} cannot be reached now.`, `${machineLabel} est injoignable pour l’instant.`) }}
          </p>
          <UButton color="neutral" variant="outline" icon="i-lucide-rotate-cw" :loading="retrying" :disabled="offlineView || !reachable" @click="retry">{{ t('Try again') }}</UButton>
        </section>
        <p v-else-if="coordPhase === 'live'" class="board-empty">{{ t('Loading…') }}</p>
        <p v-else-if="coordPhase === 'starting'" class="board-empty board-panel-starting" role="status">
          {{ sent ? tl(`Sent. ${coordThe} is starting: its conversation opens here.`, `Envoyé. ${coordThe} démarre : sa conversation s’ouvre ici.`) : tl(`${coordThe} is starting: its conversation opens here.`, `${coordThe} démarre : sa conversation s’ouvre ici.`) }}
        </p>
        <form v-else class="board-panel-first" @submit.prevent="start">
          <label for="board-panel-first">{{ tl('Not started yet: your first message starts it.', 'Pas encore démarré : ton premier message le lance.') }}</label>
          <p v-if="!reachable" class="board-panel-away" role="status">
            {{ tl(`${machineLabel} cannot be reached now: your message waits for it here.`, `${machineLabel} est injoignable pour l’instant : ton message l’attend ici.`) }}
          </p>
          <template v-if="target.freshProject && coordState === 'none'">
            <label for="coordinator-agent">{{ t('Agent') }}</label>
            <USelect id="coordinator-agent" v-model="launchAgent" :items="launchChoices" :disabled="starting" />
            <template v-if="launchAgent !== '__default'">
              <label for="coordinator-model">{{ t('Model') }} {{ t('(optional)') }}</label>
              <UInput id="coordinator-model" v-model="launchModel" :disabled="starting" autocapitalize="none" autocorrect="off" :spellcheck="false" />
              <label for="coordinator-effort">{{ t('Effort') }}</label>
              <USelect id="coordinator-effort" v-model="launchEffort" :items="effortChoices" :disabled="starting" />
            </template>
          </template>
          <UTextarea id="board-panel-first" v-model="first" :rows="3" autoresize :maxlength="TELL_MAX" :placeholder="tl('Message', 'Message')" :disabled="offlineView" />
          <UButton type="submit" color="primary" icon="i-lucide-send" :loading="starting" :disabled="!first.trim() || offlineView || !reachable">{{ t('Send') }}</UButton>
        </form>
      </div>
    </div>
  </aside>
</template>
