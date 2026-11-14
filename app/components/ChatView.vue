<script setup lang="ts">
// Conversation: the agent's transcript (without touching the terminal, so
// without resizing the pane the computer is looking at), re-read every 1.5 s (the server
// replies "unchanged" as long as the file has not grown).
// Shown = older pages loaded on demand (`older`, up to
// byte `olderCursor`) + bottom re-read continuously from byte `tailStart`.
import type { ChatItem, ChatResponse, ClaudeQueueEntry, ClaudeScreen, OmpToolView, Pane, QueuedMessage } from '#shared/types'
import { readChat, saveChat, touchChat } from '~/utils/offlineCache'
import { mayReadOffline, readOfflineAccess } from '~/utils/offlineAccess'
import { queueReason, canClearQueued } from '~/utils/queuedReason'
import { canCancelQueued, lostPhotosText, restoreDraft } from '~/utils/queuedCancel'
import { isUploadLine, uploadSrc } from '#shared/queuedMatch'
import { pendingQueue, rememberSent } from '~/utils/pendingQueue'
import { clampRange, createSelectionSettler, lastLineRect, selectionReplyPos } from '~/utils/selectionReply'
import { addAnswer, addQuote, answerEnd, answerOf, forgetReply, isQuoted, replyTargets, rowOf, rowRef, rowSettled, tableRank, tableRef, tappedAnswer, toggleOkAll, unansweredCount, withQuestions, type Answer } from '~/utils/questionReply'
import { createTailLoader, nextTail, restartsTail, tailQuery } from '~/utils/chatTail'
import { pickTyping, replyId } from '~/utils/typewriter'
import { newestThought } from '~/utils/reasoningReveal'
import { restoredScrollTop, saveReadingPosition } from '~/utils/readingPosition'
import { isStale, noMisses, onError, onUnavailable, type ChatMisses } from '~/utils/chatMiss'
import { findReplyOrigin, parseReply, type ReplyTarget } from '#shared/replyQuote'
import { messageId, messageOf, messageRef, pointRef, type Reference } from '#shared/reference'
import { isAttachmentLine, parseAttachmentLine } from '#shared/attachments'
import { OMP_CONSOLE_SHOWN, isOmpGroup, ompConsoleRows, ompTotalMs, ompWall } from '~/utils/ompTool'
import { duplicateImages } from '#shared/imageDupes'
import { isAutopilotWake } from '~/utils/autopilotWake'
import { stripPosition } from '#shared/filePaths'

const props = defineProps<{ pane: Pane, localQueued: OutboxItem[] }>()

// Beads named in replies link to their agent, or to the bead on the Board
// (utils/beadLinks.ts). The links follow the Board: one pass per HTML and refs.
let beadHtml = new Map<string, string>()
watch(beadRefs, () => { beadHtml = new Map() })
function withBeads(html: string): string {
  const known = beadRefs.value
  if (!known.size) return html
  let out = beadHtml.get(html)
  if (out === undefined) {
    out = linkBeadMentions(html, known, props.pane.id)
    if (beadHtml.size > 2000) beadHtml = new Map()
    beadHtml.set(html, out)
  }
  return out
}
function openBead(id: string) {
  const ref = beadRefs.value.get(id)
  if (!ref) return
  const agent = ref.pane && ref.pane !== props.pane.id && herdrState.value.panes.some(p => p.id === ref.pane) ? ref.pane : null
  void navigateTo(agent ? panePath(agent) : { path: '/board', query: { machine: ref.machine, task: ref.id } })
}
// A version of a reply replaced while the agent writes takes its question marks with it.
onMdDropped(forgetReply)
const route = useRoute()
const emit = defineEmits<{ gotoTerm: [], restored: [], quote: [], answered: [caret: number], unanswered: [count: number], sent: [queued: QueuedMessage | null] }>()
const searchOpen = defineModel<boolean>('search', { default: false })

const box = ref<HTMLElement | null>(null)
const listEl = ref<HTMLElement | null>(null)

interface ChatData {
  file: string | null
  token: string
  tailStart: number | null
  older: ChatItem[]
  olderCursor: number
  tail: ChatItem[]
  queue: ClaudeQueueEntry[]
}
const fresh = (): ChatData => ({ file: null, token: '', tailStart: null, older: [], olderCursor: 0, tail: [], queue: [] })
const chat = shallowRef<ChatData>(fresh())
const items = computed(() => chat.value.older.concat(chat.value.tail))
// The beads it can link to, read again (at most every 15 s) as the conversation grows.
watch(() => items.value.length, () => { void loadBeadRefs() }, { immediate: true })
const unavailable = ref<ChatResponse['reason'] | null>(null)
// With 'no_integration': what to install, and where (see shared/integrations.ts).
const integration = ref<ChatResponse['integration'] | null>(null)
const loadError = ref<string | null>(null)
const misses = shallowRef<ChatMisses>(noMisses()) // missed polls, view kept
const rendered = ref(false)
const olderBusy = ref(false)
const savedAt = ref<number | null>(null)
const readOnly = computed(() => offlineView.value || paneStale(props.pane))
// The end kept on this device, still not read again after 600 ms: "Read at" over the list.
const cachedTag = useDelayedFlag(computed(() => savedAt.value !== null && !readOnly.value && !netDown.value), 600, 0)
// Nothing kept and the end still loading: its shapes, after 300 ms (ChatSkeleton).
const skeleton = useDelayedFlag(computed(() => !rendered.value && !unavailable.value && !loadError.value))
// Commands in the agent's replies can be run in its shell mode (Run buttons,
// utils/shellCommand.ts); the replies carry `can-run` then.
const canRun = computed(() => canRunIn(props.pane))
// The end kept on this device, read while the network is asked (see onMounted):
// shown only if it comes first.
async function restoreChat() {
  if (!mayReadOffline(readOfflineAccess())) return
  const id = props.pane.id
  const saved = await readChat(id)
  if (!saved || synced || rendered.value || unavailable.value || id !== props.pane.id) return
  await apply(() => {
    chat.value = { ...fresh(), tail: saved.items }
    savedAt.value = saved.at
  })
  touchChat(props.pane.id)
}

// ------------------------------------------------------------ scrolling
const nearEnd = (px: number) => {
  const b = box.value
  return !b || b.scrollHeight - b.scrollTop - b.clientHeight < px
}
function scrollToEnd(force: boolean) {
  const b = box.value
  if (!b) return
  if (force || (!held && (stick || nearEnd(160)))) {
    stick = true
    held = false
    requestAnimationFrame(() => { b.scrollTop = b.scrollHeight })
  }
}
// Updates the conversation while keeping the current reading position: stuck to the bottom if
// we were there (or on first display), otherwise at the same place.
async function apply(update: () => void, keepScroll = false) {
  const wasNear = !held && (stick || nearEnd(120))
  const first = !rendered.value
  const before = blocks.value.length
  update()
  // Bottom first (see `shown`); what arrives below while blocks wait above stays shown.
  if (first) shown.value = FIRST_BLOCKS
  else if (shown.value !== Infinity) shown.value += Math.max(0, blocks.value.length - before)
  await nextTick()
  rendered.value = true
  if (hiddenBlocks.value) revealLater()
  // Back to a conversation already read: same position (see readingPosition.ts),
  // once its session is known; further up than what is shown: everything first.
  let restoreTop: number | null = null
  if (restoring && chat.value.file && box.value) {
    restoring = false
    if (hiddenBlocks.value && restoredScrollTop(props.pane.id, chat.value.file, box.value.scrollHeight) === 0) await revealAll()
    restoreTop = restoredScrollTop(props.pane.id, chat.value.file, box.value.scrollHeight)
  }
  if (!jumping && searchOpen.value && search.q.length >= 2) applySearchMarks(false)
  else if (restoreTop !== null && !jumping && box.value) {
    stick = false
    box.value.scrollTop = restoreTop
  }
  else if (!keepScroll && (wasNear || first)) scrollToEnd(true)
}
// Opened on a search result: that is what we show.
let restoring = typeof route.query.hit !== 'string'
// Stuck to the bottom: the conversation stays there when the area shrinks (agent
// question, keyboard, attached photos) or when content arrives.
let stick = true
// After a one-tap answer (holdScroll): nothing sticks it again, neither the
// scroll events that follow nor a status change, until the reader scrolls
// or the draft is sent or emptied.
let held = false
function onUserScroll() {
  held = false
  interruptThought()
}
let ro: ResizeObserver | null = null
onMounted(() => {
  ro = new ResizeObserver(() => {
    const b = box.value
    if (b && stick) b.scrollTop = b.scrollHeight
  })
  if (box.value) ro.observe(box.value)
  // Content that grows afterwards (images loaded, blocks expanded).
  if (listEl.value) ro.observe(listEl.value)
})
onBeforeUnmount(() => {
  if (box.value && rendered.value) saveReadingPosition(props.pane.id, chat.value.file, box.value)
})
onUnmounted(() => ro?.disconnect())
function onScroll() {
  const b = box.value
  if (!b) return
  lastScroll = Date.now()
  codeMenu.open = false
  if (!held) stick = b.scrollHeight - b.scrollTop - b.clientHeight < 120
  // Infinite scrolling upwards: the blocks not shown yet, then the older pages.
  if (hiddenBlocks.value) { if (b.scrollTop < 1500) revealMore(MORE_BLOCKS * 2) }
  else if (b.scrollTop < 400 && rendered.value) loadOlder()
}

// ------------------------------------------------------------ bottom first
// A conversation opens with its last FIRST_BLOCKS blocks only: creating the ~160
// blocks of a page at once held the main thread for a second or more, for 5 on
// screen. The ones above follow a few at a time while the page is idle, or at
// once when scrolling up to them; search, a search result and "show original"
// show them all first. `shown` counts the blocks rendered from the bottom.
const FIRST_BLOCKS = 30
const MORE_BLOCKS = 10
const shown = ref(Infinity)
const hiddenBlocks = computed(() => Math.max(0, blocks.value.length - shown.value))
const visibleBlocks = computed(() => (hiddenBlocks.value ? blocks.value.slice(hiddenBlocks.value) : blocks.value))
let lastScroll = 0
let revealTimer = false
let unmounted = false
onUnmounted(() => { unmounted = true })
// More blocks above, the reading position kept.
async function revealMore(n: number) {
  if (!hiddenBlocks.value) return
  const b = box.value
  const fromBottom = b ? b.scrollHeight - b.scrollTop : 0
  shown.value = n === Infinity ? Infinity : blocks.value.length - hiddenBlocks.value + n
  await nextTick()
  if (b) b.scrollTop = b.scrollHeight - fromBottom
}
const revealAll = () => revealMore(Infinity)
// The next few, once the page is idle (not while scrolling: a block added above
// would stop an iPhone's momentum).
function revealLater() {
  if (revealTimer || unmounted) return
  revealTimer = true
  const run = () => {
    revealTimer = false
    if (unmounted || !hiddenBlocks.value) return
    // Keep the first visible commit small even when the skeleton's minimum
    // duration outlasts the network response.
    if (skeleton.value || Date.now() - lastScroll < 400 || document.hidden) return revealLater()
    revealMore(MORE_BLOCKS).then(() => { if (hiddenBlocks.value) revealLater() })
  }
  const idle = (globalThis as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number }).requestIdleCallback
  if (idle) idle(run, { timeout: 3000 })
  else setTimeout(run, 250)
}
function interruptThought() { activeThought.value = null }

// ------------------------------------------------------------ typewriter
// Only a reply that arrives while following the conversation is revealed
// (ChatMarkdown): never on first load, on return to the app or after
// being offline, nor for older slices.
const knownReplies = new Set<string>()
const knownThoughts = new Set<string>()
const activeThought = ref<{ id: string, at: number } | null>(null)
const typing = ref<{ id: string, at: number } | null>(null)
let synced = false // first load from the server done
let away = false // app in the background or offline since the last re-read
watch(pageVisible, (v) => { if (!v) { away = true; interruptThought() } })
watch(offlineView, (v) => { if (v) { away = true; interruptThought() } })
function noteReplies(list: ChatItem[]) {
  const live = synced && !away && typewriterActive.value && !searchOpen.value && !readOnly.value
  const revealThinking = synced && !away && !searchOpen.value && !readOnly.value
  const thought = newestThought(knownThoughts, list.filter(i => i.role === 'thinking').map(replyId), revealThinking)
  if (thought) activeThought.value = { id: thought, at: Date.now() }
  away = false
  synced = true
  const id = pickTyping(knownReplies, list.filter(i => i.role === 'assistant').map(replyId), live && !thought)
  if (id) typing.value = { id, at: Date.now() }
}
const typingAt = (id: string) => (typing.value && typing.value.id === id ? typing.value.at : null)
function typingDone(id: string) { if (typing.value?.id === id) typing.value = null }
watch([typewriterActive, searchOpen], ([on, s]) => { if (!on || s) typing.value = null; if (s) interruptThought() })
function thoughtTyping(id: string) { return activeThought.value?.id === id ? activeThought.value.at : null }
function thoughtDone(id: string) { if (activeThought.value?.id === id) interruptThought() }

