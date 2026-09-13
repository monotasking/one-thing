/**
 * K3-c —— 目录这一 scheme 的实现(`docs/design/atom-2026-09.md` §9 K3 三样板)。
 *
 * 自述在产品层(`@onething/runtime/files/resource-spec`),实现在这里 —— 与会话那
 * 一对同一个形状,理由也逐字相同:只有装配层够得着脊柱(这里够的是宿主外壳口与
 * 沙箱端口)。
 *
 * ── 列目录 / stat 的代码从哪来:一行都没有新写的 ──────────────────────────────
 * `listOnethingDirectory` / `statOnethingPath` / `revealOnethingPath` 是
 * `@onething/runtime/files` 里的**纯函数**(fs 由调用方注入),`rpc/domains/files.ts`
 * 的 `listDirectory` / `stat` / `reveal` 调的就是它们。所以这只 provider 递的是同一
 * 组函数、同一份注入(`fs.readdir(withFileTypes)` / `fs.stat().catch(()=>null)` /
 * `getShellHost().revealPath`),不是第二份写法:`node_modules` / `.git` 跳过、目录
 * 在前同类按名排、失败的措辞,三样自动与 `files` 域一致,而不是靠某天有人回来对表。
 *
 * 这一层自己只做两件事:**判沙箱**,和把出参投影成自述说的那个形状
 * (`type: 'file' | 'directory'` → `kind: 'file' | 'dir'`,理由在自述那一格上)。
 *
 * ── 沙箱:缺席一律拒,不是放行 ──────────────────────────────────────────────
 * `ResourceReadContext.sandbox` 是可选的,而那一格的注释写着「缺席 = 这台宿主没有
 * 沙箱这一格,**不是随便读**:一条要判越界的读法在缺席时该自己决定怎么退」。目录
 * 这一条要判越界,所以它的答案是拒:一台没有给出读根的宿主上,「这个路径在不在
 * 界内」这个问题没有答案,而把没有答案当成「在界内」是一次静默的授权洞。
 *
 * 尺子是**工具 runner 那一把**(`wiring/toolkit/runner.ts` 的 `createSandboxPolicy`,
 * 由 `wiring/resource/index.ts` 注进内核)。所以模型经 `read` 工具读一个路径与经
 * `dir` 资源列它的父目录,判的是同一条边界 —— 两把尺子是「一个洞会在两处之一悄悄
 * 张开」的标准形状。
 *
 * **判的是读根那把尺子,不是写根那把**(2026-09-10 拍板,K3-c 留账第 3 条还的):
 * `contains` 是 `getSandboxBoundary` 的单根 —— 用它判,用户在设置里亲手接入的目录
 * 就落在界外,于是那些目录**能改却列不出来**。`SandboxPolicy.readable` 是为此加的
 * 一格,判据是 `read` 工具判 `external_directory` 用的同一张读根表(写根 ∪ 接入目录
 * ∪ 笔记根 ∪ 下载目录)。`contains` 的语义一个字没动:写面(`K3-c'` 的三条)将来
 * 照旧问它。
 *
 * `readable` 的第二参是不透明的作用域键,这里递的是**发起会话** —— 接入目录是
 * per-space 的,取哪一份由会话归属决定(`ctx.sessionId` / `ctx.invocation.sessionId`,
 * 两条路各有各的那一格)。
 *
 * ── 写面问的是写根,不是读根(K3-c',2026-09-10)─────────────────────────────
 * `createDirectory` / `rename` / `delete` 判的是 `sandbox.contains` —— **写根那把
 * 单根尺子**,一个字没动。读根比写根宽(它并上了用户亲手接入的目录、笔记根、下载
 * 目录),而「列得出」与「改得动」本来就不是同一个答案:接入一个目录是让助手**看见**
 * 它,不是把它交出去随便改。上一单(目录读根)放宽的是读那一侧,它的留账里那句
 * 「写面将来照旧问 `contains`,别顺手抄 `readable`」说的就是这一刻。
 *
 * 于是有两把尺子、两只解析函数,名字里就写着各自判的是哪一根
 * (`resolveReadable` / `resolveWritable`),共用同一句「没有沙箱 → 越界 → 敏感」的
 * 三关顺序与同一只错 —— 它们**住在 `./path-guard.ts`**(「改动」面那一单搬过去的:
 * `git` provider 判的是同一条边界,而一份复制品就是两把尺子的第一天)。
 *
 * ── 写面的三条调的是 `files` 域调的同一批纯函数 ─────────────────────────────
 * `createOnethingDirectory` / `renameOnethingPath` / `deleteOnethingPath` —— 与
 * `list` / `stat` / `reveal` 同一族、同一个理由:错误措辞与成功形状自动一致,不靠
 * 某天有人回来对表。**唯一有意分叉的一格是 `delete` 不递归**(界面是
 * `fs.rm(recursive: true)`,这里是 `false`),理由写在自述里那条做法上,而不是写在
 * 这里 —— 它是一句关于「这条做法是什么」的话,不是一句关于接线的话。
 *
 * ── 授权诚实账(K2c-1 / K2c-2 留下的那一格)────────────────────────────────
 * `files.listDirectory` 对**非本机可信**的调用方还有一层 per-caller 的
 * `context.sandboxRoot` 夹持,而资源那条路的 `Invocation` 里今天没有这一格 —— 于是
 * 同一个目录,经 `resources.read` 会比经 `files` 域宽。这只 provider 判的是**进程级**
 * 的沙箱,补不上 per-caller 那一格;补它的是内核那只 `ReadGuard`
 * (`./read-guard.ts`:非本机可信的进程一律拒 `dir` 读)。两层各判各的,谁都不替
 * 谁说话。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import {
  createOnethingDirectory,
  deleteOnethingPath,
  listOnethingDirectory,
  renameOnethingPath,
  revealOnethingPath,
  statOnethingPath,
  type OnethingDirectoryEntry,
} from '@onething/runtime/files'
import { getShellHost, hasShellHost, SHELL_HOST_UNAVAILABLE } from '@onething/runtime/shell/host-ports'
import { dirResourceSpec } from '@onething/runtime/files/resource-spec'
import { formatRef, planFromSpec } from '@onething/core/resource'
import type {
  ResourceEventHub,
  ResourceProvider,
  ResourceReadContext,
  ResourceRef,
} from '@onething/core/resource'
import type { Effect, PlanContext, Result, RunContext } from '@onething/core/toolkit'
import { Intent, textResult } from '@onething/core/toolkit'
import { resolveReadable, resolveWritable } from './path-guard.js'

/** 一个目录项 / 一次 stat 交出去的「是什么」。与自述那两格逐字同名。 */
export type DirEntryKind = 'file' | 'dir'

