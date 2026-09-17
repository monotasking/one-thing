import { useMemo, useRef, useState } from 'react'
import type { CaretController } from '../content/editing/caret-controller'
import { EditableDoc } from '../content/editing/EditableDoc'
import { EditorDocument } from '../content/editing/editor-document'
import { REVEAL_MODES, type RevealMode } from '../content/editing/reveal'
import { Button } from '../ui/Button'
import { Segmented } from '../ui/Segmented'

/**
 * `?todo-lab`:待办编辑器实验台(dev 工具页,不进产品路由)。
 *
 * 真的 `EditableDoc` + 真的光标控制器,文档是内存里的一份(假 channel,不碰真 store)。
 * 页内「跑一致性自测」照样例 `docs/todo-editor-reveal-2026-09-17.html` 的九项 × 三档逐条搬过来:
 * 导航键全部由控制器处理,所以合成按键走的就是真实路径;**页面必须真在屏幕上排版**
 * (隐藏的标签页 `innerHeight` 为 0,量尺全失真)。
 */

export const TODO_LAB_ORIGINAL = `# 实现自动化部署脚本

## 待修 bug
- [x] 服务器端 \`git rev-parse\` 拿 HASH 必失败 → **本地算好**再传过去
- [ ] 重启服务前先 **确认备份**，再动手
- [ ] 跑一遍 \`make deploy\` 看输出
- [ ] 详见[部署文档](https://example.com/deploy)里的回滚一节
- [ ] 只保留最近 *3* 个版本
- [ ] **重要**\`v2\` 两个元素紧挨着
- [ ] 中英混排折行：health check 改成 127.0.0.1 + retry polling，失败三次就 **rollback** 到上一个 release 版本

> 回滚不要动线上内容，先用**同一个版本**冒烟。`

interface Row { name: string; ok: boolean; detail: string }

function newDocument(): EditorDocument {
  return new EditorDocument(TODO_LAB_ORIGINAL, 'lab', { submit: async () => ({ conflict: false, revision: 'lab' }), requestReload: () => {} })
}

