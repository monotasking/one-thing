import { describe, expect, it } from 'vitest'
import { WORKSPACE_SLOT_COUNT } from '../workspace/types'
import {
  KEYMAP_COMMANDS,
  effectiveCombo,
  initialKeymapState,
  lookupCommand,
  workspaceSlotCommandId,
} from './transitions'

/**
 * 工作区那一族在注册表里的落位。这一份用例存在的理由有两条,第二条更要紧:
 *
 *  ① 序号直达是**按预算**长出来的(三条),不是手抄的三行 —— 预算改了这里当场红;
 *  ② ⌘⇧O **撞键**:它同时是 `toc.toggle` 的出厂键。出厂表这一层没有冲突检查
 *     (bindCombo 只拦用户改绑),lookupCommand 取的是第一个命中,所以
 *     **KEYMAP_COMMANDS 的次序就是那次撞车的裁决**。本批按 08-31 拍板让工作区
 *     面板赢,代价是目录面板的出厂键当下按不响 —— 这一格等用户裁定。
 *     在裁定之前,下面那条断言把「谁赢」钉死,免得有人挪一行就无声地翻盘。
 */

describe('序号直达那一族', () => {
  it('按 WORKSPACE_SLOT_COUNT 长出对应条数,一条不多一条不少', () => {
    const slots = KEYMAP_COMMANDS.filter((c) => c.id.startsWith('workspace.slot:'))
    expect(slots).toHaveLength(WORKSPACE_SLOT_COUNT)
  })

  it('每一条都有名字(labelKey 不许是 undefined —— 那会在设置页画出一行空白)', () => {
    for (let n = 1; n <= WORKSPACE_SLOT_COUNT; n += 1) {
      const command = KEYMAP_COMMANDS.find((c) => c.id === workspaceSlotCommandId(n))
      expect(command?.labelKey).toBeTruthy()
    }
  })

  it('出厂键是 ⌘1 / ⌘2 / ⌘3', () => {
    for (let n = 1; n <= WORKSPACE_SLOT_COUNT; n += 1) {
      expect(effectiveCombo(initialKeymapState, workspaceSlotCommandId(n))).toEqual({
        meta: true,
        key: String(n),
      })
    }
  })

  it('⌘2 落到第二个序号的命令上', () => {
    const id = lookupCommand(initialKeymapState, {
      key: '2',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    })
    expect(id).toBe(workspaceSlotCommandId(2))
  })
})

describe('⌘⇧O 撞键(待用户裁定,见文件头)', () => {
  it('两条命令的出厂键确实是同一个 —— 这条断言是那次撞车的**存在证明**', () => {
    expect(effectiveCombo(initialKeymapState, 'workspace.palette')).toEqual(
      effectiveCombo(initialKeymapState, 'toc.toggle'),
    )
  })

  it('按下去落在工作区面板上(次序即裁决;挪一行就会无声翻盘)', () => {
    const id = lookupCommand(initialKeymapState, {
      key: 'o',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    })
    expect(id).toBe('workspace.palette')
  })
})
