import { parseTaskSettings } from '../../shared/taskSettings'
import { type BoardSettings, parseBoardSettings, settingArgs } from '../../shared/boardSettings'
import { readSessionTimers } from './scheduledTranscript'
import type { SearchableBoard } from '../../shared/taskSearch'
// herdr-projects 1.x on every machine: its tasks (GET /api/tasks), one task's
// details, and what the Board can do on a task (tell, approve, open its pane).
//
// One board per machine: herdr-projects keeps it in the machine's HOME
// (~/.herdr-projects), so the named sessions of a machine share it. Its cache,
// its queue and its card list are the base machine's.
//
// How a board is read:
//  - on the host (wherdr's own machine, or any SSH machine): the plugin's
//    own CLI, run by its launcher (`sh <plugin_root>/bin/run.sh …`), in the
//    machine's own Herdr session. Each command also runs the board's upkeep, as
//    any 1.x command does on that machine; wherdr calls it sparingly: one
//    command at a time per machine, a list reused for REUSE_MS, the last list
//    kept (marked stale) when a read outlives READ_DEADLINE_MS. Without a last
//    list, the read is waited for (up to FIRST_READ_MS) rather than answered
//    empty; `pending` asks the client to come back soon (repo keys still read).
//    The server reads the Board once at start (warmTasksBoard), so the first
//    Board opened after a restart finds it read.
// Only where Herdr reports a 1.x from 1.2.1 on (shared/projectsPlugin.ts).
import { autopilotNextAt, parseAutopilot, parseAutomations, type Scheduled } from '../../shared/scheduled'
import { machineOfPane } from './machines'
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import { joinId } from '../../shared/ids'
import {
  canPickAttempt, taskAgentIdentity, type MachineTasks, type TaskDetails, type TaskPanes, type TaskReviewer, REVIEW_STAGES, type TaskRow, type TasksBoard,
  TASK_QUESTION_MAX, taskCanFix, taskCanApproveAnyway, taskCanSendReview, failureIsStale, type StartOptions, type TaskCommand, addArgs, cleanTaskType, isPlanApproval, delegateArgs, isAgentName, isEffortName, isProgramName, agentKind, parseModels, type StartModels, parseWorkerAgent, parseWorkerEffort, restoreAgentArgs, runOver, cleanRepo, cleanTarget, cleanTell, cleanTitle, type CoordinatorStatus, coordinatorArgs, coordinatorRestartArgs, coordinatorStatusArgs, parseCoordinatorStatus, isTaskCommand,
  isTaskId, parseRepoKey, parseTaskDetails, parseTaskList, rowFromTaskFile, taskActions,
  cleanAfterRefs, clearAfterArgs, parseBoardAgents, slotsOf, type TaskSlots,
} from '../../shared/projectsTasks'
import {
  AUTOPILOT_MIN, OFF, autopilotId, autopilotOnArgs, autopilotTargetArgs, coordinatorShowArgs, parseAutopilotList, parseCoordinatorSettings,
  type AutopilotDetails, type AutopilotStatus,
} from '../../shared/autopilot'
import { parseProjectsVersion, versionAtLeast } from '../../shared/projectsPlugin'
import { HERDR_BIN, HERDR_CHILD_ENV, log } from './env'
import { USER_PATH_SH, userPath } from '../../bin/lib/userpath.mjs'
import { HerdrError } from './herdr'
import { type Machine, allMachines, baseMachines } from './machines'
import { machineFor } from './actions'
import { projectsPluginInfo } from './projectsPlugin'
import { installedAgentKinds } from './agentAvailability'
import { dropStartAgent, rememberStartAgent, startAgentKey, startAgentOf, startAgentsOf } from './startAgents'
import { findPane } from './state'
import { fmt } from '../../shared/message'
import { FOLDER_MISSING, FOLDER_NOT_GIT, PROJECT_FOLDER_SCRIPT, type ProjectFolder, REGISTER_PROMPT, isFolderRef, parseFolderLook, projectFolderOf, repoNameOf } from '../../shared/projectFolder'

export const REUSE_MS = 5000
export const READ_DEADLINE_MS = 4000
export const FIRST_READ_MS = 12_000
// The two waits, shortened by the tests.
let waits = { deadline: READ_DEADLINE_MS, first: FIRST_READ_MS }
export function setReadWaits(w: { deadline: number, first: number } | null) { waits = w || { deadline: READ_DEADLINE_MS, first: FIRST_READ_MS } }
const LIST_TIMEOUT_MS = 30_000
const ACTION_TIMEOUT_MS = 60_000
const OUTPUT_MAX = 8 * 1024 * 1024

export interface RunResult { code: number, stdout: string, stderr: string }
export type Runner = (m: Machine, launcher: string, args: string[], timeoutMs: number) => Promise<RunResult>

// On an SSH machine: its own Herdr session, by name, as herdr-projects finds it
// there (never the socket wherdr forwards here). `$1` herdr binary, `$2` session
// ('' or 'default': the default one), then the command.
// The remote shell is not a login shell: its PATH is completed first, as on
// this machine (bin/lib/userpath.mjs), so herdr-projects finds the agents.
export const REMOTE_TASKS_SCRIPT = USER_PATH_SH + 'export HERDR_BIN_PATH="$1"; unset HERDR_SOCKET_PATH; '
  + 'if [ -n "$2" ] && [ "$2" != default ]; then export HERDR_SESSION="$2"; else unset HERDR_SESSION; fi; shift 2; exec "$@"'

// The environment of herdr-projects on this machine. Run directly (not as a
// Herdr plugin command), it does not widen its PATH by itself: it gets the
// user's (bin/lib/userpath.mjs), read again each time since herdr-projects'
// record of it may be newer, so it finds the agents in user folders.
export function launcherEnv(home: string, sock?: string | null, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const PATH = userPath({ env: { PATH: HERDR_CHILD_ENV.PATH, HERDR_PROJECTS_DATA_DIR: env.HERDR_PROJECTS_DATA_DIR, HERDR_PROJECTS_HOME: env.HERDR_PROJECTS_HOME }, home })
  return { ...HERDR_CHILD_ENV, PATH, HERDR_BIN_PATH: HERDR_BIN, NO_COLOR: '1', ...(sock ? { HERDR_SOCKET_PATH: sock } : {}) }
}

// The plugin's launcher with argv only: no shell on this machine, and
// positional parameters of a fixed script on a remote one.
const runLauncher: Runner = async (m, launcher, args, timeoutMs) => {
  if (m.exec) {
    const herdrBin = 'bin' in m && typeof (m as { bin?: unknown }).bin === 'string' ? (m as { bin: string }).bin : 'herdr'
    // Bounded while it arrives (the SSH runner stops the command past it).
    const r = await m.exec(REMOTE_TASKS_SCRIPT, [herdrBin, m.session || '', 'sh', launcher, ...args], { timeoutMs, maxBytes: OUTPUT_MAX })
    return { code: r.code ?? 1, stdout: r.stdout.toString('utf8'), stderr: r.stderr.trim() }
  }
  const sock = m.sock()
  return new Promise(resolve => execFile('sh', [launcher, ...args], {
    cwd: m.home,
    env: launcherEnv(m.home, sock),
    timeout: timeoutMs, maxBuffer: OUTPUT_MAX,
  }, (err, stdout, stderr) => resolve({
    code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
    stdout: String(stdout),
    stderr: String(stderr || (err ? (err.killed ? `herdr-projects did not answer within ${Math.round(timeoutMs / 1000)} s` : err.message) : '')).trim(),
  })))
}
let runner: Runner = runLauncher
// Tests replace the launcher with recorded output.
export function setRunner(r: Runner | null) { runner = r || runLauncher }
// The base machine of a machine or a named session: the board's owner.
export function boardMachine(m: Machine): Machine {
  const key = m.info().baseKey
  return (key !== undefined && baseMachines().find(b => b.key === key)) || m
}