// ------------------------------------------------------------ chargement
async function copyIntegration() {
  if (!integration.value) return
  haptic()
  try {
    await navigator.clipboard.writeText(integration.value.command)
    toast(tl('Command copied.', 'Commande copiée.'))
  } catch { toast(t('Copy failed'), true) }
}

// One re-read at a time (utils/chatTail.ts): `false` = done, `true` = run
// again at once, with the lock still held.
const chatIntent = useChatIntent()
async function loadStep(current: () => boolean): Promise<boolean> {
  const pane = props.pane.id
  const stale = () => !current() || pane !== props.pane.id
  try {
    const ready = chat.value.tailStart === null ? await chatIntent.take(props.pane) : undefined
    if (stale()) return false
    const r = ready || await api<ChatResponse>(`/api/chat?${tailQuery(pane, chat.value)}`)
    if (stale()) return false
    if (!r.available) {
      const m = onUnavailable(misses.value, Boolean(chat.value.file) && items.value.length > 0)
      misses.value = m.next
      if (!m.clear) return false
      chat.value = fresh()
      unavailable.value = r.reason || 'unsupported'
      integration.value = r.reason === 'no_integration' ? r.integration || null : null
      // Conversation opened before its first reply: that reply is new.
      synced = true
      return false
    }
    unavailable.value = null
    integration.value = null
    loadError.value = null
    if (misses.value.misses || misses.value.errors) misses.value = noMisses()
    if (r.unchanged) return false
    savedAt.value = null
    // New session (/clear, new agent), or a bottom read from another byte:
    // we start again from the bottom (utils/chatTail.ts).
    if (restartsTail(chat.value, r)) {
      chat.value = fresh()
      synced = false
      return true
    }
    // Incremental reply that does not fit our list: ask for it in full.
    const tail = nextTail(chat.value.tail, r)
    if (!tail) {
      chat.value = { ...chat.value, token: '' }
      return true
    }
    await apply(() => {
      const c = { ...chat.value }
      if (c.tailStart === null) {
        c.tailStart = r.start ?? 0
        c.olderCursor = r.start ?? 0
      }
      c.file = r.file || null
      c.token = r.token || ''
      c.tail = tail
      c.queue = r.queue || []
      chat.value = c
      noteReplies(c.tail)
    })
    saveChat(pane, items.value)
    // Paint the prepared tail first, then revalidate using its token and cursor.
    if (ready) return true
  } catch (err) {
    if (stale()) return false
    if (!items.value.length) loadError.value = (err as Error).message
    else misses.value = onError(misses.value)
  }
  return false
}
const tailLoader = createTailLoader(loadStep)
const loadChat = tailLoader.load
watch(() => props.pane.id, () => tailLoader.invalidate())

// Older slice, keeping on screen what we were reading.
async function loadOlder() {
  if (olderBusy.value || !(chat.value.olderCursor > 0)) return
  olderBusy.value = true
  const pane = props.pane.id
  const file = chat.value.file
  const before = chat.value.olderCursor
  try {
    const r = await api<ChatResponse>(`/api/chat?pane=${encodeURIComponent(pane)}&before=${before}`)
    if (pane !== props.pane.id || r.file !== file || chat.value.olderCursor !== before) return
    const b = box.value
    const fromBottom = b ? b.scrollHeight - b.scrollTop : 0
    await apply(() => {
      shown.value = Infinity
      chat.value = {
        ...chat.value,
        older: (r.items || []).concat(chat.value.older),
        // no progress: stop there
        olderCursor: (r.start ?? 0) < before ? (r.start ?? 0) : 0,
      }
    }, true)
    saveChat(pane, items.value)
    if (b) b.scrollTop = b.scrollHeight - fromBottom
  } catch (err) {
    toast((err as Error).message, true)
  } finally {
    olderBusy.value = false
  }
}

let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  // The network at once, the kept end alongside (shown only if it comes first).
  Promise.all([loadChat(), restoreChat()]).then(jumpToResult)
  timer = setInterval(() => { if (!document.hidden && !offlineView.value) loadChat() }, 1500)
})
onUnmounted(() => clearInterval(timer))
watch(pageVisible, (v) => { if (v) loadChat() })

// ------------------------------------------------------------ rendu
// Short tool nouns: written as pairs because "Read" or "Search" mean something else elsewhere.
const TOOL_COMMAND = tl('Command', 'Commande'), TOOL_EDIT = tl('Edit', 'Modif'), TOOL_SUBAGENT = tl('Subagent', 'Sous-agent')
const TOOL_LABEL: Record<string, string> = {
  Bash: TOOL_COMMAND, Read: tl('Read', 'Lecture'), Write: tl('Write', 'Écriture'), Edit: TOOL_EDIT, MultiEdit: TOOL_EDIT, Grep: tl('Search', 'Recherche'),
  Glob: tl('Files', 'Fichiers'), WebFetch: 'Web', WebSearch: tl('Web search', 'Recherche web'), Task: TOOL_SUBAGENT, Agent: TOOL_SUBAGENT,
  TodoWrite: tl('Tasks', 'Tâches'), exec: TOOL_COMMAND, shell: TOOL_COMMAND, apply_patch: TOOL_EDIT,
}
const TOOL_ICON: Record<string, string> = {
  Bash: 'i-lucide-terminal', exec: 'i-lucide-terminal', shell: 'i-lucide-terminal',
  Read: 'i-lucide-file-text', Write: 'i-lucide-file-plus', Edit: 'i-lucide-file-pen', MultiEdit: 'i-lucide-file-pen',
  apply_patch: 'i-lucide-file-pen', NotebookEdit: 'i-lucide-file-pen', Grep: 'i-lucide-text-search', Glob: 'i-lucide-folder-search',
  WebFetch: 'i-lucide-globe', WebSearch: 'i-lucide-search', Task: 'i-lucide-bot', Agent: 'i-lucide-bot',
  TodoWrite: 'i-lucide-list-todo', AskUserQuestion: 'i-lucide-message-circle-question',
}
// Codex "exec" runs code: a shell command, or another tool (write_stdin…).
// Tool summary: the task count comes from the server in English ("3 tasks").
const toolText = (tool: ChatItem) => (tool.name === 'TodoWrite' ? t(tool.text || '') : tool.text)
const isOtherTool = (tool: ChatItem) => tool.name === 'exec' && /^\w+$/.test(tool.text || '')
const toolLabel = (tool: ChatItem) => isOtherTool(tool) ? t('Tool') : TOOL_LABEL[tool.name || ''] || tool.name || ''
const toolIcon = (tool: ChatItem) => (tool.error ? 'i-lucide-circle-x' : isOtherTool(tool) ? 'i-lucide-wrench' : TOOL_ICON[tool.name || ''] || 'i-lucide-wrench')
// Collapsed action block: its last action.
const groupSuffix = (tool: ChatItem) => `${toolLabel(tool)} · ${tool.text}`
// omp's calls: a console of the last ones, the earlier ones unfolded on demand.
const ompRows = (b: { key: string, list: ChatItem[] }) => ompConsoleRows(b.list, isOpen(b.key))
// omp notes (custom_message shown): [label, icon] per kind.
const NOTICE: Record<string, [string, string]> = {
  'advisor': ['Advisor', 'i-lucide-lightbulb'],
  'async-result': ['Background job done', 'i-lucide-circle-check'],
  'irc:incoming': ['Agent message', 'i-lucide-message-square'],
  'launch-completion': ['Process', 'i-lucide-cpu'],
  'lsp-late-diagnostic': ['Diagnostics', 'i-lucide-triangle-alert'],
  'background-tan-dispatch': ['Background task', 'i-lucide-bot'],
  // Prompt a scheduled task gave Claude Code (see server/utils/transcripts.ts).
  'scheduled': ['Scheduled task', 'i-lucide-clock'],
}

const UPLOAD_RE = /\/\.cache\/herdr-web\/uploads\/\S+/g
type Block =
  | { k: 'day', key: string, label: string }
  | { k: 'who', key: string }
  | { k: 'user', key: string, text: string, pasted?: string[], srcs: string[], files: { path: string, name: string }[], time: string | null, at: string | null, reply: ReplyTarget | null, origin: string | null }
  // `rid`: its code in the references to it (shared/reference.ts messageId).
  | { k: 'assistant', key: string, id: string, rid: string, text: string, html: string, time: string | null, endsTurn: boolean }
  | { k: 'thinking', key: string, id: string, text: string, html: string, ms: number | undefined }
  | { k: 'job', key: string, id: string, tool: string, out: string, ms: number | undefined, error: boolean }
  | { k: 'autopilot', key: string, text: string }
  | { k: 'system', key: string, text: string }
  | { k: 'notice', key: string, label: string, icon: string, html: string, long: boolean, scheduled?: boolean }
  // The agent's turn failed (omp: usage limit, credit balance, stalled stream…).
  | { k: 'error', key: string, text: string, long: boolean }
  | { k: 'shell', key: string, bash: boolean, text: string, out: string, err: string, lines: number, long: boolean }
  | { k: 'ompRun', key: string, tool: ChatItem & { omp: OmpToolView } }
  | { k: 'tools', key: string, list: ChatItem[], live: boolean }
  | { k: 'turn', key: string, text: string, copy: string | null, reply: string | null }

// Images of a transcript item (a user message, or what a tool returned),
// re-read on demand from its line (ref = its position in the file).
function itemImageSrcs(it: ChatItem): string[] {
  const file = chat.value.file
  const srcs: string[] = []
  if (!it.ref || !it.images || !file) return srcs
  for (let k = 0; k < it.images; k++) {
    srcs.push(`/api/chat/image?pane=${encodeURIComponent(props.pane.id)}&file=${encodeURIComponent(file)}&ref=${it.ref}&i=${(it.imageAt || 0) + k}`)
  }
  return srcs
}
// Image srcs of actions that only repeat an image shown higher up.
const dupeSrcs = computed(() => {
  const dupes = duplicateImages(items.value)
  const out = new Set<string>()
  if (!dupes.size) return out
  for (const it of items.value) {
    if (!it.hashes || it.role === 'user') continue
    itemImageSrcs(it).forEach((src, k) => { if (dupes.has(`${it.ref}:${(it.imageAt || 0) + k}`)) out.add(src) })
  }
  return out
})
// At most 6 thumbnails under an action ("+N" opens the rest).
const TOOL_THUMB_MAX = 6
// Images of actions whose row is not on screen (collapsed block): kept
// visible under the block.
function hiddenToolImages(b: Block & { k: 'tools' }): string[][] {
  const shown: readonly ChatItem[] = isOmpGroup(b.list) ? ompRows(b).rows : b.list.length <= 3 || isOpen(b.key) ? b.list : []
  return b.list.filter(x => x.images && !shown.includes(x)).map(itemImageSrcs).filter(s => s.length)
}

// A block's HTML, rendered when first read: only the blocks shown (and the last
// reply, for its questions) pay for their Markdown.
function lazyHtml<T extends object>(b: T, render: () => string): T & { html: string } {
  let html: string | undefined
  return Object.defineProperty(b, 'html', { get: () => (html ??= render()), enumerable: true }) as T & { html: string }
}

const openTools = reactive(new Set<string>())
const working = computed(() => !readOnly.value && props.pane.status === 'working')

