import type { JsonObject } from '../json.js'

/**
 * 内核对"契约"的全部认识:一坨 JSON Schema。解释权归 `Validator` 端口。
 *
 * 资源描述(`@shared/ipc/resources.ts`)把它当载荷下发,所以这一格住在 shared;
 * 工具内核(`packages/backend/toolkit/toolkit-spec.ts`)从这里取。
 */
export type JsonSchema = JsonObject
