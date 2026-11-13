import { boardDescribe } from '../../utils/tasksBackend'

export default defineApi((_event, b) => boardDescribe(b.machine ?? '', b.id, b.text))
