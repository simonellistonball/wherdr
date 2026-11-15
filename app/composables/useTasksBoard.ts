// The Board's data (BoardView): herdr-projects 1.x tasks of every machine from
// GET /api/tasks, read again every 15 s while the page is shown (the server
// answers `same` when nothing changed) and right after an action.
// The last board is kept at module level: the view reopens at once with it;
// `reads` counts the reads that answered since then, so what must not trust
// that kept board (a push that opens a task) waits for a fresh one.
// After a reload (or iOS reopening the app), the last board kept on this device
// (offlineCache.ts) shows at once with when it was read (`cachedAt`) until a
// read answers.
import type { TasksBoard, TasksReply } from '#shared/projectsTasks'
import { readBoard, saveBoard } from '~/utils/offlineCache'
import { mayReadOffline, readOfflineAccess } from '~/utils/offlineAccess'
import { skipWhileBusy } from '~/utils/requestGuards'

const POLL_MS = 15000
const SOON_MS = 1500
let lastBoard: TasksBoard | null = null
// The last board read, from here or by a task's sheet (its "Start after…"
// picker and the names of the tasks it waits for).
export const seenTasksBoard = shallowRef<TasksBoard | null>(null)
export function sawTasksBoard(b: TasksBoard) { lastBoard = b; seenTasksBoard.value = b }
// The task open in the Board's side panel (set by BoardView while it is shown):
// its conversation in the sidebar is selected too (AgentCard).
export const boardOpenTask = shallowRef<{ machine: string, id: string } | null>(null)

export function useTasksBoard() {
  const board = shallowRef<TasksBoard | null>(lastBoard)
  const cachedAt = ref<number | null>(null)
  const error = ref('')
  const reads = ref(0)
  let seq = 0
  let stopped = false
  let soon: ReturnType<typeof setTimeout> | undefined

  async function load(fresh = false) {
    if (stopped || offlineView.value) return
    const id = ++seq
    try {
      const since = !fresh && board.value ? `?since=${encodeURIComponent(board.value.version)}` : ''
      const r = await api<TasksReply>(`/api/tasks${since}`)
      if (id !== seq) return
      error.value = ''
      cachedAt.value = null
      // Still being read on the server (repo keys, a slow first list): again soon.
      clearTimeout(soon)
      if (('same' in r ? board.value : r)?.machines.some(m => m.pending)) soon = setTimeout(() => load(), SOON_MS)
      if (!('same' in r)) {
        board.value = r
        sawTasksBoard(r)
        if (mayReadOffline(readOfflineAccess())) saveBoard(r)
      }
      reads.value++
    } catch (e) {
      if (id === seq) error.value = (e as Error).message
    }
  }

  let poll: ReturnType<typeof setInterval> | undefined
  onMounted(() => {
    load()
    if (!board.value && mayReadOffline(readOfflineAccess())) {
      readBoard().then((s) => {
        if (s && !board.value && !stopped) { board.value = s.board; cachedAt.value = s.at }
      })
    }
    // A tick starts nothing while the last read is still out (utils/requestGuards.ts).
    const tick = skipWhileBusy(() => load())
    poll = setInterval(() => { if (document.visibilityState === 'visible') tick() }, POLL_MS)
  })
  onBeforeUnmount(() => {
    stopped = true
    clearInterval(poll)
    clearTimeout(soon)
  })
  // Back on the page: at once rather than at the next tick.
  watch(pageVisible, (v) => { if (v) load() })

  return { board, cachedAt, error, reads, reload: () => load(true) }
}