// One command at a time per machine.
const queues = new Map<string, Promise<unknown>>()
function serial<T>(key: string, job: () => Promise<T>): Promise<T> {
  const before = queues.get(key) || Promise.resolve()
  const next = before.catch(() => {}).then(job)
  queues.set(key, next)
  next.finally(() => { if (queues.get(key) === next) queues.delete(key) }).catch(() => {})
  return next
}

const firstLine = (s: string) => s.split('\n').map(l => l.trim()).find(Boolean)?.slice(0, 300) || ''

async function launcherOf(m: Machine): Promise<string> {
  const info = await projectsPluginInfo(m)
  if (info.status !== 'ready' || !info.launcher) throw new HerdrError('projects_unavailable', fmt('herdr-projects 1.2.1 or later is not available on {machine}', { machine: m.label }))
  return info.launcher
}

// `whole`: the CLI's refusal as it says it, every line (a model or an effort
// it does not take: it names the ones it does).
const wholeText = (s: string) => s.trim().slice(0, 2000)
async function command(m: Machine, args: string[], timeoutMs = ACTION_TIMEOUT_MS, whole = false): Promise<string> {
  const launcher = await launcherOf(m)
  const r = await serial(m.key, () => runner(m, launcher, args, timeoutMs))
  const said = whole ? wholeText : firstLine
  if (r.code !== 0) throw new HerdrError('projects_failed', said(r.stderr) || said(r.stdout) || `herdr-projects ${args[0]}: code ${r.code}`)
  return r.stdout
}

// The program's own version: `version` is one of the two commands that never
// take over an older install's files (shared/projectsPlugin.ts). null: unknown.
export async function projectsProgramVersion(m: Machine): Promise<string | null> {
  return parseProjectsVersion(await command(m, ['version'], LIST_TIMEOUT_MS))
}

// ---------------------------------------------------------------- the board's files
const tasksRoot = (m: Machine) => path.posix.join(m.home, '.herdr-projects/data/tasks')

const missing = (e: unknown) => (e as { code?: unknown })?.code === 'ENOENT'

// A task's file. null: no such file (a task being made, or cleared). Anything
// else that keeps it from being read (rights, disk, broken JSON) is an error.
async function readTaskFile(m: Machine, id: string): Promise<Record<string, unknown> | null> {
  const [repo, n] = id.split('/') as [string, string]
  let text: string
  try { text = await m.fs.readFile(path.posix.join(tasksRoot(m), repo, n, 'task.json')) }
  catch (e) { if (missing(e)) return null; throw e }
  const t: unknown = JSON.parse(text)
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw new Error('not a task')
  return t as Record<string, unknown>
}

// The machine key of the session a task's agent runs in (its link.socket):
// `…/sessions/<name>/herdr.sock`, or the default session's socket. null: a
// session wherdr has not opened. Never another session's key: a pane id
// (w1:p1) means another agent there.
export function sessionMachine(base: Machine, socket: unknown): string | null {
  // No socket named: the board's own session, as herdr-projects reads it (flow/live.rs).
  if (typeof socket !== 'string' || !socket) return base.key
  const parts = typeof socket === 'string' ? socket.split('/') : []
  const n = parts.length
  const name = n >= 3 && parts[n - 1] === 'herdr.sock' && parts[n - 3] === 'sessions' ? parts[n - 2]! : 'default'
  if (name === (base.session || 'default')) return base.key
  return allMachines().find(m => m.info().baseKey === base.key && m.session === name)?.key ?? null
}

// The task's agent pane as its file links it, in the session it names. `known`:
// that session is open in wherdr (false: no pane can be named for it).
function linkedPane(base: Machine, t: Record<string, unknown> | null): { pane: string | null, known: boolean } {
  const link = t && typeof t.link === 'object' && t.link ? t.link as Record<string, unknown> : null
  if (!link || typeof link.pane !== 'string' || !/^w[0-9a-z]+:p[0-9a-z]+$/i.test(link.pane)) return { pane: null, known: true }
  const key = sessionMachine(base, link.socket)
  return key === null ? { pane: null, known: false } : { pane: joinId(key, link.pane), known: true }
}

// ---------------------------------------------------------------- the list
interface Cached { tasks: TaskRow[], at: number, readAt: number, error?: string, descriptions?: Map<string, string> }
const DESCRIPTION_MAX = 4000
const lists = new Map<string, Cached>()
const reading = new Map<string, Promise<Cached>>()

// When each done task was made (per machine, id → ms): `list --json` does not
// say, its file does, and it never changes. Read once, a few files at a time.
const createdAt = new Map<string, Map<string, number | null>>()
const CREATED_READS = 8
async function withCreated(m: Machine, rows: TaskRow[]): Promise<TaskRow[]> {
  const known = createdAt.get(m.key) ?? new Map<string, number | null>()
  const todo = rows.filter(r => r.group === 'done' && r.created === undefined && !known.has(r.id))
  for (let i = 0; i < todo.length; i += CREATED_READS) {
    await Promise.all(todo.slice(i, i + CREATED_READS).map(async (r) => {
      // A read that failed is tried again at the next read of the list.
      const file = await readTaskFile(m, r.id).catch(() => undefined)
      if (file !== undefined) known.set(r.id, typeof file?.created === 'number' ? file.created : null)
    }))
  }
  // Only the tasks listed now are kept.
  const listed = new Set(rows.map(r => r.id))
  for (const id of known.keys()) if (!listed.has(id)) known.delete(id)
  createdAt.set(m.key, known)
  return rows.map((r) => {
    const created = r.group === 'done' && r.created === undefined ? known.get(r.id) : null
    return typeof created === 'number' ? { ...r, created } : r
  })
}

// `at`: when this answer was given; `readAt`: when its tasks were read (kept on an error).
function readList(m: Machine): Promise<Cached> {
  const now = reading.get(m.key)
  if (now) return now
  const started = Date.now()
  const descriptions = new Map<string, string>()
  const read = command(m, ['list', '--json'], LIST_TIMEOUT_MS).then(async (text): Promise<Cached> => ({ tasks: await withCreated(m, await Promise.all(parseTaskList(text).map(async row => {
    // The CLI list omits worker identity, handovers and approval blockers.
    // Read the file without extra upkeep commands, as Home and the panel do.
    const file = await readTaskFile(m, row.id).catch(() => null)
    if (file) row = { ...row, identity: taskAgentIdentity(file) }
    // Its description, from the same file, for the global search only.
    const description = typeof file?.description === 'string' ? file.description.slice(0, DESCRIPTION_MAX) : ''
    if (description) descriptions.set(row.id, description)
    return file?.stage === 'approval' && rowFromTaskFile(file, null)?.approvalBlocked
      ? { ...row, approvalBlocked: true, group: 'needs' as const } : row
  }))), descriptions, at: Date.now(), readAt: Date.now() }))
    .catch((e: Error) => {
      const last = lists.get(m.key)
      return { tasks: last?.tasks || [], descriptions: last?.descriptions, at: Date.now(), readAt: last?.readAt ?? 0, error: e.message }
    })
    .then((c: Cached) => {
      lists.set(m.key, c)
      if (c.error) return c
      void restoreFinished(m, c.tasks, started).catch(() => {})
      void readKeys(m, c.tasks.map(t => t.repo))
      return c
    })
    .finally(() => reading.delete(m.key))
  reading.set(m.key, read)
  return read
}