const blocks = computed<Block[]>(() => {
  const out: Block[] = []
  const list = items.value
  let tools: ChatItem[] = []
  // Stable key of an action block (keeps its expanded state when older
  // pages are added above).
  const seen = new Map<string, number>()
  const flush = () => {
    if (!tools.length) return
    const f = tools[0]!
    const base = `t:${f.ts}:${f.text}`
    const n = seen.get(base) || 0
    seen.set(base, n + 1)
    out.push({ k: 'tools', key: `${base}#${n}`, list: tools, live: false })
    tools = []
  }
  // A "turn" = a user message and everything the agent does
  // afterwards. At its end: "✓ 2 min 5 s · 7 actions", like "Worked for…".
  let turn: { start: string | null, end: string | null, tools: number, replies: number } | null = null
  let lastDay = ''
  // Agent name at the top of each of its replies (once per turn).
  let needWho = true
  // Last reply of a turn: copyable from the end-of-turn line.
  let lastReply: string | null = null
  let lastReplyBlock: (Block & { k: 'assistant' }) | null = null
  const replies: { key: string, time: string | null, text: string, rid: string }[] = []
  const closeTurn = () => {
    if (turn && turn.end && turn.start && (turn.tools || turn.replies)) {
      const s = Math.max(0, Math.round((Date.parse(turn.end) - Date.parse(turn.start)) / 1000))
      const acts = turn.tools ? ` · ${turn.tools} ${t(turn.tools > 1 ? 'actions' : 'action')}` : ''
      // "Reply" of the last reply: next to "Copy", on the end-of-turn line.
      if (lastReplyBlock) lastReplyBlock.endsTurn = true
      out.push({ k: 'turn', key: `e:${out.length}`, text: `✓ ${fmtDuration(s)}${acts}`, copy: lastReply, reply: lastReplyBlock?.key || null })
    }
    turn = null
    lastReply = null
    lastReplyBlock = null
  }
  list.forEach((it, i) => {
    if (it.ts) {
      const day = new Date(it.ts).toDateString()
      if (day !== lastDay) {
        if (it.role !== 'tool') {
          flush()
          if (it.role === 'user') closeTurn()
        }
        if (lastDay) out.push({ k: 'day', key: `d:${day}`, label: dayLabel(it.ts) })
        lastDay = day
      }
    }
    if (it.role === 'user' || it.role === 'cmd' || it.role === 'bash' || (it.role === 'notice' && it.name === 'scheduled')) {
      flush()
      closeTurn()
      needWho = true
      // The output of a "!" command also goes to the agent, which may reply to it.
      if (it.role !== 'cmd') turn = { start: it.ts, end: null, tools: 0, replies: 0 }
    } else if (turn && it.ts && it.role !== 'notice' && it.role !== 'job') {
      // A note (background task finished afterwards…) does not extend the turn.
      turn.end = it.ts
      if (it.role === 'tool') turn.tools++
      else if (it.role === 'assistant') turn.replies++
    }
    if ((it.role === 'tool' || it.role === 'assistant' || it.role === 'thinking') && needWho) {
      needWho = false
      out.push({ k: 'who', key: `w:${it.ts}:${i}` })
    }
    if (it.role === 'tool') {
      tools.push(it)
      return
    }
    flush()
    const key = `${it.role}:${it.ts}:${i}`
    if (isAutopilotWake(it)) {
      out.push({ k: 'autopilot', key, text: it.text })
    } else if (it.role === 'user') {
      const uploads = it.text.match(UPLOAD_RE) || []
      // Attached files (PDF, text…): a chip each, their line leaves the text.
      const files = it.text.split('\n').map(parseAttachmentLine).filter((f): f is { path: string, name: string } => Boolean(f))
      const text = it.text.replace(/^.*\/\.cache\/herdr-web\/uploads\/\S+\s*$/gm, '').split('\n').filter(l => !isAttachmentLine(l)).join('\n').trim()
      // Images re-read from the transcript (ref = position of the message in the
      // file), or photos stored on the server whose path stayed as text.
      const srcs = itemImageSrcs(it)
      for (const u of uploads) srcs.push(`/uploads/${encodeURIComponent(u.split('/').pop()!)}`)
      // Reply to a specific message: the marker becomes a quote linking to the original.
      const parsed = parseReply(text)
      const origin = parsed ? findReplyOrigin(replies, parsed.reply)?.key || null : null
      out.push({ k: 'user', key, text: parsed ? parsed.body : text, pasted: it.pasted, srcs, files, time: it.ts ? fmtTime(it.ts) : null, at: it.ts ? fmtDateTime(it.ts) : null, reply: parsed?.reply || null, origin })
    } else if (it.role === 'assistant') {
      lastReply = it.text
      const time = it.ts ? fmtTime(it.ts) : null
      lastReplyBlock = lazyHtml({ k: 'assistant' as const, key, id: replyId(it), rid: messageId(it), text: it.text, time, endsTurn: false }, () => withQuestions(md(it.text), { reply: t('Reply'), quoted: t('Quoted'), discuss: t('Discuss'), yes: t('Yes'), no: t('No'), okAll: t('OK to all'), decisions: t('Decisions') }))
      out.push(lastReplyBlock)
      replies.push({ key, time, text: it.text, rid: lastReplyBlock.rid })
    } else if (it.role === 'thinking') {
      out.push(lazyHtml({ k: 'thinking' as const, key, id: replyId(it), text: it.text, ms: it.ms }, () => md(it.text)))
    } else if (it.role === 'job' && it.job) {
      out.push({ k: 'job', key, id: it.job.id, tool: it.job.tool, out: it.job.out, ms: it.ms, error: Boolean(it.error) })
    } else if (it.role === 'bash' && it.omp) {
      out.push({ k: 'ompRun', key: `s:${it.ts}:${it.text.slice(0, 40)}`, tool: { ...it, omp: it.omp } })
    } else if (it.role === 'bash') {
      const o = it.out || ''
      const e = it.err || ''
      const lines = (o ? o.split('\n').length : 0) + (e ? e.split('\n').length : 0)
      out.push({ k: 'shell', key: `s:${it.ts}:${it.text.slice(0, 40)}`, bash: it.role === 'bash', text: it.text, out: o, err: e, lines, long: lines > SHELL_LINES || o.length + e.length > 1500 })
    } else if (it.role === 'notice' && it.name === 'error' && it.error) {
      // The provider's own message (often raw JSON): shown as plain text.
      out.push({ k: 'error', key, text: it.text, long: it.text.split('\n').length > SHELL_LINES || it.text.length > 1200 })
    } else if (it.role === 'notice') {
      const [label, icon] = NOTICE[it.name || ''] || [it.name || 'Note', 'i-lucide-info']
      // A scheduled prompt starts folded: it is not what the user wrote.
      out.push(lazyHtml({ k: 'notice' as const, key, label: t(label), icon, scheduled: it.name === 'scheduled', long: it.name === 'scheduled' || it.text.split('\n').length > SHELL_LINES || it.text.length > 1200 }, () => md(it.text)))
    } else {
      const effort = it.role === 'system' ? it.text.match(/^Effort : (low|medium|high|xhigh|max|ultracode) \(cette session\)$/) : null
      // Local "/" command: one-line system separator ("/cost → …").
      out.push({ k: 'system', key, text: effort
        ? tl(`Effort: ${effort[1]} (this session)`, `Effort : ${effort[1]} (cette session)`)
        : it.role === 'system' ? t(it.text) : it.text })
    }
  })
  flush()
  // Last turn: summary only if it is finished (the agent is no longer working,
  // nor waiting for an approval or an answer in the middle of the turn).
  const blocked = !readOnly.value && props.pane.status === 'blocked'
  if (!working.value && !blocked && !props.pane.pendingPrompt) closeTurn()
  else {
    // In progress: the last action is the one running (or waiting for its approval).
    const last = out[out.length - 1]
    if (last && last.k === 'tools' && (working.value || blocked)) last.live = true
  }
  return out
})

// Command output: collapsed beyond a few lines.
const SHELL_LINES = 12
// Action block: three or fewer, one line each; beyond that, collapsed
// behind "N actions · last action".
const isOpen = (key: string) => openTools.has(key)
function setOpen(key: string, v: boolean) {
  if (v) openTools.add(key)
  else openTools.delete(key)
}

