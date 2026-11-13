// beads (`bd`, github.com/steveyegge/beads): the Board's second backend. A
// machine's issues come from one or more beads databases:
//  - its hub: the database `BEADS_DIR` names, shared by every repo, each issue
//    tied to its repo by a `repo:<name>` label;
//  - each Git repo open in Herdr that has its own `.beads/` folder.
// The Board reads them with `bd list --json` and `bd show --json`, and writes
// with `bd create`, `bd update`, `bd close`, `bd reopen` and `bd comment`.
// beads keeps work items only: wherdr starts an agent on one (a Herdr space in
// its repo), and the agent claims and closes it itself.
//
// Pure functions, tested in tests/beadsTasks.test.ts with recorded output.
// Nothing here trusts the output: every field is checked and bounded.
// Only types from projectsTasks: it calls beadActions, so no value goes back.
import type { TaskActions, TaskDetails, TaskGroup, TaskRow, TaskWait } from './projectsTasks'

// The Board's backend on a machine.
export type TasksBackend = 'projects' | 'beads'
export const TASKS_BACKENDS: readonly TasksBackend[] = ['projects', 'beads']
export const isTasksBackend = (v: unknown): v is TasksBackend => TASKS_BACKENDS.includes(v as TasksBackend)

// A bead's id: its database's prefix, a dash, a hash, with `.n` for a child
// (`hub-ozxp.32`). Never a flag, never a path.
export const BEAD_ID_RE = /^[A-Za-z][A-Za-z0-9_]{0,30}-[A-Za-z0-9][A-Za-z0-9.]{0,40}$/
export const isBeadId = (v: unknown): v is string => typeof v === 'string' && BEAD_ID_RE.test(v)

// The repo a hub issue belongs to: its `repo:<name>` label.
const REPO_NAME_RE = /^[A-Za-z0-9][\w.-]{0,79}$/
export const REPO_LABEL = 'repo:'
export function repoOfLabels(labels: unknown): string {
  if (!Array.isArray(labels)) return ''
  for (const l of labels) {
    if (typeof l !== 'string' || !l.startsWith(REPO_LABEL)) continue
    const name = l.slice(REPO_LABEL.length).trim()
    if (REPO_NAME_RE.test(name)) return name
  }
  return ''
}

// A database's own name on the Board: the hub by its prefix (`hub`), a repo's
// by the repo's folder name.
export function sourceName(raw: string): string {
  const s = raw.replace(/^\.+/, '').replace(/[^\w.-]/g, '-').replace(/^-+/, '').slice(0, 80)
  return REPO_NAME_RE.test(s) ? s : 'beads'
}

// Statuses, as `bd statuses` lists them, plus the custom `needs_me` some
// setups use for "waiting on the human".
//   needs_me, blocked     → Needs you
//   in_progress, hooked   → Working
//   open, deferred, pinned→ To do (an open one with an open blocker waits)
//   closed                → Done
export function groupOfStatus(status: string): TaskGroup {
  switch (status) {
    case 'needs_me': case 'blocked': return 'needs'
    case 'in_progress': case 'hooked': return 'working'
    case 'closed': return 'done'
    default: return 'todo'
  }
}
// The Board's state for the group (TaskRow.state), as herdr-projects names it.
const STATE_OF: Record<TaskGroup, { state: string, kind: string }> = {
  needs: { state: 'blocked', kind: 'question' },
  ready: { state: 'blocked', kind: 'permission' },
  working: { state: 'working', kind: '' },
  todo: { state: 'idle', kind: '' },
  done: { state: 'done', kind: '' },
}

// The agent programs an assignee can name (`claude`, `codex/gpt-5`…): its logo
// on the card. Anyone else (a person) is shown in the line instead.
const AGENT_RE = /^(claude|codex|gemini|opencode|amp|cursor|droid|pi|kimi|qwen|goose|aider|copilot|crush)(?:[/@:-].*)?$/i
export const assigneeAgent = (a: string) => (AGENT_RE.exec(a)?.[1] || '').toLowerCase()

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null)
const time = (v: unknown): number | null => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(t) ? t : null
}
const lastLine = (s: string) => s.split('\n').map(l => l.trim()).filter(Boolean).pop()?.slice(0, 300) || ''