/**
 * 越界那只错与两只解析函数住在 `./path-guard.ts`(「改动」面那一单搬过去的:
 * `git` provider 判的必须是同一把尺子、同一个顺序、同一句话)。这里**原样再导出**
 * 它们那一对名字 —— 调用方(装配层的 `index.ts`、测试)一直按这个名字匹配,
 * 搬家不该让它们跟着改一行。
 */
export { DirOutsideSandboxError } from './path-guard.js'
export type { DirRefusalReason } from './path-guard.js'

/** 底下那一层(readdir / stat / 定位)说不。那句话原样带出来。 */
export class DirOperationFailedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DirOperationFailedError'
  }
}

/** 这台宿主没有外壳能力(server / CLI:没有文件管理器可以定位)。 */
export class DirShellUnavailableError extends Error {
  constructor(reason: string = SHELL_HOST_UNAVAILABLE) {
    super(`Cannot show a path in the file manager: ${reason}`)
    this.name = 'DirShellUnavailableError'
  }
}

/** 地址缺席时的那句话。目录的每一条读法与做法都作用在**一个**路径上。 */
export class DirRefRequiredError extends Error {
  constructor(member: string) {
    super(`${member} needs a directory address, e.g. "dir:/Users/you/project"`)
    this.name = 'DirRefRequiredError'
  }
}

/**
 * `plan` 交给 `apply` 的载荷:已经解析并判过界的那些绝对路径。
 *
 * 判界只发生在 `plan` 里 —— `apply` 拿到的每一格都已经过关。这不是省事,是
 * 「计划一次、授权一次、照计划做一次」:授权者看见的那句话说的是哪个路径,
 * 真动手的就必须是那个路径,`apply` 再解析一次就是给两者之间开一道缝。
 */
