/**
 * ACP agent 探测(A1-a):在一个临时目录里放假的可执行,拿它当 PATH。
 * 不碰真 PATH、不起真 agent。
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { detectAgent, locateAgentBin, parseVersionLine, whichSync } from '../acp-detect.js'

let dir: string

function fakeBin(name: string, script: string, executable = true): string {
  const file = path.join(dir, name)
  writeFileSync(file, `#!/bin/sh\n${script}\n`)
  chmodSync(file, executable ? 0o755 : 0o644)
  return file
}

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'acp-detect-'))
  fakeBin('fake-agent', 'echo "fake-agent version 1.4.2 (build 7)"')
  fakeBin('old-agent', 'echo "0.9"')
  fakeBin('not-executable', 'echo 1.0.0', false)
  fakeBin('npx', 'echo 10.0.0')
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('ACP 探测', () => {
  it('PATH 上找得到、可执行 → 已安装,带绝对路径', () => {
    const found = locateAgentBin({ id: 'fake', name: 'Fake', launch: { command: 'fake-agent' } }, { path: dir })
    expect(found.installed).toBe(true)
    expect(found.path).toBe(path.join(dir, 'fake-agent'))
  })

  it('不存在的可执行 → 未安装;没有执行位的也不算', () => {
    expect(locateAgentBin({ id: 'ghost', name: 'Ghost', launch: { command: 'no-such-bin-xyz' } }, { path: dir }).installed)
      .toBe(false)
    expect(whichSync('not-executable', { path: dir })).toBeUndefined()
  })

  it('detect.bins 优先于 launch.command;带路径的命令直接按路径判', () => {
    expect(locateAgentBin({ id: 'x', name: 'X', launch: { command: 'nope' }, detect: { bins: ['nope2', 'fake-agent'] } }, { path: dir }).installed)
      .toBe(true)
    expect(locateAgentBin({ id: 'abs', name: 'Abs', launch: { command: path.join(dir, 'fake-agent') } }, { path: '' }).installed)
      .toBe(true)
  })

  it('npx 起的条目:装没装 = 找不找得到 npx', () => {
    const manifest = { id: 'reg', name: 'Reg', launch: { command: 'npx', args: ['-y', 'pkg@1.0.0'] } }
    expect(locateAgentBin(manifest, { path: dir }).installed).toBe(true)
    expect(locateAgentBin(manifest, { path: path.join(dir, 'empty') }).installed).toBe(false)
  })

  it('写了 versionArgs 才取版本号:首行第一个 x.y(.z)', async () => {
    const withVersion = await detectAgent({
      id: 'fake', name: 'Fake', launch: { command: 'fake-agent' }, detect: { versionArgs: ['--version'] },
    }, { path: dir })
    expect(withVersion).toMatchObject({ installed: true, version: '1.4.2' })
    expect(withVersion.belowMin).toBeUndefined()

    const withoutArgs = await detectAgent({ id: 'fake', name: 'Fake', launch: { command: 'fake-agent' } }, { path: dir })
    expect(withoutArgs.version).toBeUndefined()
  })

  it('低于 minVersion 标 belowMin', async () => {
    const result = await detectAgent({
      id: 'old', name: 'Old', launch: { command: 'old-agent' }, detect: { versionArgs: ['--version'], minVersion: '1.0.0' },
    }, { path: dir })
    expect(result).toMatchObject({ installed: true, version: '0.9', belowMin: true })
  })

  it('版本行解析', () => {
    expect(parseVersionLine('\n  gemini 0.61.0\nsecond 9.9.9')).toBe('0.61.0')
    expect(parseVersionLine('no digits')).toBeUndefined()
  })
})
