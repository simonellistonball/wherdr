// A task command that takes only the task's id: `{ machine, id, action, agent?, after? }`,
// action `delegate`, `stop`, `retry` or `archive` (`herdr-projects <action>`).
// `agent`: Start only, that agent for this start (`--worker.agent`), a model
// with it (`codex/gpt-6-sol`); `effort`: Start only, its level (`--worker.effort`).
// `after`: Start only, the tasks to wait for first (`--after`, ids or keys).
import { boardCommand } from '../../utils/tasksBackend'

export default defineApi((_event, b) => boardCommand(b.machine ?? '', b.id, b.action, b.agent, b.after, b.effort))
