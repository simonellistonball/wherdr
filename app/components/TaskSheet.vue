<script setup lang="ts">
// One herdr-projects task (the Board): what it is, where it stands, its pull
// request and review, and what can be done from here, as 1.x does it: approve
// it (merge, or yes to a plan: asked first, it cannot be undone), start it (a
// task of the backlog), stop its agent (asked first), retry what went wrong,
// finish it as it is (asked first: it goes on to checks and review), archive
// it. What 1.x does not give for a task is not shown.
// Start names the agent the task starts with by default (its worker.agent, and
// where that comes from) and offers the other agents installed on its machine
// that Settings › Agents offers (the default is shown even when unchecked):
// a pick is for this start only (`delegate --worker.agent`), the defaults stay.
// After the program, a model and an effort it takes (ModelPicker, `launch`):
// none picked, the program alone; never one picked for the user.
// No message field here: "Open the chat" closes the sheet and opens the task's
// agent in the Board's side panel (`chat`), where replying happens (with no
// pane for its agent, the panel's field sends the reply through herdr-projects).
// After an action (Approve included) the sheet shows where the task now
// stands: the Board and the task's details are read again before its buttons
// come back, or the error stays in the sheet. Archive closes it: the Board
// offers Restore for a few seconds. An archived task (Board › Archived, a link to it) is read-only, as
// in 1.x: an "Archived" tag and Restore, nothing else.
// With every slot of its board taken (`board.agents` tasks at work), Start says
// Queue and the place the task would get: the same `delegate`, which queues it.
// "Start after…" picks tasks to wait for, on any machine the Board reads
// (`delegate --after`); a task that waits says for what, with "Stop waiting"
// (`after --clear`), and one in the queue says its place.
import { canPickAttempt, AFTER_MAX, TASK_QUESTION_MAX, NO_ACTIONS, type StartOptions, type TaskCommand, type TaskDetails, type TaskRow, type TasksReply, finishCase, prNumber, startPlace, taskActions, taskKey } from '#shared/projectsTasks'
import { taskActivity } from '#shared/taskActivity'
import AppSheet from './AppSheet.vue'
import ModelPicker from './ModelPicker.vue'
import { type StartAgentChoice, startAgentChoices } from '~/utils/agentChoices'
import { finishHint, finishLabel, finishQuestion, finishTitle, finishOffered } from '~/utils/taskFinish'
import { type WaitChoice, queuePlaceText, typedRef, waitChoices, waitName } from '~/utils/taskWait'
import { type LimitPreset, formatLimit, limitStopOf, raisePresets } from '#shared/taskLimits'
import { sawTasksBoard, seenTasksBoard } from '~/composables/useTasksBoard'

// `refresh`: reads the Board again (its promise ends with the read); without
// it, `changed` asks for that. `archived` / `restored`: the task was put away
// or brought back from here.
// `chat`: open this task's agent in the side panel (the sheet has closed).
const props = withDefaults(defineProps<{ task: TaskRow | null, machine: string, refresh?: () => Promise<unknown>, embedded?: boolean, reachable?: boolean, limitRequest?: number }>(), { reachable: true })
const emit = defineEmits<{ changed: [], archived: [machine: string, task: TaskRow], restored: [machine: string, task: TaskRow], chat: [machine: string, task: TaskRow], coordinator: [machine: string, task: TaskRow] }>()
const open = defineModel<boolean>('open', { default: false })