export type DirOpPayload =
  | { readonly op: 'reveal'; readonly path: string }
  /** `path` = 要建的那个子目录;`parent` = 被作用的那个地址,也是 `created` 发在哪。 */
  | { readonly op: 'createDirectory'; readonly path: string; readonly parent: string }
  | { readonly op: 'rename'; readonly path: string; readonly to: string }
  | { readonly op: 'delete'; readonly path: string }

function requireDirPath(ref: ResourceRef | null, member: string): string {
  if (!ref || !ref.path) throw new DirRefRequiredError(member)
  return ref.path
}

/**
 * 一段目录名,**不是一条路径**。
 *
 * 地址已经说了在哪,所以这一格只许是一段名字:带分隔符或 `..` 的写法当场拒,而不是
 * 交给沙箱去兜。沙箱确实兜得住(`contains` 会拦下 `../../etc`),但那样答出来的是
 * 「越界」——一句关于边界的话,而调用方犯的错是「这一格填错了东西」。说准了它才
 * 改得对。
 */
function directoryNameParam(params: unknown, member: string): string {
  const value = params && typeof params === 'object' ? (params as Record<string, unknown>).name : undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${member} needs a non-empty name`)
  }
  if (value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
    throw new TypeError(`${member} needs one plain directory name, not a path (got ${JSON.stringify(value)})`)
  }
  return value
}

/**
 * 一条**绝对**路径参数。
 *
 * 不接受相对路径,而不是把它当成「相对于目标的父目录」或者「相对于工作目录」——
 * 那两种解释都成立、都有人这么以为,于是 `rename` 收一个 `notes.md` 会安安静静地把
 * 文件搬到某个没人打算搬去的地方(还在沙箱里,所以没有任何东西会红)。这条路上
 * 一切地址都是绝对的,这一格跟着。`~` 放行 —— `sandbox.resolve` 认得它。
 */
function absolutePathParam(params: unknown, key: string, member: string): string {
  const value = params && typeof params === 'object' ? (params as Record<string, unknown>)[key] : undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${member} needs a non-empty ${key}`)
  }
  if (!path.isAbsolute(value) && !value.startsWith('~')) {
    throw new TypeError(
      `${member} needs an absolute ${key}, e.g. "/Users/you/project/renamed" (got ${JSON.stringify(value)})`,
    )
  }
  return value
}

/** 共用那批投影函数说不 → 抛。成功就什么都不做。 */
function settle(response: { success: boolean; error?: string }, fallback: string): void {
  if (!response.success) throw new DirOperationFailedError(response.error ?? fallback)
}

/** 这个路径上此刻有没有东西。`lstat` 而不是 `stat`:一条断掉的软链也会被盖掉。 */
async function pathExists(target: string): Promise<boolean> {
  return fs.lstat(target).then(() => true, () => false)
}

/** `'file' | 'directory'`(共用那只函数的词) → `'file' | 'dir'`(自述的词)。 */
function kindOf(type: OnethingDirectoryEntry['type'] | undefined): DirEntryKind {
  return type === 'directory' ? 'dir' : 'file'
}

export class DirResourceProvider implements ResourceProvider<DirOpPayload> {
  readonly spec = dirResourceSpec

  private hub: ResourceEventHub | undefined

  attach(hub: ResourceEventHub): void {
    this.hub = hub
  }

  async read(name: string, ref: ResourceRef | null, _query: unknown, ctx: ResourceReadContext): Promise<unknown> {
    const target = resolveReadable(requireDirPath(ref, name), ctx.sandbox, ctx.sessionId)
    switch (name) {
      case 'list':
        return this.list(target)
      case 'stat':
        return this.stat(target)
      default:
        // 走不到:两条路(`ResourceTool` / `ResourceKernel.read`)都先查过读法名在不在
        // 自述里。留一句诚实的错,而不是回 `undefined` 让调用方去猜。
        return Promise.reject(new TypeError(`Dir resource has no read named ${JSON.stringify(name)}`))
    }
  }