// "Reply" under a message refers to the whole message. A passage
// selected in an agent message brings up a floating "Reply"
// button right after it, once the selection is done (see utils/selectionReply.ts);
// it quotes the passage in the field, like the "↳ Reply" button of each
// question (utils/questionReply.ts): several references, each with its answer
// (shared/reference.ts).
const msgEl = (key: string) => [...(listEl.value?.querySelectorAll<HTMLElement>('[data-hit-key]') || [])].find(el => el.dataset.hitKey === key) || null
// The agent message an element sits in, as a reference names it: the time
// shown on it, and its code.
const sourceAt = (el: Element | null) => {
  const key = el?.closest<HTMLElement>('[data-hit-key]')?.dataset.hitKey
  const b = key ? blocks.value.find(x => x.key === key) : null
  return b && b.k === 'assistant' ? { time: b.time, id: b.rid } : { time: null, id: null }
}
// What a button of a reply refers to: a row of a decision table, the whole
// table ("OK to all"), or a question or point.
function refOf(el: HTMLElement): Reference | null {
  const { time, id } = sourceAt(el)
  if (el.classList.contains('q-all')) return tableRef({ n: el.dataset.n || '', text: el.dataset.q || '' }, time, id, tableRank(el))
  const row = el.closest<HTMLElement>('.q-trow')
  if (row) return rowRef(rowOf(row), time, id)
  return el.dataset.q ? pointRef(el.dataset.q, time, id) : null
}
function replyTo(key: string) {
  const b = blocks.value.find(x => x.key === key)
  if (!b || b.k !== 'assistant') return
  quote(messageRef(b.text, b.time, b.rid))
}
function quote(ref: Reference | null) {
  const draft = useDraft(props.pane.id)
  const next = ref ? addQuote(draft.text, ref) : null
  selReply.value = null
  window.getSelection()?.removeAllRanges()
  if (next !== null) draft.text = next
  haptic()
  emit('quote')
}
// "Yes" / "No" of a closed question or of a row of a decision table: refers to
// it and writes the answer under the reference, as Reply and typing would;
// nothing is sent. After a click, `answered` hands the caret to the field
// (components/Composer.vue): it takes the focus only where Enter sends, so
// Enter sends the answer at once on a computer, while on a phone the keyboard
// stays down and the next question to answer stays in sight. A button
// pressed with the keyboard keeps the focus, to answer the next one.
const answerWord = (a: Answer) => a === 'yes' ? t('Yes') : t('No')
// A one-tap answer adds lines to the field, which grows over the bottom of the
// conversation: the messages stay where they are (no re-pinning to the end),
// so the next button to tap does not move under the finger.
const holdScroll = () => { stick = false; held = true }
function answer(ref: Reference | null, a: Answer, click: boolean) {
  if (!ref) return
  holdScroll()
  const draft = useDraft(props.pane.id)
  const next = addAnswer(draft.text, ref, answerWord(a))
  if (next !== null) draft.text = next
  haptic()
  if (click) emit('answered', answerEnd(draft.text, ref))
}
// "OK to all" of a decision table; a second tap takes it back.
function okAll(ref: Reference | null, click: boolean) {
  if (!ref) return
  holdScroll()
  const draft = useDraft(props.pane.id)
  draft.text = toggleOkAll(draft.text, ref, tl('OK to all', 'OK tout'))
  haptic()
  if (click) emit('answered', answerEnd(draft.text, ref))
}
const answered = (ref: Reference, a: Answer) => tappedAnswer(answerOf(draftText.value, ref) || '') === a
// "Quoted" state of the question and point buttons (and of the words of a
// question) and pressed state of the one-tap answers, read from the draft.
function syncQuoted() {
  const text = useDraft(props.pane.id).text
  for (const btn of listEl.value?.querySelectorAll<HTMLElement>('.q-ans, .q-tans') || []) {
    const ref = refOf(btn)
    btn.setAttribute('aria-pressed', String(Boolean(ref) && tappedAnswer(answerOf(text, ref!) || '') === btn.dataset.a))
  }
  for (const btn of listEl.value?.querySelectorAll<HTMLElement>('.q-all') || []) btn.setAttribute('aria-pressed', String(isQuoted(text, refOf(btn)!)))
  for (const btn of listEl.value?.querySelectorAll<HTMLElement>('.q-reply, .q-point, .q-tquote') || []) {
    const ref = refOf(btn)
    const on = Boolean(ref) && isQuoted(text, ref!)
    btn.classList.toggle('quoted', on)
    if (btn.dataset.n && !btn.classList.contains('q-tquote')) for (const span of wordsOf(btn)) span.classList.toggle('quoted', on)
  }
}
// The words of a question (`.q-text`) and its button share a number in their message.
const wordsOf = (btn: HTMLElement) => btn.closest('.md-body')?.querySelectorAll<HTMLElement>(`.q-text[data-n="${btn.dataset.n}"]`) || []
const buttonOf = (span: HTMLElement) => span.closest('.md-body')?.querySelector<HTMLElement>(`.q-reply[data-n="${span.dataset.n}"]`) || null
// "Tap the text" style on a touch screen: a tap on a point only arms it (its
// "↳ Discuss" button shows); a tap anywhere while reading must not quote.
let armed: HTMLElement | null = null
function arm(el: HTMLElement | null) {
  armed?.classList.remove('q-armed')
  armed = el
  el?.classList.add('q-armed')
}
// "List" style: the message whose points are waiting to be picked.
const pickKey = ref<string | null>(null)
const draftText = computed(() => useDraft(props.pane.id).text)
watch(draftText, (text) => { if (!text) held = false })
function hotQuestion(key: string, n: string, on: boolean) {
  for (const span of msgEl(key)?.querySelectorAll<HTMLElement>(`.q-text[data-n="${n}"]`) || []) span.classList.toggle('q-hot', on)
}
// A click on a point quotes it at once on a computer; not the first click of
// a double click, which selects a word.
let pointTimer: ReturnType<typeof setTimeout> | undefined
function onPointClick(e: MouseEvent, target: HTMLElement) {
  const point = target.closest<HTMLElement>('.msg-ai .md-body .q-pt')
  const btn = point?.querySelector<HTMLElement>(':scope > .q-point')
  const text = btn?.dataset.q
  clearTimeout(pointTimer)
  if (!point || !text || target.closest('a, button, summary, input')) return arm(null)
  if (replyStyle.value === 'list') {
    if (pickKey.value && point.closest<HTMLElement>('[data-hit-key]')?.dataset.hitKey === pickKey.value) {
      pickKey.value = null
      quote(refOf(btn!))
    }
    return
  }
  if (replyStyle.value !== 'text' || window.getSelection()?.isCollapsed === false) return arm(null)
  if (isTouch()) return arm(point === armed ? null : point)
  if (e.detail > 1) return
  pointTimer = setTimeout(() => { if (window.getSelection()?.isCollapsed !== false) quote(refOf(btn!)) }, 220)
}
onUnmounted(() => clearTimeout(pointTimer))
watch([() => useDraft(props.pane.id).text, visibleBlocks], () => nextTick(syncQuoted), { flush: 'post' })
const selReply = ref<{ text: string, time: string | null, id: string | null, sig: string, top: number, left: number } | null>(null)
const selBtn = ref<HTMLElement | null>(null)
const isTouch = () => window.matchMedia('(pointer: coarse)').matches
// Current selection in an agent message: text, end (last line) and signature.
function currentSelection() {
  const sel = window.getSelection()
  const range = sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : null
  const start = range ? (range.startContainer.nodeType === 1 ? range.startContainer as Element : range.startContainer.parentElement) : null
  // Message at the start of the selection; the range is trimmed to its content (see clampRange).
  const host = start?.closest<HTMLElement>('.msg-ai[data-hit-key]')
  if (!range || !host || readOnly.value || !listEl.value?.contains(host)) return null
  const clamped = clampRange(range, host.querySelector('.md') || host)
  const text = clamped?.toString().trim() || ''
  if (!clamped || !text) return null
  const end = lastLineRect(clamped.getClientRects()) || clamped.getBoundingClientRect()
  return { host, text, end, sig: `${text}|${Math.round(end.right)}|${Math.round(end.top)}` }
}
function showSelectionReply() {
  const cur = currentSelection()
  if (!cur || !listEl.value) { selReply.value = null; return }
  const view = listEl.value.getBoundingClientRect()
  const pos = selectionReplyPos(cur.end, { width: selBtn.value?.offsetWidth || 104, height: selBtn.value?.offsetHeight || 32 }, { width: window.innerWidth, top: Math.max(0, view.top), bottom: Math.min(window.innerHeight, view.bottom) }, isTouch())
  selReply.value = pos ? { text: cur.text, ...sourceAt(cur.host), sig: cur.sig, ...pos } : null
}
const settler = createSelectionSettler({ show: showSelectionReply, hide: () => { selReply.value = null }, touch: isTouch })
const onSelDown = (e: PointerEvent) => { if (e.button === 0 && !(e.target as Element | null)?.closest?.('.sel-reply')) settler.down() }
const onSelUp = () => settler.up()
const onSelChange = () => settler.change(!!selReply.value && currentSelection()?.sig === selReply.value.sig)
const onSelScroll = () => { if (selReply.value || window.getSelection()?.isCollapsed === false) settler.scroll() }
onMounted(() => {
  document.addEventListener('pointerdown', onSelDown, true)
  document.addEventListener('pointerup', onSelUp, true)
  document.addEventListener('pointercancel', onSelUp, true)
  document.addEventListener('selectionchange', onSelChange)
  window.addEventListener('scroll', onSelScroll, true)
  window.addEventListener('resize', onSelScroll)
})
onUnmounted(() => {
  settler.dispose()
  document.removeEventListener('pointerdown', onSelDown, true)
  document.removeEventListener('pointerup', onSelUp, true)
  document.removeEventListener('pointercancel', onSelUp, true)
  document.removeEventListener('selectionchange', onSelChange)
  window.removeEventListener('scroll', onSelScroll, true)
  window.removeEventListener('resize', onSelScroll)
})
// A reference of a sent message tapped (components/QuotedText.vue): the agent
// message it names, among those before the message it sits in.
provide('gotoRef', (ref: Reference, el: HTMLElement) => {
  const key = el.closest<HTMLElement>('[data-hit-key]')?.dataset.hitKey
  const at = key ? blocks.value.findIndex(b => b.key === key) : -1
  const replies = (at < 0 ? blocks.value : blocks.value.slice(0, at)).flatMap(b => (b.k === 'assistant' ? [{ key: b.key, time: b.time, text: b.text, rid: b.rid }] : []))
  gotoOrigin(findReplyOrigin(replies, { time: ref.time || '', excerpt: ref.excerpt, id: ref.id && messageOf(ref.id) })?.key || null)
})
// Quote tapped: scrolls to the original message and highlights it.
async function gotoOrigin(key: string | null) {
  if (key && !msgEl(key) && hiddenBlocks.value) await revealAll()
  const el = key ? msgEl(key) : null
  if (!el) return toast(t('Original message not found (further up the conversation?)'), true)
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  el.classList.remove('msg-flash')
  void el.offsetWidth
  el.classList.add('msg-flash')
  setTimeout(() => el.classList.remove('msg-flash'), 1700)
}

const copyText = copyCode
// Markdown code blocks: "Copy" and "Run" buttons; inline paths and commands:
// their menu (event delegation, the HTML comes from v-html).
function onListClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  const ans = target.closest?.('.q-ans') as HTMLElement | null
  // `detail` counts the clicks of a pointer; 0 for a button pressed with the keyboard.
  const click = e.detail > 0
  if (ans?.dataset.q) { e.preventDefault(); arm(null); pickKey.value = null; answer(refOf(ans), ans.dataset.a === 'no' ? 'no' : 'yes', click); return }
  const rowAns = target.closest?.('.q-tans') as HTMLElement | null
  if (rowAns?.dataset.n) { e.preventDefault(); arm(null); pickKey.value = null; answer(refOf(rowAns), rowAns.dataset.a === 'no' ? 'no' : 'yes', click); return }
  const all = target.closest?.('.q-all') as HTMLElement | null
  if (all) { e.preventDefault(); arm(null); pickKey.value = null; okAll(refOf(all), click); return }
  const question = target.closest?.('.q-reply, .q-point, .q-tquote') as HTMLElement | null
  if (question) { e.preventDefault(); arm(null); pickKey.value = null; quote(refOf(question)); return }
  // "Tap the text" style: the words of a question are its button.
  const asked = replyStyle.value === 'text' && !readOnly.value ? target.closest?.('.q-text') as HTMLElement | null : null
  const askedBtn = asked && window.getSelection()?.isCollapsed !== false ? buttonOf(asked) : null
  if (askedBtn) { e.preventDefault(); arm(null); quote(refOf(askedBtn)); return }
  const beadEl = target.closest?.('.md-body .md-bead') as HTMLElement | null
  if (beadEl?.dataset.bead) { e.preventDefault(); openBead(beadEl.dataset.bead); return }
  const pathEl = target.closest?.('.md-body .md-path') as HTMLElement | null
  if (pathEl) { e.preventDefault(); openPathMenu(pathEl); return }
  const cmdEl = target.closest?.('.md-body .md-cmd') as HTMLElement | null
  if (cmdEl) { e.preventDefault(); openCmdMenu(cmdEl); return }
  // Image in an agent reply (markdown): large preview, like ours.
  const img = target.closest?.('.md-body img') as HTMLImageElement | null
  if (img && img.src) { e.preventDefault(); openImage(img.src); return }
  if (!readOnly.value && !target.closest?.('.code-block')) onPointClick(e, target)
  const run = target.closest?.('.can-run .code-run') as HTMLElement | null
  const runCmd = run?.closest<HTMLElement>('.code-block')?.dataset.cmd
  if (runCmd) { void runCommand(runCmd); return }
  const btn = target.closest?.('.code-copy') as HTMLElement | null
  if (!btn) return
  const block = btn.closest<HTMLElement>('.code-block')
  // A shell command is copied without its prompts ("! ", "$ ") nor output.
  const text = block?.dataset.cmd ?? block?.querySelector('pre')?.textContent
  if (text == null) return
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = t('Copied')
    btn.classList.add('done')
    setTimeout(() => {
      btn.textContent = t('Copy')
      btn.classList.remove('done')
    }, 1400)
  }).catch(() => toast(t('Copy failed'), true))
}

// ------------------------------------------------------------ commands
// A command the agent proposes runs in its own terminal, in its shell mode,
// only after the user has seen it in full and confirmed (composables/useCodeRun.ts).
// Never from a message of the user's (their messages are not markdown) nor on its own.
async function runCommand(cmd: string) {
  const queued = await runInAgent(props.pane.id, cmd)
  if (queued !== false) emit('sent', queued)
}
async function runInSplit(cmd: string) {
  if (readOnly.value) return
  try {
    const r = await api<{ pane_id: string, created?: boolean }>('/api/split-command', { pane_id: props.pane.id, command: cmd })
    toast(r.created ? t('Command sent to a new split terminal') : t('Command sent to split terminal'))
    await navigateTo(desk.value ? { path: tabPath(props.pane.tab), query: { pane: r.pane_id } } : panePath(r.pane_id))
  } catch (err) { toast((err as Error).message, true) }
}
function cmdMenuItems(cmd: string, runnable: boolean): MenuItem[] {
  const items: MenuItem[] = []
  if (runnable) items.push({ label: tl('Run…', 'Lancer…'), icon: 'i-lucide-play', run: () => runCommand(cmd) })
  if (!readOnly.value) items.push({ label: t('Run in split terminal'), icon: 'i-lucide-columns-2', run: () => runInSplit(cmd) })
  items.push({ label: t('Copy command'), icon: 'i-lucide-copy', desc: cmd, mono: true, run: () => copyText(cmd) })
  return items
}
function openCmdMenu(el: HTMLElement) {
  const cmd = el.dataset.cmd
  if (!cmd) return
  openCodeMenu(el, cmdMenuItems(cmd, canRun.value && Boolean(el.closest('.can-run'))), tl('Command', 'Commande'))
}

