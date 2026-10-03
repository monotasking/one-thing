import type { ContextVariable, VariableProvider } from '../types.js'

const NAME = 'note_vaults'

/**
 * 一条库。**不带 id** —— 模型拿到 id 也没用(它没有按 id 操作的动词),而 root
 * 是它真正要的东西:写笔记往哪个根下落。
 */
export interface NoteVaultSummary {
  name: string
  /** 绝对路径。 */
  root: string
  /** `'obsidian'` / `'folder'` / … —— 给人看的标签,别让模型按它分叉。 */
  system: string
  primary: boolean
  /**
   * 主库今天那本日记的绝对路径。**算不出来就省略这一格**(app 没跑且没有快照),
   * 而不是编一个 —— 编出来的路径会让模型把今天的记录写到一个 Obsidian 不认的
   * 文件里。
   */
  today?: string
}

export interface NoteVaultsGateway {
  /**
   * 现在在册的库。
   *
   * 实现里**一条 CLI 命令都不许发**:变量板是每回合都要渲染的东西,在那条路上
   * 起子进程就是给每一轮对话加一次进程启动。今日日记那一格走领域的 offline 读
   * (快照 / 本地计算),给不出就不给。
   */
  list(): Promise<NoteVaultSummary[]> | NoteVaultSummary[]
  onChange?(callback: () => void): () => void
}

const DESCRIPTION = [
  '用户的笔记库。新建或追加笔记请落在这些根下;',
  'today 是主库今天那本日记的路径(没有这一格就说明现在算不出来,别猜)。',
  '这一格只读:要改笔记库,去设置 → 笔记。',
].join('')

/**
 * 只读派生变量 `note_vaults`(P1,§3.4 表末行)。
 *
 * **只读、无写面**:改笔记库走设置页(description 里那一句就是说给模型听的)。
 * 老的 `user_note_dir` / `work_note_dir` 是可写的,AI 用 `variable` 工具「重指
 * 目录」还要走一次审批 —— 那条路已随 P3 一起删(`providers/notes.ts` 没了)。
 *
 * `state: true` 的判据是「要不要一直在眼前」(§R.3),不是「变得快不快」:库表
 * 几个月不动一次,但模型每次写笔记都要用它,不在眼前就得先花一次工具调用去问
 * 自己该往哪写。
 *
 * 值是**算出来的**,不存 —— 与 `datetime` 同一族(应用生命周期那条:状态算出
 * 来,不存)。
 */
export class NoteVaultsProvider implements VariableProvider {
  readonly id = 'note-vaults'
  readonly priority = 35

  constructor(private readonly gateway: NoteVaultsGateway) {}

  async list(): Promise<ContextVariable[]> {
    const vaults = await this.gateway.list()
    // 一个库都没有 = 这个变量不出现。空表进提示词只是噪音。
    if (vaults.length === 0) return []
    return [{
      name: NAME,
      value: JSON.stringify(vaults),
      scope: 'global',
      readonly: true,
      state: true,
      description: DESCRIPTION,
    }]
  }

  claims(name: string): boolean {
    return name === NAME
  }

  onExternalChange(emit: () => void): () => void {
    if (!this.gateway.onChange) return () => undefined
    return this.gateway.onChange(() => emit())
  }
}
