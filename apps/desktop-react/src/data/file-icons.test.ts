import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DIRECTORY_ICON,
  DIRECTORY_OPEN_ICON,
  FILE_TONES,
  UNKNOWN_FILE_ICON,
  extensionOf,
  fileIconOf,
  iconSpecOf,
  isHiddenName,
  toneVar,
} from './file-icons'
import type { FileTone } from './file-icons'

/**
 * 图标映射表是**纯表**,所以这只测试一行 React 都不渲染:它钉的是
 * 「哪个名字画哪枚图标、上哪种色」这件事本身。
 *
 * 最后一组用例是**跨文件的执法**:tone 的名字在 TS 里,值在 tokens.css 里,
 * 没有任何东西拦着人只改一边。与 motion-tokens.test 解析 --dur 族同一条判例 ——
 * 它读 tokens.css 的文本,逐条比对。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const tokensCss = readFileSync(path.join(here, '../styles/tokens.css'), 'utf-8')

describe('目录', () => {
  it('合着是 Folder,展开换 FolderOpen —— 两态是两枚图标,不是同一枚转个角度', () => {
    expect(iconSpecOf('packages', 'directory')).toEqual(DIRECTORY_ICON)
    expect(iconSpecOf('packages', 'directory', true)).toEqual(DIRECTORY_OPEN_ICON)
    expect(DIRECTORY_ICON.icon).toBe('Folder')
    expect(DIRECTORY_OPEN_ICON.icon).toBe('FolderOpen')
    expect(DIRECTORY_ICON.tone).toBe('dir')
  })

  it('目录不看扩展名 —— 一个叫 `assets.js` 的目录仍然是目录', () => {
    expect(iconSpecOf('assets.js', 'directory')).toEqual(DIRECTORY_ICON)
  })
})

describe('语言族:同族同色,异族异色', () => {
  const jsFamily = ['a.ts', 'a.tsx', 'a.mts', 'a.cts', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs']

  it('ts / js 一族一色,图标都是 FileCode', () => {
    for (const name of jsFamily) {
      expect(fileIconOf(name), name).toEqual({ icon: 'FileCode', tone: 'js' })
    }
  })

  it('各族各一色', () => {
    expect(fileIconOf('main.py')).toEqual({ icon: 'FileCode', tone: 'py' })
    expect(fileIconOf('app.rb')).toEqual({ icon: 'FileCode', tone: 'rb' })
    expect(fileIconOf('lib.rs')).toEqual({ icon: 'FileCode', tone: 'rust' })
    expect(fileIconOf('main.go')).toEqual({ icon: 'FileCode', tone: 'go' })
    expect(fileIconOf('Main.java')).toEqual({ icon: 'FileCode', tone: 'jvm' })
    expect(fileIconOf('init.lua')).toEqual({ icon: 'FileCode', tone: 'lua' })
    expect(fileIconOf('App.vue')).toEqual({ icon: 'FileCode', tone: 'web' })
  })

  it('这六族的色两两不同 —— 「一族一色」如果撞了就不成立了', () => {
    const tones = ['a.ts', 'a.py', 'a.rb', 'a.rs', 'a.go', 'a.java', 'a.lua', 'a.vue'].map(
      (n) => fileIconOf(n).tone,
    )
    expect(new Set(tones).size).toBe(tones.length)
  })

  it('有语言但色板上没给单独一格的,仍然认得出「这是源码」', () => {
    expect(fileIconOf('main.cpp')).toEqual({ icon: 'FileCode', tone: 'code' })
    expect(fileIconOf('q.sql')).toEqual({ icon: 'FileCode', tone: 'code' })
  })
})

describe('非语言族:图标是第一判据', () => {
  it('读物 / 数据 / 表格 / 图 / 声 / 影 / 压缩 / 脚本,各一枚图标', () => {
    expect(fileIconOf('README.md')).toEqual({ icon: 'FileText', tone: 'doc' })
    expect(fileIconOf('notes.txt')).toEqual({ icon: 'FileText', tone: 'doc' })
    expect(fileIconOf('tsconfig.json')).toEqual({ icon: 'FileBraces', tone: 'data' })
    expect(fileIconOf('ci.yaml')).toEqual({ icon: 'FileBraces', tone: 'data' })
    expect(fileIconOf('Cargo.toml')).toEqual({ icon: 'FileBraces', tone: 'data' })
    expect(fileIconOf('rows.csv')).toEqual({ icon: 'FileSpreadsheet', tone: 'data' })
    expect(fileIconOf('logo.png')).toEqual({ icon: 'FileImage', tone: 'media' })
    expect(fileIconOf('logo.svg')).toEqual({ icon: 'FileImage', tone: 'media' })
    expect(fileIconOf('bell.mp3')).toEqual({ icon: 'FileMusic', tone: 'media' })
    expect(fileIconOf('clip.mp4')).toEqual({ icon: 'FilePlay', tone: 'media' })
    expect(fileIconOf('dist.tar.gz')).toEqual({ icon: 'FileArchive', tone: 'archive' })
    expect(fileIconOf('build.sh')).toEqual({ icon: 'FileTerminal', tone: 'shell' })
    expect(fileIconOf('run.zsh')).toEqual({ icon: 'FileTerminal', tone: 'shell' })
  })
})

describe('整名优先于扩展名', () => {
  it('锁文件是锁,不是「某种叫 lock 的语言」;package-lock.json 不是普通 json', () => {
    expect(fileIconOf('package-lock.json')).toEqual({ icon: 'FileLock', tone: 'config' })
    expect(fileIconOf('bun.lock')).toEqual({ icon: 'FileLock', tone: 'config' })
    expect(fileIconOf('Cargo.lock')).toEqual({ icon: 'FileLock', tone: 'config' })
  })

  it('没有扩展名也认得出来的那几个', () => {
    expect(fileIconOf('Dockerfile')).toEqual({ icon: 'FileCog', tone: 'config' })
    expect(fileIconOf('Makefile')).toEqual({ icon: 'FileCog', tone: 'config' })
    expect(fileIconOf('LICENSE')).toEqual({ icon: 'FileText', tone: 'doc' })
  })

  it('大小写不影响判据', () => {
    expect(fileIconOf('DOCKERFILE')).toEqual(fileIconOf('dockerfile'))
    expect(fileIconOf('Main.PY')).toEqual(fileIconOf('main.py'))
  })
})

describe('认不出来的那一格', () => {
  it('没有扩展名 / 扩展名不在表里 = File + plain,**不是错误**', () => {
    expect(fileIconOf('CHANGELOG')).toEqual(UNKNOWN_FILE_ICON)
    expect(fileIconOf('data.qqq')).toEqual(UNKNOWN_FILE_ICON)
    expect(UNKNOWN_FILE_ICON).toEqual({ icon: 'File', tone: 'plain' })
  })

  it('点开头的隐藏文件没有扩展名 —— `.gitignore` 的 ext 是空串,靠整名表认', () => {
    expect(extensionOf('.gitignore')).toBe('')
    expect(fileIconOf('.gitignore')).toEqual({ icon: 'FileCog', tone: 'config' })
    // 表里没有的隐藏文件退回 plain,而不是被当成某种扩展名。
    expect(extensionOf('.zshrc')).toBe('')
    expect(fileIconOf('.zshrc')).toEqual(UNKNOWN_FILE_ICON)
  })

  it('隐藏文件仍然可以有扩展名(`.eslintrc.json`),那时按扩展名走', () => {
    expect(extensionOf('.eslintrc.json')).toBe('json')
    expect(fileIconOf('.eslintrc.json')).toEqual({ icon: 'FileBraces', tone: 'data' })
  })
})

describe('隐藏判据', () => {
  it('`.` 开头算隐藏;`.` 与 `..` 是路径语法不是文件', () => {
    expect(isHiddenName('.env')).toBe(true)
    expect(isHiddenName('.eslintrc.json')).toBe(true)
    expect(isHiddenName('README.md')).toBe(false)
    expect(isHiddenName('.')).toBe(false)
    expect(isHiddenName('..')).toBe(false)
  })
})

describe('图标只有名字,组件在 REGISTRY 里', () => {
  /**
   * 这一条挡的是一类**静默**的错:`resolveIcon` 认不出名字时回的是兜底的
   * FolderTree,不抛错 —— 表里写错一个字母,屏幕上只会多出一枚长得像目录的图标,
   * 谁也不会当场发现。所以这里逐条问一句「你真的在册吗」。
   */
  it('表里给出的每一个图标名都在册,没有一个落到兜底上', async () => {
    const { resolveIcon } = await import('../components/icons')
    const fallback = resolveIcon('__definitely-not-an-icon__')
    const names = new Set(
      [
        DIRECTORY_ICON.icon,
        DIRECTORY_OPEN_ICON.icon,
        UNKNOWN_FILE_ICON.icon,
        ...[
          'a.ts', 'a.py', 'a.rb', 'a.rs', 'a.go', 'a.java', 'a.lua', 'a.vue', 'a.cpp',
          'a.md', 'a.json', 'a.csv', 'a.png', 'a.mp3', 'a.mp4', 'a.zip', 'a.sh',
          'Dockerfile', 'bun.lock',
        ].map((n) => fileIconOf(n).icon),
      ],
    )
    for (const name of names) {
      expect(resolveIcon(name), `${name} 不在 components/icons.ts 的 REGISTRY 里`).not.toBe(
        fallback,
      )
    }
  })
})

describe('色只有名字,值在 tokens.css', () => {
  it('toneVar 交出来的是 var() 引用,一个字面色值都没有', () => {
    expect(toneVar('js')).toBe('var(--ft-js)')
    for (const tone of FILE_TONES) {
      expect(toneVar(tone)).toBe(`var(--ft-${tone})`)
      expect(toneVar(tone)).not.toMatch(/#|rgb|hsl/)
    }
  })

  it('每一格 tone 在 tokens.css 的「文件类型色板」里都有一条声明', () => {
    for (const tone of FILE_TONES) {
      expect(tokensCss, `tokens.css 里找不到 --ft-${tone}`).toContain(`--ft-${tone}:`)
    }
  })

  it('色板里的每一条都是从既有色系推导的 var(),不许出现新的字面色值', () => {
    const declared = [...tokensCss.matchAll(/--ft-([a-z]+):\s*([^;]+);/g)]
    expect(declared.length).toBe(FILE_TONES.length)
    for (const [, tone, value] of declared) {
      expect(FILE_TONES).toContain(tone as FileTone)
      expect(value.trim(), `--ft-${tone} 落了字面色值:${value}`).toMatch(/^var\(--[a-z0-9-]+\)$/)
    }
  })
})