export function TodoLab() {
  const [mode, setMode] = useState<RevealMode>('element')
  const [width, setWidth] = useState<'drawer' | 'panel'>('drawer')
  const [generation, setGeneration] = useState(0)
  const document = useMemo(() => newDocument(), [generation])
  const controllerRef = useRef<CaretController | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const modeRef = useRef(mode)
  modeRef.current = mode

  const runSuite = async () => {
    const results: Row[] = []
    // 不用 rAF:预览面板藏起来时 rAF 整个停摆,自测会卡死;React 的提交走 MessageChannel,定时器够用。
    const tick = () => new Promise(resolve => setTimeout(resolve, 16))
    const setModeNow = async (next: RevealMode) => { setMode(next); modeRef.current = next; await tick(); await tick() }
    const fresh = async () => { setGeneration(g => g + 1); await tick(); await tick() }
    const ctl = () => controllerRef.current
    const editor = () => globalThis.document.querySelector<HTMLElement>('[data-lab-doc] [contenteditable="true"]')
    const key = (k: string, extra: KeyboardEventInit = {}) => editor()?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }))
    const input = (inputType: string, data?: string) => editor()?.dispatchEvent(new InputEvent('beforeinput', { inputType, data, bubbles: true, cancelable: true }))
    const where = () => { const snap = ctl()?.snapshot(); return snap ? `${snap.start}:${snap.focus}` : 'closed' }
    const at = async (find: string, offset = 0) => {
      await fresh()
      const lines = TODO_LAB_ORIGINAL.split('\n')
      const index = lines.findIndex(line => line.includes(find))
      if (index < 0) throw new Error(`lab text missing: ${find}`)
      const snapLine = lines[index]
      const prefix = snapLine.match(/^(\s*[-*+]\s+\[[ xX]\]\s?|\s*[-*+]\s+)/)?.[0] ?? ''
      ctl()?.open(index, snapLine.slice(prefix.length).indexOf(find) + offset + (prefix ? 0 : 0))
      await tick()
    }
    const healthy = () => {
      const snap = ctl()?.snapshot()
      const ed = editor()
      const selection = getSelection()
      if (!snap || !ed || !selection?.focusNode) return true
      const range = globalThis.document.createRange()
      range.setStart(ed, 0)
      range.setEnd(selection.focusNode, selection.focusOffset)
      if (range.toString().length !== snap.viewFocus) return false
      if (modeRef.current === 'none') return true
      const visible = new Set(snap.visible)
      return !(snap.focus > 0 && !visible.has(snap.focus - 1)) && !(snap.focus < snap.value.length && !visible.has(snap.focus))
    }
    const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail })

    for (const m of REVEAL_MODES) {
      await setModeNow(m)
      const tag = { element: '元素', block: '整块', none: '不显示记号' }[m]
      // ui-consume-allow: kbd-select-handwritten — 自测往编辑器里合成按键,不是列表选择
      // 1 同一位置按 ↓,三种来路结果相同
      const outcomes: string[] = []
      await at('待修 bug', 6); key('ArrowDown'); outcomes.push(where())
      await at('`git rev-parse`', 6); key('ArrowUp'); key('End'); key('ArrowDown'); outcomes.push(where())
      await at('`git rev-parse`', 6); key('ArrowUp'); { const s = ctl()?.snapshot(); if (s) ctl()?.open(s.start, s.value.length) } key('ArrowDown'); outcomes.push(where())
      check(`${tag}｜同一位置按 ↓，三种来路结果相同`, new Set(outcomes).size === 1, outcomes.join(' / '))
      // 2 → 走完全篇再 ← 走回,每一步对得上
      await at('实现自动化', 0); key('ArrowUp', { metaKey: true })
      const forward = [where()]
      let bad = 0
      for (let i = 0; i < 400; i++) { const w = where(); key('ArrowRight'); if (!healthy()) bad++; if (where() === w) break; forward.push(where()) }
      const back = [where()]
      for (let i = 0; i < 400; i++) { const w = where(); key('ArrowLeft'); if (!healthy()) bad++; if (where() === w) break; back.push(where()) }
      check(`${tag}｜→ 走完全篇再 ← 走回，每一步对得上`, bad === 0 && back[back.length - 1] === forward[0], `${forward.length} 步，自检失败 ${bad} 次`)
      // 3 ↓↓↑↑ 回原位
      await at('`make deploy`', 3); const start3 = where(); key('ArrowDown'); key('ArrowDown'); key('ArrowUp'); key('ArrowUp')
      check(`${tag}｜↓↓↑↑ 回到原位置`, where() === start3, `${start3} → ${where()}`)
      // 4 首项 ↑ / 末项 ↓ 不动
      await at('实现自动化', 2); const s4 = where(); key('ArrowUp'); const u4 = where()
      await at('冒烟', 0); const s4b = where(); key('ArrowDown')
      check(`${tag}｜第一项 ↑、最后一项 ↓ 光标不动`, u4 === s4 && where() === s4b, `${u4} / ${where()}`)
      // 5 回车 / 退格之后光标还在
      let lost = 0
      await at('待修 bug', 6); key('Enter'); if (!ctl()?.snapshot()) lost++
      key('Enter'); if (!ctl()?.snapshot()) lost++
      await at('重启服务前先', 0); input('deleteContentBackward'); if (!ctl()?.snapshot()) lost++
      await at('## 待修', 3); input('deleteContentBackward'); if (!ctl()?.snapshot()) lost++
      check(`${tag}｜回车 / 退格之后光标还在`, lost === 0, `丢失 ${lost} 次`)
      // 6 行首退格并入上一项、行尾 Delete 并入下一项
      await at('跑一遍', 0); input('deleteContentBackward'); const merged1 = ctl()?.snapshot()?.value ?? ''
      await at('确认备份**，再动手', 11); input('deleteContentForward'); const merged2 = ctl()?.snapshot()?.value ?? ''
      check(`${tag}｜行首退格并入上一项、行尾 Delete 并入下一项`, merged1.includes('再动手跑一遍') && merged2.includes('再动手跑一遍'), `${merged1.slice(-12)} | ${merged2.slice(-12)}`)
      // 7 跨项撤销
      await at('只保留最近', 5); input('insertText', '甲'); key('Enter'); input('insertText', '乙')
      key('z', { metaKey: true }); key('z', { metaKey: true }); key('z', { metaKey: true })
      const snap7 = ctl()?.snapshot()
      check(`${tag}｜跨项撤销回到原文，光标回到第一次改动处`, controllerDocText() === TODO_LAB_ORIGINAL && !!snap7 && snap7.value.startsWith('只保留最近') && snap7.focus === 5, where())
      // 8 emoji 退格删整个
      await at('只保留最近', 0); input('insertText', '👍🏽'); input('deleteContentBackward')
      const v8 = ctl()?.snapshot()?.value ?? ''
      check(`${tag}｜退格删掉整个 emoji`, v8.startsWith('只保留最近') && !/[\uD800-\uDFFF]/.test(v8), JSON.stringify(v8.slice(0, 6)))
      // 9 窄宽度折行项里 ↑↑↓↓↓↑ 回原位
      setWidth('panel'); await tick(); await tick()
      await at('中英混排', 3); const s9 = where()
      for (const k of ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowUp']) key(k)
      const e9 = where()
      setWidth('drawer'); await tick(); await tick()
      check(`${tag}｜窄宽度折行项里 ↑↑↓↓↓↑ 回到原位`, e9 === s9, `${s9} → ${e9}`)
    }
    setRows(results)
    ;(globalThis as { __todoLabResults?: Row[] }).__todoLabResults = results
  }

  const documentRef = useRef(document)
  documentRef.current = document
  function controllerDocText(): string { return documentRef.current.lines.join('\n') }

  return (
    <div style={{ padding: 'var(--sp-4)', display: 'grid', gap: 'var(--sp-3)', background: 'var(--surface-0)', minHeight: '100vh' }}>
      <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap', alignItems: 'center' }}>
        <Segmented label="mode" options={REVEAL_MODES.map(m => ({ value: m, label: m }))} value={mode} onChange={setMode} />
        <Segmented label="width" options={[{ value: 'drawer', label: 'drawer' }, { value: 'panel', label: 'panel' }]} value={width} onChange={setWidth} />
        <Button onClick={() => setGeneration(g => g + 1)}>reset</Button>
        <Button data-lab-suite="" onClick={() => void runSuite()}>run suite</Button>
      </div>
      <div data-lab-doc="" data-scroll-root="" style={{ maxWidth: width === 'drawer' ? '640px' : '340px', maxHeight: '560px', overflow: 'auto', background: 'var(--surface-2)', padding: 'var(--sp-4)', borderRadius: 'var(--r-3)' }}>
        <EditableDoc
          key={generation}
          document={document}
          mode={mode}
          density={width}
          label="todo lab"
          addLabel="添加一项"
          checkLabel={done => (done ? 'uncheck' : 'check')}
          controllerRef={controllerRef}
        />
      </div>
      {rows.length > 0 && (
        <div data-lab-results="">
          <b>{rows.filter(r => r.ok).length} / {rows.length}</b>
          {rows.map(r => <div key={r.name}>{r.ok ? '✓' : '✗'} {r.name} — {r.detail}</div>)}
        </div>
      )}
    </div>
  )
}
