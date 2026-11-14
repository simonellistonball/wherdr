// A new task: `{ machine, title, description?, repo?, delegate?, type?, planApprove? }` (`herdr-projects add`).
import { boardAdd } from '../../utils/tasksBackend'

export default defineApi((_event, b) => boardAdd(b.machine ?? '', b))
