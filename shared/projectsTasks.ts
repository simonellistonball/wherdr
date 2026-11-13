// herdr-projects 1.x: one task board per machine, read through its own CLI
// (`list --json`, `details <id> --json`; checked against 1.2.1). Pure
// functions, tested in tests/projectsTasks.test.ts with recorded output.
//
// Nothing here trusts the output: every field is checked and bounded, and an
// unknown field is dropped, so a newer 1.x can add fields without breaking it.

import { type TasksBackend, beadActions } from './beadsTasks'

// The board's five groups, in the order they need you (1.x: shown/states.rs).
export type TaskGroup = 'needs' | 'ready' | 'working' | 'todo' | 'done'
export const TASK_GROUPS: readonly TaskGroup[] = ['needs', 'ready', 'working', 'todo', 'done']

export interface TaskReview {
  pass: boolean | null // null: a review from before the gate, with no verdict we can read
  tally: string // "1 critical, 1 minor" (the board's own words)
  by: string
}

export interface TaskRow {
  id: string // `<repo>/<n>`
  repo: string
  n: number
  state: string // idle | working | blocked | done | error
  kind: string // question | permission | auth, when it waits for you
  stage: string
  title: string
  msg: string
  identity?: TaskAgentIdentity
  app: string // the agent program on it (claude, codex, …)
  progress: number | null
  eta: number | null
  pr: string // the pull request URL, or ''
  review: TaskReview | null
  reviewRound: number
  chat?: boolean // CLI `chat`: effective chat.only, distinct from a task-file chat exchange.
  research: boolean
  archived: boolean
  queue: number | null
  group: TaskGroup
  approvalBlocked?: boolean
  // Its repo's short key (`repo.key`, 1.x store/keys.rs), once read: `APP`
  // names this task `APP-6`. Not in `list --json`: wherdr asks `show --repo`.
  repoKey?: string
  // When it was made (ms, the task file's `created`): orders Done across
  // machines. Not in `list --json`: wherdr reads it from the task's file.
  created?: number
  // A partial read kept this row from an earlier one (when it was read, in ms).
  stale?: boolean
  readAt?: number
  // The backend the row comes from (shared/beadsTasks.ts); none: herdr-projects.
  backend?: TasksBackend
  // beads only: its priority (0 highest … 4) and issue type (task, bug, feature…).
  priority?: number
  type?: string
}

export interface TaskAttempt { letter: string, agent: string, standing: string, stage: string, stat: string }
export interface TaskComparison { pick: string, why: string, error: string, notes: Record<string, string> }

export interface TaskHandover { at: number | null, role: string, from: string, to: string, why: string }

export interface TaskDetails {
  handovers?: TaskHandover[]
  attempts?: TaskAttempt[]
  comparison?: TaskComparison | null
  id: string
  title: string
  stage: string
  msg: string
  description: string
  agent: string
  identity?: TaskAgentIdentity
  pr: string
  branch: string
  worktree: string
  failure: string
  // What failed (1.x `failure.stage`: start, setup, send, agent, workflow,
  // pr, merge, attempts…) and whether a login stopped it: what Retry needs.
  failureTitle?: string
  failureDetail?: string
  failureNext?: string
  failureCanFix?: boolean
  failureRemoteKind?: string
  failureSent?: boolean
  // When the board recorded it (ms), and whether the task moved on since: a
  // later stage, or its agent started again (failureIsStale). A stale one is
  // history, not where the task stands.
  failureAt?: number | null
  failureStale?: boolean
  // `details.limits` (1.2.16+): each limit as the board writes it (`2h`, `30m`
  // tokens, `none`), the time this run has taken and the task's tokens, and
  // which limit stopped it. For the gauges, when the CLI gives them:
  // `timeUsedMs` (this run, or the run the time limit stopped), `tokensCounted`
  // (the tokens counted against `limit.tokens`) and `stoppedUsed` (what was
  // used at the stop: ms or tokens).
  limits?: { time: string, timeUsed: string, tokens: string, tokensUsed: number | null, stopped?: 'time' | 'tokens', timeUsedMs?: number, tokensCounted?: number, stoppedUsed?: number }
  // `preexisting`: there before the task (1.x gate.rs), not what it must fix.
  findings?: { severity: string, title: string, detail: string, preexisting?: boolean }[]
  failureStage: string
  failureAuth: boolean
  // The agent's closing note (task.json `summary`: 1.2.1's `details` leaves
  // it out, so the server reads it from the task's file) and, for research, its
  // report (`details.report`: the file's name, its link when it is https).
  summary: string
  report: { file: string, link: string } | null
  review: TaskReview | null
  reviewRounds: number
  plan: string
  chat?: boolean // CLI `chat`: effective chat.only, distinct from a task-file chat exchange.
  research: boolean
  // Put away (`archivedAt`): 1.2.1's `details` leaves it out, so the server
  // reads it from the task's file, as the closing note.
  archived: boolean
  // What it waits for before it starts (`delegate --after`, 1.x after.rs), and
  // its place in the queue for a free slot (1 gets the next one).
  after?: TaskWait | null
  queue?: number | null
  // beads only: the issue as beads keeps it.
  bead?: BeadInfo
}
export interface BeadInfo { id: string, status: string, priority: number, type: string, assignee: string, labels: string[], comments: number }

// The panes wherdr adds to `details`: its agent's, and its reviewer's while a
// review runs (1.x `reviewing`, or `reviewneeds` when the reviewer shows a
// dialog). A reviewer's `pane: null`: its session is not open in wherdr.
export interface TaskReviewer { pane: string | null }
export const REVIEW_STAGES: readonly string[] = ['reviewing', 'reviewneeds']
export type TaskPanes = { pane: string | null, reviewer?: TaskReviewer | null }

// Identity stays with the worker, even when `app` names the active helper.
export interface TaskAgentIdentity { agent: string, reviewer: string, from: string }
export function taskAgentIdentity(value: unknown): TaskAgentIdentity {
  const r = obj(value)
  const program = (v: unknown) => str(v, 160).split('/')[0] || ''
  const current = str(r?.on, 160) || str(r?.agent, 160) || str(r?.app, 160)
  const handovers = Array.isArray(r?.handovers) ? r.handovers : []
  const last = [...handovers].reverse().map(obj).find(h => h?.role === 'worker')
  return {
    agent: program(current),
    reviewer: REVIEW_STAGES.includes(str(r?.stage, 30)) ? program(obj(obj(r?.link)?.reviewer)?.kind) : '',
    from: last && last.to === current ? program(last.from) : '',
  }
}

// A task's wait (1.x `details` `after`): the tasks it waits for (`waitsFor`,
// ids, `machine:repo/n` for another machine's), those not done yet (`left`),
// whether it waits now (stage `after`; else it is to wait once delegated), and
// why it waits for you instead (one of them failed, was stopped…).
export interface TaskWait { waitsFor: string[], left: string[], waiting: boolean, forYou: string, titles: Record<string, string> }