// ---------------------------------------------------------------- repo keys
// A task's name on the board is its repo's short key and its number (`APP-6`).
// `list --json` gives ids only, so each repo's key is asked once
// (`show --repo=<name> --json`), after a list, behind the Board's own commands,
// and asked again after a while (a key can be changed).
const KEYS_TTL_MS = 10 * 60_000
const KEYS_RETRY_MS = 60_000
const KEYS_WAIT_MS = 1_000
const repoKeys = new Map<string, Map<string, { key: string, at: number }>>()
const keysReading = new Map<string, Promise<void>>()
const keysMissing = (machine: string, c: Cached) => c.tasks.some(t => !repoKeys.get(machine)?.has(t.repo))
const keysPending = (machine: string, c: Cached): { pending?: true } => (!c.error && keysReading.has(machine) && keysMissing(machine, c) ? { pending: true } : {})

export function repoKeyOf(machine: string, repo: string): string {
  return repoKeys.get(machine)?.get(repo)?.key || ''
}
const withKeys = (machine: string, tasks: TaskRow[]): TaskRow[] => {
  const known = repoKeys.get(machine)
  return known ? tasks.map((t) => { const key = known.get(t.repo)?.key; return key ? { ...t, repoKey: key } : t }) : tasks
}

function readKeys(m: Machine, repos: string[]): Promise<void> {
  const running = keysReading.get(m.key)
  if (running) return running
  const known = repoKeys.get(m.key) ?? new Map<string, { key: string, at: number }>()
  const now = Date.now()
  const due = [...new Set(repos)].filter(r => (known.get(r)?.at ?? 0) <= now - KEYS_TTL_MS)
  if (!due.length) return Promise.resolve()
  const read = (async () => {
    for (const r of due) {
      // A failed read is asked again sooner. Each key counts as soon as it is read.
      try { known.set(r, { key: parseRepoKey(await command(m, ['show', `--repo=${r}`, '--json'], LIST_TIMEOUT_MS)), at: Date.now() }) }
      catch { known.set(r, { key: known.get(r)?.key || '', at: Date.now() - KEYS_TTL_MS + KEYS_RETRY_MS }) }
      repoKeys.set(m.key, known)
    }
  })().finally(() => keysReading.delete(m.key))
  keysReading.set(m.key, read)
  return read
}

// What a cached read says: its tasks, when they were read, and why they may be old.
function shown(machine: string, c: Cached): Pick<MachineTasks, 'tasks' | 'at' | 'error' | 'stale'> {
  return { tasks: withKeys(machine, c.tasks), ...(c.readAt ? { at: c.readAt } : {}), ...(c.error ? { error: c.error, stale: c.tasks.length > 0 } : {}) }
}

// `fresh`: the Board just opened (or asked to): check the plugin again rather
// than trust the last answer, so an install or update shows at once.
const after = (ms: number) => new Promise<null>(resolve => setTimeout(() => resolve(null), Math.max(0, ms)).unref?.())
export async function machineTasks(m: Machine, fresh = false): Promise<MachineTasks | null> {
  const started = Date.now()
  const last = lists.get(m.key)
  if (!m.local && m.status !== 'online') {
    const error = fmt('{machine} is unreachable', { machine: m.label })
    return last ? { machine: m.key, status: 'ready', version: '', ...shown(m.key, last), error, stale: true } : null
  }
  let info
  try { info = await projectsPluginInfo(m, fresh) }
  catch (e) {
    // Herdr did not answer: say so, with the last tasks read there.
    return { machine: m.key, status: 'error', version: '', tasks: [], ...(last ? shown(m.key, last) : {}), error: (e as Error).message, ...(last?.tasks.length ? { stale: true } : {}) }
  }
  const base = { machine: m.key, status: info.status, version: info.version || '' }
  if (info.status !== 'ready') return { ...base, tasks: [] }
  // A list reused while its repos' keys are still read stays `pending`: the
  // Board asks again soon rather than at its next poll (15 s later).
  if (last && Date.now() - last.at < REUSE_MS) return { ...base, ...shown(m.key, last), ...keysPending(m.key, last) }
  let c = await Promise.race([readList(m), after(waits.deadline)])
  if (!c && last) return { ...base, tasks: withKeys(m.key, last.tasks), ...(last.readAt ? { at: last.readAt } : {}), stale: true, pending: true }
  // Nothing read yet (a first read, or the list dropped after an action): an
  // empty board would be wrong, so the list is waited for.
  if (!c) c = await Promise.race([readList(m), after(waits.first - (Date.now() - started))])
  if (!c) return { ...base, tasks: [], stale: true, pending: true }
  // A repo never seen: its key is waited for a moment, so the first look names
  // its tasks right; the others follow at the next read, soon (`pending`).
  const keys = keysReading.get(m.key)
  if (!c.error && keys && keysMissing(m.key, c)) await Promise.race([keys, after(Math.min(KEYS_WAIT_MS, started + waits.deadline - Date.now()))])
  return { ...base, ...shown(m.key, c), ...keysPending(m.key, c) }
}

// The Board read once when the server starts: herdr-projects' first read (its
// list, then each repo's key) is slow, and the first Board opened after a
// restart should not wait for it. Never fails.
export function warmTasksBoard() {
  readTasksBoard().catch(() => {})
}

// Every machine's tasks. `since`: the version the client has; `{ same: true }` when nothing changed.
// Without it (the Board opening, or Refresh), each machine's plugin is checked afresh.
export async function readTasksBoard(since?: string): Promise<TasksBoard | { same: true, version: string }> {
  const machines = (await Promise.all(baseMachines().map(m => machineTasks(m, !since)))).filter((x): x is MachineTasks => x !== null)
  // What the Board shows, without when it was read: the same tasks read again are the same version.
  const version = createHash('sha1').update(JSON.stringify(machines, (k, v) => (k === 'at' || k === 'readAt' ? undefined : v))).digest('hex').slice(0, 16)
  return since === version ? { same: true, version } : { version, machines }
}

// The Board's tasks for the global search (shared/taskSearch.ts): the same
// list and cache as the Board, read once per search, with each task's
// description. A machine still read past `deadlineMs` gives its last list.
export async function searchableBoards(deadlineMs: number): Promise<SearchableBoard[]> {
  const machines = baseMachines()
  const answered = new Map<string, TaskRow[]>()
  const read = Promise.all(machines.map(m => machineTasks(m).then((r) => { answered.set(m.key, r?.tasks || []) }, () => {})))
  await Promise.race([read, after(deadlineMs)])
  return machines.map((m) => {
    const c = lists.get(m.key)
    const tasks = answered.get(m.key) ?? (c ? withKeys(m.key, c.tasks) : [])
    return { machine: m.key, tasks: tasks.map(row => ({ row, description: c?.descriptions?.get(row.id) || '' })) }
  })
}

// ---------------------------------------------------------------- one task
// The board a request names: a machine key of the Board (a base machine); a
// named session's key reaches its machine's board.
const boardOf = (machine: unknown) => boardMachine(machineFor(machine))

