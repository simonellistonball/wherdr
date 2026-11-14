// The Board's backend on each machine: herdr-projects (server/utils/projectsTasks.ts)
// or beads (server/utils/beadsTasks.ts). The routes that both backends serve
// (the list, a task's details, add, describe, reply, Start, Archive, Restore)
// come through here; herdr-projects-only routes (coordinators, approve, review,
// limits, autopilot…) stay on projectsTasks, which refuses them on a machine
// without herdr-projects.
//
// `WHERDR_TASKS_BACKEND`: `auto` (the default), `projects` or `beads` for every
// machine, or per machine by its label: `laptop=beads,devbox=projects,*=auto`.
// `auto`: herdr-projects where Herdr has it ready, else beads where bd finds a
// database, else herdr-projects (whose Board then says it is not installed).
import { createHash } from 'node:crypto'
import { type BeadRef, type BeadRefsReply, type TasksBackend, isTasksBackend } from '../../shared/beadsTasks'
import type { MachineTasks, StartOptions, TaskDetails, TaskPanes, TaskRow, TasksBoard } from '../../shared/projectsTasks'
import type { SearchableBoard } from '../../shared/taskSearch'
import { machineFor } from './actions'
import { type Machine, baseMachines } from './machines'
import * as projects from './projectsTasks'
import * as beads from './beadsTasks'
import { projectsPluginInfo } from './projectsPlugin'

type Choice = TasksBackend | 'auto'
export function parseBackendSetting(raw: string | undefined): { all: Choice, by: Map<string, Choice> } {
  const by = new Map<string, Choice>()
  let all: Choice = 'auto'
  for (const part of (raw || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const [k, v] = part.includes('=') ? part.split('=', 2).map(s => s.trim()) as [string, string] : ['*', part]
    const c: Choice | null = v === 'auto' || isTasksBackend(v) ? v as Choice : null
    if (!c) continue
    if (k === '*') all = c
    else by.set(k.toLowerCase(), c)
  }
  return { all, by }
}
const setting = parseBackendSetting(process.env.WHERDR_TASKS_BACKEND)

const AUTO_TTL_MS = 60_000
const chosen = new Map<string, { at: number, backend: TasksBackend }>()
export async function backendOf(m: Machine, fresh = false): Promise<TasksBackend> {
  const c = setting.by.get(m.label.toLowerCase()) ?? setting.all
  if (c !== 'auto') return c
  const hit = chosen.get(m.key)
  if (hit && !fresh && Date.now() - hit.at < AUTO_TTL_MS) return hit.backend
  let backend: TasksBackend = 'projects'
  const plugin = await projectsPluginInfo(m, fresh).catch(() => null)
  if (plugin?.status !== 'ready' && (m.local || m.status === 'online')) {
    if ((await beads.beadsSources(m, fresh).catch(() => [])).length) backend = 'beads'
  }
  chosen.set(m.key, { at: Date.now(), backend })
  return backend
}
export function resetBackendChoices() { chosen.clear() }

const boardOf = (machine: unknown) => projects.boardMachine(machineFor(machine))
const isBeads = async (machine: unknown) => { const m = boardOf(machine); return { m, beads: (await backendOf(m)) === 'beads' } }

// Every machine's tasks, as projectsTasks.readTasksBoard gives them.
export async function readBoard(since?: string): Promise<TasksBoard | { same: true, version: string }> {
  const machines = (await Promise.all(baseMachines().map(async (m) => {
    const fresh = !since
    return (await backendOf(m, fresh)) === 'beads' ? beads.beadsMachineTasks(m, fresh) : projects.machineTasks(m, fresh)
  }))).filter((x): x is MachineTasks => x !== null)
  const version = createHash('sha1').update(JSON.stringify(machines, (k, v) => (k === 'at' || k === 'readAt' ? undefined : v))).digest('hex').slice(0, 16)
  return since === version ? { same: true, version } : { version, machines }
}
export function warmBoard() { readBoard().catch(() => {}) }

export async function boardSearchables(deadlineMs: number): Promise<SearchableBoard[]> {
  const ms = baseMachines()
  const kinds = await Promise.all(ms.map(m => backendOf(m).catch(() => 'projects' as const)))
  const own = ms.filter((_, i) => kinds[i] === 'beads')
  const [fromProjects, fromBeads] = await Promise.all([
    projects.searchableBoards(deadlineMs).then(b => b.filter(x => !own.some(m => m.key === x.machine))),
    Promise.all(own.map(m => Promise.race([beads.beadsSearchable(m), new Promise<SearchableBoard>(r => setTimeout(() => r({ machine: m.key, tasks: [] }), deadlineMs))]).catch(() => ({ machine: m.key, tasks: [] })))),
  ])
  return [...fromProjects, ...fromBeads]
}

export async function boardTaskDetails(machine: unknown, id: unknown): Promise<TaskDetails & TaskPanes> {
  const { m, beads: b } = await isBeads(machine)
  return b ? beads.beadDetails(m, id) : projects.taskDetails(machine, id)
}
export async function boardTell(machine: unknown, id: unknown, text: unknown) {
  const { m, beads: b } = await isBeads(machine)
  return b ? beads.tellBead(m, id, text) : projects.tellTask(machine, id, text)
}
export async function boardDescribe(machine: unknown, id: unknown, text: unknown) {
  const { m, beads: b } = await isBeads(machine)
  return b ? beads.describeBead(m, id, text) : projects.describeTask(machine, id, text)
}
export async function boardCommand(machine: unknown, id: unknown, action: unknown, agent?: unknown, after?: unknown, effort?: unknown) {
  const { m, beads: b } = await isBeads(machine)
  return b ? beads.beadCommand(m, id, action, agent) : projects.taskCommand(machine, id, action, agent, after, effort)
}
export async function boardStartOptions(machine: unknown, id: unknown): Promise<StartOptions> {
  const { m, beads: b } = await isBeads(machine)
  return b ? beads.beadStartOptions(m, id) : projects.taskStartOptions(machine, id)
}
export async function boardAdd(machine: unknown, body: Parameters<typeof projects.addTask>[1]) {
  const { m, beads: b } = await isBeads(machine)
  return b ? beads.addBead(m, body) : projects.addTask(machine, body)
}
// beads has no archive: closed issues are Done, on the Board itself.
export async function boardArchived(machine: unknown): Promise<{ machine: string, tasks: TaskRow[] }> {
  const { m, beads: b } = await isBeads(machine)
  return b ? { machine: m.key, tasks: [] } : projects.archivedTasks(machine)
}

// The beads every beads board knows, for links in conversations. Machines on
// herdr-projects are never read for it. `none`: no beads board at all (the
// client can stop asking for a while).
export async function boardBeadRefs(since?: string): Promise<BeadRefsReply> {
  const ms = baseMachines().filter(m => m.local || m.status === 'online')
  const kinds = await Promise.all(ms.map(m => backendOf(m).catch(() => 'projects' as const)))
  const own = ms.filter((_, i) => kinds[i] === 'beads')
  const refs: BeadRef[] = (await Promise.all(own.map(m => beads.beadRefs(m).catch(() => [] as BeadRef[])))).flat()
  const version = createHash('sha1').update(JSON.stringify(refs)).digest('hex').slice(0, 16)
  if (since === version) return { same: true, version }
  return { version, refs, ...(own.length ? {} : { none: true }) }
}