// What wherdr can do on a task: 1.x `tell`, `approve`, `delegate`, `stop`,
// `retry`, `finish`, `archive`, `restore` (and its pane in Herdr).
export interface TaskActions { tell: boolean, approve: boolean, delegate: boolean, stop: boolean, retry: boolean, finish: boolean, archive: boolean, restore: boolean }
// The task commands that take nothing but the task's id. `review`: the
// reviewer's findings back to the agent (taskCanSendReview).
export const TASK_COMMANDS = ['delegate', 'stop', 'retry', 'finish', 'fix', 'review', 'archive', 'restore'] as const
export type TaskCommand = typeof TASK_COMMANDS[number]
export const isTaskCommand = (v: unknown): v is TaskCommand => TASK_COMMANDS.includes(v as TaskCommand)
export const NO_ACTIONS: TaskActions = { tell: false, approve: false, delegate: false, stop: false, retry: false, finish: false, archive: false, restore: false }

// One board per machine (its HOME): the named sessions of a machine share it.
export interface MachineTasks {
  machine: string // the base machine's key
  // What the board is (none: herdr-projects). A beads board has no
  // coordinators, autopilot, reviews or merges.
  backend?: TasksBackend
  // herdr-projects there (shared/projectsPlugin.ts): only `ready` has tasks.
  // `error`: Herdr did not answer, so it is not known.
  status: 'missing' | 'old' | 'shepherdr' | 'disabled' | 'ready' | 'error'
  version: string
  tasks: TaskRow[]
  // When `tasks` were read (ms). With `error` or `stale`: kept from that read.
  at?: number
  error?: string
  stale?: boolean
  // Still being read (the list past the deadline, or its repos' keys): ask again soon.
  pending?: boolean
}
export interface TasksBoard { version: string, machines: MachineTasks[] }
export type TasksReply = TasksBoard | { same: true, version: string }

const MAX_TASKS = 500
// `<repo>/<n>` (herdr-projects), or `<repo>/<bead id>` (beads: `hub-ozxp.32`).
const ID_RE = /^[A-Za-z0-9][\w.-]{0,79}\/(?:\d{1,7}|[A-Za-z][A-Za-z0-9_]{0,30}-[A-Za-z0-9][A-Za-z0-9.]{0,40})$/
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null)

export function isTaskId(v: unknown): v is string {
  return typeof v === 'string' && ID_RE.test(v)
}

// A task as herdr-projects names it (store/keys.rs tag_of): its repo's key and
// its number, `APP-6` for `demo-app/6`; `#6` while the key is not known.
// A bead is named by its own id (`hub-ozxp.32`).
export const taskKey = (id: string, repoKey?: string | null) => {
  const n = id.split('/')[1] || ''
  if (!/^\d*$/.test(n)) return n
  return repoKey ? `${repoKey}-${n}` : `#${n}`
}

// A repo's key: 2 to 5 letters or digits, the first a letter, in capitals.
const REPO_KEY_RE = /^[A-Z][A-Z0-9]{1,4}$/
// `show --repo <name> --json`: the `repo.key` row. A key another repo has or
// had is not used: its note names the stand-in the tasks go by, if any.
export function parseRepoKey(text: string): string {
  let v: unknown
  try { v = JSON.parse(text) } catch { return '' }
  const rows = obj(v)?.settings
  const row = Array.isArray(rows) ? rows.map(obj).find(r => r?.name === 'repo.key') : null
  if (!row) return ''
  const note = str(row.note, 300)
  const standIn = /its tasks go by ([A-Z][A-Z0-9]{1,4})\b/.exec(note)
  if (standIn) return standIn[1]!
  if (note.startsWith('not used')) return ''
  const key = str(row.value, 10)
  return REPO_KEY_RE.test(key) ? key : ''
}

// From `data/repo-keys.json` (store/keys_given.rs): every key a repo went by (`had`, key -> repo, in the order they
// were recorded: the last is the latest) and the stand-ins (`standIn`, repo -> key).
export function repoKeysFromFile(text: string): Record<string, string> {
  let v: unknown
  try { v = JSON.parse(text) } catch { return {} }
  const o = obj(v)
  const out: Record<string, string> = {}
  for (const [key, repo] of Object.entries(obj(o?.had) || {})) if (typeof repo === 'string' && REPO_KEY_RE.test(key)) out[repo] = key
  for (const [repo, key] of Object.entries(obj(o?.standIn) || {})) if (typeof key === 'string' && REPO_KEY_RE.test(key)) out[repo] = key
  return out
}