// ------------------------------------------------------------ file paths
// Inline code that looks like a path (utils/markdown.ts): Preview (in a sheet,
// FilesView) and Download from the agent's machine, wherever it runs; Reveal
// in Finder and Open there when it is a Mac; Copy path everywhere.
// Paths and commands: dropdown at the code on a computer, sheet on the phone.
const codeMenu = reactive({ open: false, x: 0, y: 0, w: 0, h: 0 })
const codeMenuDropdown = ref<ReturnType<typeof toDropdown>>([])
function openCodeMenu(el: HTMLElement, items: MenuItem[], title: string) {
  if (sheetMenus.value) {
    haptic()
    openMenu(items, title)
    return
  }
  const r = el.getBoundingClientRect()
  Object.assign(codeMenu, { x: r.left, y: r.top, w: r.width, h: r.height })
  codeMenuDropdown.value = toDropdown(items)
  codeMenu.open = true
}
const fileName = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p
function pathMenuItems(p: string): MenuItem[] {
  const items: MenuItem[] = []
  // A folder (`src/`) has nothing to show or save.
  if (!offlineView.value && !p.endsWith('/')) {
    items.push(
      { label: t('Preview'), icon: 'i-lucide-eye', run: () => previewFile(p) },
      { label: t('Download'), icon: 'i-lucide-download', run: () => downloadFile(p) },
    )
  }
  if (canOpenOnMachine(props.pane) && !offlineView.value) {
    items.push(
      { label: t('Reveal in Finder'), icon: 'i-lucide-folder-search', run: () => revealOnMachine(p, 'reveal') },
      { label: t('Open'), icon: 'i-lucide-external-link', run: () => revealOnMachine(p, 'open') },
    )
  }
  items.push({ label: t('Copy path'), icon: 'i-lucide-copy', desc: p, mono: true, run: () => copyText(p) })
  return items
}
function openPathMenu(el: HTMLElement, path?: string) {
  const p = path || (el.textContent || '').trim()
  if (p) openCodeMenu(el, pathMenuItems(p), fileName(p))
}
const filePeek = reactive({ open: false, path: '' })
function previewFile(p: string) {
  Object.assign(filePeek, { open: true, path: p })
}
async function downloadFile(p: string) {
  try { await saveFile(`/api/files/download?pane=${encodeURIComponent(props.pane.id)}&path=${encodeURIComponent(p)}&from=chat`, fileName(stripPosition(p))) }
  catch (err) { toast((err as Error).message, true) }
}
function onListKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && (pickKey.value || armed)) { pickKey.value = null; arm(null); return }
  if (e.key !== 'Enter' && e.key !== ' ') return
  const bead = (e.target as HTMLElement).closest?.('.md-body .md-bead') as HTMLElement | null
  if (bead?.dataset.bead) { e.preventDefault(); openBead(bead.dataset.bead); return }
  const el = (e.target as HTMLElement).closest?.('.md-body .md-path, .md-body .md-cmd') as HTMLElement | null
  if (!el) return
  e.preventDefault()
  if (el.classList.contains('md-cmd')) openCmdMenu(el)
  else openPathMenu(el)
}
async function revealOnMachine(p: string, mode: 'reveal' | 'open') {
  try {
    const r = await api<{ machine: string }>('/api/reveal', { pane_id: props.pane.id, path: p, mode })
    toast(mode === 'reveal'
      ? tl(`Shown in Finder on ${r.machine}`, `Affiché dans le Finder sur ${r.machine}`)
      : tl(`Opened in the editor on ${r.machine}`, `Ouvert dans l’éditeur sur ${r.machine}`))
  } catch (err) {
    toast((err as Error).message, true)
  }
}