const details = ref<(TaskDetails & { pane: string | null }) | null>(null)
const editingDescription = ref(false)
const descriptionDraft = ref('')
const descriptionError = ref('')
const descriptionUnavailable = computed(() => busy.value || offlineView.value || props.reachable === false || archived.value || loading.value || !!error.value || !details.value)
function editDescription() {
  if (descriptionUnavailable.value) return
  descriptionDraft.value = details.value?.description ?? ''
  descriptionError.value = ''
  editingDescription.value = true
}
async function saveDescription() {
  const task = props.task
  if (!task || !editingDescription.value || descriptionUnavailable.value) return
  const g = gen
  const text = descriptionDraft.value
  busy.value = true
  descriptionError.value = ''
  try {
    await api('/api/tasks/describe', { machine: props.machine, id: task.id, text })
    if (g !== gen) return
    editingDescription.value = false
    // Read the stored value: describe removes carriage returns and trims its edges.
    await settle(g)
  } catch (e) { if (g === gen) descriptionError.value = (e as Error).message }
  finally { if (g === gen) busy.value = false }
}
const question = ref('')
const asking = ref(false)
const error = ref('')
const loading = ref(false)
const busy = ref(false)
const running = ref<TaskCommand | null>(null)
// Why the last action failed, kept in the sheet (a toast goes away).
const actionError = ref('')
// A failed task's Retry or Start waits for its details (what failed).
const failure = computed(() => (details.value && details.value.id === props.task?.id ? details.value : null))
// Archived: as its details (its file) or its row say, until Restore from here.
const restored = ref(false)
const archived = computed(() => Boolean(failure.value?.archived) || (Boolean(props.task?.archived) && !restored.value))
const row = computed(() => (props.task ? { ...props.task, archived: archived.value, chat: failure.value?.chat ?? props.task.chat } : null))
// Finish on a row stuck at "Finishing": not while its agent is still at work (1.x refuses).
const paneStatus = computed(() => herdrState.value.panes.find(p => p.id === failure.value?.pane)?.status ?? null)
const withFinish = (a: ReturnType<typeof taskActions>) => ({ ...a, finish: a.finish && Boolean(row.value) && finishOffered(row.value!, paneStatus.value) })
const actions = computed(() => (row.value ? withFinish(taskActions(row.value, failure.value)) : NO_ACTIONS))
const finishWhy = computed(() => { const c = row.value ? finishCase(row.value) : null; return c ? finishHint(c) : '' })
const limitStopped = computed(() => row.value?.stage === 'stopped' && row.value?.state === 'blocked' && !archived.value)
const limitOpen = ref(false)
const limitName = computed(() => failure.value?.limits?.stopped ? `limit.${failure.value.limits.stopped}` : null)
const limitNotice = ref('')
const limitValue = ref('')
const resuming = ref(false)
watch(limitName, () => { limitValue.value = ''; limitNotice.value = '' })
function openLimit() {
  limitNotice.value = ''
  limitValue.value = ''
  limitOpen.value = true
}
// One tap per preset (+1 h / ×2 / none for time, ×2 / +10 M / none for tokens):
// the same `set` as a typed value. A preset not above what was already used
// is offered disabled, since herdr-projects would not resume.
const limitStop = computed(() => (limitStopped.value ? limitStopOf(failure.value?.limits, row.value?.msg) : null))
const limitPresets = computed(() => {
  const s = limitStop.value
  return s && limitName.value === `limit.${s.kind}` ? raisePresets(s.kind, s.limit, s.used) : []
})
function presetLabel(p: LimitPreset): string {
  switch (p.id) {
    case 'plus1h': return '+1 h'
    case 'plus10m': return '+10 M'
    case 'double': return '×2'
    default: return tl('No limit', 'Sans limite')
  }
}
const presetTo = (p: LimitPreset) => (p.value === 'none' || !limitStop.value ? '' : formatLimit(limitStop.value.kind, p.value, language))
function applyPreset(p: LimitPreset) {
  if (!p.resumes) return
  limitValue.value = p.value
  void raiseLimit()
}
async function raiseLimit() {
  const task = props.task
  if (!task || busy.value || offlineView.value || props.reachable === false || !limitStopped.value || !limitName.value || !limitValue.value.trim()) return
  const g = gen
  const machine = props.machine
  busy.value = true
  resuming.value = true
  limitNotice.value = ''
  actionError.value = ''
  try {
    await api('/api/tasks/limit', { machine, id: task.id, name: limitName.value, value: limitValue.value.trim() })
    await settle(g)
    if (g === gen) {
      if (!error.value && failure.value?.stage && failure.value.stage !== 'stopped') limitOpen.value = false
      else limitNotice.value = tl('Limit saved. Resumption is not confirmed yet. It can take a few seconds; if the task stays stopped, choose a ceiling above its usage.', 'Plafond enregistré. La reprise n’est pas encore confirmée. Elle peut prendre quelques secondes ; si la tâche reste arrêtée, choisis un plafond supérieur à sa consommation.')
    }
  } catch (e) { failed(e, g) }
  finally { if (g === gen) { busy.value = false; resuming.value = false } }
}
const pr = computed(() => details.value?.pr || props.task?.pr || '')
const review = computed(() => details.value?.review || props.task?.review || null)
// Working: an agent running, or the board waiting for CI or for its turn.
const activity = computed(() => (props.task ? taskActivity(props.task) : null))
const label = computed(() => (props.task ? taskKey(props.task.id, props.task.repoKey) : ''))
// A beads issue (shared/beadsTasks.ts): Archive closes it, Restore reopens it,
// and Start opens an agent on it without waiting for other tasks.
const beads = computed(() => props.task?.backend === 'beads')
// Offered when it has an agent to talk to (its pane, as its details name it),
// or one herdr-projects takes a reply for (`tell`), pane or not.
const chatShown = computed(() => !archived.value && (Boolean(failure.value?.pane) || actions.value.tell))

// Start: the task's default agent and the installed ones (`/api/tasks/start`),
// read when the sheet offers Start. `pick`: another agent for this start; null
// is the default, which sends no agent at all (Start exactly as before).
const startOpts = ref<StartOptions | null>(null)
const startLoading = ref(false)
const pick = ref<string | null>(null)
const defaultKind = computed(() => startOpts.value?.agent?.kind || '')
// The default, then the other installed agents that Settings › Agents offers
// (an unchecked default is still shown, marked: it is what Start runs).
const startAgents = computed(() => (startOpts.value ? startAgentChoices(startOpts.value, hiddenAgents.value, tl('default', 'par défaut')) : []))
const defaultUsable = computed(() => startAgents.value[0]?.usable ?? true)
// A pick no longer offered (unchecked meanwhile) falls back to the default.
const startAgent = computed(() => (pick.value && startAgents.value.some(a => !a.isDefault && a.id === pick.value) ? pick.value : null))
// The default is not installed there: Start waits for another agent.
const needsPick = computed(() => !defaultUsable.value && !startAgent.value)
// The model and effort for this start (none: the program's own).
const startModel = ref<string | null>(null)
const startEffort = ref<string | null>(null)
const startProgram = computed(() => startAgent.value || (defaultUsable.value ? defaultKind.value : ''))
// What Start sends: the program, with the model when one is picked.
const startName = computed(() => (startModel.value && startProgram.value ? `${startProgram.value}/${startModel.value}` : startAgent.value))
const checked = (a: StartAgentChoice) => (a.isDefault ? a.usable && !startAgent.value : a.id === startAgent.value)
// The default's tag: not installed there, or unchecked in Settings › Agents.
function defaultTag(a: StartAgentChoice) {
  if (!a.usable) return tl('default · not installed', 'défaut · pas installé')
  return a.hidden ? tl('default · hidden in Settings', 'défaut · masqué dans les réglages') : tl('default', 'défaut')
}
// Where the default comes from, in the user's words (1.x's own as a fallback).
function agentSource(): string {
  const a = startOpts.value?.agent
  if (!a) return ''
  const repo = props.task?.repo || ''
  switch (a.place) {
    case 'task': return tl('Default set on this task', 'Défaut réglé sur cette tâche')
    case 'repo': return tl(`Default from your settings for ${repo}`, `Défaut de tes réglages pour ${repo}`)
    case 'you': return tl('Default from your settings', 'Défaut de tes réglages')
    case 'builtin': return beads.value ? tl('wherdr’s default') : tl('herdr-projects’ built-in default', 'Défaut intégré de herdr-projects')
    default: return tl(`Default: ${a.from}`, `Défaut : ${a.from}`)
  }
}
let startSeq = 0
async function loadStart() {
  const t = props.task
  if (!t) return
  const id = ++startSeq
  startLoading.value = true
  try {
    const o = await api<StartOptions>(`/api/tasks/start?machine=${encodeURIComponent(props.machine)}&id=${encodeURIComponent(t.id)}`)
    if (id === startSeq) startOpts.value = o
  } catch {
    // Start still works with the task's default: only the choice is missing.
    if (id === startSeq) startOpts.value = null
  } finally {
    if (id === startSeq) startLoading.value = false
  }
}