// Only an https link is kept: the card opens it in a new tab.
export function cleanUrl(v: unknown): string {
  const s = str(v, 400)
  return /^https:\/\/[^\s"'<>]+$/i.test(s) ? s : ''
}

// `#7` from a GitHub pull request link, else '' (the card then says "PR").
export function prNumber(url: string): string {
  const m = /\/pull\/(\d{1,7})(?:[/?#]|$)/.exec(url)
  return m ? `#${m[1]}` : ''
}

const SEVERITIES = ['critical', 'major', 'minor', 'trivial'] as const

// The review as the board counts it: findings by severity, those that were
// there before the task apart (1.x: gate.rs tally).
export function parseReview(v: unknown): TaskReview | null {
  const rv = obj(v)
  if (!rv || rv.stale === true) return null
  const by = str(rv.by, 40)
  if (Array.isArray(rv.findings) && typeof rv.meets === 'boolean') {
    const findings = rv.findings.slice(0, 200).map(obj).filter(Boolean) as Record<string, unknown>[]
    const open = findings.filter(f => f.preexisting !== true)
    const parts: string[] = []
    for (const s of SEVERITIES) {
      const n = open.filter(f => (SEVERITIES.includes(f.severity as typeof SEVERITIES[number]) ? f.severity : 'major') === s).length
      if (n) parts.push(`${n} ${s}`)
    }
    const pre = findings.length - open.length
    if (pre) parts.push(`${pre} pre-existing`)
    return { pass: rv.pass === true ? true : rv.pass === false ? false : null, tally: parts.join(', '), by }
  }
  if (typeof rv.error === 'string') return { pass: false, tally: str(rv.error, 200), by }
  const score = num(rv.score)
  if (score !== null) return { pass: rv.recommend === false ? false : rv.recommend === true ? true : null, tally: `${score}/5`, by }
  return null
}

// The group the 1.x board puts a row in (shown/states.rs: group_of). The list
// needs the task file's merge/sync blockers too, absent from the CLI list.
export function groupOf(r: Pick<TaskRow, 'state' | 'kind' | 'stage' | 'review' | 'approvalBlocked'>): TaskGroup {
  const awaitsYes = r.state === 'blocked' && r.kind === 'permission' && r.stage === 'approval'
  if (awaitsYes && !r.approvalBlocked && r.review?.pass !== false) return 'ready'
  if (r.state === 'blocked' || r.state === 'error') return 'needs'
  if (r.state === 'working') return 'working'
  if (r.state === 'done') return 'done'
  return 'todo'
}

export function parseTaskRow(v: unknown): TaskRow | null {
  const t = obj(v)
  if (!t || !isTaskId(t.id)) return null
  const [repo, n] = t.id.split('/') as [string, string]
  const progress = num(t.progress)
  const row: Omit<TaskRow, 'group'> = {
    id: t.id, repo, n: Number(n),
    state: str(t.state, 20), kind: str(t.kind, 20), stage: str(t.stage, 30),
    title: str(t.title, 300), msg: str(t.msg, 1000), app: str(t.app, 40),
    ...(obj(t.identity) ? { identity: { agent: str(obj(t.identity)?.agent, 40), reviewer: str(obj(t.identity)?.reviewer, 40), from: str(obj(t.identity)?.from, 40) } } : {}),
    progress: progress === null ? null : Math.max(0, Math.min(100, Math.round(progress))),
    eta: num(t.eta),
    pr: cleanUrl(t.pr),
    review: parseReview(t.review),
    reviewRound: Math.max(0, Math.floor(num(t.reviewRound) ?? 0)),
    chat: t.chat === true,
    research: t.research === true,
    archived: Boolean(t.archivedAt),
    queue: num(t.queue),
    ...(num(t.created) !== null ? { created: num(t.created)! } : {}),
    ...(t.mergeFailed || t.syncBlocked || t.prFailure || t.prState === 'failing' ? { approvalBlocked: true } : {}),
  }
  return { ...row, group: groupOf(row) }
}

// `list --json`: an array of rows. Anything else is refused, not guessed.
export function parseTaskList(text: string): TaskRow[] {
  let v: unknown
  try { v = JSON.parse(text) } catch { throw new Error('herdr-projects list: not JSON') }
  if (!Array.isArray(v)) throw new Error('herdr-projects list: not a list')
  return v.slice(0, MAX_TASKS).map(parseTaskRow).filter((r): r is TaskRow => r !== null)
}

// A failure is an object with words in it, or plain words.
function failureText(v: unknown): string {
  if (typeof v === 'string') return v.slice(0, 2000)
  const f = obj(v)
  if (!f) return ''
  for (const k of ['msg', 'message', 'error', 'words', 'text', 'why']) if (typeof f[k] === 'string' && f[k]) return (f[k] as string).slice(0, 2000)
  return ''
}

function parseTaskLimits(v: unknown): TaskDetails['limits'] {
  const limits = obj(v)
  if (!limits) return undefined
  const time = obj(limits.time)
  const tokens = obj(limits.tokens)
  // 1.2.16 omits time.used after stopping; stopped.used is milliseconds.
  const stopped = obj(limits.stopped)
  const usedMs = stopped?.what === 'time' ? num(stopped.used) : null
  const seconds = usedMs === null ? null : Math.round(Math.max(0, usedMs) / 1000)
  const stoppedTime = seconds === null ? '' : seconds >= 3600
    ? `${Math.floor(seconds / 3600)}h${Math.floor(seconds % 3600 / 60) ? `${Math.floor(seconds % 3600 / 60)}m` : ''}`
    : seconds >= 60 ? `${Math.floor(seconds / 60)}m${seconds % 60 ? `${seconds % 60}s` : ''}` : `${seconds}s`
  const timeUsedMs = num(time?.usedMs) ?? usedMs
  const tokensCounted = num(tokens?.used) ?? num(tokens?.total)
  const stoppedUsed = stopped?.what === 'time' || stopped?.what === 'tokens' ? num(stopped.used) : null
  return {
    ...(stopped?.what === 'time' || stopped?.what === 'tokens' ? { stopped: stopped.what } : {}),
    time: str(time?.limit, 40), timeUsed: str(time?.used, 40) || stoppedTime, tokens: str(tokens?.limit, 40), tokensUsed: num(tokens?.total) ?? num(tokens?.used),
    ...(timeUsedMs === null ? {} : { timeUsedMs }), ...(tokensCounted === null ? {} : { tokensCounted }), ...(stoppedUsed === null ? {} : { stoppedUsed }),
  }
}
function parseFindings(v: unknown): NonNullable<TaskDetails['findings']> {
  const review = obj(v)
  if (review?.stale === true || !Array.isArray(review?.findings)) return []
  return review.findings.slice(0, 200).map(v => {
    const f = obj(v)
    return { severity: str(f?.severity, 20), title: str(f?.subject ?? f?.title, 400), detail: [str(f?.where, 200), str(f?.proof ?? f?.detail, 4000)].filter(Boolean).join(' — '), ...(f?.preexisting === true ? { preexisting: true } : {}) }
  })
}

// CLI 1.2.16: oldest first, { at (milliseconds), role, from, to, why }.
// Keep partial records without guessing a role, participant or date. Undated
// records follow dated ones in their original order. Identity uses raw history.
export function parseTaskHandovers(value: unknown): TaskHandover[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 500).flatMap(value => {
    const h = obj(value)
    if (!h) return []
    const at = num(h.at)
    const record = {
      at: at !== null && at >= 0 && at <= 8640000000000000 ? at : null,
      role: str(h.role, 80), from: str(h.from, 160), to: str(h.to, 160), why: str(h.why, 2000),
    }
    return record.at !== null || record.role || record.from || record.to || record.why ? [record] : []
  }).sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity))
}

export function parseTaskDetails(text: string): TaskDetails {
  let v: unknown
  try { v = JSON.parse(text) } catch { throw new Error('herdr-projects details: not JSON') }
  const d = obj(v)
  const t = obj(d?.task)
  if (!d || !t || !isTaskId(t.id)) throw new Error('herdr-projects details: unexpected reply')
  const plan = obj(d.plan)
  return {
    handovers: parseTaskHandovers(d.handovers),
    attempts: parseTaskAttempts(d.attempts),
    comparison: parseTaskComparison(d.comparison),
    id: t.id,
    title: str(t.title, 300), stage: str(t.stage, 30), msg: str(t.msg, 1000), description: typeof t.description === 'string' ? t.description : '',
    agent: str(d.agent, 40),
    pr: cleanUrl(d.pr),
    branch: str(d.branch, 200),
    worktree: str(d.worktree, 500),
    failure: failureText(d.failure) || [str(obj(d.failure)?.title, 300), str(obj(d.failure)?.detail, 12000)].filter(Boolean).join(': '),
    failureTitle: str(obj(d.failure)?.title, 300),
    failureDetail: str(obj(d.failure)?.detail, 12000),
    failureNext: str(obj(d.failure)?.next, 2000),
    failureCanFix: obj(d.failure)?.agentCanFix === true,
    failureRemoteKind: str(obj(d.failure)?.remoteKind, 40),
    failureSent: Boolean(obj(d.failure)?.sentAt),
    failureAt: num(obj(d.failure)?.at),
    limits: parseTaskLimits(d.limits),
    findings: parseFindings(d.review),
    failureStage: str(obj(d.failure)?.stage, 30),
    failureAuth: obj(d.failure)?.auth === true,
    review: parseReview(d.review),
    reviewRounds: Array.isArray(d.reviews) ? d.reviews.length : 0,
    plan: plan ? str(plan.text, 8000) : '',
    chat: d.chat === true,
    research: d.research === true,
    archived: Boolean(t.archivedAt ?? d.archivedAt),
    summary: str(d.summary ?? t.summary, 8000).trim(),
    report: parseReport(d.report),
    after: parseWait(d.after),
    queue: queuePlace(obj(d.queue)?.place),
  }
}
const queuePlace = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null)