// ------------------------------------------------------------ queued
// Messages sent but not yet taken by the agent: dotted bubbles
// below the conversation, until they appear in its transcript.
// Our sends not yet taken + Claude's own queue (messages typed on
// the computer while it was working), without duplicates.
// Screen of a working Claude (read by the server): the transcript only has a
// "!" command at the end; the screen already says it is running, and which
// messages were sent or are still in its queue (see shared/queuedPhase.ts).
// omp: only the "!" / "$" command it runs (it stays idle meanwhile).
const screen = computed<ClaudeScreen | null>(() => {
  if (readOnly.value) return null
  const p = props.pane
  if (p.agent === 'omp') return p.ompShell ? { shell: p.ompShell, sent: null, queued: [] } : null
  return p.agent === 'claude' && p.status === 'working' ? p.claudeScreen || null : null
})
const liveShell = computed(() => (screen.value && screen.value.shell) || null)
// Duration of the running command, to the second.
const nowTick = ref(Date.now())
let tick: ReturnType<typeof setInterval> | undefined
watch(liveShell, (sh) => {
  if (sh && !tick) tick = setInterval(() => { nowTick.value = Date.now() }, 1000)
  if (!sh && tick) { clearInterval(tick); tick = undefined }
}, { immediate: true })
onUnmounted(() => clearInterval(tick))
const shellDuration = computed(() => {
  const since = liveShell.value && liveShell.value.since
  if (!since) return null
  const s = Math.max(0, Math.round((nowTick.value - since) / 1000))
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`
})
const queuedList = computed(() => {
  const p = props.pane
  // A record the server gives back is on its way to the message field (see utils/givenBack.ts).
  const mine = withOutbox(readOnly.value ? [] : (p.queued || []).filter(q => !q.back), props.localQueued)
  const memory = rememberSent(p.id, mine)
  const replies = blocks.value.filter(b => b.k === 'assistant')
  // Agent idle, nothing holding it: Claude's own queue is empty by now.
  const idle = queueReason(p, {}) === 'sending'
  return pendingQueue({ mine, claude: chat.value.queue || [], items: items.value, screen: screen.value, memory, idle }).map((q) => {
    const lines = q.raw.split('\n')
    const text = lines.filter(l => !isUploadLine(l) && !isAttachmentLine(l)).join('\n').trim()
    const parsed = parseReply(text)
    return {
      ...q,
      srcs: q.photos.map(uploadSrc),
      files: lines.map(parseAttachmentLine).filter((f): f is { path: string, name: string } => Boolean(f)),
      text,
      body: parsed ? parsed.body : text,
      reply: parsed?.reply || null,
      origin: parsed ? findReplyOrigin(replies, parsed.reply)?.key || null : null,
    }
  })
})
const sendingNow = ref(false)
async function sendNow() {
  if (sendingNow.value) return
  sendingNow.value = true
  try { await api('/api/send-now', { pane_id: props.pane.id }) }
  catch (err) { toast((err as Error).message, true) }
  finally { sendingNow.value = false }
}
// Same parts as a message in the conversation: thumbnails above the bubble,
// so nothing moves when it lands.
const pendingParts = (q: { srcs: string[], missing: number, body: string, files: unknown[] }) => [
  ...q.srcs.map(url => ({ type: 'file' as const, mediaType: 'image/jpeg', url })),
  ...Array.from({ length: q.missing }, () => ({ type: 'file' as const, mediaType: 'image/jpeg', url: '' })),
  ...(q.body || q.files.length ? [{ type: 'text' as const, text: q.body || ' ' }] : []),
]
// "Cancel": the message leaves the agent's queue and comes back into the input
// field. Already read in the meantime: the server refuses, we say so.
const canCancel = computed(() => !readOnly.value && canCancelQueued(props.pane))
const cancelling = ref<string | null>(null)
async function cancelQueued(q: { id: string, raw: string, mine: boolean, local?: boolean, pasted?: string[] }) {
  if (cancelling.value) return
  // Never reached the server: the app's copy goes back into the field.
  if (q.local) {
    restoreDraft(useDraft(props.pane.id), outboxDrop(props.pane.id, q.id) || q.raw)
    emit('restored')
    return
  }
  cancelling.value = q.id
  haptic()
  try {
    const r = await api<{ text: string, lost?: number }>('/api/unqueue', { pane_id: props.pane.id, text: q.raw, id: q.mine ? q.id : undefined })
    restoreDraft(useDraft(props.pane.id), r.text || q.raw, q.pasted)
    emit('restored')
    // Photos Claude queued itself, whose files wherdr never had: said, not silently dropped.
    if (r.lost) toast(t('Removed from the queue'), true, lostPhotosText(r.lost))
    else toast(t('Removed from the queue'))
    setTimeout(loadChat, 400)
  } catch (err) {
    toast((err as Error).message, true)
  } finally {
    cancelling.value = null
  }
}
// "Retry" on a message that could not be sent: held again by the server.
const retrying = ref<string | null>(null)
async function retryQueued(q: { id: string, local?: boolean }) {
  if (retrying.value) return
  retrying.value = q.id
  haptic()
  try {
    if (q.local) await outboxRetry(props.pane, props.pane.id, q.id)
    else await api('/api/requeue', { pane_id: props.pane.id, id: q.id })
  } catch (err) {
    toast((err as Error).message, true)
  } finally {
    retrying.value = null
  }
}
// Menu left open on the agent's screen (see server/utils/queued.ts
// lookForLeftMenu): closed with Escape, or closed and the messages typed now.
const menuLeftShown = computed(() => Boolean(props.pane.menuLeftOpen) && queuedList.value.some(q => q.phase === 'queued'))
const menuLeftBusy = ref<'close' | 'send' | null>(null)
async function menuLeft(action: 'close' | 'send') {
  if (menuLeftBusy.value) return
  menuLeftBusy.value = action
  haptic()
  try {
    await api('/api/menu-left', { pane_id: props.pane.id, action })
  } catch (err) {
    toast((err as Error).message, true)
  } finally {
    menuLeftBusy.value = null
  }
}
// Why a message is marked not sent (see server/utils/queued.ts).
function failedText(reason: QueuedMessage['reason'] | undefined) {
  if (reason === 'busy') return t('Not sent — the agent’s input contains text')
  if (reason === 'no_input') return t('Not sent — the agent’s input field was not found on its screen')
  if (reason === 'lost') return t('Not sent — it was taken out of the agent’s queue before being read')
  if (reason === 'unseen') return t('Not sent — still not in the conversation after an hour')
  return t('Not sent')
}
const clearing = ref<string | null>(null)
async function clearAndSend(q: { id: string, inputText?: string }) {
  if (clearing.value) return
  clearing.value = q.id
  try { await api('/api/clear-queued-input', { pane_id: props.pane.id, id: q.id, input_text: q.inputText }) }
  catch (err) { toast((err as Error).message, true) }
  finally { clearing.value = null }
}
function queuedLabel(q: { reason?: QueuedMessage['reason'], inputText?: string, state: string | null }) {
  if (q.state === 'sending') return t('Queued · ') + t('sending…')
  switch (queueReason(props.pane, q)) {
    case 'busy': return q.inputText
      ? tl(`Not sent: the agent’s input already contains text (“${q.inputText}”)`, `Pas envoyé : la saisie de l’agent contient déjà du texte (« ${q.inputText} »)`)
      : t('Not sent — the agent’s input contains text')
    case 'stopped': return t('Queued · ') + t('agent stopped')
    case 'question': return t('Queued · ') + t('after you answer the question')
    case 'dialog': return t('Queued · ') + t('will be sent when the menu closes')
    case 'starting': return t('Queued · ') + t('agent starting')
    case 'working': return t('Queued')
    default: return t('Queued · ') + t('sending…')
  }
}
watch(() => queuedList.value.map(q => `${q.id}:${q.phase}`).join(','), () => nextTick(() => scrollToEnd(false)))
watch(() => liveShell.value && liveShell.value.lines.join('\n'), () => nextTick(() => scrollToEnd(false)))

// No conversation yet but a waiting screen (key legend):
// the agent is waiting for an action. Recognized screen: details and buttons in the
// "Your turn" panel at the bottom; otherwise preview of the last lines, to do in the terminal.
const waiting = computed(() => {
  const p = props.pane
  if (p.menu || p.interaction === 'terminal' || !unavailable.value || unavailable.value === 'unsupported' || !p.screen || p.status === 'working' || readOnly.value) return null
  const who = kindLabel(p.agent)
  return knownScreen(p)
    ? { text: tl(`${who} is waiting for your answer, below or in the terminal.`, `${who} attend ta réponse, ci-dessous ou dans le terminal.`), lines: [] }
    : { text: tl(`${who} is waiting for an action in the terminal.`, `${who} attend une action dans le terminal.`), lines: p.screen.lines }
})

const status = computed(() => {
  if (readOnly.value) return null
  const p = props.pane
  if (p.pendingPrompt && p.status !== 'working') {
    return { typing: true, text: tl(`Your first message will be sent when ${kindLabel(p.agent)} is ready`, `Ton premier message partira dès que ${kindLabel(p.agent)} sera prêt`) }
  }
  // Claude: its current verb ("✻ Orbiting…"), read from the screen by the server;
  // the spinning star in front is animated on the app side (ClaudeSpinner).
  if (liveShell.value) return { typing: true, text: tl('Command running…', 'Commande en cours…') }
  if (p.status === 'working' && p.agent === 'claude' && p.activity) return { typing: true, verb: true, text: `${p.activity}…` }
  // omp: its running step ("⠧ Finding Fixed section") and the turn's time, read
  // from the screen; braille spinner animated on the app side (OmpSpinner).
  if (p.status === 'working' && p.agent === 'omp' && p.ompActivity) {
    const a = p.ompActivity
    return { typing: true, omp: true, since: a.since, text: a.step || `${kindLabel(p.agent)} ${tl('is working…', 'travaille…')}` }
  }
  if (p.status === 'working') return { typing: true, text: `${kindLabel(p.agent)} ${tl('is working…', 'travaille…')}` }
  if (p.status === 'blocked' && !p.menu && !waiting.value && !(p.prompt && p.prompt.options) && !knownScreen(p)) return { typing: false, text: t('Waiting for your reply — details in the Terminal tab') }
  return null
})
watch(() => props.pane.status, () => nextTick(() => scrollToEnd(false)))

// ------------------------------------------------------------ search
// Loads the whole conversation, then highlights the matches (CSS Custom
// Highlight API: nothing is modified in the DOM rendered by Vue) and lets
// you step through them.
const search = reactive({ q: '', hits: [] as Range[], cur: -1, loading: false })
let jumping = false
const searchInput = ref<{ inputRef?: HTMLInputElement } | null>(null)
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const highlights = (typeof CSS !== 'undefined' && 'highlights' in CSS) ? (CSS as unknown as { highlights: Map<string, unknown> }).highlights : null
type HighlightCtor = new (...r: Range[]) => unknown
const HighlightCls = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight

function clearMarks() {
  highlights?.delete('hw-hit')
  highlights?.delete('hw-cur')
}
function applySearchMarks(jumpToLast: boolean, target?: HTMLElement | null) {
  clearMarks()
  search.hits = []
  if (!searchOpen.value || search.q.length < 2 || !listEl.value) return
  const q = fold(search.q)
  const walker = document.createTreeWalker(listEl.value, NodeFilter.SHOW_TEXT)
  // fold() keeps the same length as the original text for the usual
  // accented letters (NFD then accents removed).
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const f = fold(n.nodeValue || '')
    let i = 0
    let j: number
    while ((j = f.indexOf(q, i)) >= 0) {
      const r = document.createRange()
      r.setStart(n, j)
      r.setEnd(n, Math.min(j + q.length, (n.nodeValue || '').length))
      search.hits.push(r)
      i = j + q.length
    }
  }
  if (target) {
    const at = search.hits.findIndex(r => target.contains(r.startContainer))
    search.cur = at >= 0 ? at : 0
  } else if (jumpToLast || search.cur >= search.hits.length) search.cur = search.hits.length - 1
  focusHit()
}
function focusHit() {
  if (highlights && HighlightCls) {
    highlights.set('hw-hit', new HighlightCls(...search.hits.filter((_, k) => k !== search.cur)))
    const cur = search.hits[search.cur]
    if (cur) highlights.set('hw-cur', new HighlightCls(cur))
    else highlights.delete('hw-cur')
  }
  const r = search.hits[search.cur]
  const b = box.value
  if (r && b) {
    const rect = r.getBoundingClientRect()
    const br = b.getBoundingClientRect()
    b.scrollTo({ top: b.scrollTop + rect.top - br.top - b.clientHeight / 2, behavior: 'smooth' })
  }
}
const searchCount = computed(() => search.loading
  ? t('loading…')
  : search.q.length < 2 ? '' : search.hits.length ? `${search.cur + 1}/${search.hits.length}` : t('no results'))
function stepSearch(d: number) {
  if (!search.hits.length) return
  search.cur = (search.cur + d + search.hits.length) % search.hits.length
  focusHit()
}
async function loadAllOlder() {
  while (chat.value.olderCursor > 0) {
    const before = chat.value.olderCursor
    await loadOlder()
    if (chat.value.olderCursor === before) break
  }
}
let searchTimer: ReturnType<typeof setTimeout> | undefined
function onSearchInput() {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(runSearch, 250)
}
async function runSearch() {
  if (search.q.trim().length < 2) {
    clearMarks()
    search.hits = []
    search.cur = -1
    return
  }
  if (chat.value.olderCursor > 0 && !readOnly.value) {
    search.loading = true
    await loadAllOlder()
    search.loading = false
  }
  await revealAll()
  applySearchMarks(true)
}
async function jumpToResult() {
  const raw = route.query.hit
  const q = route.query.q
  if (typeof raw !== 'string' || typeof q !== 'string' || !/^\d+$/.test(raw)) return
  const offset = Number(raw)
  searchOpen.value = true
  search.q = q
  search.loading = true
  jumping = true
  try {
    // Each load goes up one slice until the one of the target message.
    while (chat.value.olderCursor > offset && !readOnly.value) {
      const before = chat.value.olderCursor
      await loadOlder()
      if (chat.value.olderCursor >= before) break
    }
    await revealAll()
    const role = String(route.query.role || '')
    const ts = String(route.query.ts || '')
    const prefix = String(route.query.prefix || '')
    const index = items.value.findIndex(i => i.role === role && i.ts === ts && i.text.startsWith(prefix))
    const key = index < 0 ? '' : `${role}:${ts}:${index}`
    const target = [...(listEl.value?.querySelectorAll<HTMLElement>('[data-hit-key]') || [])].find(el => el.dataset.hitKey === key)
    applySearchMarks(false, target)
    if (target && !search.hits.length) target.scrollIntoView({ block: 'center' })
  } finally { jumping = false; search.loading = false }
}
watch(() => route.query.hit, () => { if (route.params.pane === props.pane.id) jumpToResult() })
function closeSearch() {
  searchOpen.value = false
}
watch(searchOpen, (open) => {
  if (open) nextTick(() => searchInput.value?.inputRef?.focus())
  else {
    search.q = ''
    search.hits = []
    search.cur = -1
    clearMarks()
  }
})
onUnmounted(clearMarks)
function onSearchKey(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    stepSearch(e.shiftKey ? 1 : -1)
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    closeSearch()
  }
}

function openImage(src: string) { openLightbox([src]) }

// Mod+F with the search already open: back to its field, text selected.
function focusSearch() {
  const el = searchInput.value?.inputRef
  el?.focus()
  el?.select()
}
// Questions left unanswered: those of the agent's last message that the draft
// does not answer yet (utils/questionReply.ts, unansweredCount), for the
// reminder above the field. Only once the agent has stopped on that message
// and nothing of the user's follows it: not while it works, types, waits on
// a prompt, or while a message of ours is on its way.
// `asked`: that message, whatever the draft says (the list keeps room for the
// reminder as long as it may show, so answering moves nothing).
const asked = computed(() => {
  if (readOnly.value || working.value || props.pane.status === 'blocked' || queuedList.value.length || liveShell.value) return null
  const last = blocks.value.findLast(b => b.k === 'assistant' || b.k === 'user' || b.k === 'autopilot' || b.k === 'shell' || b.k === 'ompRun')
  if (!last || last.k !== 'assistant' || typingAt(last.id) !== null) return null
  const targets = replyTargets(last.html)
  return targets.questions.length + targets.rows.length ? { key: last.key, time: last.time, rid: last.rid, targets } : null
})
const unanswered = computed(() => {
  const count = asked.value ? unansweredCount(asked.value.targets, draftText.value, asked.value.time, asked.value.rid) : 0
  return asked.value && count ? { key: asked.value.key, count } : null
})
watch(() => unanswered.value?.count || 0, n => emit('unanswered', n), { immediate: true })
onUnmounted(() => emit('unanswered', 0))
// Reminder tapped: scrolls to the first question still unanswered and flashes it.
function gotoUnanswered() {
  const msg = unanswered.value ? msgEl(unanswered.value.key) : null
  const text = draftText.value
  const src = sourceAt(msg)
  const el = [...(msg?.querySelectorAll<HTMLElement>('.q-reply, .q-trow') || [])].find(x => x.classList.contains('q-trow')
    ? !rowSettled(text, rowOf(x), src.time, src.id)
    : !isQuoted(text, refOf(x)!))
  if (!el) return
  const lit = el.classList.contains('q-trow') ? [el] : [...wordsOf(el)]
  ;(lit[0] || el).scrollIntoView({ block: 'center', behavior: reducedMotion.value ? 'auto' : 'smooth' })
  for (const x of lit) {
    x.classList.remove('q-flash')
    void x.offsetWidth
    x.classList.add('q-flash')
    setTimeout(() => x.classList.remove('q-flash'), 1700)
  }
  haptic()
}
defineExpose({ scrollToEnd, reload: () => setTimeout(loadChat, 400), focusSearch, gotoUnanswered })
</script>

<template>
  <div v-if="searchOpen" class="search-bar">
    <UInput
      ref="searchInput" v-model="search.q" type="search" enterkeyhint="search" autocomplete="off"
      icon="i-lucide-search" variant="none" :placeholder="t('Search the conversation')" class="flex-1 min-w-0"
      @update:model-value="onSearchInput" @keydown="onSearchKey"
    />
    <span class="search-count">{{ searchCount }}</span>
    <UButton icon="i-lucide-chevron-up" color="neutral" variant="ghost" size="sm" :aria-label="t('Previous')" @click="stepSearch(-1)" />
    <UButton icon="i-lucide-chevron-down" color="neutral" variant="ghost" size="sm" :aria-label="t('Next')" @click="stepSearch(1)" />
    <UButton icon="i-lucide-x" color="neutral" variant="ghost" size="sm" :aria-label="t('Close')" @click="closeSearch" />
  </div>

  <div class="chat-wrap">
    <OfflineNote v-if="readOnly || netDown" :label="readOnly ? t('Offline reading') : undefined" :at="savedAt" />
    <OfflineNote v-else-if="isStale(misses)" :label="t('Conversation not up to date — reconnecting…')" />
    <!-- The end kept on this device while the network is slow to answer: said, over the list (nothing moves). -->
    <span v-if="cachedTag && savedAt" class="cached-tag chat-cached" role="status">{{ tl(`Read at ${fmtTime(savedAt)}`, `Lu à ${fmtTime(savedAt)}`) }}</span>
    <div ref="box" class="chat" @scroll.passive="onScroll" @wheel.passive="onUserScroll" @touchmove.passive="onUserScroll">
      <UChatMessages
        :status="working ? 'streaming' : 'ready'" :should-auto-scroll="false"
        :auto-scroll="{ color: 'neutral', variant: 'outline' }"
        auto-scroll-icon="i-lucide-arrow-down"
        :ui="{ root: 'chat-msgs', viewport: 'hw-jump-vp', autoScroll: 'hw-jump' }"
      >
        <div ref="listEl" class="chat-list" :class="[readOnly ? 'no-reply' : `rs-${replyStyle}`, { asking: asked, skeleton }]" @click="onListClick" @keydown="onListKey">
          <div v-if="unavailable && waiting" class="chat-empty waiting">
            <UIcon name="i-lucide-square-terminal" class="chat-empty-icon" />
            <p>{{ waiting.text }}</p>
            <pre v-if="waiting.lines.length" class="choices-screen-text">{{ waiting.lines.join('\n') }}</pre>
            <UButton size="sm" color="neutral" variant="outline" class="mono-btn" icon="i-lucide-square-terminal" @click="emit('gotoTerm')">{{ t('View terminal') }}</UButton>
          </div>
          <div v-else-if="unavailable === 'no_integration' && integration" class="chat-empty no-integration">
            <UIcon name="i-lucide-plug-zap" class="chat-empty-icon" />
            <p class="no-integration-title">{{ tl(`Herdr's ${kindLabel(integration.agent)} integration is missing`, `L’intégration ${kindLabel(integration.agent)} de Herdr manque`) }}</p>
            <p class="no-integration-text">
              {{ integration.machine
                ? tl(`Without it, wherdr cannot find this agent's conversation. Run this in a terminal on ${integration.machine}, then restart the agent:`, `Sans elle, wherdr ne retrouve pas la conversation de cet agent. Lance cette commande dans un terminal de ${integration.machine}, puis relance l’agent :`)
                : tl('Without it, wherdr cannot find this agent\'s conversation. Run this in a terminal on the agent\'s machine, then restart the agent:', 'Sans elle, wherdr ne retrouve pas la conversation de cet agent. Lance cette commande dans un terminal de la machine de l’agent, puis relance l’agent :') }}
            </p>
            <code class="no-integration-cmd">{{ integration.command }}</code>
            <div class="no-integration-actions">
              <UButton size="sm" color="neutral" variant="outline" class="mono-btn" icon="i-lucide-copy" @click="copyIntegration">{{ t('Copy command') }}</UButton>
              <UButton size="sm" color="neutral" variant="outline" class="mono-btn" icon="i-lucide-square-terminal" @click="emit('gotoTerm')">{{ t('View terminal') }}</UButton>
            </div>
          </div>
          <div v-else-if="unavailable" class="chat-empty">
            <UIcon name="i-lucide-message-square-dashed" class="chat-empty-icon" />
            <p>{{ unavailable === 'not_found' ? t('No conversation for this agent yet.') : t('Conversation unavailable for this agent.') }}</p>
            <UButton size="sm" color="neutral" variant="outline" class="mono-btn" icon="i-lucide-square-terminal" @click="emit('gotoTerm')">{{ t('View terminal') }}</UButton>
          </div>
          <template v-else>
            <ChatSkeleton v-if="skeleton" :agent="pane.agent" />
            <!-- Blocks above not shown yet: no "Load earlier" before them. -->
            <template v-else-if="hiddenBlocks" />
            <div v-else-if="chat.olderCursor > 0" class="chat-more">
              <UButton size="xs" color="neutral" variant="outline" class="mono-btn" :loading="olderBusy" icon="i-lucide-arrow-up" @click="loadOlder">
                {{ t('Load earlier messages') }}
              </UButton>
            </div>
            <div v-else-if="chat.older.length" class="chat-note">{{ t('Start of conversation') }}</div>

            <template v-for="b in (skeleton ? [] : visibleBlocks)" :key="b.key">
              <div v-if="b.k === 'day'" class="day-sep"><span>{{ b.label }}</span></div>

              <div v-else-if="b.k === 'who'" class="msg-who" :class="pane.agent || ''">
                <UIcon :name="agentIcon(pane.agent) || 'i-lucide-bot'" /><span>{{ kindLabel(pane.agent) }}</span>
              </div>

              <AutopilotMessage v-else-if="b.k === 'autopilot'" :text="b.text" :data-hit-key="b.key" @copy="copyText" />

              <div v-else-if="b.k === 'user'" class="msg-user-wrap" :data-hit-key="b.key">
                <button v-if="b.reply" type="button" class="msg-quote" :aria-label="t('Show original message')" @click="gotoOrigin(b.origin)">
                  <UIcon name="i-lucide-corner-left-up" class="msg-quote-time" /><span class="msg-quote-time">{{ b.reply.time }}</span><span class="msg-quote-text">{{ b.reply.excerpt }}</span>
                </button>
                <UChatMessage
                  :id="b.key" role="user" side="right" variant="soft"
                  :parts="[...b.srcs.map(url => ({ type: 'file' as const, mediaType: 'image/jpeg', url })), ...(b.text || b.files.length ? [{ type: 'text' as const, text: b.text || ' ' }] : [])]"
                  :ui="{ root: b.text.trim() || b.files.length ? 'msg msg-user' : 'msg msg-user msg-no-text', container: 'msg-c', content: 'msg-bubble', header: 'msg-files' }"
                >
                  <template #files>
                    <MsgThumbs :srcs="b.srcs" :offline="readOnly" />
                  </template>
                  <template #content>
                    <span v-if="b.files.length" class="msg-file-chips">
                      <FileChip v-for="f in b.files" :key="f.path" :name="f.name" clickable @open="el => openPathMenu(el, f.path)" />
                    </span><UserText :text="b.text" :pasted="b.pasted" />
                  </template>
                </UChatMessage>
                <div v-if="b.time" class="msg-time" :title="b.at || undefined">{{ b.time }}</div>
              </div>

              <template v-else-if="b.k === 'assistant'">
                <UChatMessage
                  :id="b.key" role="assistant" side="left" variant="naked"
                  :data-hit-key="b.key"
                  :parts="[{ type: 'text', text: b.text }]"
                  :ui="{ root: `msg msg-ai tw-${pane.agent || 'agent'}${canRun ? ' can-run' : ''}${pickKey === b.key ? ' q-picking' : ''}`, container: 'msg-c', content: 'md' }"
                >
                  <template #content>
                    <ChatMarkdown :html="withBeads(b.html)" :typing="typingAt(b.id)" @done="typingDone(b.id)" />
                  </template>
                </UChatMessage>
                <div v-if="replyStyle === 'list' && !readOnly && typingAt(b.id) === null && (replyTargets(b.html).questions.length || replyTargets(b.html).pick)" class="q-bar">
                  <template v-if="replyTargets(b.html).questions.length">
                    <p class="q-bar-h">{{ tl('Questions · reply to', 'Questions · répondre à') }}</p>
                    <div v-for="q in replyTargets(b.html).questions" :key="q.n" class="q-line">
                      <button
                        type="button" class="q-row" :class="{ quoted: isQuoted(draftText, pointRef(q.text, b.time, b.rid)) }"
                        :aria-label="`${t('Reply')}: ${q.text}`" @click="quote(pointRef(q.text, b.time, b.rid))"
                        @mouseenter="hotQuestion(b.key, q.n, true)" @mouseleave="hotQuestion(b.key, q.n, false)" @focus="hotQuestion(b.key, q.n, true)" @blur="hotQuestion(b.key, q.n, false)"
                      >
                        <b>{{ isQuoted(draftText, pointRef(q.text, b.time, b.rid)) ? '✓' : q.n }}</b><span>{{ q.text }}</span><i>↳<em> {{ isQuoted(draftText, pointRef(q.text, b.time, b.rid)) ? t('Quoted') : t('Reply') }}</em></i>
                      </button>
                      <template v-if="q.closed">
                        <button
                          v-for="a in (['yes', 'no'] as const)" :key="a" type="button" class="q-row-ans" :aria-pressed="answered(pointRef(q.text, b.time, b.rid), a)"
                          :aria-label="`${answerWord(a)}: ${q.text}`" @click="answer(pointRef(q.text, b.time, b.rid), a, $event.detail > 0)"
                        >{{ answerWord(a) }}</button>
                      </template>
                    </div>
                  </template>
                  <button v-if="replyTargets(b.html).pick" type="button" class="q-pick" :aria-pressed="pickKey === b.key" @click="pickKey = pickKey === b.key ? null : b.key">
                    {{ pickKey === b.key ? tl('Pick the point to quote · Cancel', 'Choisis le point à citer · Annuler') : tl('+ Quote a point', '+ Citer un point') }}
                  </button>
                </div>
                <div v-if="!b.endsTurn && !readOnly" class="msg-actions">
                  <button type="button" class="msg-reply" @click="replyTo(b.key)">
                    <UIcon name="i-lucide-reply" /><span>{{ t('Reply') }}</span>
                  </button>
                </div>
              </template>

              <UChatReasoning v-else-if="b.k === 'thinking'" class="omp-thinking" :text="b.text"
                :streaming="thoughtTyping(b.id) !== null" :duration="b.ms === undefined ? undefined : Math.max(1, Math.round(b.ms / 1000))"
                :auto-close-delay="450" :ui="{ root: 'omp-thinking', trigger: 'omp-thinking-head', label: 'omp-thinking-label', content: 'omp-thinking-content', body: 'omp-thinking-body' }">
                <ChatMarkdown class="md" :html="b.html" :typing="thoughtTyping(b.id)" :speed="reducedMotion ? 'off' : 'fast'" :cipher="false" @done="thoughtDone(b.id)" />
              </UChatReasoning>

              <div v-else-if="b.k === 'job'" class="omp-job" :class="{ err: b.error, open: isOpen(b.key) }">
                <button type="button" class="omp-job-head" :disabled="!b.out" :aria-expanded="b.out ? isOpen(b.key) : undefined" @click="setOpen(b.key, !isOpen(b.key))">
                  <span class="omp-job-glyph">{{ b.error ? '✗' : '✓' }}</span>
                  <span class="omp-job-label">{{ tl('Background job completed', 'Tâche de fond terminée') }}</span>
                  <code>[{{ b.tool }}] {{ b.id }}</code>
                  <span v-if="b.ms !== undefined" class="omp-job-wall">{{ ompWall(b.ms) }}</span>
                  <UIcon v-if="b.out" :name="isOpen(b.key) ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" />
                </button>
                <div v-if="b.out && isOpen(b.key)" class="omp-tool-out">
                  <div class="omp-tool-out-head"><span class="omp-tool-out-label">{{ b.error ? tl('Error', 'Erreur') : tl('Output', 'Sortie') }}</span><span v-if="b.ms !== undefined" class="omp-tool-out-right">wall {{ ompWall(b.ms) }}</span></div>
                  <pre>{{ b.out }}</pre>
                </div>
              </div>

              <div v-else-if="b.k === 'shell'" class="msg-shell" :class="{ bash: b.bash, long: b.long, open: isOpen(b.key) }">
                <div class="msg-shell-cmd">
                  <span class="msg-shell-sign" aria-hidden="true">{{ b.bash ? '!' : '❯' }}</span>
                  <code>{{ b.text }}</code>
                  <UTooltip :text="t('Copy command')" :disabled="!desk">
                    <UButton icon="i-lucide-copy" color="neutral" variant="ghost" size="xs" class="msg-shell-copy" :aria-label="t('Copy command')" @click="copyText(b.bash ? `!${b.text}` : b.text)" />
                  </UTooltip>
                </div>
                <div v-if="b.out || b.err" class="msg-shell-body">
                  <pre v-if="b.out" class="msg-shell-out">{{ b.out }}</pre>
                  <pre v-if="b.err" class="msg-shell-out err">{{ b.err }}</pre>
                </div>
                <div v-else-if="b.bash" class="msg-shell-empty">{{ t('No output') }}</div>
                <button v-if="b.long" type="button" class="msg-shell-more" :aria-expanded="isOpen(b.key)" @click="setOpen(b.key, !isOpen(b.key))">
                  <UIcon :name="isOpen(b.key) ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" />
                  <span>{{ isOpen(b.key) ? t('Collapse') : tl(`Show all · ${b.lines} lines`, `Tout afficher · ${b.lines} lignes`) }}</span>
                </button>
              </div>
              <div v-else-if="b.k === 'ompRun'" class="tools omp-console omp-run">
                <div class="omp-console-head">
                  <span class="omp-console-title">{{ b.tool.omp.title === 'Python' ? '$' : '!' }}</span>
                  <span>{{ tl('You ran', 'Lancé par toi') }}</span>
                </div>
                <OmpTool :tool="b.tool" run />
              </div>
              <div v-else-if="b.k === 'system'" class="msg-system"><span>{{ b.text }}</span></div>
              <div v-else-if="b.k === 'error'" class="msg-notice msg-error" :class="{ long: b.long, open: isOpen(b.key) }">
                <div class="msg-notice-head"><UIcon name="i-lucide-circle-alert" /><span>{{ t('Error') }}</span></div>
                <div class="msg-notice-body msg-error-text">{{ b.text }}</div>
                <button v-if="b.long" type="button" class="msg-shell-more" :aria-expanded="isOpen(b.key)" @click="setOpen(b.key, !isOpen(b.key))">
                  <UIcon :name="isOpen(b.key) ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" />
                  <span>{{ isOpen(b.key) ? t('Collapse') : t('Show all') }}</span>
                </button>
              </div>
              <div v-else-if="b.k === 'notice'" class="msg-notice" :class="{ long: b.long, open: isOpen(b.key), scheduled: b.scheduled }">
                <div class="msg-notice-head"><UIcon :name="b.icon" /><span>{{ b.label }}</span></div>
                <ChatMarkdown class="msg-notice-body md" :html="withBeads(b.html)" :typing="null" />
                <button v-if="b.long" type="button" class="msg-shell-more" :aria-expanded="isOpen(b.key)" @click="setOpen(b.key, !isOpen(b.key))">
                  <UIcon :name="isOpen(b.key) ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" />
                  <span>{{ isOpen(b.key) ? t('Collapse') : t('Show all') }}</span>
                </button>
              </div>
              <div v-else-if="b.k === 'turn'" class="turn-end">
                <UTooltip v-if="b.copy" :text="t('Copy reply')" :disabled="!desk">
                  <UButton icon="i-lucide-copy" color="neutral" variant="ghost" size="xs" class="turn-copy" :aria-label="t('Copy reply')" @click="copyText(b.copy)" />
                </UTooltip>
                <button v-if="b.reply && !readOnly" type="button" class="msg-reply" @click="replyTo(b.reply)">
                  <UIcon name="i-lucide-reply" /><span>{{ t('Reply') }}</span>
                </button>
                <span>{{ b.text }}</span>
              </div>

              <!-- omp: a console, "OMP · N ACTIONS · Σ time", one line per call. -->
              <div v-else-if="b.k === 'tools' && isOmpGroup(b.list)" class="tools omp-console" :class="{ live: b.live }">
                <span class="fx-ring omp-ring" aria-hidden="true"><span class="fx-spin" /></span>
                <div class="omp-console-head">
                  <span class="omp-console-title">omp</span>
                  <span>{{ b.list.length }} {{ t('actions') }}</span>
                  <span v-if="ompTotalMs(b.list)" class="omp-console-total">Σ {{ ompWall(ompTotalMs(b.list)) }}</span>
                </div>
                <button
                  v-if="ompRows(b).hidden || (b.list.length > OMP_CONSOLE_SHOWN && isOpen(b.key))" type="button" class="omp-console-more"
                  :aria-expanded="isOpen(b.key)" @click="setOpen(b.key, !isOpen(b.key))"
                >
                  <template v-if="ompRows(b).hidden">⋯ {{ tl(`${ompRows(b).hidden} earlier actions`, `${ompRows(b).hidden} actions avant`) }}</template>
                  <template v-else>⋯ {{ t('Collapse') }}</template>
                </button>
                <MsgThumbs v-for="(srcs, j) in hiddenToolImages(b)" :key="`h${j}`" class="tool-thumbs" :srcs="srcs" :max="TOOL_THUMB_MAX" :offline="readOnly" :dupes="dupeSrcs" />
                <template v-for="(tool, j) in ompRows(b).rows" :key="`${b.key}:${b.list.length - ompRows(b).rows.length + j}`">
                  <OmpTool :tool="{ ...tool, omp: tool.omp! }" :live="b.live && tool === b.list[b.list.length - 1]" />
                  <MsgThumbs v-if="tool.images" class="tool-thumbs" :srcs="itemImageSrcs(tool)" :max="TOOL_THUMB_MAX" :offline="readOnly" :dupes="dupeSrcs" />
                </template>
              </div>
              <div v-else-if="b.k === 'tools'" class="tools" :class="{ live: b.live }">
                <template v-if="b.list.length <= 3">
                  <template v-for="(tool, j) in b.list" :key="j">
                    <UChatTool
                      :text="toolLabel(tool)" :suffix="toolText(tool)" :icon="toolIcon(tool)"
                      :loading="b.live && j === b.list.length - 1" :streaming="b.live && j === b.list.length - 1"
                      :ui="{ root: 'tool', trigger: 'tool-trigger', label: 'tool-label', suffix: 'tool-suffix', leading: 'tool-leading' }"
                      :class="{ err: tool.error }"
                    />
                    <MsgThumbs v-if="tool.images" class="tool-thumbs" :srcs="itemImageSrcs(tool)" :max="TOOL_THUMB_MAX" :offline="readOnly" :dupes="dupeSrcs" />
                  </template>
                </template>
                <UChatTool
                  v-else :open="isOpen(b.key)" :text="`${b.list.length} ${t('actions')}`"
                  :suffix="groupSuffix(b.list[b.list.length - 1]!)"
                  :icon="b.live ? undefined : 'i-lucide-layers'" :loading="b.live" :streaming="b.live" chevron="trailing"
                  :ui="{ root: 'tool group', trigger: 'tool-trigger', label: 'tool-label', suffix: 'tool-suffix', leading: 'tool-leading', body: 'tool-body', trailingIcon: 'tool-chev' }"
                  @update:open="setOpen(b.key, $event)"
                >
                  <template v-for="(tool, j) in b.list" :key="j">
                    <div class="tool-row" :class="{ err: tool.error }">
                      <UIcon :name="toolIcon(tool)" /><b>{{ toolLabel(tool) }}</b><span>{{ toolText(tool) }}</span>
                    </div>
                    <MsgThumbs v-if="tool.images" class="tool-thumbs" :srcs="itemImageSrcs(tool)" :max="TOOL_THUMB_MAX" :offline="readOnly" :dupes="dupeSrcs" />
                  </template>
                </UChatTool>
                <MsgThumbs v-for="(srcs, j) in hiddenToolImages(b)" :key="`h${j}`" class="tool-thumbs" :srcs="srcs" :max="TOOL_THUMB_MAX" :offline="readOnly" :dupes="dupeSrcs" />
              </div>
            </template>
            <div v-if="rendered && !items.length && !loadError" class="chat-empty">
              <UIcon name="i-lucide-message-square-dashed" class="chat-empty-icon" />
              <p>{{ t('No messages yet.') }}</p>
            </div>
            <div v-if="loadError" class="chat-empty"><p>{{ loadError }}</p></div>
          </template>
        </div>

        <Teleport to="body">
          <button
            v-if="selReply" ref="selBtn" type="button" class="sel-reply" :style="{ top: `${selReply.top}px`, left: `${selReply.left}px` }"
            :aria-label="t('Reply to this passage')" @pointerdown.prevent @mousedown.prevent @click="quote(pointRef(selReply.text, selReply.time, selReply.id))"
          >
            <UIcon name="i-lucide-reply" /><span>{{ t('Reply') }}</span>
          </button>
        </Teleport>
        <div v-if="queuedList.length || liveShell || screen?.sendNow" class="queued-list">
          <div v-if="!readOnly && screen?.sendNow" class="queued-tag">
            <button type="button" class="queued-cancel" :disabled="sendingNow" @click="sendNow">{{ t('Send now') }}</button>
          </div>
          <!-- Already sent (visible as sent on screen), not yet in the transcript. -->
          <div v-for="q in queuedList.filter(x => x.phase === 'sent')" :key="q.id" class="msg-user-wrap">
            <button v-if="q.reply" type="button" class="msg-quote" :aria-label="t('Show original message')" @click="gotoOrigin(q.origin)">
              <UIcon name="i-lucide-corner-left-up" class="msg-quote-time" /><span class="msg-quote-time">{{ q.reply.time }}</span><span class="msg-quote-text">{{ q.reply.excerpt }}</span>
            </button>
            <UChatMessage
              :id="`q:${q.id}`" role="user" side="right" variant="soft"
              :parts="pendingParts(q)"
              :ui="{ root: `msg msg-user msg-pending sent${q.body || q.files.length ? '' : ' msg-no-text'}`, container: 'msg-c', content: 'msg-bubble', header: 'msg-files' }"
            >
              <template #files>
                <MsgThumbs v-if="q.srcs.length" :srcs="q.srcs" /><span v-for="k in q.missing" :key="k" class="thumb-missing" :title="t('Image')"><UIcon name="i-lucide-image" /></span>
              </template>
              <template #content>
                <span v-if="q.files.length" class="msg-file-chips">
                  <FileChip v-for="f in q.files" :key="f.path" :name="f.name" clickable @open="el => openPathMenu(el, f.path)" />
                </span><UserText :text="q.body" :pasted="q.pasted" />
              </template>
            </UChatMessage>
            <div class="queued-tag sent"><UIcon name="i-lucide-check" /><span>{{ t('Sent · read by the agent') }}</span></div>
          </div>
          <!-- "!" command running: live output read from the screen. -->
          <div v-if="liveShell" class="msg-user-wrap">
            <div class="msg-shell bash running">
              <div class="msg-shell-cmd">
                <span class="msg-shell-sign" aria-hidden="true">{{ pane.agent !== 'omp' ? '!' : liveShell.python ? '>>>' : '$' }}</span>
                <code>{{ liveShell.command }}</code>
              </div>
              <div v-if="liveShell.lines.length" class="msg-shell-body">
                <div v-if="liveShell.hidden" class="msg-shell-hidden">{{ tl(`+ ${liveShell.hidden} lines above`, `+ ${liveShell.hidden} lignes au-dessus`) }}</div>
                <pre class="msg-shell-out">{{ liveShell.lines.join('\n') }}</pre>
              </div>
              <div v-else class="msg-shell-empty">{{ t('No output yet') }}</div>
            </div>
            <div class="queued-tag running">
              <UIcon name="i-lucide-loader-circle" class="spin" /><span>{{ t('Running') }}<template v-if="shellDuration"> · {{ shellDuration }}</template></span>
            </div>
          </div>
          <div v-for="q in queuedList.filter(x => x.phase === 'queued')" :key="q.id" class="msg-user-wrap">
            <button v-if="q.reply" type="button" class="msg-quote" :aria-label="t('Show original message')" @click="gotoOrigin(q.origin)">
              <UIcon name="i-lucide-corner-left-up" class="msg-quote-time" /><span class="msg-quote-time">{{ q.reply.time }}</span><span class="msg-quote-text">{{ q.reply.excerpt }}</span>
            </button>
            <UChatMessage
              :id="`q:${q.id}`" role="user" side="right" variant="soft"
              :parts="pendingParts(q)"
              :ui="{ root: `msg msg-user msg-pending queued${q.body || q.files.length ? '' : ' msg-no-text'}`, container: 'msg-c', content: 'msg-bubble queued', header: 'msg-files' }"
            >
              <template #files>
                <MsgThumbs v-if="q.srcs.length" :srcs="q.srcs" /><span v-for="k in q.missing" :key="k" class="thumb-missing" :title="t('Image')"><UIcon name="i-lucide-image" /></span>
              </template>
              <template #content>
                <span v-if="q.files.length" class="msg-file-chips">
                  <FileChip v-for="f in q.files" :key="f.path" :name="f.name" clickable @open="el => openPathMenu(el, f.path)" />
                </span><UserText :text="q.body" :pasted="q.pasted" />
              </template>
            </UChatMessage>
            <div v-if="q.state === 'failed'" class="queued-tag failed" role="alert">
              <UIcon name="i-lucide-circle-alert" /><span>{{ failedText(q.reason) }}</span>
              <button type="button" class="queued-cancel" :disabled="Boolean(retrying)" @click="retryQueued(q)">
                <UIcon :name="retrying === q.id ? 'i-lucide-loader-circle' : 'i-lucide-rotate-cw'" :class="{ spin: retrying === q.id }" />{{ t('Retry') }}
              </button>
              <button type="button" class="queued-cancel" :disabled="Boolean(cancelling)" @click="cancelQueued(q)">
                <UIcon :name="cancelling === q.id ? 'i-lucide-loader-circle' : 'i-lucide-undo-2'" :class="{ spin: cancelling === q.id }" />{{ t('Cancel') }}
              </button>
            </div>
            <div v-else class="queued-tag">
              <UIcon name="i-lucide-clock" /><span>{{ queuedLabel(q) }}</span>
              <button v-if="canClearQueued(pane, q)" type="button" class="queued-cancel" :disabled="Boolean(clearing)" @click="clearAndSend(q)">{{ t('Clear and send') }}</button>
              <button v-if="q.state === 'held' && queueReason(pane, q) !== 'working'" type="button" class="queued-cancel" @click="emit('gotoTerm')">{{ t('Open terminal') }}</button>
              <button v-if="q.state !== 'sending' && (canCancel || q.state === 'held') && q.raw" type="button" class="queued-cancel" :disabled="Boolean(cancelling)" @click="cancelQueued(q)">
                <UIcon :name="cancelling === q.id ? 'i-lucide-loader-circle' : 'i-lucide-undo-2'" :class="{ spin: cancelling === q.id }" />{{ t('Cancel') }}
              </button>
            </div>
          </div>
          <!-- A menu left open in the agent's terminal (no card shows it) holds the messages back. -->
          <div v-if="menuLeftShown" class="menu-left" role="status">
            <p class="menu-left-text">
              <UIcon name="i-lucide-square-terminal" /><span>{{ t('A menu is still open in the agent’s terminal. Your messages wait for it to close.') }}</span>
            </p>
            <div class="menu-left-actions">
              <button type="button" class="queued-cancel" :disabled="Boolean(menuLeftBusy)" @click="menuLeft('close')">
                <UIcon :name="menuLeftBusy === 'close' ? 'i-lucide-loader-circle' : 'i-lucide-x'" :class="{ spin: menuLeftBusy === 'close' }" />{{ t('Close menu') }}
              </button>
              <button type="button" class="queued-cancel" :disabled="Boolean(menuLeftBusy)" @click="menuLeft('send')">
                <UIcon :name="menuLeftBusy === 'send' ? 'i-lucide-loader-circle' : 'i-lucide-send'" :class="{ spin: menuLeftBusy === 'send' }" />{{ t('Send anyway') }}
              </button>
            </div>
          </div>
        </div>

        <div v-if="status" class="chat-status" :class="{ typing: status.typing, waiting: !status.typing }">
          <!-- Claude's verb and omp's step have their own spinner: no extra state dot. -->
          <span v-if="'verb' in status" class="claude-verb-line"><ClaudeSpinner /><UChatShimmer :text="status.text" :duration="2.4" class="claude-verb" /></span>
          <span v-else-if="'omp' in status" class="omp-step-line"><OmpSpinner :since="status.since"><UChatShimmer :text="status.text" :duration="2.4" class="omp-step" /></OmpSpinner></span>
          <template v-else>
            <i class="status-dot" />
            <UChatShimmer v-if="status.typing" :text="status.text" :duration="2.4" />
            <span v-else>{{ status.text }}</span>
          </template>
        </div>
      </UChatMessages>
    </div>
    <UDropdownMenu v-if="!sheetMenus" v-model:open="codeMenu.open" :items="codeMenuDropdown" :content="{ align: 'start', side: 'bottom', sideOffset: 4 }" :ui="{ content: 'hw-dropdown' }">
      <span class="path-anchor" :style="{ left: `${codeMenu.x}px`, top: `${codeMenu.y}px`, width: `${codeMenu.w}px`, height: `${codeMenu.h}px` }" aria-hidden="true" />
    </UDropdownMenu>
    <AppSheet v-model:open="filePeek.open" :title="fileName(stripPosition(filePeek.path))" wide full screen>
      <FilesView v-if="filePeek.open" :key="filePeek.path" :pane-id="pane.id" :file="filePeek.path" />
    </AppSheet>
  </div>
</template>