// Queue: no slot free on the task's board, so Start puts it in the queue, at this place.
const place = computed(() => startPlace(startOpts.value?.slots))
function startLabel(): string {
  const a = startName.value
  if (place.value) return a ? tl(`Queue with ${a}`, `Mettre en file avec ${a}`) : tl('Queue', 'Mettre en file')
  return a ? tl(`Start with ${a}`, `Lancer avec ${a}`) : tl('Start', 'Lancer')
}
const placeLine = computed(() => {
  const s = startOpts.value?.slots
  if (!place.value || !s) return ''
  return `${queuePlaceText(place.value)} · ${tl(`all ${s.max} slots are taken`, s.max === 1 ? 'la seule place est prise' : `les ${s.max} places sont prises`)}`
})
// Where a task already started stands: its place in the queue, or what it
// waits for (a task not delegated yet: what it is to wait for, once it is).
const queued = computed(() => (props.task?.stage === 'queued' && !archived.value ? props.task.queue ?? failure.value?.queue ?? 0 : null))
const wait = computed(() => {
  const w = failure.value?.after
  return w && !archived.value && (w.waiting || props.task?.stage === 'todo' || props.task?.stage === 'after') ? w : null
})
const labelOf = (key: string) => (key ? machineInfo(key)?.label || key : hostLabel.value)
const boards = computed(() => seenTasksBoard.value?.machines ?? [])
const nameOf = (id: string) => waitName(id, props.machine, boards.value, labelOf)
const canClear = computed(() => Boolean(wait.value))

// "Start after…": the picker, in the sheet (no sheet over the sheet on a phone).
const picking = ref(false)
const query = ref('')
const chosen = ref<WaitChoice[]>([])
const boardLoading = ref(false)
const choices = computed(() => (picking.value && props.task
  ? waitChoices(boards.value, props.machine, props.task.id, labelOf, query.value).filter(c => !chosen.value.some(x => x.ref === c.ref))
  : []))
// What was typed, as the board reads it, when the list has no such task.
const typed = computed(() => { const r = typedRef(query.value); return r && !chosen.value.some(x => x.ref === r) && !choices.value.some(c => c.ref.toLowerCase() === r.toLowerCase()) ? r : null })
let boardSeq = 0
async function openPicker() {
  picking.value = true
  query.value = ''
  chosen.value = []
  const id = ++boardSeq
  boardLoading.value = !seenTasksBoard.value
  try {
    // Every machine's tasks, as the Board reads them (its last read reused when fresh).
    const r = await api<TasksReply>('/api/tasks')
    if (!('same' in r)) sawTasksBoard(r)
  } catch { /* the last board read, or typed ids */ }
  finally { if (id === boardSeq) boardLoading.value = false }
}
function closePicker() { picking.value = false; query.value = ''; chosen.value = [] }
function choose(c: WaitChoice) { if (chosen.value.length < AFTER_MAX) chosen.value = [...chosen.value, c]; query.value = '' }
function chooseTyped() {
  const r = typed.value
  if (r) choose({ ref: r, id: r, machine: '', title: '', group: 'todo' })
}
function unchoose(ref: string) { chosen.value = chosen.value.filter(c => c.ref !== ref) }

let seq = 0
async function load() {
  const t = props.task
  if (!t) return
  const id = ++seq
  loading.value = true
  error.value = ''
  try {
    const d = await api<TaskDetails & { pane: string | null }>(`/api/tasks/details?machine=${encodeURIComponent(props.machine)}&id=${encodeURIComponent(t.id)}`)
    if (id === seq) details.value = d
  } catch (e) {
    if (id === seq) error.value = (e as Error).message
  } finally {
    if (id === seq) loading.value = false
  }
}
// By the task itself, its machine and its id: each read of the Board gives a
// new row, which must not empty the sheet back to "Loading…" under the user's
// finger; the same id on another machine is another task, whose sheet starts
// empty (no details, no words written for the other one).
const target = () => `${props.machine}|${props.task?.id ?? ''}`
// The sheet's generation: a new one each time it shows another task, closes or
// opens again. What a request finishes for an older one (close
// the sheet, end "busy") is not done to the sheet now shown.
let gen = 0
watch([open, target], ([o]) => {
  gen++
  editingDescription.value = false
  descriptionDraft.value = ''
  descriptionError.value = ''
  limitOpen.value = false
  limitValue.value = ''
  limitNotice.value = ''
  resuming.value = false
  busy.value = false
  running.value = null
  actionError.value = ''
  restored.value = false
  pick.value = null
  startModel.value = null
  startEffort.value = null
  closePicker()
  question.value = ''
  asking.value = false
  startOpts.value = null
  startLoading.value = false
  startSeq++
  if (!o) return
  details.value = null
  load()
}, { immediate: true })
watch(() => props.limitRequest, () => { if (limitStopped.value) openLimit() })
// Asked once per sheet, when it offers Start (a failed task may offer it only
// once its details say what failed).
// Watched after the reset above, so another task's sheet asks again.
watch(() => `${open.value && actions.value.delegate}|${target()}`, () => {
  if (open.value && actions.value.delegate && !startOpts.value && !startLoading.value) loadStart()
}, { immediate: true })
// The same task moving on (working → failed, …): its details are read again,
// so what it now allows (Retry after a failure) shows without reopening. Kept
// on screen meanwhile; only a real change of stage or state reads again.
const step = () => `${props.task?.stage ?? ''}|${props.task?.state ?? ''}`
watch([target, step], ([t, s], [wasT, wasS]) => {
  if (open.value && t === wasT && s !== wasS) load()
})

// After an action: the Board, then the task's details, read again, so the
// sheet shows what the task now allows before its buttons come back.
async function settle(g: number) {
  if (props.refresh) await props.refresh().catch(() => {})
  else emit('changed')
  if (g === gen && open.value) await load()
}
function failed(e: unknown, g: number) {
  const msg = (e as Error).message
  toast(msg, true)
  if (g === gen) actionError.value = msg
}

// Still the task the user was asked about (a push or a card may have shown
// another meanwhile): nothing is sent for it otherwise.
const still = (was: string) => open.value && target() === was

