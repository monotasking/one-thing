/**
 * 工作区沙箱守卫（主线 T 批 3）。
 *
 * 批 1 因为「通用信封不带 request context」把 markdown 退回「不可迁清单」第 2 类，
 * 理由是迁过去会掉 `apps/server` 那套沙箱护栏。这份测试就是那句话的验收门：
 * **同一个 handler**，喂 desktop context 与 http context 两种 dispatch context，
 * 越界路径在夹紧那侧全部被拦，在桌面那侧全部照旧放行。
 *
 * 覆盖的越界形状：`../` 相对穿越、绝对路径出沙箱、`~` 展开、`file:` URL、
 * wiki 链接里裹着的穿越、**笔记库的附件目录指向沙箱外**、解析结果走出沙箱。
 *
 * P3(2026-09-18):库的判定从「往上找 `.obsidian`」换成问笔记领域的注册表,
 * 所以这里假的是那只注册表 —— 测试因此不再在盘上造 `.obsidian` 目录。
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultSettings } from '@shared/defaults/settings.js'
import { createDefaultVariablesFile } from '@onething/runtime/variables/schema'
import { DESKTOP_RPC_CONTEXT, type RpcDispatchContext } from '@shared/ipc/rpc.js'
import { resetVariablesStoreForTests } from '@onething/runtime/variables/store-bound'
import { updateSettingsInMemory } from '../../stores/settings.js'
import { markdownRpcHandlers } from '../domains/markdown.js'
import { configureHostLocalTrust } from '../../server/host-trust.js'
import { FolderVault } from '@onething/runtime/notes'
import type { NoteVault } from '@onething/runtime/notes'

/**
 * 笔记领域的假件:一张「这条路径归哪个库」的表。
 *
 * 反证:把 `markdownRuntimeAdapters` 夹紧那一支的 `vaultFor: () => null` 挖掉
 * (改成照样问注册表),「附件目录指向沙箱外」那条在夹紧侧就会放行。
 */
const notes = vi.hoisted(() => ({ vaults: [] as NoteVault[] }))
vi.mock('../../wiring/notes/index.js', () => ({
  getNotesSubsystemSafe: () => ({
    registry: {
      vaultFor: (absolutePath: string) =>
        notes.vaults.find(vault => absolutePath.startsWith(`${vault.root}/`)) ?? null,
    },
  }),
  noteRootsNow: () => notes.vaults.map(vault => vault.root),
}))

const tempRoots: string[] = []

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

/** 一个联网宿主会 mint 的 context：owner 已认证 + 沙箱根已算好。 */
function httpContext(sandboxRoot: string): RpcDispatchContext {
  return {
    transport: 'http',
    ownerUid: 'alice',
    workspaceId: 'default',
    sandboxRoot,
  }
}

/**
 * 「在一台桌面上」跑一次调用。
 *
 * C0 R2:`resolveRpcSandbox` 的"不夹"判据从 `context.transport === 'ipc'` 换成了
 * `isHostLocallyTrusted()` —— 那句话由宿主在**装配时**说(两个桌面壳都写
 * `{ origin: 'desktop-embedded' }`),不再由一个 transport 字面量说。这份文件比的是
 * 「同一个 handler、两种 context」,两种 context 一个字没改;桌面那一侧现在多一句
 * 声明,而且**只罩住那一次调用** —— 夹紧那一侧必须留在"未声明"里,否则这份文件
 * 就不再是在验护栏了。
 */
async function onDesktopHost<T>(run: () => Promise<T>): Promise<T> {
  const restore = configureHostLocalTrust({ origin: 'desktop-embedded' })
  try {
    return await run()
  } finally {
    restore()
  }
}

const OUTSIDE_DOC = 'Markdown document path must stay inside the workspace sandbox root.'
const OUTSIDE_TARGET = 'Markdown asset target must stay inside the workspace sandbox root.'
const OUTSIDE_ROOT = 'Markdown workspace root must stay inside the workspace sandbox root.'

beforeEach(() => {
  notes.vaults = []
  updateSettingsInMemory(createDefaultSettings())
  resetVariablesStoreForTests().hydrateForTests(createDefaultVariablesFile())
})

