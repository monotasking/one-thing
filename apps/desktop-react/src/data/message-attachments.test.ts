import { describe, expect, it } from 'vitest'
import { createSessionProjectionState, reduceSessionProjection } from '@onething/core/session/projection/reducer'
import { materializeChatMessagesCached } from './chat-materialize'
import { rehangPageResults } from './page-results'
import { imageMimeTypeOf, messageAttachmentMetadata } from './message-attachments'

const image = {
  id: 'image-1', fileName: '屏幕截图.png', mimeType: 'image/png', mediaType: 'image',
  size: 1024, filePath: '/stored/屏幕截图.png', base64Data: { hash: 'deadbeef', bytes: 1024 },
}
const expected = {
  id: 'image-1', fileName: '屏幕截图.png', mimeType: 'image/png', mediaType: 'image',
  size: 1024, filePath: '/stored/屏幕截图.png',
  image: { mimeType: 'image/png', base64Data: image.base64Data },
}

describe('消息附件元信息:与正文并列,不依赖正文加载', () => {
  it('实时账本投影保留附件;只有附件且 blob 尚未读取时仍能显示文件名', () => {
    const state = reduceSessionProjection(createSessionProjectionState(), {
      seq: 1, time: 1000, type: 'user/message',
      data: { message: { id: 'u1', role: 'user', content: '', timestamp: 1000, attachments: [image] } },
    } as never)
    const message = materializeChatMessagesCached(state, {}, 0).messages[0]
    expect(message.content).toBe('')
    expect(message.attachments).toEqual([image])
    expect(messageAttachmentMetadata(message)).toEqual([expected])
  })

  it('历史页投影保留同一份附件元信息,不必重新读取图片 blob', () => {
    const message = rehangPageResults([{
      id: 'u1', role: 'user', content: '', timestamp: 1000, attachments: [image],
    }], undefined)[0]
    expect(messageAttachmentMetadata(message)).toEqual([expected])
  })

  it('非图片元信息读取不访问 base64Data,也不把大文件正文带入展示结构', () => {
    const attachment = {
      id: 'file-1', fileName: '报告.pdf',
      get base64Data(): never { throw new Error('UI 不应读取附件正文') },
    }
    expect(messageAttachmentMetadata({ id: 'u1', attachments: [attachment] }))
      .toEqual([{ id: 'file-1', fileName: '报告.pdf' }])
  })

  it('图片保留同一份 blob 引用或内联 base64,不读取和解码字节', () => {
    const metadata = messageAttachmentMetadata({ id: 'u1', attachments: [
      image,
      { fileName: '照片.jpeg', base64Data: '/9j/4AAQ' },
    ] })
    expect(metadata[0].image?.base64Data).toBe(image.base64Data)
    expect(metadata[1].image).toEqual({ mimeType: 'image/jpeg', base64Data: '/9j/4AAQ' })
  })

  it('待发送图片保留原始 File,空 MIME 时也能按文件名识别', () => {
    const file = new File(['image bytes'], '屏幕截图.PNG')
    const metadata = messageAttachmentMetadata({ id: 'pending', attachments: [{ file }] })
    expect(metadata[0]).toMatchObject({ fileName: '屏幕截图.PNG', image: { mimeType: 'image/png' } })
    expect(metadata[0].file).toBe(file)
  })

  it('图片缺少或携带无效正文时仍保留预览类型和文件路径', () => {
    const metadata = messageAttachmentMetadata({ id: 'u1', attachments: [
      { filePath: '/stored/屏幕截图.png' },
      { fileName: '照片.gif', base64Data: { hash: 'incomplete' } },
    ] })
    expect(metadata[0]).toMatchObject({ filePath: '/stored/屏幕截图.png', image: { mimeType: 'image/png' } })
    expect(metadata[1].image).toEqual({ mimeType: 'image/gif' })
  })

  it.each([
    ['Image/PNG; charset=binary', 'unnamed', 'image/png'],
    ['image/webp', 'wrong.png', 'image/webp'],
    ['application/octet-stream', '照片.JPEG', 'image/jpeg'],
    [undefined, '截图.svg', 'image/svg+xml'],
    ['text/plain', 'notes.txt', undefined],
    [undefined, 'unknown', undefined],
  ])('根据 MIME 或扩展名识别图片: %s / %s', (mimeType, fileName, expectedMimeType) => {
    expect(imageMimeTypeOf(mimeType, fileName)).toBe(expectedMimeType)
  })

  it('不完整旧附件也有稳定身份和可显示名称,忽略无效项目', () => {
    const metadata = messageAttachmentMetadata({ id: 'u1', attachments: [
      { filePath: '/project/旧报告.pdf' },
      { name: '旧附件名.txt', size: 0 },
      { sourceTitle: '参考网页', sourceUrl: 'https://example.test' },
      {}, null, 'invalid',
    ] })
    expect(metadata).toHaveLength(4)
    expect(metadata[0]).toEqual({ id: 'u1:attachment:0', fileName: '旧报告.pdf', filePath: '/project/旧报告.pdf' })
    expect(metadata[1]).toEqual({ id: 'u1:attachment:1', fileName: '旧附件名.txt', size: 0 })
    expect(metadata[2]).toMatchObject({ fileName: '参考网页', sourceUrl: 'https://example.test' })
    expect(metadata[3].fileName).toBeTruthy()
    expect(metadata[3].id).toBe('u1:attachment:3')
  })
})