async function approve() {
  const t = props.task
  if (!t || busy.value) return
  const was = target()
  const machine = props.machine
  const plan = t.stage === 'plan'
  const ok = await askConfirm(plan
    ? tl(`Say yes to the plan of “${t.title}”? Its agent starts building.`, `Accepter le plan de « ${t.title} » ? Son agent commence à construire.`)
    : tl(`Approve “${t.title}”? herdr-projects merges its work. This cannot be undone.`, `Approuver « ${t.title} » ? herdr-projects fusionne son travail. C’est irréversible.`),
  plan ? tl('Approve plan', 'Accepter le plan') : tl('Approve and merge', 'Approuver et fusionner'), 'primary')
  if (!ok || !still(was)) return
  const g = gen
  busy.value = true
  actionError.value = ''
  try {
    const r = await api<{ msg: string }>('/api/tasks/approve', { machine, id: t.id })
    toast(r.msg || tl('Approved', 'Approuvé'))
    // The sheet stays: it shows where the task now stands (merging, building the plan…).
    await settle(g)
  } catch (e) { failed(e, g) }
  finally { if (g === gen) busy.value = false }
}

const attemptUnavailable = () => offlineView.value || props.reachable === false

// The human names a letter and explicitly accepts closing every other attempt.
async function keepAttempt(letter: string) {
  const task = props.task
  if (!task || busy.value || attemptUnavailable() || loading.value || error.value || !canPickAttempt(failure.value, letter)) return
  const was = target()
  const g = gen
  const machine = props.machine
  busy.value = true
  actionError.value = ''
  try {
    const ok = await askConfirm(
      tl(`Keep attempt ${letter} for “${task.title}”? The other attempts’ tabs close.`, `Garder l’essai ${letter} pour « ${task.title} » ? Les onglets des autres essais se ferment.`),
      tl(`Keep ${letter} and close the others`, `Garder ${letter} et fermer les autres`), 'primary')
    if (!ok || g !== gen || !still(was) || attemptUnavailable() || !canPickAttempt(failure.value, letter)) return
    const r = await api<{ msg: string }>('/api/tasks/pick', { machine, id: task.id, letter, confirmed: true })
    toast(r.msg)
    await settle(g)
  } catch (e) { failed(e, g) }
  finally { if (g === gen) busy.value = false }
}

// Start, stop, retry, archive, restore: the task's id only. Stopping is asked
// first (the agent's turn is cut short); archiving is undone by Restore, which
// the Board offers right after it.
const ACTION_DONE: Record<Exclude<TaskCommand, 'archive'>, () => string> = {
  delegate: () => tl('Started: an agent is on it', 'Lancée : un agent s’en occupe'),
  stop: () => tl('Stopped', 'Arrêtée'),
  fix: () => tl('Sent to the agent to fix', 'Envoyée à l’agent pour correction'),
  retry: () => tl('Sent back to its agent', 'Renvoyée à son agent'),
  review: () => tl('Review sent back to the agent', 'Remarques renvoyées à l’agent'),
  finish: () => tl('Taken as it is: checks, then review', 'Prise telle quelle : vérifications puis relecture'),
  restore: () => tl('Restored', 'Restaurée'),
}
async function act(action: TaskCommand, after?: string[]) {
  const t = props.task
  if (!t || busy.value) return
  if (action === 'delegate' && needsPick.value) return
  const was = target()
  const machine = props.machine
  if (action === 'stop' && !await askConfirm(
    tl(`Stop the agent of “${t.title}”? Its turn ends now; the task stays, and Retry or Start picks it up again.`, `Arrêter l’agent de « ${t.title} » ? Son tour s’arrête maintenant ; la tâche reste, Réessayer ou Lancer la reprend.`),
    tl('Stop the agent', 'Arrêter l’agent'))) return
  if (action === 'finish' && !await askConfirm(finishQuestion(t.title, row.value?.chat), finishLabel(row.value?.chat), 'primary')) return
  if (!still(was)) return
  const g = gen
  busy.value = true
  running.value = action
  actionError.value = ''
  try {
    const agent = action === 'delegate' ? startName.value : null
    const effort = action === 'delegate' && startModel.value ? startEffort.value : null
    const r = await api<{ msg: string }>('/api/tasks/action', { machine, id: t.id, action, ...(agent ? { agent } : {}), ...(effort ? { effort } : {}), ...(action === 'delegate' && after?.length ? { after } : {}) })
    if (action === 'delegate' && g === gen) closePicker()
    haptic()
    if (action === 'archive') {
      // The Board says it, with Restore, and reads itself again.
      if (g === gen) open.value = false
      emit('archived', machine, t)
      return
    }
    toast(r.msg || (action === 'finish' && row.value?.chat ? tl('Conversation ended', 'Conversation terminée') : ACTION_DONE[action]()))
    if (action === 'restore' && g === gen) restored.value = true
    if (action === 'restore') emit('restored', machine, t)
    await settle(g)
  } catch (e) { failed(e, g) }
  finally { if (g === gen) { busy.value = false; running.value = null } }
}

// Start after the tasks picked: the board checks them, and says why it refuses.
function startAfter() {
  if (chosen.value.length) act('delegate', chosen.value.map(c => c.ref))
}
// Stop waiting (`after --clear`): it starts, or takes its place in the queue.
async function clearWait() {
  const t = props.task
  if (!t || busy.value || !canClear.value) return
  const machine = props.machine
  const g = gen
  busy.value = true
  actionError.value = ''
  try {
    const r = await api<{ msg: string }>('/api/tasks/after', { machine, id: t.id })
    haptic()
    toast(r.msg || tl('No longer waiting', 'N’attend plus'))
    await settle(g)
  } catch (e) { failed(e, g) }
  finally { if (g === gen) busy.value = false }
}

