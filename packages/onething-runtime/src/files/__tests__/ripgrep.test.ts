import { describe, expect, it } from 'vitest'
import {
  buildOnethingRipgrepFileListArgs,
  buildOnethingRipgrepSearchArgs,
  getOnethingRipgrepPlatformConfig,
  parseOnethingRipgrepSearchOutput,
} from '../ripgrep.js'

describe('runtime ripgrep helpers', () => {
  /**
   * 两条边界立在参数上(09-07 事故第三条修):**没有 `--follow`**(符号链接环
   * 是那 415GB 虚拟内存的来源),**默认 `--max-depth=8`**。
   */
  it('builds file listing args with hidden files and git excluded by default', () => {
    expect(buildOnethingRipgrepFileListArgs({ glob: ['*.ts'], noIgnore: true })).toEqual([
      '--files',
      '--hidden',
      '--no-ignore',
      '--max-depth=8',
      '--glob=!.git/*',
      '--glob=*.ts',
    ])

    expect(buildOnethingRipgrepFileListArgs({ hidden: false })).toEqual([
      '--files',
      '--max-depth=8',
      '--glob=!.git/*',
    ])
  })

  it('深度可以覆盖,`0` 是明说的「不设限」', () => {
    expect(buildOnethingRipgrepFileListArgs({ hidden: false, maxDepth: 2 })).toEqual([
      '--files',
      '--max-depth=2',
      '--glob=!.git/*',
    ])
    expect(buildOnethingRipgrepFileListArgs({ hidden: false, maxDepth: 0 })).toEqual([
      '--files',
      '--glob=!.git/*',
    ])
  })

  it('`--follow` 一个字都不许回来(符号链接环 = 415GB 虚拟内存那一次)', () => {
    for (const options of [
      { hidden: false },
      { hidden: true, noIgnore: true, maxDepth: 0, glob: ['*.md'] },
    ]) {
      expect(buildOnethingRipgrepFileListArgs(options)).not.toContain('--follow')
    }
  })

  it('builds search args and preserves literal glob order', () => {
    expect(buildOnethingRipgrepSearchArgs({
      cwd: '/repo',
      pattern: 'hello|world',
      glob: ['*.ts', '!dist/*'],
      maxCount: 5,
      ignoreCase: true,
      literal: true,
    })).toEqual([
      '-n',
      '-H',
      '--color=never',
      '--hidden',
      '--field-match-separator=|',
      '--ignore-case',
      '--fixed-strings',
      '--glob',
      '*.ts',
      '--glob',
      '!dist/*',
      '--max-count',
      '5',
      '--regexp',
      'hello|world',
      '/repo',
    ])
  })

  it('parses ripgrep search output with separators in matched text', () => {
    expect(parseOnethingRipgrepSearchOutput([
      'src/a.ts|12|hello|world',
      'src/b.ts|3|plain',
      'bad-line',
      '',
    ].join('\n'))).toEqual([
      { path: 'src/a.ts', lineNumber: 12, lineText: 'hello|world' },
      { path: 'src/b.ts', lineNumber: 3, lineText: 'plain' },
    ])
  })

  it('exposes supported platform metadata', () => {
    expect(getOnethingRipgrepPlatformConfig('x64-linux')).toEqual({
      platform: 'x86_64-unknown-linux-musl',
      extension: 'tar.gz',
    })
    expect(getOnethingRipgrepPlatformConfig('mips-plan9')).toBeUndefined()
  })
})
