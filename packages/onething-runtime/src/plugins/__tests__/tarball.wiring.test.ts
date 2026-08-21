/**
 * 装前清单预读:手写 tar 遍历的正反例。
 *
 * tarball 全部在测试里现造(手写 512 字节块 + gzipSync),不落任何 fixture ——
 * 反例才是重点:坏 gzip、不是 tar、缺 package.json、命名不符,每一条都必须
 * 落到**自己的** errorCode 上,否则 UI 只能说一句"读取失败",用户无从下手。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { readPluginTarballSummary, readTarMembers } from '../tarball.wiring.js'

// ── 手写 tar:够用就好,只写我们的读端要认的那几个字段 ──

function tarHeader(name: string, size: number, typeFlag = '0', prefix = ''): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf-8')
  header.write('0000644\0', 100)
  header.write('0000000\0', 108)
  header.write('0000000\0', 116)
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
  header.write('00000000000\0', 136)
  // 校验和先按 8 个空格参与计算(tar 的约定)。
  header.write('        ', 148)
  header.write(typeFlag, 156)
  header.write('ustar\0', 257)
  header.write('00', 263)
  if (prefix) header.write(prefix, 345, 155, 'utf-8')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return header
}

function tarMember(name: string, content: string, typeFlag = '0', prefix = ''): Buffer {
  const data = Buffer.from(content, 'utf-8')
  const padding = (512 - (data.length % 512)) % 512
  return Buffer.concat([tarHeader(name, data.length, typeFlag, prefix), data, Buffer.alloc(padding)])
}

function tarArchive(...members: Buffer[]): Buffer {
  // 归档以两个全零块收尾。
  return Buffer.concat([...members, Buffer.alloc(1024)])
}

/** pax 记录格式:`<总长> <key>=<value>\n`,总长把自己的位数也算进去。 */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`
  let length = body.length + 1
  while (String(length).length + body.length !== length) {
    length = String(length).length + body.length
  }
  return `${length}${body}`
}

const PACKAGE_JSON = JSON.stringify({
  name: '@onething-plugins/tps-meter',
  version: '1.0.3',
  description: 'from package.json',
  author: { name: 'pkg author' },
})

const PLUGIN_JSON = JSON.stringify({
  name: 'TPS Meter',
  version: '1.0.3',
  description: 'tokens per second, live',
  author: 'onething',
  minAppVersion: '1.4.0',
  contributes: {
    uiSlots: [{ anchor: 'message.footer', id: 'tps', label: 'TPS', lifetime: 'persistent' }],
    permissions: ['session:read'],
  },
})

function writeTarball(name: string, body: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-plugin-tarball-'))
  const file = path.join(dir, name)
  fs.writeFileSync(file, body)
  return file
}

function writeGzippedTar(members: Buffer[]): string {
  return writeTarball('plugin.tgz', gzipSync(tarArchive(...members)))
}

describe('readPluginTarballSummary — 正例', () => {
  it('从 package.json 取包名与版本,从 plugin.json 取声明', () => {
    const file = writeGzippedTar([
      tarMember('package/plugin-entry.js', 'export default {}'),
      tarMember('package/package.json', PACKAGE_JSON),
      tarMember('package/plugin.json', PLUGIN_JSON),
    ])

    const result = readPluginTarballSummary(file)

    expect(result.success).toBe(true)
    expect(result.summary).toMatchObject({
      path: file,
      pkg: '@onething-plugins/tps-meter',
      pluginId: 'tps-meter',
      version: '1.0.3',
      displayName: 'TPS Meter',
      description: 'tokens per second, live',
      author: 'onething',
      minAppVersion: '1.4.0',
    })
    // contributes 是 manifest 原文 —— 披露页与市场那条路同形。
    expect(result.summary?.contributes).toEqual({
      uiSlots: [{ anchor: 'message.footer', id: 'tps', label: 'TPS', lifetime: 'persistent' }],
      permissions: ['session:read'],
    })
    expect(result.summary?.manifestIssue).toBeUndefined()
  })

  it('plugin.json 缺失 = 降级而非拒绝:摘要照给,并明说它装得上但不会被加载', () => {
    const file = writeGzippedTar([tarMember('package/package.json', PACKAGE_JSON)])

    const result = readPluginTarballSummary(file)

    expect(result.success).toBe(true)
    expect(result.summary?.pkg).toBe('@onething-plugins/tps-meter')
    // package.json 兜底了描述/作者,manifest 独有的字段则缺席。
    expect(result.summary?.description).toBe('from package.json')
    expect(result.summary?.author).toBe('pkg author')
    expect(result.summary?.contributes).toBeUndefined()
    expect(result.summary?.manifestIssue).toContain('never load')
  })

  it('plugin.json 是坏 JSON 时同样降级,不牵连整次预读', () => {
    const file = writeGzippedTar([
      tarMember('package/package.json', PACKAGE_JSON),
      tarMember('package/plugin.json', '{ not json'),
    ])

    const result = readPluginTarballSummary(file)

    expect(result.success).toBe(true)
    expect(result.summary?.version).toBe('1.0.3')
    expect(result.summary?.manifestIssue).toContain('plugin.json')
  })

  it('pax 扩展头的 path 覆盖 header 里的短名', () => {
    const pax = paxRecord('path', 'package/package.json')
    const file = writeGzippedTar([
      tarMember('PaxHeaders.0/bogus', pax, 'x'),
      tarMember('this-name-is-overridden', PACKAGE_JSON),
      tarMember('package/plugin.json', PLUGIN_JSON),
    ])

    const result = readPluginTarballSummary(file)

    expect(result.success).toBe(true)
    expect(result.summary?.pkg).toBe('@onething-plugins/tps-meter')
    expect(result.summary?.displayName).toBe('TPS Meter')
  })

  it('GNU 长名扩展(typeflag L)也认', () => {
    const file = writeGzippedTar([
      tarMember('././@LongLink', 'package/package.json\0', 'L'),
      tarMember('truncated-name', PACKAGE_JSON),
    ])

    const result = readPluginTarballSummary(file)

    expect(result.success).toBe(true)
    expect(result.summary?.pluginId).toBe('tps-meter')
  })

  it('ustar 的 prefix 与 name 拼成全路径', () => {
    const members = [tarMember('package.json', PACKAGE_JSON, '0', 'package')]
    const found = readTarMembers(tarArchive(...members), ['package/package.json'])

    expect(found.has('package/package.json')).toBe(true)
  })
})

describe('readPluginTarballSummary — 结构化拒绝', () => {
  it('文件不存在', () => {
    const result = readPluginTarballSummary(path.join(os.tmpdir(), 'onething-no-such-plugin.tgz'))

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('not-found')
  })

  it('空路径', () => {
    expect(readPluginTarballSummary('   ').errorCode).toBe('not-found')
  })

  it('不是 gzip', () => {
    const file = writeTarball('plain.tgz', Buffer.from('this is not a gzip archive'))

    const result = readPluginTarballSummary(file)

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('not-gzip')
  })

  it('gzip 头对但内容坏了', () => {
    const broken = gzipSync(Buffer.from('hello'))
    broken[broken.length - 4] ^= 0xff
    const file = writeTarball('broken.tgz', broken)

    expect(readPluginTarballSummary(file).errorCode).toBe('not-gzip')
  })

  it('是 gzip 但不是 tar —— 说清是哪一层坏了,而不是笼统的"没有 package.json"', () => {
    const file = writeTarball('notar.tgz', gzipSync(Buffer.alloc(2048, 0x41)))

    const result = readPluginTarballSummary(file)

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('not-tar')
    expect(result.error).toContain('not a tar archive')
  })

  it('tar 里没有 package/package.json', () => {
    const file = writeGzippedTar([tarMember('package/plugin.json', PLUGIN_JSON)])

    const result = readPluginTarballSummary(file)

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('missing-package-json')
  })

  it('package.json 是坏 JSON', () => {
    const file = writeGzippedTar([tarMember('package/package.json', '{ oops')])

    expect(readPluginTarballSummary(file).errorCode).toBe('invalid-package-json')
  })

  it('package.json 没有 name', () => {
    const file = writeGzippedTar([tarMember('package/package.json', JSON.stringify({ version: '1.0.0' }))])

    expect(readPluginTarballSummary(file).errorCode).toBe('missing-name')
  })

  it('包名不符 @onething-plugins/<id> 命名契约 —— 拒绝,不猜', () => {
    for (const name of ['tps-meter', '@other-scope/tps-meter', '@onething-plugins/Bad Name', '@onething-plugins/a/b']) {
      const file = writeGzippedTar([
        tarMember('package/package.json', JSON.stringify({ name, version: '1.0.0' })),
      ])
      const result = readPluginTarballSummary(file)
      expect(result.success, name).toBe(false)
      expect(result.errorCode, name).toBe('name-contract')
    }
  })

  it('包名合规但没有 version', () => {
    const file = writeGzippedTar([
      tarMember('package/package.json', JSON.stringify({ name: '@onething-plugins/tps-meter' })),
    ])

    expect(readPluginTarballSummary(file).errorCode).toBe('missing-version')
  })

  it('目录不是文件', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-plugin-dir-'))

    const result = readPluginTarballSummary(dir)

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('not-found')
  })
})
