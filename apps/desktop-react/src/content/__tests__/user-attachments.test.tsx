import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { UserFiles, UserImages, USER_IMG_FOLD_AT } from '../user-attachments'
import type { MessageAttachmentMetadata } from '../../data/message-attachments'
import { useStageStore } from '../../stage/store'

const openFile = vi.hoisted(() => vi.fn())
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII='
vi.mock('../viewer/open-target', () => ({ openFileInCurrentTarget: openFile }))

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  openFile.mockClear()
})

const png = (id: string, extra: Partial<MessageAttachmentMetadata> = {}): MessageAttachmentMetadata => ({
  id, fileName: `${id}.png`, image: { mimeType: 'image/png', base64Data: PNG }, ...extra,
})

describe('用户消息里的图(站在气泡外)', () => {
  it('图直接渲染,不再在图下面挂文件名 chip;名字在无障碍名里', async () => {
    render(<UserImages sessionId="s1" images={[png('图片')]} />)
    const image = await screen.findByRole('img', { name: '图片.png' })
    expect(image.getAttribute('src')).toBe(`data:image/png;base64,${PNG}`)
    expect(screen.queryByText('图片.png')).toBeNull()
    expect(document.querySelector('[data-ref-kind="attachmentRef"]')).toBeNull()
    expect(screen.getByTestId('user-images').getAttribute('data-shape')).toBe('single')
  })

  it('点一张图 = 放大层,位图那一支不垫卡', async () => {
    render(<UserImages sessionId="s1" images={[png('图片')]} />)
    fireEvent.click(await screen.findByRole('button', { name: '查看 图片.png' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe(`data:image/png;base64,${PNG}`)
  })

  it('解码失败 = 诚实态:文件名是看得见的字,有落盘路径就能打开那个文件', async () => {
    render(<UserImages sessionId="s1" images={[
      { id: 'one', fileName: '损坏.png', filePath: '/stored/image.png', image: { mimeType: 'image/png', base64Data: 'bad-data' } },
    ]} />)
    fireEvent.error(await screen.findByRole('img', { name: '损坏.png' }))
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('损坏.png')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '打开 损坏.png' }))
    expect(openFile).toHaveBeenCalledWith('/stored/image.png')
  })

  it('没有字节也没有路径:诚实态,不是按钮', async () => {
    render(<UserImages sessionId="s1" images={[{ id: 'x', fileName: '截图.png', image: { mimeType: 'image/png' } }]} />)
    expect(await screen.findByText('截图.png')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('二到四张是一排方块,不折叠', async () => {
    render(<UserImages sessionId="s1" images={['a', 'b', 'c', 'd'].map((id) => png(id))} />)
    expect(await screen.findAllByRole('img')).toHaveLength(4)
    expect(screen.getByTestId('user-images').getAttribute('data-shape')).toBe('row')
  })

  it(`${USER_IMG_FOLD_AT} 张起收成一摞:只画最上三张 + 计数;指针进来摊开,离开宽限后收回`, async () => {
    vi.useFakeTimers()
    try {
      const images = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => png(id))
      render(<UserImages sessionId="s1" images={images} />)
      await act(async () => {})
      const group = screen.getByTestId('user-images')
      expect(group.getAttribute('data-shape')).toBe('stack')
      expect(group.getAttribute('aria-label')).toBe('6 张图片')
      const visible = () => [...group.querySelectorAll('img')].filter((img) => !img.closest('[class*="stackHidden"]'))
      expect(visible().map((img) => img.getAttribute('alt'))).toEqual(['d.png', 'e.png', 'f.png'])

      const stack = group.firstElementChild as HTMLElement
      fireEvent.mouseEnter(stack)
      expect(stack.getAttribute('data-open')).toBe('true')
      expect(visible()).toHaveLength(6)

      fireEvent.mouseLeave(stack)
      expect(stack.getAttribute('data-open')).toBe('true')
      act(() => { vi.advanceTimersByTime(250) })
      expect(stack.getAttribute('data-open')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('气泡里的文件 chip', () => {
  it('显示原始名称,点击打开持久化后的实际文件路径', () => {
    render(<UserFiles attachments={[{ id: 'one', fileName: '报告.pdf', filePath: '/stored/hash-document.pdf' }]} />)
    const file = screen.getByRole('button', { name: '打开 报告.pdf' })
    expect(file.textContent).toBe('报告.pdf')
    fireEvent.click(file)
    expect(openFile).toHaveBeenCalledWith('/stored/hash-document.pdf')
  })

  it('没有落盘路径也显示名字,只是不可点', () => {
    render(<UserFiles attachments={[{ id: 'one', fileName: '报告.pdf' }]} />)
    expect(screen.getByText('报告.pdf')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