// The task's row as the last list has it; read again when that list was
// dropped (an action just ran) or never read.
async function taskOf(m: Machine, id: string): Promise<TaskRow | null> {
  const known = lists.get(m.key)
  const hit = known?.tasks.find(t => t.id === id)
  if (hit || (known && !known.error && Date.now() - known.at < REUSE_MS)) return hit || null
  return (await readList(m)).tasks.find(t => t.id === id) || null
}
// The machine's rows: the last list while it is fresh, else read again.
async function rowsOf(m: Machine): Promise<TaskRow[]> {
  const known = lists.get(m.key)
  if (known && !known.error && Date.now() - known.at < REUSE_MS) return known.tasks
  return (await readList(m)).tasks
}

function checkId(id: unknown): string {
  if (!isTaskId(id)) throw new HerdrError('bad_task', 'Invalid task')
  return id
}

export async function taskDetails(machine: unknown, id: unknown): Promise<TaskDetails & TaskPanes> {
  const m = boardOf(machine)
  const tid = checkId(id)
  const file = await readTaskFile(m, tid).catch(() => null)
  let d: TaskDetails = parseTaskDetails(await command(m, ['details', '--json', '--', tid], LIST_TIMEOUT_MS))
  // The closing note and whether it is archived: in the task's file only (1.2.1's `details` leaves them out).
  if (!d.summary && typeof file?.summary === 'string') d = { ...d, summary: file.summary.slice(0, 8000).trim() }
  if (!d.archived && file?.archivedAt) d = { ...d, archived: true }
  return { ...withStale(d, file), ...(file ? { identity: taskAgentIdentity(file) } : {}), pane: taskPane(m, file), reviewer: reviewerOf(m, file, d.stage) }
}

// Whether its failure is behind it: the task's file has when it last moved on.
function withStale(d: TaskDetails, file: Record<string, unknown> | null): TaskDetails {
  return { ...d, failureStale: failureIsStale(d.stage, d.failureAt, file) }
}

// The task's agent pane in Herdr: only the one the board linked it to (its
// task.json, read only, in the session it names), while Herdr shows it. No
// readable link, or a linked pane that is gone: no pane (the sheet opens). An
// agent working in the same folder is never taken for the task's.
function taskPane(m: Machine, file: Record<string, unknown> | null): string | null {
  const linked = linkedPane(m, file)
  return linked.pane && findPane(linked.pane) ? linked.pane : null
}

// The reviewer's pane while a review runs (1.x link.reviewer.pane, in the
// task's own session): the dialog of a review that needs you is there. Its pane
// even when Herdr does not show it now (the panel tells a closed pane from
// one it cannot reach); `pane: null`: its session is not open in wherdr.
function reviewerOf(m: Machine, file: Record<string, unknown> | null, stage: string): TaskReviewer | null {
  if (!REVIEW_STAGES.includes(stage || String(file?.stage ?? ''))) return null
  const link = file && typeof file.link === 'object' && file.link ? file.link as Record<string, unknown> : null
  const rv = link && typeof link.reviewer === 'object' && link.reviewer ? link.reviewer as Record<string, unknown> : null
  if (!rv || typeof rv.pane !== 'string' || !/^w[0-9a-z]+:p[0-9a-z]+$/i.test(rv.pane)) return null
  const key = sessionMachine(m, link!.socket)
  return { pane: key === null ? null : joinId(key, rv.pane) }
}

function forget(m: Machine) { lists.delete(m.key) }
// Tests start from an empty cache.
// `keepKeys`: the repos' keys stay (a later list without asking them again).
export function resetTasksCache(keepKeys = false) {
  lists.clear(); reading.clear(); queues.clear(); createdAt.clear(); versions.clear()
  if (!keepKeys) { repoKeys.clear(); keysReading.clear() }
}

export async function tellTask(machine: unknown, id: unknown, text: unknown): Promise<{ ok: true, msg: string }> {
  const m = boardOf(machine)
  const tid = checkId(id)
  const words = cleanTell(text)
  if (!words) throw new HerdrError('empty', 'Nothing to send')
  const row = await taskOf(m, tid)
  if (row && !taskActions(row).tell) throw new HerdrError('bad_action', 'This task has no agent to talk to')
  const out = await command(m, ['tell', '--', tid, words])
  forget(m)
  log(`herdr-projects tell ${tid}${m.local ? '' : ` on ${m.label}`}`)
  return { ok: true, msg: firstLine(out) }
}

// Description is opaque data: pass it unchanged as one argv item; the CLI owns normalization.
export async function describeTask(machine: unknown, id: unknown, text: unknown): Promise<{ ok: true, msg: string }> {
  const m = boardOf(machine)
  const tid = checkId(id)
  if (!m.local && m.status !== 'online') throw new HerdrError('offline', fmt('{machine} is unreachable', { machine: m.label }))
  if (typeof text !== 'string' || text.includes('\0')) throw new HerdrError('bad_action', 'Invalid description')
  const file = await readTaskFile(m, tid)
  if (file?.archivedAt || (await taskOf(m, tid))?.archived) throw new HerdrError('bad_action', 'Archived tasks are read-only')
  const out = await command(m, ['describe', '--', tid, text], ACTION_TIMEOUT_MS, true)
  forget(m)
  return { ok: true, msg: firstLine(out) }
}

export async function approveTask(machine: unknown, id: unknown, anyway: unknown = false): Promise<{ ok: true, msg: string }> {
  const m = boardOf(machine)
  const tid = checkId(id)
  const row = await taskOf(m, tid)
  if (!row || !taskActions(row).approve) throw new HerdrError('bad_action', 'This task does not wait for approval')
  if (anyway !== false && anyway !== true) throw new HerdrError('bad_action', 'Invalid approval')
  if (anyway && (!row || !taskCanApproveAnyway(row, await taskDetails(machine, id)))) throw new HerdrError('bad_action', 'This task cannot bypass approval checks')
  const out = await command(m, ['approve', ...(anyway ? ['--anyway'] : []), '--', tid])
  forget(m)
  log(`herdr-projects approve ${tid}${m.local ? '' : ` on ${m.label}`}`)
  return { ok: true, msg: firstLine(out) }
}

