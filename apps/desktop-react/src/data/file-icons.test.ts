import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DIRECTORY_GLYPH,
  DIRECTORY_OPEN_GLYPH,
  FILE_BRANDS,
  FILE_TONES,
  UNKNOWN_FILE_GLYPH,
  brandVars,
  extensionOf,
  fileGlyphOf,
  glyphOf,
  isHiddenName,
  toneVar,
} from './file-icons'
import type { FileBrand, FileTone } from './file-icons'

/**
 * 图标 / 字标映射表是**纯表**,所以这只测试一行 React 都不渲染:它钉的是
 * 「哪个名字画哪一形、哪一枚、上哪种色」这件事本身。
 *
 * 最后两组用例是**跨文件的执法**:形与色的**名字**在 TS 里,值在 tokens.css 里,
 * 没有任何东西拦着人只改一边。与 motion-tokens.test 解析 --dur 族同一条判例 ——
 * 它读 tokens.css 的文本,逐条比对。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const tokensCss = readFileSync(path.join(here, '../styles/tokens.css'), 'utf-8')

describe('二形:brand 字标 | lucide 图标', () => {
  it('说得出语言的画字标,说不出的画图标 —— 两形是判别联合,不是带空字段的一形', () => {
    expect(fileGlyphOf('app.ts')).toEqual({ kind: 'brand', brand: 'ts', label: 'TS' })
    expect(fileGlyphOf('main.py')).toEqual({ kind: 'brand', brand: 'py', label: 'PY' })
    expect(fileGlyphOf('init.lua')).toEqual({ kind: 'brand', brand: 'lua', label: 'LUA' })
    expect(fileGlyphOf('build.sh')).toEqual({ kind: 'brand', brand: 'sh', label: 'SH' })
    expect(fileGlyphOf('README.md')).toEqual({ kind: 'brand', brand: 'md', label: 'MD' })
    // JSON 印的是花括号,不是四个字母 —— 那是它在定稿上的画法。
    expect(fileGlyphOf('tsconfig.json')).toEqual({ kind: 'brand', brand: 'json', label: '{ }' })
    expect(fileGlyphOf('a.wasm')).toEqual({ kind: 'brand', brand: 'bin', label: 'BIN' })

    expect(fileGlyphOf('logo.png')).toEqual({ kind: 'icon', icon: 'Image', tone: 'media' })
    expect(fileGlyphOf('dist.tar.gz')).toEqual({ kind: 'icon', icon: 'FileArchive', tone: 'archive' })
    expect(fileGlyphOf('.editorconfig')).toEqual({ kind: 'icon', icon: 'Settings', tone: 'config' })
  })

  it('字标的字由表定一次 —— 同一个 brand 两处取出来逐字相同', () => {
    const a = fileGlyphOf('a.ts')
    const b = fileGlyphOf('b.tsx')
    expect(a).toEqual(b)
  })
})

describe('目录', () => {
  it('合着是 Folder,展开换 FolderOpen —— 两态是两枚图标,不是同一枚转个角度', () => {
    expect(glyphOf('packages', 'directory')).toEqual(DIRECTORY_GLYPH)
    expect(glyphOf('packages', 'directory', true)).toEqual(DIRECTORY_OPEN_GLYPH)
    expect(DIRECTORY_GLYPH).toEqual({ kind: 'icon', icon: 'Folder', tone: 'dir' })
    expect(DIRECTORY_OPEN_GLYPH.icon).toBe('FolderOpen')
  })

  it('目录不看扩展名 —— 一个叫 `assets.ts` 的目录仍然是目录,不画 TS 字标', () => {
    expect(glyphOf('assets.ts', 'directory')).toEqual(DIRECTORY_GLYPH)
  })
})

describe('图标族:同族同形,异族异色', () => {
  it('官方色表上没有的那些语言仍然认得出「这是源码」,只是不冒充字标', () => {
    expect(fileGlyphOf('a.js')).toEqual({ kind: 'icon', icon: 'FileCode', tone: 'js' })
    expect(fileGlyphOf('lib.rs')).toEqual({ kind: 'icon', icon: 'FileCode', tone: 'rust' })
    expect(fileGlyphOf('main.go')).toEqual({ kind: 'icon', icon: 'FileCode', tone: 'go' })
    expect(fileGlyphOf('Main.java')).toEqual({ kind: 'icon', icon: 'FileCode', tone: 'jvm' })
    expect(fileGlyphOf('App.vue')).toEqual({ kind: 'icon', icon: 'FileCode', tone: 'web' })
    expect(fileGlyphOf('main.cpp')).toEqual({ kind: 'icon', icon: 'FileCode', tone: 'code' })
  })

  it('这几族的色两两不同 —— 「一族一色」如果撞了就不成立了', () => {
    const tones = ['a.js', 'a.rb', 'a.rs', 'a.go', 'a.java', 'a.vue'].map((n) => {
      const glyph = fileGlyphOf(n)
      return glyph.kind === 'icon' ? glyph.tone : glyph.brand
    })
    expect(new Set(tones).size).toBe(tones.length)
  })

  it('非语言族各一枚图标:读物 / 数据 / 表格 / 图 / 声 / 影 / 压缩 / 非 POSIX 脚本', () => {
    expect(fileGlyphOf('notes.txt')).toEqual({ kind: 'icon', icon: 'FileText', tone: 'doc' })
    expect(fileGlyphOf('ci.yaml')).toEqual({ kind: 'icon', icon: 'FileBraces', tone: 'data' })
    expect(fileGlyphOf('Cargo.toml')).toEqual({ kind: 'icon', icon: 'FileBraces', tone: 'data' })
    expect(fileGlyphOf('rows.csv')).toEqual({ kind: 'icon', icon: 'FileSpreadsheet', tone: 'data' })
    expect(fileGlyphOf('logo.svg')).toEqual({ kind: 'icon', icon: 'Image', tone: 'media' })
    expect(fileGlyphOf('bell.mp3')).toEqual({ kind: 'icon', icon: 'FileMusic', tone: 'media' })
    expect(fileGlyphOf('clip.mp4')).toEqual({ kind: 'icon', icon: 'FilePlay', tone: 'media' })
    expect(fileGlyphOf('run.bat')).toEqual({ kind: 'icon', icon: 'FileTerminal', tone: 'shell' })
  })
})

describe('整名优先于扩展名', () => {
  it('锁文件是锁,不是「某种叫 lock 的语言」;package-lock.json 不画 JSON 字标', () => {
    expect(fileGlyphOf('package-lock.json')).toEqual({
      kind: 'icon',
      icon: 'FileLock',
      tone: 'config',
    })
    expect(fileGlyphOf('bun.lock')).toEqual({ kind: 'icon', icon: 'FileLock', tone: 'config' })
    expect(fileGlyphOf('Cargo.lock')).toEqual({ kind: 'icon', icon: 'FileLock', tone: 'config' })
  })

  it('没有扩展名也认得出来的那几个', () => {
    expect(fileGlyphOf('Dockerfile')).toEqual({ kind: 'icon', icon: 'Settings', tone: 'config' })
    expect(fileGlyphOf('Makefile')).toEqual({ kind: 'icon', icon: 'Settings', tone: 'config' })
    expect(fileGlyphOf('LICENSE')).toEqual({ kind: 'icon', icon: 'FileText', tone: 'doc' })
  })

  it('大小写不影响判据', () => {
    expect(fileGlyphOf('DOCKERFILE')).toEqual(fileGlyphOf('dockerfile'))
    expect(fileGlyphOf('Main.PY')).toEqual(fileGlyphOf('main.py'))
  })
})

describe('认不出来的那一格', () => {
  it('没有扩展名 / 扩展名不在表里 = `···` 字标,**不是错误**', () => {
    expect(fileGlyphOf('CHANGELOG')).toEqual(UNKNOWN_FILE_GLYPH)
    expect(fileGlyphOf('data.qqq')).toEqual(UNKNOWN_FILE_GLYPH)
    expect(UNKNOWN_FILE_GLYPH).toEqual({ kind: 'brand', brand: 'unknown', label: '···' })
  })

  it('点开头的隐藏文件没有扩展名 —— `.gitignore` 的 ext 是空串,靠整名表认', () => {
    expect(extensionOf('.gitignore')).toBe('')
    expect(fileGlyphOf('.gitignore')).toEqual({ kind: 'icon', icon: 'Settings', tone: 'config' })
    expect(extensionOf('.zshrc')).toBe('')
    expect(fileGlyphOf('.zshrc')).toEqual(UNKNOWN_FILE_GLYPH)
  })

  it('隐藏文件仍然可以有扩展名(`.eslintrc.json`),那时按扩展名走', () => {
    expect(extensionOf('.eslintrc.json')).toBe('json')
    expect(fileGlyphOf('.eslintrc.json')).toEqual({
      kind: 'brand',
      brand: 'json',
      label: '{ }',
    })
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
    const probes = [
      'a.js', 'a.rb', 'a.rs', 'a.go', 'a.java', 'a.vue', 'a.cpp',
      'a.txt', 'a.yaml', 'a.csv', 'a.png', 'a.mp3', 'a.mp4', 'a.zip', 'a.bat',
      'Dockerfile', 'bun.lock', 'LICENSE',
    ]
    const names = new Set<string>([DIRECTORY_GLYPH.icon, DIRECTORY_OPEN_GLYPH.icon])
    for (const probe of probes) {
      const glyph = fileGlyphOf(probe)
      expect(glyph.kind, `${probe} 该走图标那一形`).toBe('icon')
      if (glyph.kind === 'icon') names.add(glyph.icon)
    }
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

describe('品牌色是数据:值在 tokens.css 的数据节,JS 里一个都没有', () => {
  it('brandVars 交出来的是两条 var() 引用(底色 / 字色成对)', () => {
    for (const name of FILE_BRANDS) {
      const vars = brandVars(name)
      expect(vars).toEqual({ bg: `var(--fb-${name}-bg)`, fg: `var(--fb-${name}-fg)` })
      expect(`${vars.bg}${vars.fg}`).not.toMatch(/#|rgb|hsl/)
    }
  })

  it('每一格 brand 在数据节里**成对**声明 —— 只改一半会让深底配深字', () => {
    for (const name of FILE_BRANDS) {
      expect(tokensCss, `tokens.css 里找不到 --fb-${name}-bg`).toContain(`--fb-${name}-bg:`)
      expect(tokensCss, `tokens.css 里找不到 --fb-${name}-fg`).toContain(`--fb-${name}-fg:`)
    }
  })

  it('数据节里的每一条都是**字面色值**(这是它与 --ft-* 的分水岭),而且不多不少', () => {
    const declared = [...tokensCss.matchAll(/--fb-([a-z]+)-(bg|fg):\s*([^;]+);/g)]
    expect(declared.length).toBe(FILE_BRANDS.length * 2)
    for (const [, name, , value] of declared) {
      expect(FILE_BRANDS).toContain(name as FileBrand)
      // 官方色不过 theme-bridge:它是数据,所以这里就该是一个 hex,不是 var()。
      expect(value.trim(), `--fb-${name} 不是字面色值:${value}`).toMatch(/^#[0-9a-f]{3,8}$/i)
    }
  })
})