  async plan(op: string, ref: ResourceRef | null, params: unknown, ctx: PlanContext): Promise<Intent<DirOpPayload>> {
    const scope = ctx.invocation.sessionId
    switch (op) {
      case 'reveal': {
        // 沙箱与读那一条同一句话、同一把尺子(**读根** —— 列得出的目录指得出来):
        // **先夹后降级** —— 越界的答案是越界,不是「这台宿主没有外壳能力」
        // (与 `rpc/domains/files.ts` 的 `reveal` 逐字同序)。
        const target = resolveReadable(requireDirPath(ref, op), ctx.sandbox, scope)
        // 宿主口缺席在 **plan** 期就判,与 `ResourceTool` 对 `home: 'shell'` 的那一句
        // 同一个理由:一次注定跑不了的做法不该先去弹一张权限卡问人。
        if (!hasShellHost()) throw new DirShellUnavailableError()
        return planFromSpec<DirOpPayload>(this.spec, op, ref, { op, path: target }, {
          title: `Show ${target} in the file manager`,
        })
      }
      case 'createDirectory': {
        // 父目录与新目录都过写根 —— 后者其实被前者蕴含(孩子在父下面),两句都写是
        // 因为敏感判据不蕴含:一个不敏感的目录底下照样可以有一个敏感的名字。
        const parent = resolveWritable(requireDirPath(ref, op), ctx.sandbox)
        const target = resolveWritable(path.join(parent, directoryNameParam(params, op)), ctx.sandbox)
        return planFromSpec<DirOpPayload>(this.spec, op, ref, { op, path: target, parent }, {
          title: `Create the directory ${target}`,
        })
      }
      case 'rename': {
        const from = resolveWritable(requireDirPath(ref, op), ctx.sandbox)
        const to = resolveWritable(absolutePathParam(params, 'to', op), ctx.sandbox)
        /*
         * **按参数分档**(自述那两格是上界,理由写在 `resource-spec.ts` 的
         * `rename` 上)。所以这里不用 `planFromSpec` —— 那只函数照上界顶格造,
         * 于是每一次改名都会报「会覆盖」,而绝大多数改名不会。
         *
         * 判据是**此刻目标上有没有东西**,在 plan 期看一次。它与 apply 之间当然有
         * 一个窗口(有人正好在这中间建了个同名的),那个窗口是 `plan` / `apply`
         * 两拍这个结构自带的,不是这里独有;真要关掉它得让 rename 自己不覆盖
         * (`renameat2(RENAME_NOREPLACE)`),而那是共用那只投影函数的事,不是这里
         * 偷偷换一套写法的理由。
         */
        const resources = ref ? [formatRef(ref)] : []
        const effects: Effect[] = [{ kind: 'file_write', resources }]
        if (await pathExists(to)) effects.push({ kind: 'file_destructive_edit', resources })
        return Intent.of({
          effects,
          payload: { op, path: from, to },
          preview: {
            title: effects.length > 1 ? `Rename ${from} to ${to}, replacing what is there` : `Rename ${from} to ${to}`,
          },
        })
      }
      case 'delete': {
        const target = resolveWritable(requireDirPath(ref, op), ctx.sandbox)
        return planFromSpec<DirOpPayload>(this.spec, op, ref, { op, path: target }, {
          title: `Delete ${target}`,
        })
      }
      default:
        throw new TypeError(`Dir resource has no op named ${JSON.stringify(op)}`)
    }
  }

