/**
 * 本地 read / write / edit 工具的沙箱面(读根、写根、缺省工作目录)。
 *
 * 从 `catalog.ts` 抽出来的理由(A3-b):ACP 的文件桥(`runtime/acp/fs-bridge.ts`)要与这几只工具
 * 用**同一份**根列表,而它不该为此 import 整张工具目录(那会把每只内置工具都拖进 server /
 * daemon 的装配依赖图)。目录照旧从这里拿,口径只有一处。
 */
import type { MutatingFileToolAdapters, ReadToolAdapters } from '@onething/backend/runtime/toolkit'
import { getOnethingFileMutationsDir } from '@onething/backend/runtime/storage'
import { getSettings } from '../../stores/settings.js'
import { getConnectedDirectoriesForSession } from '../../stores/connected-directories.js'
import { getDefaultReadRoots } from '@onething/backend/runtime/tools/core/sandbox'

export function defaultToolWorkingDirectory(): string | undefined {
  return getSettings().tools?.bash?.defaultWorkingDirectory
}

export function readAdapters(): ReadToolAdapters {
  return {
    getDefaultWorkingDirectory: defaultToolWorkingDirectory,
    /**
     * 读根里的接入目录按**会话归属的 space** 解析(批 B2)。走这里而不是全局适配器:
     * 那份适配器服务的是没有会话语境的调用面,退回全局层对它是对的。
     */
    getDefaultReadRoots: sessionId => getDefaultReadRoots({
      getConnectedDirectories: () => getConnectedDirectoriesForSession(sessionId),
    }),
  }
}

export function mutatingFileAdapters(): MutatingFileToolAdapters {
  return {
    getDefaultWorkingDirectory: defaultToolWorkingDirectory,
    getFileMutationsDir: getOnethingFileMutationsDir,
    // per-space:按**会话归属**取,不是当前空间(批 B2 / 设计盲点 1)。
    getConnectedDirectories: sessionId => getConnectedDirectoriesForSession(sessionId),
  }
}