afterEach(async () => {
  resetVariablesStoreForTests()
  await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

describe('markdown RPC domain · dispatch context decides the sandbox', () => {
  it('rejects a document path that escapes the sandbox, and does not on desktop', async () => {
    const sandboxRoot = await makeTempRoot('md-sandbox-')
    const outside = await makeTempRoot('md-outside-')
    const secret = path.join(outside, 'secret.md')
    await fs.writeFile(secret, '# secret')

    // 绝对路径出沙箱
    await expect(markdownRpcHandlers.resolveAsset(
      { documentPath: secret, rawTarget: 'x.png' },
      httpContext(sandboxRoot),
    )).resolves.toEqual({ success: false, error: OUTSIDE_DOC })

    // `../` 相对穿越:先落进沙箱再爬出去
    await expect(markdownRpcHandlers.resolveAsset(
      { documentPath: `notes/../../${path.basename(outside)}/secret.md`, rawTarget: 'x.png' },
      httpContext(sandboxRoot),
    )).resolves.toEqual({ success: false, error: OUTSIDE_DOC })

    // 同一条请求在桌面 context 下不被沙箱拦(桌面根本没有沙箱)。
    const desktop = await onDesktopHost(() => markdownRpcHandlers.resolveAsset(
      { documentPath: secret, rawTarget: 'x.png' },
      DESKTOP_RPC_CONTEXT,
    ))
    expect(desktop.success).toBe(true)
    expect(desktop.error).toBeUndefined()
  })

  it('expands ~ to the sandbox root instead of the real home directory', async () => {
    const sandboxRoot = await makeTempRoot('md-sandbox-')
    await fs.writeFile(path.join(sandboxRoot, 'note.md'), '# note')

    const response = await markdownRpcHandlers.resolveAsset(
      { documentPath: '~/note.md', rawTarget: '#anchor' },
      httpContext(sandboxRoot),
    )
    // 夹进沙箱之后这个文档是存在的 —— 说明 `~` 落到了沙箱根,而不是真家目录。
    expect(response.success).toBe(true)
  })

  it('rejects a workspace root outside the sandbox', async () => {
    const sandboxRoot = await makeTempRoot('md-sandbox-')
    const outside = await makeTempRoot('md-outside-')
    await fs.writeFile(path.join(sandboxRoot, 'note.md'), '# note')

    await expect(markdownRpcHandlers.resolveAsset(
      { documentPath: path.join(sandboxRoot, 'note.md'), workspaceRoot: outside, rawTarget: 'a.png' },
      httpContext(sandboxRoot),
    )).resolves.toEqual({ success: false, error: OUTSIDE_ROOT })
  })

  it('rejects link targets that escape the sandbox — plain, wiki, and file: forms', async () => {
    const sandboxRoot = await makeTempRoot('md-sandbox-')
    const outside = await makeTempRoot('md-outside-')
    const notePath = path.join(sandboxRoot, 'notes', 'today.md')
    await fs.mkdir(path.dirname(notePath), { recursive: true })
    await fs.writeFile(notePath, '# Today')
    const secretImage = path.join(outside, 'secret.png')
    await fs.writeFile(secretImage, 'secret')

    const escapes = [
      '../../etc/passwd',
      secretImage,
      `[[${secretImage}]]`,
      `<${secretImage}>`,
      `file://${secretImage}`,
      '~/secret.png',
    ]
    for (const rawTarget of escapes) {
      await expect(markdownRpcHandlers.resolveAsset(
        { documentPath: notePath, rawTarget },
        httpContext(sandboxRoot),
      )).resolves.toEqual({ success: false, error: OUTSIDE_TARGET })
    }

    // 沙箱内的相对目标照常解析(护栏不是"一律拒绝")。
    await fs.writeFile(path.join(sandboxRoot, 'notes', 'ok.png'), 'ok')
    const allowed = await markdownRpcHandlers.resolveAsset(
      { documentPath: notePath, rawTarget: 'ok.png' },
      httpContext(sandboxRoot),
    )
    expect(allowed.success).toBe(true)
    expect(allowed.asset?.absolutePath).toBe(path.join(sandboxRoot, 'notes', 'ok.png'))

    // 外部 URL 不是文件系统访问,放行。
    const external = await markdownRpcHandlers.resolveAsset(
      { documentPath: notePath, rawTarget: 'https://example.com/a.png' },
      httpContext(sandboxRoot),
    )
    expect(external.success).toBe(true)
  })

  /**
   * 「库的配置把附件指到沙箱外」那条逃逸面,在夹紧侧是**结构上不存在**的。
   *
   * P3 之前它存在,因为服务自己会往上扫盘找 `.obsidian` —— 夹不夹紧它都找得到,
   * 所以必须有一道守卫(`noteAttachmentRootStaysInside`)去判那份配置。今天
   * 「这份文档归哪个库」是一格适配器,而夹紧的宿主**一个库都不交**(`vaultFor`
   * 恒 `null`,与 `getNoteRoots: () => []` 同一条理由:笔记库是宿主机器上用户
   * 自己的文件)。于是那道守卫在这一侧问的是同一份适配器,答案恒真 —— 它留着
   * 是为了「哪天有宿主在夹紧态下真的交出库表」那一刻;它本身的判法由
   * `runtime/markdown/__tests__/asset-service.test.ts` 直接钉住。
   *
   * 这条用例证的因此是**更强的那句话**:夹紧侧根本不走库语义,附件落在沙箱里;
   * 桌面侧同一个库的配置照旧生效。
   */
  it('a confined host claims no note vault, so a vault attachment folder cannot reach out', async () => {
    const sandboxRoot = await makeTempRoot('md-sandbox-')
    const outside = await makeTempRoot('md-outside-')
    const notePath = path.join(sandboxRoot, 'vault', 'today.md')
    await fs.mkdir(path.join(sandboxRoot, 'vault'), { recursive: true })
    await fs.writeFile(notePath, '# Today')
    // 库自己的配置把附件指到沙箱外 —— 那是磁盘上的配置,不是请求输入。
    // (附件目录是**库相对**的,所以指到界外要写成 `../..` 这样的相对路径。)
    const vaultRoot = path.join(sandboxRoot, 'vault')
    notes.vaults = [new FolderVault({
      root: vaultRoot,
      id: 'v-outside',
      attachmentDirectory: path.relative(vaultRoot, outside),
    })]

    const confined = await markdownRpcHandlers.saveAttachments(
      {
        documentPath: notePath,
        files: [{ fileName: 'a.png', mimeType: 'image/png', base64Data: 'AA==' }],
      },
      httpContext(sandboxRoot),
    )
    expect(confined.success).toBe(true)
    expect(confined.attachments?.[0]?.absolutePath.startsWith(sandboxRoot)).toBe(true)
    expect(confined.attachments?.[0]?.absolutePath.startsWith(outside)).toBe(false)

    // 桌面 context 下同一个库的配置照旧生效 —— 那是用户自己的机器。
    const desktop = await onDesktopHost(() => markdownRpcHandlers.saveAttachments(
      {
        documentPath: notePath,
        workspaceRoot: vaultRoot,
        files: [{ fileName: 'a.png', mimeType: 'image/png', base64Data: 'AA==' }],
      },
      DESKTOP_RPC_CONTEXT,
    ))
    expect(desktop.success).toBe(true)
    expect(desktop.attachments?.[0]?.absolutePath.startsWith(outside)).toBe(true)
  })

  it('drops note roots and clamps the configured attachment directory when confined', async () => {
    const sandboxRoot = await makeTempRoot('md-sandbox-')
    const outside = await makeTempRoot('md-outside-')
    const notePath = path.join(sandboxRoot, 'personal', 'today.md')
    await fs.mkdir(path.dirname(notePath), { recursive: true })
    await fs.writeFile(notePath, '# Personal')

    // 笔记根指向沙箱外,附件目录也指向沙箱外 —— 两者都必须失效。
    const settings = createDefaultSettings()
    settings.notes = { ...settings.notes!, attachmentDirectory: outside }
    updateSettingsInMemory(settings)
    notes.vaults = []

    const result = await markdownRpcHandlers.saveAttachments(
      {
        documentPath: notePath,
        files: [{ fileName: 'a.png', mimeType: 'image/png', base64Data: 'AA==' }],
      },
      httpContext(sandboxRoot),
    )

    // 笔记根被清空 → 走项目语义,附件落在沙箱根下;越界的附件目录被丢弃。
    expect(result.success).toBe(true)
    const saved = result.attachments?.[0]?.absolutePath ?? ''
    expect(saved.startsWith(sandboxRoot)).toBe(true)
    expect(saved.startsWith(outside)).toBe(false)
  })

  it('refuses a networked context that arrives without a sandbox root (fail-closed)', async () => {
    // 宿主接线漏了。绝不退回「不夹」——那才是真正危险的降级。
    await expect(markdownRpcHandlers.resolveAsset(
      { documentPath: '/etc/passwd', rawTarget: 'x' },
      { transport: 'http', ownerUid: 'alice', workspaceId: 'default' },
    )).rejects.toThrow(/without an absolute sandboxRoot/)
  })
})