// One issue of `bd list --json`, in its database `source`. `open`: the ids of
// the issues still open in that database (a dependency not among them is done).
// `hub`: a hub's issues go under the repo their label names; a repo's own
// database's issues all belong to that repo.
export interface BeadRow extends TaskRow { bead: string, source: string }
export function parseBead(v: unknown, source: string, open: ReadonlySet<string>, hub = true): BeadRow | null {
  const b = obj(v)
  if (!b || !isBeadId(b.id)) return null
  const status = str(b.status, 30)
  const repo = (hub && repoOfLabels(b.labels)) || source
  const waitsFor = blockersOf(b.dependencies, b.id).filter(id => open.has(id))
  const group = groupOfStatus(status)
  const waiting = group === 'todo' && waitsFor.length > 0
  const assignee = str(b.assignee, 120)
  const created = time(b.created_at)
  const msg = group === 'done' ? str(b.close_reason, 300)
    : waiting ? `Waits for ${waitsFor.slice(0, 3).join(', ')}${waitsFor.length > 3 ? '…' : ''}`
      : group === 'working' && assignee ? `${assignee} is on it`
        : lastLine(str(b.notes, 4000))
  return {
    id: `${repo}/${b.id}`, repo, n: created ? Math.floor(created / 1000) : 0,
    ...STATE_OF[group], stage: waiting ? 'waiting' : status,
    title: str(b.title, 300), msg,
    app: assigneeAgent(assignee),
    progress: null, eta: null,
    pr: prLink(b.external_ref),
    review: null, reviewRound: 0, research: false, archived: false, queue: null,
    group,
    ...(created !== null ? { created: time(b.closed_at) ?? created } : {}),
    backend: 'beads', bead: b.id, source,
    priority: typeof b.priority === 'number' && Number.isInteger(b.priority) ? Math.max(0, Math.min(4, b.priority)) : 2,
    type: str(b.issue_type, 30),
  }
}

// What an issue waits for: its `blocks` dependencies (`bd list` gives
// `depends_on_id`, `bd show` the dependency itself with `id`).
function blockersOf(deps: unknown, self: string): string[] {
  if (!Array.isArray(deps)) return []
  const out: string[] = []
  for (const d of deps.slice(0, 100)) {
    const o = obj(d)
    if (!o) continue
    const type = str(o.type ?? o.dependency_type, 30) || 'blocks'
    if (type !== 'blocks') continue
    const id = isBeadId(o.depends_on_id) ? o.depends_on_id : isBeadId(o.id) ? o.id : ''
    if (id && id !== self && !out.includes(id)) out.push(id)
  }
  return out
}