// One of the task commands that take only its id (`delegate`, `stop`,
// `retry`, `archive`), on a task the last list shows it applies to.
// `agent` (delegate only): start it with that agent, one installed on the
// task's machine, for this start only (shared delegateArgs); none: its default.
// It may name a model (`codex/gpt-6-sol`); `effort` a level (`--worker.effort`).
export async function taskCommand(machine: unknown, id: unknown, action: unknown, agent?: unknown, after?: unknown, effort?: unknown): Promise<{ ok: true, msg: string }> {
  const m = boardOf(machine)
  const tid = checkId(id)
  if (!isTaskCommand(action)) throw new HerdrError('bad_action', 'Unknown action')
  const chosen = agent === undefined || agent === null || agent === '' ? null : agent
  if (chosen !== null && action !== 'delegate') throw new HerdrError('bad_action', 'Only Start takes an agent')
  const level = effort === undefined || effort === null || effort === '' ? null : effort
  if (level !== null && (action !== 'delegate' || !isEffortName(level))) throw new HerdrError('bad_effort', 'Invalid effort')
  // Start after…: the tasks to wait for (`delegate --after`); the board checks them.
  const waits = after === undefined || after === null ? null : cleanAfterRefs(after)
  if (after !== undefined && after !== null && (!waits || action !== 'delegate')) throw new HerdrError('bad_after', 'Invalid tasks to wait for')
  if (chosen !== null && (!isAgentName(chosen) || !(await installedAgentKinds(m)).includes(agentKind(chosen)))) {
    throw new HerdrError('bad_agent', fmt('{agent} is not installed on {machine}', { agent: isAgentName(chosen) ? agentKind(chosen) : '?', machine: m.label }))
  }
  // An archived task is not in the list: its own row (`restore` only applies to it).
  const row = action === 'restore' ? await archivedRow(m, tid) : await taskOf(m, tid)
  // A failed task: what failed decides between Retry and Start (`details`).
  // `fix` also needs to know the failure is still current (its file).
  const failure = action === 'fix' || (row?.stage === 'failed' && (action === 'retry' || action === 'delegate'))
    ? withStale(parseTaskDetails(await command(m, ['details', '--json', '--', tid], LIST_TIMEOUT_MS)), action === 'fix' ? await readTaskFile(m, tid).catch(() => null) : null)
    : null
  const allowed = !row ? false
    : action === 'fix' ? taskCanFix(row, failure)
      : action === 'review' ? taskCanSendReview(row)
        : taskActions(row, failure)[action]
  if (!row || !allowed) throw refused(action)
  // A new start: an agent picked for an earlier one goes first, so the task
  // starts from its own default again (or from the one picked now).
  let prev: string | null = null
  let prevEffort: string | null = null
  if (action === 'delegate') {
    await restoreStartAgent(m, tid)
    if (chosen || level) {
      const show = await taskShow(m, tid)
      const own = parseWorkerAgent(show)
      prev = own?.place === 'task' ? own.value : null
      const ownEffort = parseWorkerEffort(show)
      prevEffort = ownEffort?.place === 'task' ? ownEffort.value : null
    }
  }
  const out = await command(m, action === 'delegate' ? delegateArgs(tid, chosen, waits, level) : [action, '--', tid], ACTION_TIMEOUT_MS, Boolean(chosen?.includes('/') || level))
  forget(m)
  const setAgent = chosen && chosen !== prev ? chosen : ''
  const setEffort = level && level !== prevEffort ? level : null
  if (setAgent || setEffort) await rememberStartAgent(startAgentKey(m.key, tid), { agent: setAgent, prev, ...(setEffort ? { effort: setEffort, prevEffort } : {}), at: Date.now() })
  log(`herdr-projects ${action} ${tid}${chosen ? ` --worker.agent=${chosen}` : ''}${level ? ` --worker.effort=${level}` : ''}${waits ? ` --after=${waits.join(',')}` : ''}${m.local ? '' : ` on ${m.label}`}`)
  return { ok: true, msg: firstLine(out) }
}

// Raising a task limit resumes it in the CLI; never follow this with retry.
export async function raiseTaskLimit(machine: unknown, id: unknown, name: unknown, value: unknown) {
  const m = boardOf(machine)
  const tid = checkId(id)
  if ((name !== 'limit.time' && name !== 'limit.tokens') || typeof value !== 'string' || !value.trim() || value.length > 40 || /[\r\n\0]/.test(value)) {
    throw new HerdrError('bad_action', 'Invalid settings')
  }
  const row = await taskOf(m, tid)
  if (!row || row.archived || row.stage !== 'stopped' || row.state !== 'blocked') throw refused('retry')
  const details = parseTaskDetails(await command(m, ['details', '--json', '--', tid], LIST_TIMEOUT_MS))
  if (!details.limits?.stopped || name !== `limit.${details.limits.stopped}`) throw new HerdrError('bad_action', 'Invalid settings')
  // CLI validates units and refuses invalid values without changing the task.
  const out = await command(m, ['set', name, value.trim(), '--task', tid])
  forget(m)
  return { ok: true, msg: firstLine(out) }
}

const taskShow = (m: Machine, id: string) => command(m, ['show', '--json', '--', id], LIST_TIMEOUT_MS)

// Pure read: unlike Start, this must never restore or modify an agent choice.
export async function taskSettings(machine: unknown, id: unknown) {
  const m = boardOf(machine)
  return parseTaskSettings(await taskShow(m, checkId(id)))
}

// ------------------------------------------------------------ board settings
// A machine's settings (Board › Board settings): the user's own (`show`), or
// one repo's entry (`show --repo R`), with the agent programs installed there.
function settingsRepo(repo: unknown): string {
  const r = repo === undefined || repo === null ? '' : repo
  if (typeof r !== 'string' || (r && (!cleanRepo(r) || r.startsWith('/') || r.startsWith('~')))) throw new HerdrError('bad_repo', 'Invalid repository')
  return r
}
// Bulk archive stays a single CLI operation: the CLI owns eligibility (including pins).
export async function archiveDoneTasks(machine: unknown, repo: unknown) {
  const m = boardOf(machine)
  const r = settingsRepo(repo)
  if (!r) throw new HerdrError('bad_repo', 'Invalid repository')
  const launcher = await launcherOf(m)
  try {
    const result = await serial(m.key, () => runner(m, launcher, ['archive', '--done', '--repo', r], ACTION_TIMEOUT_MS))
    return { ...result, machine: m.key }
  } finally { forget(m) }
}

async function readBoardSettings(m: Machine, repo: string): Promise<BoardSettings> {
  const [raw, agents] = await Promise.all([
    command(m, ['show', '--json', ...(repo ? [`--repo=${repo}`] : [])], LIST_TIMEOUT_MS, true),
    installedAgentKinds(m).catch(() => [] as string[]),
  ])
  let parsed
  try { parsed = parseBoardSettings(raw) }
  catch { throw new HerdrError('projects_failed', 'herdr-projects gave settings wherdr cannot read.') }
  return { ...parsed, repo, agents }
}
export async function boardSettings(machine: unknown, repo: unknown): Promise<BoardSettings> {
  return readBoardSettings(boardOf(machine), settingsRepo(repo))
}
// `set` or `unset` (for the user, or `--repo`), then the settings as
// herdr-projects now has them: nothing assumed from what was asked. A refusal
// is herdr-projects' own words (it names the nearest right value).
export async function changeBoardSetting(machine: unknown, b: Record<string, unknown>): Promise<BoardSettings & { msg: string }> {
  const m = boardOf(machine)
  const repo = settingsRepo(b.repo)
  let args: string[]
  try { args = settingArgs({ name: b.name, value: b.value, unset: b.unset, repo }) }
  catch (e) { throw new HerdrError('bad_value', (e as Error).message) }
  const out = await command(m, args, ACTION_TIMEOUT_MS, true)
  // board.agents and merge.* change what the Board shows next.
  forget(m)
  log(`herdr-projects ${args[0]} ${b.name}${repo ? ` --repo ${repo}` : ''}${m.local ? '' : ` on ${m.label}`}`)
  return { ...await readBoardSettings(m, repo), msg: firstLine(out) }
}

