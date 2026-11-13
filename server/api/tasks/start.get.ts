// What Start offers on a task: `?machine=<key>&id=<repo>/<n>` → its default
// agent (`show <id> --json`, worker.agent) and the agents installed on its machine.
import { boardStartOptions } from '../../utils/tasksBackend'

export default defineApi(async (event) => {
  const q = getQuery(event)
  return boardStartOptions(q.machine ?? '', q.id)
})
