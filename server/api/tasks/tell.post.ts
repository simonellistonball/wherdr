// A message to a task's agent: `{ machine, id, text }` (`herdr-projects tell`).
import { boardTell } from '../../utils/tasksBackend'

export default defineApi((_event, b) => boardTell(b.machine ?? '', b.id, b.text))