// Puts back what the task had before an agent was picked for one start, while
// its own worker.agent is still that pick (one set since by someone else stays).
async function restoreStartAgent(m: Machine, id: string): Promise<void> {
  const key = startAgentKey(m.key, id)
  const rec = await startAgentOf(key)
  if (!rec) return
  const show = await taskShow(m, id)
  const own = parseWorkerAgent(show)
  if (rec.agent && own?.place === 'task' && own.value === rec.agent) {
    await command(m, restoreAgentArgs(id, rec.prev))
    log(`herdr-projects ${rec.prev ? `set worker.agent ${rec.prev}` : 'unset worker.agent'} --task ${id} (after a start with ${rec.agent})${m.local ? '' : ` on ${m.label}`}`)
  }
  const ownEffort = rec.effort ? parseWorkerEffort(show) : null
  if (rec.effort && ownEffort?.place === 'task' && ownEffort.value === rec.effort) {
    await command(m, restoreAgentArgs(id, rec.prevEffort ?? null, 'worker.effort'))
    log(`herdr-projects ${rec.prevEffort ? `set worker.effort ${rec.prevEffort}` : 'unset worker.effort'} --task ${id} (after a start with ${rec.effort})${m.local ? '' : ` on ${m.label}`}`)
  }
  await dropStartAgent(key)
}

// After a list: the picks of runs now over are taken back, behind the Board's
// own commands. Only with a list read after the pick (`since`): an older one
// still shows the task as it was before its start.
async function restoreFinished(m: Machine, tasks: TaskRow[], since: number): Promise<void> {
  for (const [id, rec] of await startAgentsOf(m.key)) {
    const row = tasks.find(t => t.id === id)
    if (rec.at >= since || !row || !runOver(row)) continue
    await restoreStartAgent(m, id).catch(e => log(`herdr-projects: could not put back worker.agent of ${id}: ${(e as Error).message}`))
  }
}
// What Start offers on a task: the agent it starts with by default (`show <id>
// --json`: its worker.agent and where that comes from) and the agents
// installed on its machine.
export async function taskStartOptions(machine: unknown, id: unknown): Promise<StartOptions> {
  const m = boardOf(machine)
  const tid = checkId(id)
  const [show, agents] = await Promise.all([
    // The default as the next start will have it: an earlier pick put back first.
    restoreStartAgent(m, tid).then(() => taskShow(m, tid)),
    installedAgentKinds(m).catch(() => [] as string[]),
  ])
  return { agent: parseWorkerAgent(show), agents, slots: await slotsFor(m, show) }
}
// The models and effort levels a program takes on a machine (`models
// <program>`), kept a while by machine and program. An error, or no model
// read: Start offers the program alone (the caller says so, quietly).
const MODELS_KEEP_MS = 30 * 60_000
const modelsCache = new Map<string, { at: number, value: StartModels }>()
export function resetModelsCache() { modelsCache.clear() }
export async function taskStartModels(machine: unknown, program: unknown, refresh = false): Promise<StartModels> {
  const m = boardOf(machine)
  if (!isProgramName(program)) throw new HerdrError('bad_agent', 'Invalid agent')
  const key = `${m.key}|${program}`
  const kept = modelsCache.get(key)
  if (kept && !refresh && Date.now() - kept.at < MODELS_KEEP_MS) return kept.value
  const value = parseModels(await command(m, ['models', program], LIST_TIMEOUT_MS), program)
  if (value.models.length) modelsCache.set(key, { at: Date.now(), value })
  else modelsCache.delete(key)
  return value
}
// The board's slots as Start finds them: `board.agents` (the same `show`) and
// the tasks of its list. Not known: null (Start, as before).
async function slotsFor(m: Machine, show: string): Promise<TaskSlots | null> {
  const max = parseBoardAgents(show)
  if (max === null) return null
  return slotsOf(await rowsOf(m).catch(() => []), max)
}

// Stop waiting: `after --clear`. A task that waited goes on to a slot (it
// starts, or waits in the queue); one not delegated yet keeps nothing to wait for.
export async function clearTaskAfter(machine: unknown, id: unknown): Promise<{ ok: true, msg: string }> {
  const m = boardOf(machine)
  const tid = checkId(id)
  const row = await taskOf(m, tid)
  if (!row || row.archived) throw new HerdrError('bad_action', 'This task does not wait for other tasks')
  const out = await command(m, clearAfterArgs(tid))
  forget(m)
  log(`herdr-projects after ${tid} --clear${m.local ? '' : ` on ${m.label}`}`)
  return { ok: true, msg: firstLine(out) }
}

function refused(action: TaskCommand): HerdrError {
  switch (action) {
    case 'delegate': return new HerdrError('bad_action', 'This task cannot be started now')
    case 'stop': return new HerdrError('bad_action', 'This task has no agent at work to stop')
    case 'fix': return new HerdrError('bad_action', 'This failure needs the human first')
    case 'retry': return new HerdrError('bad_action', 'This task has nothing to retry')
    case 'review': return new HerdrError('bad_action', 'This task has no failed review to send back')
    case 'finish': return new HerdrError('bad_action', 'This task has nothing to finish as it is')
    case 'archive': return new HerdrError('bad_action', 'This task cannot be archived while an agent works on it')
    case 'restore': return new HerdrError('bad_action', 'This task is not archived')
  }
}

// An archived task's row: from its file (read only), else from the archived list.
async function archivedRow(m: Machine, id: string): Promise<TaskRow | null> {
  const file = await readTaskFile(m, id).catch(() => null)
  const row = file ? rowFromTaskFile(file, null) : null
  if (row) return row
  return (await archivedList(m)).find(t => t.id === id) || null
}

// The archived tasks of a machine's board (`list --json --archived`), newest first. Not cached: asked when the Board's
// "Archived" is opened, or for one task.
async function archivedList(m: Machine): Promise<TaskRow[]> {
  return parseTaskList(await command(m, ['list', '--json', '--archived'], LIST_TIMEOUT_MS)).filter(t => t.archived)
}
export async function archivedTasks(machine: unknown): Promise<{ machine: string, tasks: TaskRow[] }> {
  const m = boardOf(machine)
  const tasks = (await archivedList(m)).sort((a, b) => b.n - a.n || a.repo.localeCompare(b.repo))
  void readKeys(m, tasks.map(t => t.repo)).catch(() => {})
  return { machine: m.key, tasks: withKeys(m.key, tasks) }
}

// A new task (`add`): in a repo the board knows (its name or its folder), or
// in the home folder; `delegate` puts an agent on it at once.
export async function addTask(machine: unknown, b: { title?: unknown, description?: unknown, repo?: unknown, delegate?: unknown, type?: unknown, planApprove?: unknown }): Promise<{ ok: true, msg: string }> {
  const m = boardOf(machine)
  const title = cleanTitle(b.title)
  if (!title) throw new HerdrError('empty', 'A task needs a title')
  const repo = cleanRepo(b.repo)
  if (repo === null) throw new HerdrError('bad_repo', 'Invalid repo')
  const type = cleanTaskType(b.type)
  if (type === null) throw new HerdrError('bad_type', 'Invalid task type')
  if (b.planApprove !== undefined && !isPlanApproval(b.planApprove)) throw new HerdrError('bad_plan', 'Invalid plan approval')
  const out = await command(m, addArgs({ planApprove: b.planApprove, type, title, description: cleanTell(b.description), repo, delegate: b.delegate === true }))
  forget(m)
  log(`herdr-projects add${b.delegate === true ? ' --delegate' : ''}${m.local ? '' : ` on ${m.label}`}`)
  return { ok: true, msg: firstLine(out) }
}

