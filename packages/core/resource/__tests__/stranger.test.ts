/**
 * K0 —— **陌生能力演练**(法条「加功能不许改骨架」;
 * `docs/design/atom-2026-09.md` §8「陌生能力演练」、§7 盲点 7)。
 *
 * 法条的原话:「任何架构方案交卷前必须做『陌生能力演练』—— 拿一个设计时没想过的
 * 能力列出要改的文件,答案不是『能力自己的模块 + 它的壳渲染模块 + 各一行注册』
 * 就是骨架没抽到位。手段只有一个:凡『按能力枚举』的地方改成『能力自述、别人读
 * 表』(manifest + 注册表),core 里不出现任何能力的名字。」
 *
 * 演练题就是设计文档 §8 的第一道:**接一个邮箱**。这只文件做两件事:
 *   ① 把那份自述原样登记进一张新表,断言三个动词全都够得着 —— 证明「一行注册」
 *      真的够;
 *   ② **扫本目录的非测试文件,断言里面一个字都没提过这个 scheme** —— 证明「core
 *      里不出现任何能力的名字」不是一句愿望。第二条才是门:第一条只要写得出实现
 *      就会绿,第二条会在有人往 `spec.ts` 里加一行 `if (scheme === 'xxx')` 的那天
 *      变红。
 *
 * ── K1 扩了什么 ────────────────────────────────────────────────────────────
 * ① 扫描名单跟着 K1 新增的五只文件长(`errors` / `events` / `kernel` / `provider` /
 *    `schema` / `tool`)—— 名单是**写死的**而不是「扫到几个算几个」,理由与它自己
 *    那句注释一样:一个扫了零个文件的门永远是绿的,而一个「扫到什么算什么」的门在
 *    有人把违规代码放进一个新文件时同样是绿的。
 * ② 第二个陌生 scheme:**`session`**。K1 里第一个真 scheme 就是它,而它的自述与
 *    实现分别住在产品层(`runtime/src/sessions/resource-spec.ts`)与装配层
 *    (`backend/wiring/resource/session-provider.ts`)—— core 里一个字都不该有。
 *    这一条是「§8 演练的答案是能力自己的模块 + 一行注册」在**真**能力上的复核。
 *
 * ── 为什么词边界扫描放得过 `sessionId` ─────────────────────────────────────
 * `\bsession\b` 要求 `session` 后面紧跟一个非词字符,而 `sessionId` 后面是 `I`。
 * 这不是漏网,是判据本身:`Invocation.sessionId` / `ResourceReadContext.sessionId`
 * 是**调用坐标**的字段名(哪一条会话的回合里发生的),core/toolkit 早就有它;
 * 它与「内核认识 `session` 这种资源」是两件事。会被抓住的是真正的命中:字面量
 * `'session'`、`scheme === 'session'`、`session.rename`。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ResourceRegistry } from '../registry.js'
import { describeResourceSpecProblem } from '../contract.js'
import type { ResourceSpec } from '../spec.js'

/** 一个 core 从没听说过的命名空间。它只活在这只文件里。 */
const STRANGER_SCHEME = 'mail'

/**
 * 内核不许提名字的 scheme 全表:演练题那个,加上 K1 真的接上来的第一个。
 * 加一种资源就往这里加一行 —— 这张表是「core 里不出现任何能力的名字」的清单。
 */
const FORBIDDEN_SCHEMES = [STRANGER_SCHEME, 'session'] as const

/** 本目录里该有哪些非测试文件。写死,理由见文件头②。 */
const KERNEL_FILES = [
  'contract.ts',
  'errors.ts',
  'events.ts',
  'index.ts',
  'kernel.ts',
  'provider.ts',
  'ref.ts',
  'registry.ts',
  'schema.ts',
  'spec.ts',
  'tool.ts',
]

const strangerSpec: ResourceSpec = {
  scheme: STRANGER_SCHEME,
  title: 'Mailbox',
  reads: {
    list: {
      title: 'List a folder',
      query: { type: 'object', properties: { folder: { type: 'string' } } },
      result: { type: 'array' },
    },
    get: {
      title: 'Read one message',
      query: { type: 'object', properties: { id: { type: 'string' } } },
      result: { type: 'object' },
    },
  },
  ops: {
    send: {
      title: 'Send a message',
      params: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } } },
      effects: ['net_fetch'],
      home: 'core',
      keymap: true,
      describe: params => `send to ${String((params as { to?: unknown }).to)}`,
    },
    archive: {
      title: 'Archive a message',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      effects: ['net_fetch'],
      home: 'core',
      entity: 'message',
    },
  },
  events: {
    received: { title: 'A message arrived', payload: { type: 'object' } },
  },
  state: {
    unread: { title: 'Unread count', schema: { type: 'number' }, volatility: 'turn' },
  },
}

describe('stranger capability drill: a namespace core has never heard of', () => {
  it('passes the contract as written, with no kernel change', () => {
    expect(describeResourceSpecProblem(strangerSpec)).toBeNull()
  })

  it('is reachable through all three verbs after one line of registration', () => {
    const registry = new ResourceRegistry()
    const dispose = registry.register(strangerSpec)

    // 地址 → 资源
    const resolved = registry.resolve(`${STRANGER_SCHEME}:inbox/42`)
    expect(resolved?.spec.title).toBe('Mailbox')
    expect(resolved?.ref).toEqual({ scheme: STRANGER_SCHEME, path: 'inbox/42' })

    // 读
    expect(registry.readOf(`${STRANGER_SCHEME}:inbox/42`, 'list')?.title).toBe('List a folder')
    expect(registry.readOf(`${STRANGER_SCHEME}:inbox/42`, 'get')?.title).toBe('Read one message')

    // 做(含效果上界、家在哪、进不进命令面板、人话)
    const send = registry.opOf(`${STRANGER_SCHEME}:inbox/42`, 'send')
    expect(send?.effects).toEqual(['net_fetch'])
    expect(send?.home).toBe('core')
    expect(send?.keymap).toBe(true)
    expect(send?.describe?.({ to: 'someone' })).toBe('send to someone')
    expect(registry.opOf(`${STRANGER_SCHEME}:inbox/42`, 'archive')?.entity).toBe('message')

    // 看 / 喂给提示词
    expect(Object.keys(resolved!.spec.events)).toEqual(['received'])
    expect(resolved!.spec.state?.unread.volatility).toBe('turn')

    dispose()
    expect(registry.resolve(`${STRANGER_SCHEME}:inbox/42`)).toBeNull()
  })

  it('is not named anywhere in the kernel — the gate for "加功能不许改骨架"', () => {
    const dir = fileURLToPath(new URL('../', import.meta.url))
    const files = readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.ts'))
      .map(entry => entry.name)

    // 先确认真的扫到了东西 —— 一个扫了零个文件的门永远是绿的。
    expect(files.sort()).toEqual(KERNEL_FILES)

    // 按**词**扫而不是裸子串:裸子串会把 `email` 这种正常英文单词也算成命中,
    // 一道会因为写文档而变红的门,人只会去关掉它。词边界既拦得住真正的命中
    // (`'mail'` 字面量、`scheme === 'mail'`、`mail.archive`),又不碰路过的散文。
    const hits: string[] = []
    for (const scheme of FORBIDDEN_SCHEMES) {
      const named = new RegExp(`\\b${scheme}\\b`, 'i')
      for (const name of files) {
        if (named.test(readFileSync(join(dir, name), 'utf-8'))) hits.push(`${name}:${scheme}`)
      }
    }
    expect(hits).toEqual([])
  })
})
