import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { FileActionsMenu } from '../FileActionsMenu'
import { FILE_OPEN_MODES, FILE_OPEN_MODE_LABELS, useFileOpenMode } from '../../data/file-open-mode'
import { useViewerSource } from '../../data/viewer-source'
import { t } from '../../i18n'
import { FocusScope } from '../../focus/FocusScope'
import { focusTree } from '../../focus/registry'
import { FocusDispatchHarness } from '../../test/focus-harness'
import { useStageStore } from '../../stage/store'
import { useWorkbenchStore } from '../../workbench/store'
import { pinMacUserAgent } from '../../test/mac-ua'
import '../kinds'

/**
 * **「打开方式」折进二级菜单**(09-24)。
 *
 * 报障「文件的菜单,打开之后把文件列表都挡住了」:真机 1200×800、目录面板 399 宽,
 * 右键 `drawer.ts` 开出来的菜单 206×452,贴在行下方盖住整整 17 行 —— 小节头 22 + 六枚
 * `menuitemradio` × 30 占了一半。这一组钉三件:一级那张表**长什么样**(项数与文案逐条);
 * 「打开方式 ▸」那一行在、行尾说当下那一档;子表里六枚单选、勾落在当下那一档,
 * 以及 APG 那套键盘(→ 进、← 退、Esc 只退一层)。
 */

const TS = { path: '/repo/drawer.ts', name: 'drawer.ts', type: 'file' as const }
const DIR = { path: '/repo/src', name: 'src', type: 'directory' as const, expanded: false }

beforeEach(() => {
  pinMacUserAgent()
  useStageStore.setState({ locale: 'zh' })
  useWorkbenchStore.getState().reset()
  useViewerSource.getState().reset()
  useFileOpenMode.setState({ mode: 'panel' })
})

afterEach(() => {
  focusTree.reset()
})

function renderMenu(target: typeof TS | typeof DIR) {
  return render(
    <FocusScope scope="root">
      {({ scopeProps }) => (
        <div {...scopeProps}>
          <FocusDispatchHarness />
          <FileActionsMenu target={target} x={10} y={10} onClose={() => {}} onDetail={() => {}} />
        </div>
      )}
    </FocusScope>,
  )
}

/** 一级那张表(第一张 `role=menu`)。子表开着时它仍是文档里的第一张。 */
const topMenu = (): HTMLElement => screen.getAllByRole('menu')[0]
const openWithRow = (): HTMLElement =>
  within(topMenu()).getByRole('menuitem', { name: new RegExp(`^${t('files.openWith')}`) })

describe('一级那张表:「打开方式」只剩一行', () => {
  it('文件(`drawer.ts`,没开着):项数与文案逐条,一枚单选都不在一级', () => {
    renderMenu(TS)
    const labels = within(topMenu())
      .getAllByRole('menuitem')
      .map((el) => el.textContent)
    expect(labels).toEqual([
      `${t('files.menuOpen')}${t('files.openIn.panel')}`,
      t('viewer.edit'),
      t('files.menuOpenRight'),
      t('files.menuOpenBelow'),
      `${t('files.openWith')}${t('files.openIn.panel')}`,
      `${t('files.detailAction')}⌘I`,
      t('files.copyPath'),
      t('files.reveal'),
    ])
    expect(within(topMenu()).queryAllByRole('menuitemradio')).toHaveLength(0)
  })

  it('「打开方式 ▸」是一项子菜单:`aria-haspopup=menu`、收着时 `aria-expanded=false`、行尾写当下那一档', () => {
    useFileOpenMode.setState({ mode: 'edge-right' })
    renderMenu(TS)
    const row = openWithRow()
    expect(row.getAttribute('aria-haspopup')).toBe('menu')
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(row.textContent).toBe(`${t('files.openWith')}${t('files.openIn.edgeRight')}`)
  })

  it('目录那一行没有「打开方式」(它没有查看器)—— 表形照旧', () => {
    renderMenu(DIR)
    const labels = within(topMenu())
      .getAllByRole('menuitem')
      .map((el) => el.textContent)
    expect(labels).toEqual([
      t('files.menuExpand'),
      `${t('files.detailAction')}⌘I`,
      t('files.copyPath'),
      t('files.reveal'),
    ])
  })
})

describe('二级那张表:六档原样', () => {
  it('点开:六枚 `menuitemradio`,次序与文案照 `FILE_OPEN_MODES`,勾落在当下那一档', async () => {
    useFileOpenMode.setState({ mode: 'stage' })
    renderMenu(TS)
    fireEvent.click(openWithRow())
    await waitFor(() => expect(screen.getAllByRole('menu')).toHaveLength(2))
    const sub = screen.getAllByRole('menu')[1]
    const radios = within(sub).getAllByRole('menuitemradio')
    expect(radios.map((el) => el.textContent)).toEqual(FILE_OPEN_MODES.map((m) => t(FILE_OPEN_MODE_LABELS[m])))
    expect(radios.map((el) => el.getAttribute('aria-checked'))).toEqual(
      FILE_OPEN_MODES.map((m) => String(m === 'stage')),
    )
    expect(openWithRow().getAttribute('aria-expanded')).toBe('true')
  })

  it('选一档 = 记住它(点击行为逐字不变)', async () => {
    renderMenu(TS)
    fireEvent.click(openWithRow())
    await waitFor(() => expect(screen.getByText(t('files.openIn.float'))).toBeTruthy())
    fireEvent.click(screen.getByText(t('files.openIn.float')))
    await waitFor(() => expect(useFileOpenMode.getState().mode).toBe('float'))
  })

  it('键盘:→ 进子表、焦点落进去;← 收起、焦点回到那一行', async () => {
    renderMenu(TS)
    const row = openWithRow()
    act(() => row.focus())
    fireEvent.keyDown(row, { key: 'ArrowRight' })
    await waitFor(() => expect(screen.getAllByRole('menu')).toHaveLength(2))
    const sub = screen.getAllByRole('menu')[1]
    await waitFor(() => expect(sub.contains(document.activeElement)).toBe(true))
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft' })
    await waitFor(() => expect(screen.getAllByRole('menu')).toHaveLength(1))
    await waitFor(() => expect(document.activeElement).toBe(openWithRow()))
  })

  it('Esc 只退一层:子表收起,一级那张还开着', async () => {
    renderMenu(TS)
    fireEvent.click(openWithRow())
    await waitFor(() => expect(screen.getAllByRole('menu')).toHaveLength(2))
    const sub = screen.getAllByRole('menu')[1]
    await waitFor(() => expect(sub.contains(document.activeElement)).toBe(true))
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.getAllByRole('menu')).toHaveLength(1))
  })
})
