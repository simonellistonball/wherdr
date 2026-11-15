// herdr-projects' links for the home list (GET /api/tasks/links): which panes
// and spaces belong to each machine's board. Read every 15 s while a list that
// uses it is mounted and the page is shown (`same` when nothing changed), and
// again when Herdr's spaces change (a task's space opens). Kept at module
// level: the list comes back with the last links at once.
import { type BoardLinks, type BoardLinksReply, type MachineLinks, resolveCoordinators } from '#shared/boardLinks'
import { skipWhileBusy } from '~/utils/requestGuards'

const POLL_MS = 15000
const links = shallowRef<BoardLinks | null>(null)
let users = 0
let poll: ReturnType<typeof setInterval> | undefined
let seq = 0

async function load() {
  if (offlineView.value) return
  const id = ++seq
  try {
    const since = links.value ? `?since=${encodeURIComponent(links.value.version)}` : ''
    const r = await api<BoardLinksReply>(`/api/tasks/links${since}`)
    if (id === seq && !('same' in r)) links.value = r
  } catch { /* the list stays as it is: ungrouped rows are still listed */ }
}

// A tick starts nothing while the last read is still out (utils/requestGuards.ts).
const tick = skipWhileBusy(load)

// The links read, each coordinator on the pane Herdr shows it in now (its
// file's ids may be those of a pane closed since: resolveCoordinators).
const resolved = computed<MachineLinks[]>(() => resolveCoordinators(links.value?.machines ?? [], herdrState.value.panes))
// The last links read (the close confirmation names the tasks it stops).
export const boardLinksNow = (): MachineLinks[] => resolved.value
// Read now (before a close is confirmed: the list may not be on screen).
export const refreshBoardLinks = () => load()

export function useBoardLinks() {
  onMounted(() => {
    if (!users++) {
      load()
      poll = setInterval(() => { if (document.visibilityState === 'visible') tick() }, POLL_MS)
    }
  })
  onBeforeUnmount(() => { if (!--users) clearInterval(poll) })
  watch(pageVisible, (v) => { if (v) load() })
  // A space opened or closed: the board may have just linked it.
  let spaces = ''
  watch(() => herdrState.value.workspaces.map(w => w.id).join(' '), (now) => {
    if (spaces && now !== spaces) setTimeout(load, 1500)
    spaces = now
  })
  return resolved
}

// The clock of the elapsed times on the board's cards: one for every card, every 20 s.
const now = ref(Date.now())
let ticking = false
export function useBoardNow() {
  if (!ticking && import.meta.client) {
    ticking = true
    setInterval(() => { if (document.visibilityState === 'visible') now.value = Date.now() }, 20000)
  }
  return now
}