// A question to the project's coordinator, separate from the task agent.
async function askCoordinator() {
  const task = props.task
  if (!task || archived.value || busy.value || !question.value.trim() || offlineView.value) return
  const machine = props.machine
  const g = gen
  busy.value = true
  actionError.value = ''
  try {
    await api('/api/tasks/question', { machine, id: task.id, text: question.value.trim() })
    if (g === gen) {
      question.value = ''
      open.value = false
      emit('coordinator', machine, task)
    }
  } catch (e) { failed(e, g) }
  finally { if (g === gen) busy.value = false }
}
function coordinator() {
  if (!props.task || busy.value) return
  open.value = false
  emit('coordinator', props.machine, props.task)
}
// The task's conversation in the Board's side panel, the sheet closed.
function chat() {
  const t = props.task
  if (!t || !chatShown.value) return
  open.value = false
  emit('chat', props.machine, t)
}
</script>

<template>
  <component :is="embedded ? 'section' : AppSheet" v-model:open="open" :title="task?.title || tl('Task', 'Tâche')" wide>
    <div v-if="task" class="task-sheet">
      <p v-if="!embedded" class="task-sheet-meta">
        <TaskKey :value="label" />
        <span class="task-state" :class="task.group">{{ taskGroupLabel(task.group) }}</span>
        <TaskActivityBadge :activity="activity" />
        <span v-if="archived" class="task-chip task-archived"><UIcon name="i-lucide-archive" />{{ tl('Archived', 'Archivée') }}</span>
        <span v-if="task.app" class="task-chip">{{ task.app }}</span>
        <span v-if="row?.chat" class="task-chip">{{ tl('Conversation', 'Conversation') }}</span>
        <span v-else-if="task.research" class="task-chip">{{ tl('research', 'recherche') }}</span>
        <span v-if="multiMachine && machine !== undefined" class="task-chip">{{ machineName(machine) }}</span>
      </p>
      <span v-if="embedded && row?.chat" class="task-chip">{{ tl('Conversation', 'Conversation') }}</span>
      <p v-if="embedded && activity?.kind === 'running' && task.progress !== null" class="task-sheet-msg">{{ tl('Progress', 'Avancement') }} · {{ task.progress }}%<template v-if="task.eta !== null"> · {{ tl(`${task.eta} min left`, `${task.eta} min restantes`) }}</template></p>
      <p v-if="task.msg && !wait && queued === null" class="task-sheet-msg">{{ task.msg }}</p>
      <!-- Where a started task stands before an agent is on it: the queue, or what it waits for. -->
      <section v-if="queued !== null" class="task-sheet-block task-wait" role="status">
        <h4>{{ tl('In the queue', 'En file') }}</h4>
        <p class="task-wait-line"><UIcon name="i-lucide-list-ordered" />{{ tl('Waiting for a free slot', 'Attend une place libre') }}<template v-if="queued"> · <strong>{{ queuePlaceText(queued) }}</strong></template></p>
      </section>
      <section v-if="wait" class="task-sheet-block task-wait" role="status">
        <h4>{{ wait.waiting ? tl('Waiting', 'En attente') : tl('To wait for', 'À attendre') }}</h4>
        <p class="task-wait-line">
          <UIcon name="i-lucide-hourglass" />{{ wait.waiting ? tl('Waits for', 'Attend') : tl('Will wait for', 'Attendra') }}
          <span v-for="id in wait.waitsFor" :key="id" class="task-wait-chip" :class="{ done: !wait.left.includes(id) }" :title="wait.titles[id] || undefined">
            {{ nameOf(id) }}<small v-if="!wait.left.includes(id)">{{ tl('done', 'fait') }}</small>
          </span>
        </p>
        <p v-if="wait.forYou" class="board-note error">{{ wait.forYou }}</p>
        <p class="task-wait-hint">{{ wait.waiting ? tl('It starts by itself once they are done.', 'Elle démarre d’elle-même quand elles sont faites.') : tl('Once started, it waits for them to be done.', 'Une fois lancée, elle attend qu’elles soient faites.') }}</p>
        <UButton v-if="canClear" color="neutral" variant="outline" icon="i-lucide-x" class="task-wait-clear" :disabled="busy || offlineView" @click="clearWait">
          {{ tl('Stop waiting', 'Ne plus attendre') }}
        </UButton>
      </section>
      <p v-if="archived" class="board-note task-sheet-archived">{{ tl('Archived: read-only, as in herdr-projects. Restore it to change or start it again.', 'Archivée : en lecture seule, comme dans herdr-projects. Restaure-la pour la modifier ou la relancer.') }}</p>

      <p v-if="loading && !details" class="board-empty">{{ t('Loading…') }}</p>
      <p v-if="error" class="board-note error">{{ error }}</p>

      <section v-if="!archived && task.stage === 'pick' && details?.stage === 'pick'" class="task-sheet-block task-attempts">
        <h4>{{ tl('Choose an attempt', 'Choisis un essai') }}</h4>
        <p v-if="details.comparison?.pick" class="task-sheet-text">{{ tl(`Picker recommends ${details.comparison.pick}`, `Le picker recommande ${details.comparison.pick}`) }}</p>
        <p v-if="details.comparison?.why" class="task-sheet-text">{{ details.comparison.why }}</p>
        <p v-if="details.comparison?.error" class="board-note error">{{ details.comparison.error }}</p>
        <div v-for="attempt in details.attempts" :key="attempt.letter" class="task-attempt">
          <p><strong class="mono">{{ attempt.letter }}</strong> · {{ attempt.agent }}</p>
          <p>{{ attempt.standing === 'passed' ? tl('Checks passed', 'Vérifications réussies') : attempt.standing === 'out' ? tl('Not selectable', 'Non sélectionnable') : tl('Checks not passed yet', 'Vérifications pas encore réussies') }}<template v-if="attempt.standing !== 'passed'"> · {{ attempt.stage }}</template></p>
          <p v-if="attempt.stat">{{ attempt.stat }}</p>
          <p v-if="details.comparison?.notes[attempt.letter]">{{ details.comparison.notes[attempt.letter] }}</p>
          <UButton :disabled="busy || offlineView || reachable === false || loading || !!error || !canPickAttempt(details, attempt.letter)" @click="keepAttempt(attempt.letter)">{{ tl(`Keep ${attempt.letter}`, `Garder ${attempt.letter}`) }}</UButton>
        </div>
        <p v-if="!details.attempts?.length" class="board-note">{{ tl('No attempts available', 'Aucun essai disponible') }}</p>
      </section>

      <dl v-if="pr || review || details?.branch || details?.agent" class="task-sheet-facts">
        <template v-if="pr">
          <dt>{{ tl('Pull request', 'Pull request') }}</dt>
          <dd><a :href="pr" target="_blank" rel="noopener noreferrer">{{ prNumber(pr) || 'PR' }} <UIcon name="i-lucide-external-link" /></a></dd>
        </template>
        <template v-if="review">
          <dt>{{ tl('Review', 'Revue') }}{{ task.reviewRound > 1 ? ` · R${task.reviewRound}` : '' }}</dt>
          <dd :class="review.pass === false ? 'fail' : review.pass ? 'pass' : ''">
            {{ review.pass === false ? tl('Fail', 'Échec') : review.pass ? tl('Pass', 'Validée') : '' }}{{ review.tally ? ` · ${review.tally}` : '' }}{{ review.by ? ` · ${review.by}` : '' }}
          </dd>
        </template>
        <template v-if="details?.branch">
          <dt>{{ tl('Branch', 'Branche') }}</dt>
          <dd class="mono">{{ details.branch }}</dd>
        </template>
        <template v-if="details?.agent">
          <dt>{{ tl('Agent', 'Agent') }}</dt>
          <dd>{{ details.agent }}</dd>
        </template>
      </dl>
      <section v-if="details?.handovers?.length" class="task-sheet-block task-handovers">
        <h4>{{ t('Handovers') }}</h4>
        <ol class="task-handover-list">
          <li v-for="(handover, index) in details.handovers" :key="index" class="task-sheet-text">
            <p v-if="handover.role" class="task-handover-meta">{{ handover.role === 'worker' ? t('Agent') : handover.role === 'reviewer' ? t('Reviewer') : handover.role }}</p>
            <p v-if="handover.from"><span>{{ t('Previous agent') }}: </span>{{ handover.from }}</p>
            <p v-if="handover.to"><span>{{ t('Taken over by') }}: </span>{{ handover.to }}</p>
            <p v-if="handover.why">{{ handover.why }}</p>
            <time v-if="handover.at !== null" :datetime="new Date(handover.at).toISOString()" class="task-handover-meta">{{ new Date(handover.at).toLocaleString(language) }}</time>
          </li>
        </ol>
      </section>
      <div v-if="details?.failure && !details.failureStale && !embedded" class="plugin-input-note warn">
        <UIcon name="i-lucide-triangle-alert" />
        <p>{{ details.failure }}</p>
      </div>
      <!-- A failure the task has moved on from: history, not where it stands. -->
      <section v-if="details?.failure && details.failureStale" class="task-sheet-block task-sheet-earlier">
        <h4>{{ tl('Earlier failure', 'Échec précédent') }}<template v-if="details.failureAt"> · {{ new Date(details.failureAt).toLocaleString(language) }}</template></h4>
        <p class="task-sheet-text">{{ details.failureTitle || details.failure }}</p>
      </section>
      <section v-if="details" class="task-sheet-block task-description">
        <h4 v-if="!editingDescription">{{ tl('Description', 'Description') }}</h4>
        <form v-if="editingDescription" class="sheet-form task-question" @submit.prevent="saveDescription">
          <label for="task-description" class="field-label">{{ tl('Description', 'Description') }}</label>
          <UTextarea id="task-description" v-model="descriptionDraft" :disabled="busy || archived" :rows="6" class="w-full" />
          <p v-if="descriptionError" class="board-note error" role="alert">{{ descriptionError }}</p>
          <div class="task-sheet-actions">
            <UButton type="submit" :loading="busy" :disabled="descriptionUnavailable">{{ t('Save') }}</UButton>
            <UButton color="neutral" variant="outline" :disabled="busy" @click="editingDescription = false">{{ t('Cancel') }}</UButton>
          </div>
        </form>
        <template v-else>
          <p class="task-sheet-text">{{ details.description }}</p>
          <UButton v-if="!archived" color="neutral" variant="outline" icon="i-lucide-pencil" :disabled="descriptionUnavailable" @click="editDescription">{{ t('Edit description') }}</UButton>
        </template>
      </section>
      <TaskSettings v-if="!embedded" :machine="machine" :id="task.id" :active="open" :reachable="reachable" />
      <section v-if="details?.plan" class="task-sheet-block">
        <h4>{{ tl('Plan', 'Plan') }}</h4>
        <p class="task-sheet-text">{{ details.plan }}</p>
      </section>

      <section v-if="details?.summary" class="task-sheet-block board-panel-note">
        <h4>{{ tl('Closing note', 'Note de fin') }}</h4>
        <p class="task-sheet-text">{{ details.summary }}</p>
      </section>
      <p v-if="details?.report" class="board-panel-report">
        <span>{{ details.research ? tl('Research report', 'Rapport de recherche') : tl('Report', 'Rapport') }}</span>
        <a v-if="details.report.link" :href="details.report.link" target="_blank" rel="noopener noreferrer">{{ details.report.file }}</a>
        <span v-else>{{ details.report.file }}</span>
      </p>
      <section v-if="details?.findings?.length" class="task-sheet-block">
        <h4>{{ tl('Review findings', 'Remarques de relecture') }}</h4>
        <p v-for="(f, i) in details.findings" :key="i" class="task-sheet-text">{{ f.severity }} · {{ f.title }}<template v-if="f.detail"> — {{ f.detail }}</template></p>
      </section>
      <TaskLimitGauges v-if="details?.limits" :limits="details.limits" />

      <section v-if="!archived && !beads" class="task-sheet-block">
        <div class="task-sheet-actions">
          <UButton color="neutral" variant="outline" icon="i-lucide-message-circle-question-mark" :aria-expanded="asking" :disabled="busy || offlineView" @click="asking = !asking">{{ tl('Ask the coordinator', 'Demander au coordinateur') }}</UButton>
          <UButton color="neutral" variant="ghost" :disabled="busy || offlineView" @click="coordinator">{{ tl('Coordinator replies', 'Réponses du coordinateur') }}</UButton>
        </div>
        <form v-if="asking" class="task-question sheet-form" @submit.prevent="askCoordinator">
          <label for="task-question" class="field-label">{{ tl('Your question about this task', 'Ta question sur cette tâche') }}</label>
          <UTextarea id="task-question" v-model="question" :maxlength="TASK_QUESTION_MAX" :disabled="busy" :rows="3" />
          <p>{{ tl('The project coordinator answers in its chat. Asking leaves the task as it is.', 'Le coordinateur du projet répond dans son chat. Poser une question laisse la tâche en l’état.') }}</p>
          <div class="task-sheet-actions">
            <UButton type="submit" :loading="busy" :disabled="busy || offlineView || !question.trim()">{{ tl('Send question', 'Envoyer la question') }}</UButton>
          </div>
        </form>
      </section>

      <div v-if="actions.delegate" class="task-start-agent" role="radiogroup" :aria-label="tl('Agent for this start', 'Agent pour ce lancement')">
        <span class="task-start-label">{{ tl('Agent', 'Agent') }}</span>
        <span v-if="!startOpts" class="task-start-wait">{{ startLoading ? t('Loading…') : tl('the task’s default', 'celui de la tâche par défaut') }}</span>
        <button
          v-for="a in startAgents" :key="a.id ?? ''" type="button" role="radio" class="task-start-chip"
          :class="{ on: checked(a), off: !a.usable }"
          :aria-checked="checked(a)"
          :disabled="busy || offlineView || !a.usable" @click="pick = a.id"
        >
          <AgentAvatar v-if="a.id || startOpts?.agent" :agent="a.id || defaultKind" /><span class="task-start-name">{{ a.label }}</span><small v-if="a.isDefault">{{ defaultTag(a) }}</small>
        </button>
        <!-- A beads Start opens the program with its own model (no herdr-projects `models`). -->
        <span v-if="startOpts && startProgram && !offlineView && !beads" class="task-start-model">
          <span class="task-start-label">{{ tl('Model', 'Modèle') }}</span>
          <ModelPicker :key="`${target()}|${startProgram}`" v-model:model="startModel" v-model:effort="startEffort" :launch="{ machine, program: startProgram }" />
        </span>
        <span v-if="startOpts?.agent" class="task-start-from">{{ agentSource() }}</span>
        <span v-if="needsPick" class="task-start-from task-start-missing" role="status">{{ tl(`${defaultKind} is not installed on this machine: pick another agent to start it.`, `${defaultKind} n’est pas installé sur cette machine : choisis un autre agent pour la lancer.`) }}</span>
        <span v-if="startName" class="task-start-from">{{ tl('For this start only: the default stays.', 'Pour ce lancement seulement : le défaut ne change pas.') }}</span>
      </div>
      <div v-if="chatShown || actions.approve || actions.delegate || actions.retry || actions.finish || actions.stop || actions.archive || actions.restore" class="task-sheet-actions">
        <UButton v-if="actions.restore" color="primary" icon="i-lucide-archive-restore" :loading="running === 'restore'" :disabled="busy || offlineView" @click="act('restore')">{{ beads ? tl('Reopen') : tl('Restore', 'Restaurer') }}</UButton>
        <UButton v-if="actions.delegate" color="primary" :icon="place ? 'i-lucide-list-ordered' : 'i-lucide-play'" class="task-start" :loading="running === 'delegate' && !picking" :disabled="busy || offlineView || needsPick" @click="act('delegate')">{{ startLabel() }}</UButton>
        <UButton v-if="actions.delegate && !beads" color="primary" variant="outline" icon="i-lucide-hourglass" class="task-start-after" :aria-expanded="picking" :disabled="busy || offlineView || needsPick" @click="picking ? closePicker() : openPicker()">{{ tl('Start after…', 'Démarrer après…') }}</UButton>
        <UButton v-if="actions.approve" color="primary" icon="i-lucide-check" :loading="busy && !running" :disabled="busy || offlineView" @click="approve">
          {{ task.stage === 'plan' ? tl('Approve plan', 'Accepter le plan') : tl('Approve', 'Approuver') }}
        </UButton>
        <UButton v-if="actions.retry" color="primary" variant="outline" icon="i-lucide-rotate-ccw" :loading="running === 'retry'" :disabled="busy || offlineView" @click="act('retry')">{{ limitStopped ? tl('Continue', 'Continuer') : tl('Retry', 'Réessayer') }}</UButton>
        <UButton v-if="limitStopped" variant="outline" :disabled="busy || offlineView || reachable === false" @click="openLimit">{{ tl('Raise limit', 'Relever la limite') }}</UButton>
        <UButton v-if="actions.finish" color="primary" variant="outline" icon="i-lucide-flag" class="task-finish" :title="finishTitle(row?.chat)" :aria-description="finishTitle(row?.chat)" :loading="running === 'finish'" :disabled="busy || offlineView" @click="act('finish')">{{ limitStopped && !row?.chat ? tl('Take as is', 'Prendre tel quel') : finishLabel(row?.chat) }}</UButton>
        <UButton
          v-if="chatShown && !embedded" class="task-chat" color="neutral" variant="outline" icon="i-lucide-message-square"
          @click="chat"
        >
          {{ tl('Open the chat', 'Ouvrir la discussion') }}
        </UButton>
        <UButton v-if="actions.stop" color="error" variant="outline" icon="i-lucide-square" :loading="running === 'stop'" :disabled="busy || offlineView" @click="act('stop')">{{ tl('Stop', 'Arrêter') }}</UButton>
        <UButton v-if="actions.archive" color="neutral" variant="ghost" :icon="beads ? 'i-lucide-circle-check' : 'i-lucide-archive'" class="task-archive" :loading="running === 'archive'" :disabled="busy || offlineView" @click="act('archive')">{{ beads ? tl('Close') : tl('Archive', 'Archiver') }}</UButton>
      </div>
      <p v-if="resuming" role="status">{{ tl('Resuming…', 'Reprise…') }}</p>
      <p v-if="limitStopped && embedded" class="task-finish-why">{{ finishWhy }}</p>
      <AppSheet v-model:open="limitOpen" :title="tl('Raise limit', 'Relever la limite')" top>
        <form class="sheet-form task-question" @submit.prevent="raiseLimit">
          <p>{{ tl('Choose a total ceiling above usage for the limit that stopped this task. Usage is kept; the CLI resumes automatically when this limit is lifted. Enter none to explicitly remove it.', 'Choisis un plafond total supérieur à la consommation pour la limite qui a arrêté cette tâche. La consommation est conservée ; le CLI reprend automatiquement quand cette limite est levée. Saisis none pour la supprimer explicitement.') }}</p>
          <p id="task-limit-kind" class="field-label">{{ limitName === 'limit.time' ? tl('Reached limit: time per run', 'Limite atteinte : temps par tranche') : limitName === 'limit.tokens' ? tl('Reached limit: tokens for the whole task', 'Limite atteinte : jetons pour toute la tâche') : tl('The reached limit is not available. Refresh the task before changing a ceiling.', 'La limite atteinte n’est pas disponible. Actualise la tâche avant de modifier un plafond.') }}</p>
          <div v-if="limitPresets.length" class="raise-limit-presets" role="group" :aria-label="tl('Quick choices', 'Choix rapides')">
            <UButton v-for="p in limitPresets" :key="p.id" color="neutral" variant="outline" :data-preset="p.id" :disabled="busy || offlineView || reachable === false || !p.resumes" :title="p.resumes ? undefined : tl('Not above what it already used: it would not resume', 'Pas au-dessus de ce qu’elle a déjà utilisé : elle ne reprendrait pas')" @click="applyPreset(p)">
              <span class="raise-limit-op">{{ presetLabel(p) }}</span><span v-if="presetTo(p)" class="raise-limit-to">{{ presetTo(p) }}</span>
            </UButton>
          </div>
          <label for="task-limit-value" class="field-label">{{ limitName === 'limit.time' ? tl('New duration (e.g. 4h, 90m, none)', 'Nouvelle durée (ex. 4h, 90m, none)') : tl('New token count (e.g. 3m, 500k, none)', 'Nouvelle quantité de jetons (ex. 3m, 500k, none)') }}</label>
          <UInput id="task-limit-value" v-model="limitValue" :disabled="busy || !limitName" :maxlength="40" />
          <p v-if="limitNotice" role="status">{{ limitNotice }}</p>
          <p v-if="actionError" role="alert">{{ actionError }}</p>
          <div class="task-sheet-actions">
            <UButton color="neutral" variant="outline" :disabled="busy" @click="limitOpen = false">{{ tl('Cancel', 'Annuler') }}</UButton>
            <UButton type="submit" :disabled="busy || offlineView || !limitName || !limitValue.trim()" :loading="resuming">{{ resuming ? tl('Resuming…', 'Reprise…') : tl('Apply limit', 'Appliquer le plafond') }}</UButton>
          </div>
        </form>
      </AppSheet>
      <p v-if="actions.delegate && placeLine" class="task-queue-place" role="status">{{ placeLine }}</p>
      <!-- Start after…: the tasks to wait for, searched by key, id or title, on every machine the Board reads. -->
      <section v-if="actions.delegate && picking" class="task-sheet-block task-after-pick">
        <h4>{{ tl('Start after…', 'Démarrer après…') }}</h4>
        <p class="task-wait-hint">{{ tl('It starts by itself once these tasks are done. Another machine’s task: machine:KEY-12.', 'Elle démarre d’elle-même quand ces tâches sont faites. Tâche d’une autre machine : machine:CLÉ-12.') }}</p>
        <p v-if="chosen.length" class="task-wait-line">
          <span v-for="c in chosen" :key="c.ref" class="task-wait-chip">
            {{ c.ref }}<button type="button" class="task-wait-unchoose" :aria-label="tl(`Remove ${c.ref}`, `Retirer ${c.ref}`)" @click="unchoose(c.ref)"><UIcon name="i-lucide-x" /></button>
          </span>
        </p>
        <UInput
          v-model="query" size="xl" class="w-full task-after-search" icon="i-lucide-search" autocapitalize="none" autocorrect="off" :spellcheck="false" enterkeyhint="done" maxlength="120"
          :placeholder="tl('Key, id or title', 'Clé, id ou titre')" :aria-label="tl('Task to wait for', 'Tâche à attendre')"
          @keydown.enter.prevent="typed ? chooseTyped() : choices[0] && choose(choices[0])"
        />
        <ul class="task-after-list">
          <li v-if="typed"><button type="button" class="task-after-choice" @click="chooseTyped"><span class="mono">{{ typed }}</span><span>{{ tl('Wait for this task', 'Attendre cette tâche') }}</span></button></li>
          <li v-for="c in choices" :key="c.ref">
            <button type="button" class="task-after-choice" @click="choose(c)"><span class="mono">{{ c.ref }}</span><span class="task-after-title">{{ c.title }}</span><small>{{ taskGroupLabel(c.group) }}</small></button>
          </li>
        </ul>
        <p v-if="!choices.length && !typed" class="board-empty">{{ boardLoading ? t('Loading…') : tl('No task to wait for matches.', 'Aucune tâche à attendre ne correspond.') }}</p>
        <div class="task-sheet-actions">
          <UButton color="primary" :icon="place ? 'i-lucide-list-ordered' : 'i-lucide-hourglass'" :loading="running === 'delegate'" :disabled="busy || offlineView || needsPick || !chosen.length" @click="startAfter">
            {{ chosen.length ? tl(`Start after ${chosen.length === 1 ? chosen[0]!.ref : `${chosen.length} tasks`}`, `Démarrer après ${chosen.length === 1 ? chosen[0]!.ref : `${chosen.length} tâches`}`) : tl('Pick a task', 'Choisis une tâche') }}
          </UButton>
          <UButton color="neutral" variant="ghost" :disabled="running === 'delegate'" @click="closePicker">{{ t('Cancel') }}</UButton>
        </div>
      </section>
      <p v-if="actions.finish && !embedded" class="task-finish-why">{{ finishWhy }}</p>
      <p v-if="actionError" class="board-note error task-sheet-error" role="alert">{{ actionError }}</p>

    </div>
  </component>
</template>

<style scoped>
.task-attempt { border-top: 1px solid var(--line); padding: 12px 0; display: grid; gap: 8px; overflow-wrap: anywhere; }
.task-question { display: grid; gap: 12px; margin-top: 16px; }
.task-question p { color: var(--muted); font-size: 13px; }
</style>