// A message to one of the machine's coordinators (the agent behind the
// board's box): its Coordinator by default, the machine coordinator, or a
// repo's project coordinator. It turns it into tasks; `delegate` puts an agent
// on each task it adds. Started by herdr-projects when it is not running, in
// the machine's own session.
// The pane a coordinator talks in, as herdr-projects keeps it: asked in the
// board's own session (where `coordinator tell` starts it), so its pane id is
// that session's, and only a pane Herdr shows there now. `pane: null`: not
// started, starting, or gone (its first message starts it). `error`: why its
// last start failed (it waits for Try again, `restartCoordinator`).
export async function coordinatorPane(machine: unknown, to: unknown): Promise<CoordinatorStatus> {
  const m = boardOf(machine)
  const target = cleanTarget(to)
  if (!target) throw new HerdrError('bad_target', 'Invalid coordinator')
  const st = parseCoordinatorStatus(await command(m, coordinatorStatusArgs(target), LIST_TIMEOUT_MS))
  const pane = st.pane ? joinId(m.key, st.pane) : null
  return { ...st, pane: pane && findPane(pane) ? pane : null }
}

// Try again after a failed start: `coordinator restart` clears the error
// herdr-projects kept and starts it, with the words still waiting.
export async function restartCoordinator(machine: unknown, to: unknown): Promise<{ ok: true, msg: string }> {
  const m = boardOf(machine)
  const target = cleanTarget(to)
  if (!target) throw new HerdrError('bad_target', 'Invalid coordinator')
  const out = await command(m, coordinatorRestartArgs(target))
  forget(m)
  log(`herdr-projects coordinator${target.kind === 'main' ? '' : ` (${target.kind === 'project' ? target.repo : 'machine'})`} restart${m.local ? '' : ` on ${m.label}`}`)
  return { ok: true, msg: firstLine(out) }
}

// ---------------------------------------------------------------- a project's folder
// What a machine says of a folder picked for a project coordinator: on its
// board already (by name), to be added, missing, or not a Git repository.
function lookFolder(m: Machine, folder: string): Promise<string> {
  if (m.exec) return m.exec(PROJECT_FOLDER_SCRIPT, [folder], { timeoutMs: 10_000 }).then(r => r.stdout.toString('utf8'))
  return new Promise((resolve, reject) => execFile('sh', ['-c', PROJECT_FOLDER_SCRIPT, 'sh', folder], { timeout: 10_000, maxBuffer: 64 * 1024 },
    (e, out) => (e ? reject(e) : resolve(String(out || '')))))
}
async function readRepos(m: Machine): Promise<unknown> {
  try { return JSON.parse(await m.fs.readFile(path.posix.join(m.home, '.herdr-projects/data/repos.json'))) }
  catch (e) { if (missing(e)) return {}; throw e }
}
async function folderState(m: Machine, folder: string): Promise<ProjectFolder> {
  const repo = cleanRepo(folder)
  if (!repo || !isFolderRef(repo)) throw new HerdrError('bad_repo', 'Invalid repo')
  return projectFolderOf(parseFolderLook(await lookFolder(m, repo)), await readRepos(m))
}
export async function projectFolder(machine: unknown, folder: unknown): Promise<ProjectFolder> {
  return folderState(boardOf(machine), typeof folder === 'string' ? folder : '')
}

// A project coordinator's repo by its name on the board, the folder added to
// the board first when it does not know it. herdr-projects 1.2.26 has no
// command that only adds a repo (`set --repo` refuses one it does not know).
// `automations add --repo <root>` names it on first sight without making a
// task (a task would be an "added" event other automations may fire on, and
// take the repo's number 1); it is removed at once. Its trigger cannot fire in
// between: a merge of a task of this repo, which has none.
export async function registerProject(machine: unknown, folder: unknown): Promise<{ repo: string, root: string, added: boolean }> {
  const m = boardOf(machine)
  const f = await folderState(m, typeof folder === 'string' ? folder : '')
  if (f.state === 'missing') throw new HerdrError('folder_missing', FOLDER_MISSING)
  if (f.state === 'notgit') throw new HerdrError('folder_not_git', FOLDER_NOT_GIT)
  if (f.state === 'known') return { repo: f.repo, root: f.root, added: false }
  const name = `wherdr-add-repo-${randomBytes(4).toString('hex')}`
  await command(m, ['automations', 'add', `--prompt=${REGISTER_PROMPT}`, '--when=merged', `--repo=${f.root}`, '--', name])
  try { await command(m, ['automations', 'remove', '--', name]) }
  catch (e) { throw new HerdrError('projects_failed', fmt('The repository is on the board now, but the automation {name} that added it could not be removed: {why}', { name, why: (e as Error).message })) }
  forget(m)
  const repo = repoNameOf(await readRepos(m), f.root)
  if (!repo) throw new HerdrError('projects_failed', 'herdr-projects did not add the repository to the board.')
  log(`herdr-projects: repo ${repo} added${m.local ? '' : ` on ${m.label}`}`)
  return { repo, root: f.root, added: true }
}

export async function tellCoordinator(machine: unknown, text: unknown, opts: { to?: unknown, delegate?: unknown, start?: unknown } = {}): Promise<{ ok: true, msg: string, repo?: string }> {
  const m = boardOf(machine)
  const words = cleanTell(text)
  if (!words) throw new HerdrError('empty', 'Nothing to send')
  let to = cleanTarget(opts.to)
  if (!to) throw new HerdrError('bad_target', 'Invalid coordinator')
  // A folder (an older New sheet, a link): its repo on the board, added first.
  if (to.kind === 'project' && isFolderRef(to.repo)) to = { kind: 'project', repo: (await registerProject(m.key, to.repo)).repo }
  if (opts.start !== undefined) {
    const start = opts.start as { agent?: unknown, effort?: unknown } | null
    if (!start || typeof start.agent !== 'string' || !/^[a-z][a-z0-9-]*(?:\/[A-Za-z0-9._/-]+)?$/.test(start.agent) || start.agent.length > 160
      || (start.effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(String(start.effort)))) {
      throw new HerdrError('bad_agent', 'Invalid agent')
    }
    if (to.kind !== 'project') throw new HerdrError('bad_target', 'Invalid coordinator')
    // Never reset an existing conversation, including a stopped or failed one.
    const status = parseCoordinatorStatus(await command(m, coordinatorStatusArgs(to), LIST_TIMEOUT_MS))
    if (status.state === 'none' && !status.pane && !status.error) {
      await command(m, ['coordinator', `--project=${to.repo}`, `--agent=${start.agent}`, ...(start.effort ? [`--effort=${start.effort}`] : []), '--', 'new'])
    }
  }
  const out = await command(m, coordinatorArgs(to, words, opts.delegate === true))
  forget(m)
  log(`herdr-projects coordinator${to.kind === 'main' ? '' : ` (${to.kind === 'project' ? to.repo : 'machine'})`} tell${opts.delegate === true ? ' --delegate' : ''}${m.local ? '' : ` on ${m.label}`}`)
  return { ok: true, msg: firstLine(out), ...(to.kind === 'project' ? { repo: to.repo } : {}) }
}

// Questions only: target and context come from the task on its owning board.
// Never pass delegation flags or invoke a task action here.
export async function askTaskCoordinator(machine: unknown, id: unknown, text: unknown) {
  const tid = checkId(id)
  const words = cleanTell(text).slice(0, TASK_QUESTION_MAX)
  if (!words) throw new HerdrError('empty', 'Nothing to send')
  const task = await taskDetails(machine, tid)
  return tellCoordinator(machine, `Question about task ${tid}: “${task.title}”. References to “it” or “this task” mean this task. Answer the question only; do not start, delegate or change any task.\n\n${words}`, { to: { kind: 'project', repo: tid.split('/')[0] } })
}

