/**
 * 插件 API 的存储面:插件自有配置的只读快照(`settings`)、老 KV(`store`)与数据目录(`storage`:JSON 读写、受管文件树、消息作用域状态)。
 *
 * 从 `plugin-api-builder.ts` 按面拆出(大文件拆分批 2,2026-10-04):每一格的方法正文与拆分前一字不差,
 * 从前读闭包变量的地方,现在读开头从上下文(`plugin-api-context.ts`)解构出来的同名局部量。
 * 键的顺序不在这里定 —— `createCorePluginAPI` 按拆分前那只对象字面量的顺序拼。
 */
import { deepFreezeCorePluginValue } from './plugin-freeze.js'
import type {
  CorePluginFileEntry,
  CorePluginFilesOptions,
  CorePluginFilesReadOptions,
  CorePluginFilesUsage,
} from './plugin-storage-files.js'
import type { CorePluginAPITypeArgs, PluginApiBuildContext } from './plugin-api-context.js'

export function buildPluginApiStorage<T extends CorePluginAPITypeArgs>(ctx: PluginApiBuildContext<T>) {
  const { pluginId, host, store, state, configUnsubs, requireStorage, requireMessageState, requireFiles, withStorageFailureReport, rejectDisposedWrite, rejectLateCall } = ctx

  return {
    settings: {
      /**
       * **有意不带 disposed 闩**:读配置没有破坏性(不注册、不落盘、不发事件),
       * 拆除之后一个晚到的读取最多拿到一份过期快照。给它加闩只会让插件在
       * teardown 竞速里拿到 undefined 而崩,收益为负。
       */
      get<T = Record<string, unknown>>(): T {
        // 深冻结快照,不是活引用:浅冻结只挡住顶层赋值,
        // `get().tags.push('x')` 照样能写穿共享的数组(乃至 manifest 里的
        // schema.default 本体)。而且 H 线把插件搬进子进程之后,
        // "同步读一个远端对象"根本不成立 —— 快照语义现在就定死。
        return deepFreezeCorePluginValue({ ...(host.getPluginConfig?.(pluginId) ?? {}) }) as T
      },
      onChange(callback: (config: Record<string, unknown>) => void): () => void {
        if (rejectLateCall('settings.onChange')) return () => {}
        const unsub = host.onPluginConfigChange?.(pluginId, callback) ?? (() => {})
        configUnsubs.push(unsub)
        return unsub
      },
    },

    store,

    /**
     * 目录访问面。路径穿越与序列化守卫在 createCorePluginStorage 里(它会抛),
     * 这一层只加两件宿主的事:disposed 闩 + 把失败记进熔断账(scope `storage`)。
     */
    storage: {
      dir(): string {
        rejectDisposedWrite('dir')
        return withStorageFailureReport('dir', () => requireStorage().dir())
      },
      readJson<T = unknown>(name: string, fallback?: T): T | undefined {
        if (state.disposed && !state.disposing) {
          rejectLateCall('storage.readJson')
          return fallback
        }
        return withStorageFailureReport('readJson', () => requireStorage().readJson<T>(name, fallback))
      },
      writeJson(name: string, value: unknown): void {
        rejectDisposedWrite('writeJson')
        withStorageFailureReport('writeJson', () => requireStorage().writeJson(name, value))
      },
      exists(name: string): boolean {
        if (state.disposed && !state.disposing) {
          rejectLateCall('storage.exists')
          return false
        }
        return withStorageFailureReport('exists', () => requireStorage().exists(name))
      },
      /**
       * 消息作用域状态(plugin-message-state-2026-08)。**坐标随调用递交** ——
       * 宿主在这一刻收到 (sessionId, messageId),结构性归账,零语义解释。
       * 读写语义与 KV 同规:写面抛(配额/不可序列化)、拆除闩、熔断分车道。
       */
      /**
       * F1 受管文件树。`api.storage.files.readText('candidates/2026-08.jsonl')`
       *
       * 与 KV / message-state 同一套宿主纪律,一条不多一条不少:
       *  - **拆除闩**:写面在拆除后静默丢弃(不重建被归档的家目录),读面退化;
       *  - **熔断分车道**:`storage.files.<动词>` 各记各的账,免得 exists 的成功
       *    不断把 writeText 的连败清掉;
       *  - **错误继续抛**:路径穿越 / 配额 / 未声明外部根都要让插件当场知道 ——
       *    静默吞掉只会让它以为写成功了,而记忆已经断流。
       *
       * 判据、原子写、O_APPEND、配额记账全在 `plugin-storage-files.ts`(它会抛),
       * 这一层不重复任何一条。
       */
      files: {
        readText(relPath: string, fileOptions?: CorePluginFilesReadOptions): string | undefined {
          if (state.disposed && !state.disposing) {
            rejectLateCall('storage.files.readText')
            return undefined
          }
          return withStorageFailureReport('files.readText', () =>
            requireFiles().readText(relPath, fileOptions))
        },
        writeText(relPath: string, content: string, fileOptions?: CorePluginFilesOptions): void {
          rejectDisposedWrite('files.writeText')
          withStorageFailureReport('files.writeText', () =>
            requireFiles().writeText(relPath, content, fileOptions))
        },
        appendText(relPath: string, content: string, fileOptions?: CorePluginFilesOptions): void {
          rejectDisposedWrite('files.appendText')
          withStorageFailureReport('files.appendText', () =>
            requireFiles().appendText(relPath, content, fileOptions))
        },
        list(relDir?: string, fileOptions?: CorePluginFilesOptions): CorePluginFileEntry[] {
          if (state.disposed && !state.disposing) {
            rejectLateCall('storage.files.list')
            return []
          }
          return withStorageFailureReport('files.list', () =>
            requireFiles().list(relDir, fileOptions))
        },
        exists(relPath: string, fileOptions?: CorePluginFilesOptions): boolean {
          if (state.disposed && !state.disposing) {
            rejectLateCall('storage.files.exists')
            return false
          }
          return withStorageFailureReport('files.exists', () =>
            requireFiles().exists(relPath, fileOptions))
        },
        remove(relPath: string, fileOptions?: CorePluginFilesOptions): void {
          rejectDisposedWrite('files.remove')
          withStorageFailureReport('files.remove', () =>
            requireFiles().remove(relPath, fileOptions))
        },
        usage(): CorePluginFilesUsage {
          return withStorageFailureReport('files.usage', () => requireFiles().usage())
        },
      },
      message(sessionId: string, messageId: string) {
        return {
          readJson<T = unknown>(fallback?: T): T | undefined {
            if (state.disposed && !state.disposing) {
              rejectLateCall('storage.message.readJson')
              return fallback
            }
            return withStorageFailureReport('message.readJson', () =>
              requireMessageState().readJson<T>(sessionId, messageId, fallback))
          },
          writeJson(value: unknown): void {
            rejectDisposedWrite('message.writeJson')
            withStorageFailureReport('message.writeJson', () =>
              requireMessageState().writeJson(sessionId, messageId, value))
          },
          exists(): boolean {
            if (state.disposed && !state.disposing) {
              rejectLateCall('storage.message.exists')
              return false
            }
            return withStorageFailureReport('message.exists', () =>
              requireMessageState().exists(sessionId, messageId))
          },
        }
      },
    },
  }
}