// A task named in a wait: `repo/n`, or another machine's `label:repo/n`.
const WAIT_ID_RE = /^(?:[A-Za-z0-9][\w.-]{0,39}:)?[A-Za-z0-9][\w.-]{0,79}\/\d{1,7}$/
const waitIds = (v: unknown) => (Array.isArray(v) ? v.slice(0, 50).filter((x): x is string => typeof x === 'string' && WAIT_ID_RE.test(x)) : [])
export function parseWait(v: unknown): TaskWait | null {
  const a = obj(v)
  if (!a) return null
  const waitsFor = waitIds(a.waitsFor)
  if (!waitsFor.length) return null
  const titles: Record<string, string> = {}
  for (const x of Array.isArray(a.tasks) ? a.tasks.slice(0, 50) : []) {
    const o = obj(x)
    if (o && typeof o.id === 'string' && waitsFor.includes(o.id) && typeof o.title === 'string') titles[o.id] = o.title.slice(0, 300)
  }
  return {
    waitsFor,
    // No `left` (a task not delegated yet): all of them, as far as wherdr knows.
    left: Array.isArray(a.left) ? waitIds(a.left).filter(x => waitsFor.includes(x)) : waitsFor,
    waiting: a.waiting === true,
    forYou: str(a.waitsForYou, 500),
    titles,
  }
}
function parseReport(v: unknown): TaskDetails['report'] {
  const r = obj(v)
  const file = r ? str(r.file, 200) : ''
  return file ? { file, link: cleanUrl(r!.link) } : null
}

// What the card offers, from the row and, for a failed task, what failed
// (`details`). These follow 1.2.1's own checks, so a button is shown only where
// the command can work; 1.x still has the last word, and says why it refuses.
// - `tell` reaches the task's agent (or, on a plan that waits, sends the plan
//   back), so only once an agent has been on it (1.x refuses it before);
// - `approve` merges finished work or says yes to a plan;
// - `delegate` puts an agent on a task of the backlog ("to do"), or again on
//   one that failed before its agent got going (start, setup, attempts);
// - `stop` stops the agent at work, or the one that waits for your answer;
// - `retry` is 1.2.1's `send_error` (cli/tasks.rs): it continues a task a
//   limit stopped, tells an agent that stopped without a summary to go on,
//   starts again an agent that never took its text, or sends a failure of the
//   agent or of the finish line back to it. Not a login problem (that needs
//   you first: reply instead), not a failure before an agent got going, not an
//   agent whose terminal is gone (the task is still at work: Stop is offered);
// - `finish` is 1.x `finish_anyway` (actions/finish_line.rs): it takes the work
//   as it is (check, then review) when a limit stopped the agent, when it
//   stopped without a summary, or when the board missed the end of its turn
//   (shown/states.rs stuck_finishing: its row stays on "Finishing");
// - `archive` puts a task away (`restore` brings it back): not in a stage where
//   something runs (store/files.rs SLOT_STAGES, plus queued and attempts).
//   An archived task is read-only, as 1.x has it (store/tasks.rs refuses any
//   change "Restore it before making changes"): `restore` is all it offers.
export type TaskFailure = Pick<TaskDetails, 'failureStage' | 'failureAuth'>
// 1.2.1 store/files.rs SLOT_STAGES, and the stages archive.rs also refuses.
const ACTIVE_STAGES = ['starting', 'setup', 'working', 'checking', 'pushing', 'reviewing', 'merging', 'queued', 'attempts']
// A failure before any agent was on it: Start again, not Retry.
const BEFORE_AGENT = ['start', 'setup', 'attempts']
export function taskActions(r: Pick<TaskRow, 'state' | 'kind' | 'stage' | 'group' | 'archived' | 'app' | 'backend'> & { msg?: string, chat?: boolean }, f?: TaskFailure | null): TaskActions {
  if (r.backend === 'beads') return beadActions(r)
  if (r.archived) return { ...NO_ACTIONS, restore: true }
  const live = r.group !== 'todo' && r.group !== 'done'
  const limitStop = r.stage === 'stopped' && r.state === 'blocked'
  const failed = r.stage === 'failed'
  // A failed task's Retry depends on what failed: unknown until `details` says.
  const retryFailed = failed && Boolean(f) && !f!.failureAuth && (f!.failureStage === 'send' || (Boolean(f!.failureStage) && !BEFORE_AGENT.includes(f!.failureStage)))
  return {
    tell: live && Boolean(r.app) && !(failed && f && BEFORE_AGENT.includes(f.failureStage)),
    approve: !r.chat && (r.stage === 'approval' || (r.stage === 'plan' && r.state === 'blocked')),
    delegate: r.group === 'todo' || (failed && Boolean(f) && BEFORE_AGENT.includes(f!.failureStage)),
    // Also an agent whose terminal is gone or that exited: still at work for 1.x.
    stop: r.group === 'working' || (r.group === 'needs' && r.state === 'blocked' && Boolean(r.app) && !limitStop && r.kind !== 'auth')
      || (r.stage === 'working' && r.state === 'error'),
    retry: limitStop || r.stage === 'nosummary' || retryFailed,
    finish: finishCase(r) !== null,
    archive: r.group !== 'working' && !ACTIVE_STAGES.includes(r.stage),
    restore: false,
  }
}

// Why Finish is offered: a waiting conversation, a limit, no summary, or a missed finish.
export type FinishCase = 'conversation' | 'limit' | 'nosummary' | 'stuck'
// 1.x shown/states.rs stuck_finishing: an agent task at stage "working" whose
// row says "Finishing" (state.rs: its agent idle or done, its turn's end not
// seen). 1.x refuses it while the agent is still at work.
type FinishRow = Pick<TaskRow, 'state' | 'stage' | 'app' | 'archived'> & { msg?: string, chat?: boolean }
export function taskStuckFinishing(r: FinishRow): boolean {
  return !r.archived && Boolean(r.app) && r.stage === 'working' && r.state === 'working' && r.msg === 'Finishing'
}
export function finishCase(r: FinishRow): FinishCase | null {
  if (r.archived) return null
  if (r.chat) return r.stage === 'asks' && r.state === 'blocked' ? 'conversation' : null
  if (r.stage === 'stopped' && r.state === 'blocked') return 'limit'
  if (r.stage === 'nosummary') return 'nosummary'
  return taskStuckFinishing(r) ? 'stuck' : null
}