// A pull request in `external_ref` (an https link only): shown on the card as
// herdr-projects' PR is.
const prLink = (v: unknown) => {
  const u = str(v, 400)
  return /^https:\/\/[^\s"'<>]+$/i.test(u) && /\/pulls?\/\d+/.test(u) ? u : ''
}

// `bd list --json`: an array. Anything else is refused, not guessed.
export function parseBeadList(text: string, source: string, open?: ReadonlySet<string>, hub = true): BeadRow[] {
  let v: unknown
  try { v = JSON.parse(text || '[]') } catch { throw new Error('bd list: not JSON') }
  if (v === null) return []
  if (!Array.isArray(v)) throw new Error('bd list: not a list')
  const items = v.slice(0, MAX_BEADS)
  const ids = open ?? new Set(items.map(obj).filter(o => o && o.status !== 'closed' && isBeadId(o.id)).map(o => o!.id as string))
  return items.map(b => parseBead(b, source, ids, hub)).filter((r): r is BeadRow => r !== null)
}
export const MAX_BEADS = 1000
// Done is history: the latest closed issues of each database.
export const CLOSED_SHOWN = 50

// `bd show <id> --json`: a list of one issue, with its dependencies' own
// status. `comments`: `bd comments <id> --json`, newest last.
export function parseBeadDetails(text: string, id: string, comments = ''): TaskDetails {
  let v: unknown
  try { v = JSON.parse(text) } catch { throw new Error('bd show: not JSON') }
  const b = obj(Array.isArray(v) ? v[0] : v)
  if (!b || !isBeadId(b.id)) throw new Error('bd show: unexpected reply')
  const status = str(b.status, 30)
  const deps = Array.isArray(b.dependencies) ? b.dependencies.slice(0, 100).map(obj).filter(Boolean) as Record<string, unknown>[] : []
  const blocks = deps.filter(d => (str(d.dependency_type ?? d.type, 30) || 'blocks') === 'blocks' && isBeadId(d.id))
  const titles: Record<string, string> = {}
  for (const d of blocks) titles[d.id as string] = str(d.title, 300)
  const waitsFor = blocks.map(d => d.id as string)
  const left = blocks.filter(d => d.status !== 'closed').map(d => d.id as string)
  const after: TaskWait | null = waitsFor.length
    ? { waitsFor, left, waiting: groupOfStatus(status) === 'todo' && left.length > 0, forYou: '', titles }
    : null
  // Design and acceptance criteria are read with the notes: the description
  // stays as stored, since the sheet edits it.
  const extra = [['Design', b.design], ['Acceptance criteria', b.acceptance_criteria]].map(([h, t]) => {
    const s = str(t, 8000).trim()
    return s ? `${h}:\n${s}` : ''
  }).filter(Boolean)
  const notes = str(b.notes, 8000).trim()
  const said = parseComments(comments)
  return {
    id, title: str(b.title, 300), stage: status, msg: '',
    description: str(b.description, 20000),
    agent: assigneeAgent(str(b.assignee, 120)),
    pr: prLink(b.external_ref), branch: '', worktree: '',
    failure: '', failureStage: '', failureAuth: false,
    summary: [str(b.close_reason, 4000).trim(), ...extra, notes, said].filter(Boolean).join('\n\n'),
    report: null, review: null, reviewRounds: 0, plan: '', research: false, archived: false,
    after, queue: null,
    bead: {
      id: b.id, status, priority: typeof b.priority === 'number' ? b.priority : 2, type: str(b.issue_type, 30),
      assignee: str(b.assignee, 120), labels: Array.isArray(b.labels) ? b.labels.filter((l): l is string => typeof l === 'string').slice(0, 50) : [],
      comments: commentCount(comments),
    },
  }
}
function commentCount(text: string): number {
  try { const v: unknown = JSON.parse(text || '[]'); return Array.isArray(v) ? v.length : 0 } catch { return 0 }
}
// The comments as one text, oldest first: `author: text`.
function parseComments(text: string): string {
  if (!text.trim()) return ''
  let v: unknown
  try { v = JSON.parse(text) } catch { return '' }
  if (!Array.isArray(v)) return ''
  return v.slice(-50).map(obj).filter(Boolean).map(c => `${str(c!.author, 80) || '?'}: ${str(c!.text, 4000).trim()}`).filter(s => !s.endsWith(': ')).join('\n\n')
}

// What the Board can do on a bead. Start (`delegate`) opens an agent on it,
// in its repo; Archive closes it (`bd close`), Restore reopens it; a reply
// (`tell`) goes to its agent's pane, or else becomes a comment.
export function beadActions(r: Pick<TaskRow, 'group' | 'stage'>): TaskActions {
  return {
    approve: false, stop: false, retry: false, finish: false,
    tell: r.group !== 'done',
    delegate: r.group === 'todo' || r.group === 'needs',
    archive: r.group !== 'done',
    restore: r.group === 'done',
  }
}

// ---------------------------------------------------------------- commands
// Every argument after its flag (`--flag=value`) or after `--`, so no text is
// ever read as a flag.
export const listArgs = () => ['list', '--json', '--flat', '--no-pager', `--limit=${MAX_BEADS}`]
export const closedArgs = () => ['list', '--json', '--flat', '--no-pager', '--status=closed', '--sort=closed', `--limit=${CLOSED_SHOWN}`]
export const showArgs = (id: string) => ['show', '--json', '--', id]
export const commentsArgs = (id: string) => ['comments', '--json', '--', id]
export function createArgs(t: { title: string, description: string, repoLabel: string }): string[] {
  return ['create', '--json',
    ...(t.description ? [`--description=${t.description}`] : []),
    ...(t.repoLabel ? [`--labels=${REPO_LABEL}${t.repoLabel}`] : []),
    '--', t.title]
}
export const describeArgs = (id: string, text: string) => ['update', `--description=${text}`, '--', id]
export const closeArgs = (id: string) => ['close', '--reason=Closed from wherdr', '--', id]
export const reopenArgs = (id: string) => ['reopen', '--', id]
export const commentArgs = (id: string, text: string) => ['comment', '--', id, text]
// What Start marks: in progress, on that agent (the agent claims it again itself).
export const startArgs = (id: string, agent: string) => ['update', '--status=in_progress', `--assignee=${agent}`, '--', id]

// What the agent is told when it starts: the bead, and how beads works.
export function startPrompt(id: string, title: string, hub: boolean): string {
  return [
    `Work on beads issue ${id}: ${title}`,
    '',
    `Run \`bd show ${id}\` for the full description, and \`bd comments ${id}\` for the discussion.`,
    `Claim it first with \`bd update ${id} --claim\`. Record progress with \`bd note ${id} "..."\`.`,
    `If you need a decision from me, say so and run \`bd update ${id} --status=needs_me\`.`,
    `When it is done, close it with \`bd close ${id} --reason="..."\`.`,
    ...(hub ? ['', `This issue is in the shared beads hub ($BEADS_DIR); keep its \`repo:\` label.`] : []),
  ].join('\n')
}

// The space Start opens: its label, and the branch of its worktree.
export const startLabel = (id: string, title: string) => `${id} ${title}`.slice(0, 60).trim()
export const startBranch = (id: string) => `bd/${id}`.replace(/[^\w./-]/g, '-').slice(0, 80)

// `bd where` (plain text): the database folder on its first line.
export function parseWhere(stdout: string): string {
  const first = stdout.split('\n').map(l => l.trim()).find(Boolean) || ''
  return first.startsWith('/') && !first.includes('\0') ? first : ''
}