  async apply(op: string, intent: Intent<DirOpPayload>, _ctx: RunContext): Promise<Result> {
    const payload = intent.payload
    switch (payload.op) {
      case 'reveal': {
        // 投影函数与注入**逐字抄自 `rpc/domains/files.ts` 的 `reveal`**:先 stat(路径
        // 不在就是失败,不是一次静默的无操作),再经宿主口定位;未注入 = 抛,投影自己
        // catch 成 `{ success:false, error }`。
        const response = await revealOnethingPath({
          path: payload.path,
          stat: target => fs.stat(target),
          revealPath: async target => {
            const outcome = await getShellHost().revealPath(target)
            if (!outcome.success) throw new Error(outcome.error ?? SHELL_HOST_UNAVAILABLE)
          },
        })
        settle(response, 'Failed to reveal path')
        return textResult(`Showed ${payload.path} in the file manager`)
      }
      case 'createDirectory': {
        // `recursive: false` 与 `files.createDirectory` 逐字相同:缺父目录是失败,
        // 不是顺手把整条路径造出来(那会让一次拼错的地址安静地长出一棵树)。
        const response = await createOnethingDirectory({
          path: payload.path,
          createDirectory: target => fs.mkdir(target, { recursive: false }).then(() => undefined),
        })
        settle(response, 'Failed to create directory')
        this.emit(payload.parent, 'created', { path: payload.path })
        return textResult(`Created ${payload.path}`)
      }
      case 'rename': {
        const response = await renameOnethingPath({
          oldPath: payload.path,
          newPath: payload.to,
          renamePath: fs.rename,
        })
        settle(response, 'Failed to rename path')
        this.emit(payload.path, 'renamed', { path: payload.to })
        return textResult(`Renamed ${payload.path} to ${payload.to}`)
      }
      case 'delete': {
        /*
         * **一个文件,或者一个空目录** —— 与 `files.delete`(界面那条,
         * `fs.rm(recursive: true)`)有意分叉,理由写在自述里那条做法上。
         *
         * 注入不是一句 `fs.rm(recursive: false)`:那句话在 Node 里对**目录**是
         * `ERR_FS_EISDIR`(`fs.rm` 不递归时等同 `unlink`),连空目录都删不掉,于是
         * 「只删空目录」会变成「一个目录都删不掉」。分两支才是那句话的真实写法 ——
         * `rmdir` 的语义**恰好就是**「删一个空目录」,非空时它自己答 `ENOTEMPTY`
         * (那是一句准确的话:这里面还有东西),不需要这里先数一遍再判。
         *
         * `lstat` 而不是 `stat`:指向目录的软链要被 `unlink` 掉(删的是这条链),
         * 不是 `rmdir` 它指的那个目录。路径不存在 → 抛 → 投影答失败,与
         * `force: false` 想说的是同一句:删一个不存在的路径是失败,不是静默成功。
         */
        const response = await deleteOnethingPath({
          path: payload.path,
          deletePath: async target => {
            const stats = await fs.lstat(target)
            if (stats.isDirectory()) await fs.rmdir(target)
            else await fs.rm(target, { force: false })
          },
        })
        settle(response, 'Failed to delete path')
        this.emit(payload.path, 'deleted', { path: payload.path })
        return textResult(`Deleted ${payload.path}`)
      }
      default:
        throw new TypeError(`Dir resource has no op named ${JSON.stringify(op)}`)
    }
  }

  /** 事件发在**这条做法作用的那个地址**上(自述文件头「三条事件」那一段)。 */
  private emit(target: string, event: string, payload: unknown): void {
    this.hub?.emit({ scheme: this.spec.scheme, path: target }, event, payload)
  }

  private async list(target: string): Promise<unknown> {
    const response = await listOnethingDirectory({
      path: target,
      readDir: dirPath => fs.readdir(dirPath, { withFileTypes: true }),
      stat: entryPath => fs.stat(entryPath).catch(() => null),
    })
    if (!response.success) throw new DirOperationFailedError(response.error ?? 'Failed to list directory')
    return {
      entries: (response.entries ?? []).map(entry => ({
        name: entry.name,
        path: entry.path,
        kind: kindOf(entry.type),
        // 缺席的格子**不出现**,不写成 `null` / `0`:一个 stat 不到的项与一个 0 字节
        // 的项在读者眼里不该是同一件事(与会话摘要那几格同一条)。
        ...(entry.size !== undefined ? { size: entry.size } : {}),
        ...(entry.mtimeMs !== undefined ? { mtimeMs: entry.mtimeMs } : {}),
      })),
    }
  }

  private async stat(target: string): Promise<unknown> {
    // `homeDir` 不给:`~` 已经在 `sandbox.resolve` 那一步展开过了(那只函数的
    // `expandCorePath`),这里再展一次等于两处各有一份 home 的解释权。
    const response = await statOnethingPath({ path: target, stat: path => fs.stat(path) })
    if (!response.success) throw new DirOperationFailedError(response.error ?? 'Failed to stat path')
    return {
      path: response.path ?? target,
      kind: kindOf(response.type),
      ...(response.size !== undefined ? { size: response.size } : {}),
      ...(response.mtimeMs !== undefined ? { mtimeMs: response.mtimeMs } : {}),
    }
  }
}