// A failure the task has moved on from. 1.x keeps `failure` on the task after
// it goes on (a review that failed, then a run stopped at its limit; a pull
// request error, then the agent started again and asks something new), so the
// failure alone is not where the task stands. It is stale when, after it was
// recorded, the stage changed (`at`) or its agent was started again
// (`armedAt`, `startedAgentAt`). A failed task's failure is always its own.
// 1.x stamps the failure just before the change that records it
// (store/failures.rs failure_patch, then store/tasks.rs update), hence the margin.
const STALE_MARGIN_MS = 10_000
export function failureIsStale(stage: string, failureAt: number | null | undefined, file: Record<string, unknown> | null): boolean {
  if (stage === 'failed' || !failureAt || !file) return false
  const later = ['at', 'armedAt', 'startedAgentAt'].map(k => num(file[k]) ?? 0)
  return Math.max(...later) > failureAt + STALE_MARGIN_MS
}

// Rows of one group, as the board orders them: by repo, then newest first.
// Done is history, newest first whatever its repo (store/tasks.rs: by `created`);
// without a creation time, it keeps the order of the list, newest first too.
export function sortTasks(rows: TaskRow[]): TaskRow[] {
  return [...rows].sort((a, b) => TASK_GROUPS.indexOf(a.group) - TASK_GROUPS.indexOf(b.group)
    || (a.group === 'done' ? newerFirst(a, b) : a.repo.localeCompare(b.repo) || b.n - a.n))
}
// Newest created first; rows with no creation time last, in their order.
export const newerFirst = (a: Pick<TaskRow, 'created'>, b: Pick<TaskRow, 'created'>): number => (b.created ?? 0) - (a.created ?? 0)

// Text sent with `tell`: one message, bounded. Empty: nothing to send.
// Leave room for task context in a coordinator message.
export const TASK_QUESTION_MAX = 7000
export const TELL_MAX = 8000
export function cleanTell(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim().slice(0, TELL_MAX) : ''
}

// ---------------------------------------------------------------- commands
// Every argument comes after the command's own flags, and the user's words
// after `--` (or as `--flag=value`), so no text is ever read as a flag.

// A new task's title: one line (1.x shortens a long one at a word and keeps
// the full text in the description).
export const TITLE_MAX = 300
export function cleanTitle(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX) : ''
}

// `--repo NAME|PATH`: a repo the board knows by its name, or a folder's path
// (absolute, or from the home folder). '' : the home folder (wherdr runs the
// command there). Anything else is refused, not guessed.
const REPO_NAME_RE = /^[A-Za-z0-9][\w.-]{0,79}$/
export function cleanRepo(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return ''
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s) return ''
  if (REPO_NAME_RE.test(s)) return s
  // eslint-disable-next-line no-control-regex
  if (/^(\/|~\/)/.test(s) && s.length <= 500 && !/[\u0000-\u001f]/.test(s)) return s
  return null
}

export type TaskType = 'work' | 'research' | 'chat'
export function cleanTaskType(value: unknown): TaskType | null {
  if (value === undefined) return 'work'
  return value === 'work' || value === 'research' || value === 'chat' ? value : null
}
// CLI 1.x flow/plan/build.rs begins the plan step for all types, including chat.
// Inheritance omits the flag; never translate it to plan.approve=none.
export type PlanApproval = 'you' | 'reviewer'
export function isPlanApproval(value: unknown): value is PlanApproval {
  return value === 'you' || value === 'reviewer'
}
export interface NewTask { title: string, description: string, repo: string, delegate: boolean, type?: TaskType, planApprove?: PlanApproval }
// `add`: `--delegate` puts an agent on it at once.
export function addArgs(t: NewTask): string[] {
  return ['add',
    ...(t.type === 'research' ? ['--research'] : t.type === 'chat' ? ['--chat'] : []),
    ...(t.description ? [`--desc=${t.description}`] : []),
    ...(t.repo ? [`--repo=${t.repo}`] : []),
    ...(t.delegate ? ['--delegate'] : []),
    ...(t.planApprove ? [`--plan.approve=${t.planApprove}`] : []),
    '--', t.title]
}

// Start with another agent, for this start only: `delegate --worker.agent=<kind>
// -- <id>` is a work setting for this task (1.x "any work setting, for this
// task only"); the repo's and the user's defaults are not touched. No agent:
// the task's own default, exactly as before. The agent can name a model
// (`codex/gpt-6-sol`, `pi/<provider>/<model>`) and `--worker.effort` a level:
// the CLI checks both and says which names it takes.
const PROGRAM_RE = /^[a-z][a-z0-9-]{0,39}$/
const AGENT_NAME_RE = /^[a-z][a-z0-9-]{0,39}(?:\/[A-Za-z0-9][\w.:[\]-]{0,79}){0,2}$/
export const isProgramName = (v: unknown): v is string => typeof v === 'string' && PROGRAM_RE.test(v)
export const isAgentName = (v: unknown): v is string => typeof v === 'string' && AGENT_NAME_RE.test(v)
const EFFORT_RE = /^[a-z][a-z0-9-]{0,19}$/
export const isEffortName = (v: unknown): v is string => typeof v === 'string' && EFFORT_RE.test(v)
export function delegateArgs(id: string, agent?: string | null, after?: string[] | null, effort?: string | null): string[] {
  return ['delegate', ...(agent ? [`--worker.agent=${agent}`] : []), ...(effort ? [`--worker.effort=${effort}`] : []), ...(after?.length ? [`--after=${after.join(',')}`] : []), '--', id]
}