// Re-read the owning board before a human pick; never use the recommendation as a default.
export async function pickTask(machine: unknown, id: unknown, letter: unknown, confirmed: unknown) {
  const m = boardOf(machine)
  const tid = checkId(id)
  if (confirmed !== true || typeof letter !== 'string' || !/^[A-E]$/.test(letter)) throw new HerdrError('bad_action', 'Invalid attempt choice')
  const details = await taskDetails(machine, tid)
  if (details.id !== tid || !canPickAttempt(details, letter)) throw new HerdrError('bad_action', 'This attempt cannot be chosen')
  const out = await command(m, ['pick', '--', tid, letter])
  forget(m)
  return { ok: true, msg: firstLine(out) }
}

// ---------------------------------------------------------------- autopilot
// Autopilot runs on the same machine as the coordinator's commands. The state
// shown is always read back from `autopilot --json`, never assumed.
// The program's version, asked again after a while (it can be updated).
const VERSION_TTL_MS = 5 * 60_000
const versions = new Map<string, { version: string | null, at: number }>()
async function needsAutopilot(m: Machine) {
  let known = versions.get(m.key)
  if (!known || Date.now() - known.at > VERSION_TTL_MS) {
    known = { version: await projectsProgramVersion(m), at: Date.now() }
    versions.set(m.key, known)
  }
  const version = known.version
  if (!versionAtLeast(version, AUTOPILOT_MIN)) {
    throw new HerdrError('projects_too_old', fmt('Autopilot needs herdr-projects {min} or later on {machine} (it has {version}).', { min: AUTOPILOT_MIN, machine: m.label, version: version ?? '?' }))
  }
}
async function autopilotList(m: Machine): Promise<Record<string, AutopilotStatus>> {
  try { return parseAutopilotList(await command(m, ['autopilot', '--json'], LIST_TIMEOUT_MS)) }
  catch (e) {
    if (e instanceof HerdrError) throw e
    throw new HerdrError('projects_failed', 'herdr-projects gave an Autopilot status wherdr cannot read.')
  }
}

// Every coordinator of a machine, by its autopilot id ("main", "machine", "project:<repo>").
export async function autopilotStatuses(machine: unknown): Promise<Record<string, AutopilotStatus>> {
  const m = boardOf(machine)
  await needsAutopilot(m)
  return autopilotList(m)
}

// One coordinator, with its saved goal and the values `on` falls back on.
// `input`: turn it on ({ action: 'on', goal, every?, tasksPerDay?, tasksAtOnce? }) or off first.
export async function coordinatorAutopilot(machine: unknown, to: unknown, input?: Record<string, unknown>): Promise<AutopilotDetails> {
  const m = boardOf(machine)
  const target = cleanTarget(to)
  if (!target) throw new HerdrError('bad_target', 'Invalid coordinator')
  let args: string[] | undefined
  if (input) {
    if (input.action !== 'on' && input.action !== 'off') throw new HerdrError('bad_action', 'Invalid Autopilot action.')
    try { args = input.action === 'on' ? autopilotOnArgs(target, input) : ['autopilot', 'off', ...autopilotTargetArgs(target)] }
    catch (e) { throw new HerdrError('bad_value', (e as Error).message) }
  }
  await needsAutopilot(m)
  if (args) await command(m, args, ACTION_TIMEOUT_MS, true)
  const status = (await autopilotList(m))[autopilotId(target)] ?? OFF
  let saved = { goal: '', defaults: { every: '', tasksPerDay: '', tasksAtOnce: '' } }
  try { saved = parseCoordinatorSettings(await command(m, ['show', ...coordinatorShowArgs(target), '--json'], LIST_TIMEOUT_MS)) }
  catch { /* the status still stands without its saved settings */ }
  return { ...status, goal: status.goal || saved.goal, defaults: saved.defaults }
}

// Read only, requested when the Scheduled disclosure opens or the board refreshes.
export async function coordinatorScheduled(machine: unknown, to: unknown): Promise<Scheduled> {
  const m = boardOf(machine)
  const target = cleanTarget(to)
  if (!target) throw new HerdrError('bad_target', 'Invalid coordinator')
  const out: Scheduled = { autopilot: null, automations: [], timers: [], timezone: 'UTC', warnings: [] }
  try {
    if (m.local) out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    else {
      const r = await m.exec!('if [ -f /etc/timezone ]; then cat /etc/timezone; else readlink /etc/localtime; fi', [], { timeoutMs: 4000, maxBytes: 1024 })
      const zone = r.stdout.toString('utf8').trim().replace(/^.*zoneinfo\//, '')
      new Intl.DateTimeFormat('en', { timeZone: zone }).format()
      out.timezone = zone
    }
  } catch { out.warnings.push('Machine time zone unavailable; using UTC') }
  try { out.autopilot = parseAutopilot(await command(m, ['autopilot', '--json'], LIST_TIMEOUT_MS), target) }
  catch { out.warnings.push('Autopilot unavailable') }
  try {
    out.automations = parseAutomations(await command(m, ['automations', '--json'], LIST_TIMEOUT_MS), target)
    for (const automation of out.automations) {
      if (!/^[a-f0-9]{8}$/.test(automation.id)) continue
      try {
        const file = path.posix.join(m.home, '.herdr-projects/data/automations/firings', `${automation.id}.jsonl`)
        const stat = await m.fs.stat(file)
        if (stat.size > 1024 * 1024) continue
        const lines = (await m.fs.readFile(file)).trim().split('\n').slice(-5)
        const tasks = lines.flatMap(line => {
          try { const f = JSON.parse(line); return typeof f.task === 'string' && isTaskId(f.task) ? [f.task] : [] }
          catch { return [] }
        }).reverse()
        automation.tasks = [...new Set(tasks)]
      } catch { /* The list still carries the latest task on older installs. */ }
    }
  }
  catch { out.warnings.push('Automations unavailable') }
  try {
    // Raw state supplements the human-readable CLI dates without changing it.
    const folder = path.posix.join(m.home, '.herdr-projects/data/coordinator', m.session || 'default',
      ...(target.kind === 'machine' ? ['machine'] : target.kind === 'project' ? ['projects', target.repo] : []))
    const state = JSON.parse(await m.fs.readFile(path.posix.join(folder, 'state.json')))
    if (out.autopilot?.on && state.autopilot) {
      const p = state.autopilot
      const next = autopilotNextAt(p.timerAt, out.autopilot)
      if (next) out.autopilot.next = next
      if (Array.isArray(p.wakes) && p.wakes.length) out.autopilot.last = Math.max(...p.wakes.map((w: { at?: number }) => w.at || 0)) || out.autopilot.last
    }
  } catch { /* Older board versions need only the CLI. */ }
  try {
    const status = await coordinatorPane(machine, target)
    const pane = status.pane ? findPane(status.pane) : undefined
    if (pane?.agent === 'claude') {
      const owner = machineOfPane(pane.id)
      const loc = owner && await owner.transcripts.locate(pane)
      if (owner && loc) {
        out.timers = await readSessionTimers(owner.fs, loc.file, Date.now(), out.timezone)
      }
    }
  } catch { out.warnings.push('Session timers unavailable') }
  return out
}