// `models <program>`: a sentence, one `program/model` line per model it takes,
// then `Effort (…): low, medium, high (from …); a, b only low, medium.`
// `models`: the model part only (`gpt-6-sol`, `openai/gpt-5` for pi).
// `efforts`: the levels for every model, `only` those some models are limited to.
export interface StartModels { program: string, models: string[], efforts: string[], only: { models: string[], levels: string[] }[] }
const words = (s: string) => s.replace(/\([^)]*\)/g, ' ').replace(/`/g, ' ').split(',').map(w => w.trim().replace(/\.$/, '')).filter(w => EFFORT_RE.test(w) || AGENT_NAME_RE.test(`x/${w}`))
export function parseModels(stdout: string, program: string): StartModels {
  const out: StartModels = { program, models: [], efforts: [], only: [] }
  for (const raw of stdout.split('\n')) {
    const l = raw.trim()
    const effort = /^effort\b[^:]*:\s*(.*)$/i.exec(l)
    if (effort) {
      const [all = '', ...rest] = effort[1]!.split(';')
      out.efforts = words(all).filter(w => EFFORT_RE.test(w))
      for (const part of rest) {
        const m = /^(.*?)\s+only\s+(.*)$/i.exec(part.trim())
        if (!m) continue
        const levels = words(m[2]!).filter(w => EFFORT_RE.test(w))
        const models = words(m[1]!)
        if (levels.length && models.length) out.only.push({ models, levels })
      }
      continue
    }
    if (l.startsWith(`${program}/`) && isAgentName(l) && !out.models.includes(l.slice(program.length + 1))) out.models.push(l.slice(program.length + 1))
  }
  return out
}
// The levels a model takes: its own limit, else every level. No model: none
// (the program's own model is not known here).
export function effortsFor(m: StartModels | null | undefined, model: string | null | undefined): string[] {
  if (!m || !model) return []
  return m.only.find(o => o.models.includes(model))?.levels ?? m.efforts
}

// `delegate --after`: the tasks to wait for, as a person names them: an id
// (`demo/12`), a key (`DEMO-12`, `#12` is not taken: it needs the repo), each
// with another machine's label first (`vm-str:ELA-3`, 1.x after/far.rs). The
// board checks the rest (does it exist, a circle, a machine that does not
// answer) and says why it refuses.
export const AFTER_MAX = 20
const AFTER_REF_RE = /^(?:[A-Za-z0-9][\w.-]{0,39}:)?(?:[A-Za-z0-9][\w.-]{0,79}\/\d{1,7}|[A-Za-z][A-Za-z0-9]{1,4}-\d{1,7})$/
export function cleanAfterRefs(v: unknown): string[] | null {
  if (!Array.isArray(v) || !v.length || v.length > AFTER_MAX) return null
  const out: string[] = []
  for (const r of v) {
    if (typeof r !== 'string' || !AFTER_REF_RE.test(r.trim())) return null
    if (!out.includes(r.trim())) out.push(r.trim())
  }
  return out
}
// `after --clear -- <id>`: it waits for nothing; one that waited goes on to a slot.
export const clearAfterArgs = (id: string) => ['after', '--clear', '--', id]

// A machine as 1.x names it in a wait (remote.rs short_label): its label up to
// the first dot, what follows an `@` for a target.
export function boardLabel(raw: string): string {
  const s = (raw.split('@').pop() || '').split('.')[0] || ''
  return s.replace(/[^A-Za-z0-9_.-]/g, '-')
}
// How a task is named to wait for it: its key (`DEMO-12`) or its id, with its
// machine's label first when it is on another machine than the waiting task.
export function afterRef(id: string, repoKey?: string | null, label?: string | null): string {
  const own = repoKey ? taskKey(id, repoKey) : id
  return label ? `${boardLabel(label)}:${own}` : own
}

// ---------------------------------------------------------------- slots
// The board's slots (1.x actions/start.rs start_queued): at most `board.agents`
// tasks in a slot stage at once (store/files.rs SLOT_STAGES, on every session
// of the machine); a task started with none free waits in the queue
// (stage `queued`, `queue` its place: 1 gets the next).
export const SLOT_STAGES = ['starting', 'setup', 'working', 'checking', 'pushing', 'reviewing', 'merging'] as const
export interface TaskSlots { max: number, busy: number, waiting: number }
export function slotsOf(rows: Pick<TaskRow, 'stage' | 'archived'>[], max: number): TaskSlots {
  const live = rows.filter(r => !r.archived)
  return {
    max,
    busy: live.filter(r => (SLOT_STAGES as readonly string[]).includes(r.stage)).length,
    waiting: live.filter(r => r.stage === 'queued').length,
  }
}
// Where Start would put the task: null when a slot is free (or not known: it
// says Start), else its place in the queue, after those already waiting.
export function startPlace(s: TaskSlots | null | undefined): number | null {
  return s && s.max > 0 && s.busy >= s.max ? s.waiting + 1 : null
}
// `board.agents` from `show --json` (how many work at once; 1.x's own default 4).
export function parseBoardAgents(stdout: string): number | null {
  let v: unknown
  try { v = JSON.parse(stdout) } catch { return null }
  const list = obj(v)?.settings
  if (!Array.isArray(list)) return null
  const row = list.map(obj).find(r => r?.name === 'board.agents')
  const n = row ? (typeof row.value === 'number' ? row.value : typeof row.value === 'string' ? Number(row.value) : NaN) : NaN
  return Number.isSafeInteger(n) && n > 0 && n <= 1000 ? n : null
}

// 1.x keeps that option as the task's own setting (`show` then says `place:
// task`) and reads it at every start of its agent, so it stays for the run;
// afterwards wherdr puts back what the task had: its own value (`set`), or
// none (`unset`: its repo's or the user's default applies again).
export function restoreAgentArgs(id: string, prev: string | null, name: 'worker.agent' | 'worker.effort' = 'worker.agent'): string[] {
  return prev ? ['set', `--task=${id}`, '--', name, prev] : ['unset', `--task=${id}`, '--', name]
}
// A run is over, so the agent picked for it can be taken back: the task is
// back in the backlog, or done. (A task that waits for another, `after`, or
// for a slot, `queued`, is in To do too, and still starts with it.)
export const runOver = (r: Pick<TaskRow, 'stage' | 'state' | 'archived'>) => !r.archived && (r.stage === 'todo' || r.state === 'done')

// The agent a task starts with by default: its `worker.agent` as `show <id>
// --json` resolves it, and where that comes from (`place`: task, carried,
// repo, you, builtin; `from`: 1.x's own words for it).
export interface TaskAgent { value: string, kind: string, place: string, from: string }
// What Start offers: that default, and the agents installed on the task's machine.
// `slots`: the board's slots as Start finds them (Queue when none is free).
export interface StartOptions { agent: TaskAgent | null, agents: string[], slots?: TaskSlots | null }
// `codex/gpt-5.5` → `codex`.
export const agentKind = (v: string) => v.split('/')[0] || ''
export function parseWorkerAgent(stdout: string): TaskAgent | null {
  let v: unknown
  try { v = JSON.parse(stdout) } catch { return null }
  const list = obj(v)?.settings
  if (!Array.isArray(list)) return null
  const row = list.map(obj).find(r => r?.name === 'worker.agent')
  const value = row && typeof row.value === 'string' ? row.value.trim().slice(0, 120) : ''
  if (!value) return null
  return { value, kind: agentKind(value), place: str(row!.place, 40), from: str(row!.from, 200) }
}
// The task's `worker.effort` (a level picked for one start is put back too).
export function parseWorkerEffort(stdout: string): { value: string, place: string } | null {
  let v: unknown
  try { v = JSON.parse(stdout) } catch { return null }
  const list = obj(v)?.settings
  const row = Array.isArray(list) ? list.map(obj).find(r => r?.name === 'worker.effort') : null
  const value = row && typeof row.value === 'string' ? row.value.trim().slice(0, 40) : ''
  return value ? { value, place: str(row!.place, 40) } : null
}

// Who the Board's chat talks to on a machine: its Coordinator (one per Herdr
// session), the machine coordinator, or a repo's project coordinator.
export type CoordinatorTarget = { kind: 'main' } | { kind: 'machine' } | { kind: 'project', repo: string }
export function cleanTarget(v: unknown): CoordinatorTarget | null {
  const o = obj(v)
  if (!o || o.kind === 'main') return { kind: 'main' }
  if (o.kind === 'machine') return { kind: 'machine' }
  if (o.kind === 'project') {
    const repo = cleanRepo(o.repo)
    return repo ? { kind: 'project', repo } : null
  }
  return null
}
// `coordinator [--machine | --project=REPO] [--delegate] -- tell <words>`:
// `--delegate` (the board's Tab) puts an agent on every task the message adds.
export function coordinatorArgs(to: CoordinatorTarget, words: string, delegate: boolean): string[] {
  return ['coordinator',
    ...(to.kind === 'machine' ? ['--machine'] : to.kind === 'project' ? [`--project=${to.repo}`] : []),
    ...(delegate ? ['--delegate'] : []),
    '--', 'tell', words]
}

// Which pane a coordinator talks in, as herdr-projects itself keeps it
// (coordinator/look.rs `summary`): `coordinator [--machine | --project=REPO]
// status --json` gives its state and its pane in the board's own session.
// Never guessed from an agent's name: two repos can share one once Herdr's
// rules shorten it (`demo` and `demo-2`, `demo.app` and `demo-app`).
export function coordinatorStatusArgs(to: CoordinatorTarget): string[] {
  return ['coordinator', ...(to.kind === 'machine' ? ['--machine'] : to.kind === 'project' ? [`--project=${to.repo}`] : []), '--json', 'status']
}
// `coordinator [--machine | --project=REPO] -- restart`: start its program
// again (the Board's Try again after a failed start). herdr-projects clears
// the error it kept, and the words still waiting go in once it runs.
export function coordinatorRestartArgs(to: CoordinatorTarget): string[] {
  return ['coordinator', ...(to.kind === 'machine' ? ['--machine'] : to.kind === 'project' ? [`--project=${to.repo}`] : []), '--', 'restart']
}
// Its agent answers in Herdr: working, blocked or idle. Anything else (none,
// starting, exited) has no pane to talk to yet.
const LIVE_COORDINATOR = ['working', 'blocked', 'idle']
const PANE_RE = /^w[0-9a-z]+:p[0-9a-z]+$/i
// `error`: why its last start or message delivery failed (pump.rs);
// it is not tried again by itself, and its state may still say "starting".
// `name`: how herdr-projects names it ("Coordinator", "devbox coordinator").
// `queued`: pending messages; null for older or invalid replies.
export interface CoordinatorStatus { state: string, pane: string | null, error: string, name: string, queued: number | null }
export function parseCoordinatorStatus(text: string): CoordinatorStatus {
  let v: unknown
  try { v = JSON.parse(text) } catch { throw new Error('herdr-projects coordinator: not JSON') }
  const o = obj(v)
  if (!o) throw new Error('herdr-projects coordinator: unexpected reply')
  const state = str(o.state, 20)
  const pane = str(o.pane, 40)
  return {
    state,
    queued: typeof o.queued === 'number' && Number.isSafeInteger(o.queued) && o.queued >= 0 ? o.queued : null,
    pane: LIVE_COORDINATOR.includes(state) && PANE_RE.test(pane) ? pane : null,
    error: str(o.error, 400).replace(/\s+/g, ' ').trim(),
    name: str(o.name, 80).trim(),
  }
}

// What the Board's panel shows for a coordinator: its conversation (`live`),
// why it could not start (`failed`), that it is on its way (`starting`), or
// the field whose first message starts it (`idle`). A failed start wins over
// "starting": herdr-projects keeps saying "starting" while the words wait,
// but it does not try again until it is asked to.
export type CoordinatorPhase = 'live' | 'failed' | 'starting' | 'idle'
export function coordinatorPhase(s: { pane: string | null, state: string, error: string }): CoordinatorPhase {
  if (s.pane) return 'live'
  if (s.error) return 'failed'
  if (s.state === 'starting') return 'starting'
  return 'idle'
}

// What a coordinator is named after: nothing for the Coordinator, the
// machine for the machine coordinator (as herdr-projects names it, else
// wherdr's label for it), the repo for a project coordinator. The UI says
// "Coordinator", "devbox coordinator", "web coordinator": each named once.
export function coordinatorSubject(to: CoordinatorTarget, machineLabel: string, statusName = ''): string {
  if (to.kind === 'project') return to.repo
  if (to.kind === 'main') return ''
  const m = /^(.+) coordinator$/i.exec(statusName.trim())
  return m?.[1]?.trim() || machineLabel
}

// ---------------------------------------------------------------- by repo
// A machine's rows under their repos (1.x: grouped by repo, `Alt+S`): repos
// by name, each one's rows as the board orders them (by group, newest first).
export interface RepoTasks { repo: string, tasks: TaskRow[] }
export function groupByRepo(rows: TaskRow[]): RepoTasks[] {
  const by = new Map<string, TaskRow[]>()
  for (const r of sortTasks(rows)) {
    const list = by.get(r.repo)
    if (list) list.push(r)
    else by.set(r.repo, [r])
  }
  return [...by].sort(([a], [b]) => a.localeCompare(b)).map(([repo, tasks]) => ({ repo, tasks }))
}

// How many rows of each group: a heading's summary.
export function groupCounts(rows: TaskRow[]): Record<TaskGroup, number> {
  const c: Record<TaskGroup, number> = { needs: 0, ready: 0, working: 0, todo: 0, done: 0 }
  for (const r of rows) c[r.group]++
  return c
}

// ---------------------------------------------------------------- push
// `board.notify` runs a command once per event, with the task's id, title and
// event in its environment. This one hands it to Herdr as a notification,
// which wherdr already sends to the phone (server/utils/herdrNotify.ts): no
// state of wherdr's own, and it works on every machine wherdr reaches.
export const NOTIFY_COMMAND = 'herdr notification show --body="$HERDR_PROJECTS_TITLE" --sound request -- "$HERDR_PROJECTS_ID · $HERDR_PROJECTS_EVENT"'
// The command that sets it, on each machine that runs herdr-projects.
export const NOTIFY_SETUP = (launcher: string) => `${launcher} set board.notify '${NOTIFY_COMMAND}'`
export const NOTIFY_EVENTS = ['needs you', 'ready to approve', 'failed'] as const
export type NotifyEvent = typeof NOTIFY_EVENTS[number]
// A notification that NOTIFY_COMMAND sent: its task and what happened; else null.
export function taskNotice(title: string): { id: string, event: NotifyEvent } | null {
  const m = /^(\S+) · (needs you|ready to approve|failed)$/.exec(title.trim())
  return m && isTaskId(m[1]) ? { id: m[1], event: m[2] as NotifyEvent } : null
}

// ---------------------------------------------------------------- read from the files
// What the board's own files (`data/tasks/<repo>/<n>/task.json`) say where the
// CLI's answer leaves something out (an archived task, an approval's blockers,
// links between boards): read only, nothing written. The row follows 1.2.1's
// own rules (flow/state.rs `show`) from the task's stage; for an agent at work,
// `paneStatus` is the status wherdr sees on its pane (Herdr's own, as 1.x reads
// it). A close reading, not the program's: the CLI stays the reference.
type Raw = Record<string, unknown>
const BLOCKED_STAGES: Record<string, string> = { approval: 'permission', plan: 'permission', pick: 'permission' }

export function stateFromTaskFile(t: Raw, paneStatus: string | null): { state: string, kind: string } {
  const stage = str(t.stage, 30)
  const failure = obj(t.failure)
  switch (stage) {
    case 'todo': return { state: 'idle', kind: '' }
    case 'after': return t.afterBlocked ? { state: 'blocked', kind: 'question' } : { state: 'working', kind: '' }
    case 'done': case 'tried': return { state: 'done', kind: '' }
    case 'failed': return failure?.auth ? { state: 'blocked', kind: 'auth' } : { state: 'error', kind: '' }
    case 'asks': return { state: 'blocked', kind: str(t.kind, 20) || 'question' }
    case 'nosummary': return { state: 'error', kind: '' }
    case 'reviewneeds': return { state: 'blocked', kind: '' }
    case 'stopped': return t.limitStop ? { state: 'blocked', kind: '' } : { state: 'idle', kind: '' }
    case 'working': return paneStatus === 'blocked' ? { state: 'blocked', kind: '' } : { state: 'working', kind: '' }
  }
  if (BLOCKED_STAGES[stage]) return { state: 'blocked', kind: BLOCKED_STAGES[stage]! }
  return { state: 'working', kind: '' } // queued, starting, reviewing, checking, merging, attempts…
}

// A delegated run keeps its mode even if chat.only changes afterwards (CLI 1.2.16).
const chatFromTaskFile = (o: Raw) => typeof o.chatRun === 'boolean' ? o.chatRun : obj(o.settings)?.['chat.only'] === true

// One row of the board from a task file; null for what the board does not list
// on its own (an attempt of a task done several times at once) or cannot read.
export function rowFromTaskFile(t: unknown, paneStatus: string | null): TaskRow | null {
  const o = obj(t)
  if (!o || o.attemptOf) return null
  const { state, kind } = stateFromTaskFile(o, paneStatus)
  const review = obj(o.review)
  return parseTaskRow({
    id: o.id, identity: taskAgentIdentity(o), state, kind, mergeFailed: o.mergeFailed, syncBlocked: o.syncBlocked, prFailure: o.prFailure, prState: o.prState, stage: o.stage, title: o.title, msg: o.msg, app: o.app,
    pr: o.pr, review: review && !review.stale ? review : null, reviewRound: o.reviewRound,
    chat: chatFromTaskFile(o),
    research: o.research === true, archivedAt: o.archivedAt, created: o.created,
    progress: obj(o.watch)?.progress,
  })
}

// `details` from a task file: what the file holds (no plan text, no review history).
export function detailsFromTaskFile(t: unknown): TaskDetails | null {
  const o = obj(t)
  if (!o || !isTaskId(o.id)) return null
  return parseTaskDetails(JSON.stringify({
    task: { id: o.id, title: o.title, stage: o.stage, msg: o.msg, description: o.description, summary: o.summary, archivedAt: o.archivedAt ?? null },
    handovers: o.handovers,
    report: o.report ?? null,
    failure: o.failure ?? o.prFailure ?? null, limits: o.limits, review: o.review ?? null, reviews: [],
    // The program on it: `on` while one works, then `agent`, as `details` gives it; else the row's `app`.
    agent: o.on || o.agent || o.app || null,
    chat: chatFromTaskFile(o),
    research: o.research === true, pr: o.pr ?? null, branch: o.branch ?? null, worktree: o.worktree ?? null, plan: null,
    after: o.after ? { waitsFor: o.after, left: o.stage === 'after' ? o.afterLeft : undefined, waiting: o.stage === 'after', waitsForYou: o.afterBlocked } : null,
  }))
}

// `fix` is distinct from `retry`: only the board's structured failure can offer it.
// A stale failure is never sent: the agent has moved on from it.
export function taskCanFix(r: Pick<TaskRow, 'archived' | 'stage' | 'app'>, d: TaskDetails | null): boolean {
  return !r.archived && Boolean(r.app) && Boolean(d?.failureCanFix) && !d?.failureAuth && !d?.failureStale
    && !(d?.failureSent && r.stage === 'working') && r.stage !== 'merging'
}
export function taskCanApproveAnyway(r: Pick<TaskRow, 'archived' | 'stage' | 'research' | 'review' | 'chat'>, d: TaskDetails | null): boolean {
  return !r.archived && !r.chat && !r.research && r.stage === 'approval'
    && (r.review?.pass === false || (d?.failureRemoteKind === 'checks'))
}
// A review that failed, its task waiting for you: 1.x asks "merge anyway, or
// send the review back" (`review <id>`), sending back first.
export function taskCanSendReview(r: Pick<TaskRow, 'archived' | 'stage' | 'research' | 'review' | 'chat'>, d?: Pick<TaskDetails, 'review'> | null): boolean {
  return !r.archived && !r.chat && !r.research && r.stage === 'approval' && (d?.review ?? r.review)?.pass === false
}
// What a sent-back review carries, worst first: its open findings (those there
// before the task stay out), `shown` of them, and how many more.
const severityRank = (s: string) => { const i = SEVERITIES.indexOf(s as typeof SEVERITIES[number]); return i < 0 ? 1 : i }
export function reviewFindingsBrief(findings: TaskDetails['findings'], shown = 3): { list: NonNullable<TaskDetails['findings']>, more: number } {
  const open = (findings || []).filter(f => !f.preexisting && f.title)
    .map((f, i) => ({ f, i })).sort((a, b) => severityRank(a.f.severity) - severityRank(b.f.severity) || a.i - b.i).map(x => x.f)
  return { list: open.slice(0, shown), more: Math.max(0, open.length - shown) }
}

// CLI details (1.2.16, actions/finish_line.rs): only `passed` may be picked.
export function parseTaskAttempts(value: unknown): TaskAttempt[] {
  if (!Array.isArray(value)) return []
  const letters = new Set<string>()
  return value.slice(0, 5).flatMap(value => {
    const a = obj(value)
    const letter = str(a?.letter, 10)
    if (!/^[A-E]$/.test(letter) || letters.has(letter)) return []
    letters.add(letter)
    return [{ letter, agent: str(a?.agent, 160), standing: str(a?.standing, 30), stage: str(a?.stage, 30), stat: str(a?.stat, 500) }]
  })
}
function parseTaskComparison(value: unknown): TaskComparison | null {
  const c = obj(value)
  if (!c) return null
  const notes: Record<string, string> = {}
  for (const [letter, note] of Object.entries(obj(c.notes) || {})) if (/^[A-E]$/.test(letter)) notes[letter] = str(note, 600)
  return { pick: /^[A-E]$/.test(str(c.pick, 10)) ? str(c.pick, 10) : '', why: str(c.why, 2000), error: str(c.error, 2000), notes }
}
export function canPickAttempt(details: TaskDetails | null | undefined, letter: unknown): boolean {
  return Boolean(details && !details.archived && details.stage === 'pick' && typeof letter === 'string'
    && /^[A-E]$/.test(letter) && details.attempts?.some(a => a.letter === letter && a.standing === 'passed'))
}
