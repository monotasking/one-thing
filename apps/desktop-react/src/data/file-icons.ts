/**
 * 文件名 → **这一行画什么**。一张纯表,一个纯函数,不 import React、不 import
 * lucide —— 所以它能被单测逐条钉死,而渲染层只负责把交出来的名字兑成组件与变量。
 *
 * ── 二形(08-31 定稿改判)────────────────────────────────────────────────────
 * 从前只有一形(lucide 图标 + 类型色),而 lucide 没有语言 logo:一屏里 `.ts`、
 * `.py`、`.lua` 全是同一张「带尖括号的纸」,只有色相差别 —— 扫的时候读不出是哪门。
 * 定稿把它拆成**两种形**,判据是「这一格说得出语言吗」:
 *
 *  ① **brand —— 语言品牌字标**。一小块底色 + 二三个大写字母(`TS` / `PY` / `LUA`
 *     / `SH` / `MD`),JSON 画 `{ }`,二进制画 `BIN`,认不出的画 `···`。
 *     底色取该语言的**官方标识色**(值在 `styles/tokens.css` 的「数据节」里,
 *     那一节注明了它为什么不过 theme-bridge:官方色是数据,不是主题)。
 *     字标只在那一小块里染色,**不外溢到名字**。
 *  ② **icon —— lucide 族图标**。给**说不出语言**的那些:目录、图片、压缩包、
 *     配置,以及有语言但官方色表里没有它的那些(它们仍然是 FileCode + 类型色
 *     —— 「这是源码」认得出来,只是「是哪一门」这台不装懂,同 `langOfPath`
 *     认不出就退素文本的口径)。
 *
 * 两形是**判别联合**,不是一个带空字段的结构:消费方 `switch (glyph.kind)`,
 * 不会有「brand 却去读 icon」这种半空对象。
 * ──────────────────────────────────────────────────────────────────────────
 *
 * ── 两级判据:先整名,后扩展名 ─────────────────────────────────────────────
 * 有一批文件**没有扩展名或扩展名说不了话**:`Dockerfile` / `Makefile` /
 * `bun.lock` / `.gitignore` —— 它们靠整个文件名认。所以查表分两级:整名(小写)
 * 优先,扩展名兜底,都不中 = `···` 字标(**这不是错误**,是这台不认识它)。
 *
 * ── 色的复用规矩(只管 icon 那一形)──────────────────────────────────────────
 * 色板只有七八个能拉开的色相,而族比色多。规矩是:**图标是第一判据,色是第二判据**
 * —— 同一个色允许在**不同图标族**之间复用(压缩包与 rust 都是琥珀,但一个是
 * FileArchive 一个是 FileCode,不会看混),同一个图标族里的两个语言必须换色。
 */

/**
 * 类型色的名字(icon 那一形专用)。每一格在 `styles/tokens.css` 里有且只有一条
 * `--ft-<tone>` ——`file-icons.test.ts` 逐条比对这两处,少一条当场红。
 */
export type FileTone =
  | 'dir'
  | 'js'
  | 'py'
  | 'rb'
  | 'rust'
  | 'go'
  | 'jvm'
  | 'lua'
  | 'web'
  | 'shell'
  | 'data'
  | 'media'
  | 'archive'
  | 'doc'
  | 'config'
  | 'code'
  | 'plain'

/** tone 的全集。测试与将来的色板校验都读它,不许再手抄一份。 */
export const FILE_TONES: readonly FileTone[] = [
  'dir',
  'js',
  'py',
  'rb',
  'rust',
  'go',
  'jvm',
  'lua',
  'web',
  'shell',
  'data',
  'media',
  'archive',
  'doc',
  'config',
  'code',
  'plain',
]

/**
 * 字标的名字。每一格在 `styles/tokens.css` 的**数据节**里有且只有一对
 * `--fb-<brand>-bg` / `--fb-<brand>-fg`(前景与背景成对给,不让消费方自己算对比度)。
 */
export type FileBrand = 'lua' | 'ts' | 'py' | 'sh' | 'md' | 'json' | 'bin' | 'unknown'

export const FILE_BRANDS: readonly FileBrand[] = [
  'lua',
  'ts',
  'py',
  'sh',
  'md',
  'json',
  'bin',
  'unknown',
]

/**
 * 字标上印的那几个字。**它们是符号不是文案**(与详情面那道缺席破折号 `—`、
 * 与 formatBytes 的单位符号同一条口径):换一门语言 `TS` 也还是 `TS`,
 * 所以它们不进字典。
 */
const BRAND_LABELS: Record<FileBrand, string> = {
  lua: 'LUA',
  ts: 'TS',
  py: 'PY',
  sh: 'SH',
  md: 'MD',
  json: '{ }',
  bin: 'BIN',
  unknown: '···',
}

export interface BrandGlyph {
  kind: 'brand'
  brand: FileBrand
  /** 印在字标上的字(由 BRAND_LABELS 定一次,消费方不许自己拼)。 */
  label: string
}

export interface IconGlyph {
  kind: 'icon'
  /** `components/icons.ts` REGISTRY 的键。 */
  icon: string
  tone: FileTone
}

export type FileGlyph = BrandGlyph | IconGlyph

function brand(name: FileBrand): BrandGlyph {
  return { kind: 'brand', brand: name, label: BRAND_LABELS[name] }
}

function icon(name: string, tone: FileTone): IconGlyph {
  return { kind: 'icon', icon: name, tone }
}

/** 目录:合着一枚 Folder,展开换 FolderOpen。色是 accent —— 目录在树里是路标。 */
export const DIRECTORY_GLYPH: IconGlyph = icon('Folder', 'dir')
export const DIRECTORY_OPEN_GLYPH: IconGlyph = icon('FolderOpen', 'dir')

/** 认不出的那一格。画 `···` 而不是留白 —— 留白读成「渲染坏了」。 */
export const UNKNOWN_FILE_GLYPH: BrandGlyph = brand('unknown')

/**
 * 第一级:整个文件名(已小写)。锁文件 / 构建脚本 / 点开头的配置 —— 这些靠扩展名
 * 认不出来,或者认出来会说错话(`bun.lock` 的扩展名是 `lock`,不是某种语言)。
 */
const BY_NAME: Record<string, FileGlyph> = {
  dockerfile: icon('Settings', 'config'),
  makefile: icon('Settings', 'config'),
  procfile: icon('Settings', 'config'),
  'package-lock.json': icon('FileLock', 'config'),
  'bun.lock': icon('FileLock', 'config'),
  'bun.lockb': icon('FileLock', 'config'),
  'yarn.lock': icon('FileLock', 'config'),
  'pnpm-lock.yaml': icon('FileLock', 'config'),
  'cargo.lock': icon('FileLock', 'config'),
  'poetry.lock': icon('FileLock', 'config'),
  'gemfile.lock': icon('FileLock', 'config'),
  'composer.lock': icon('FileLock', 'config'),
  '.gitignore': icon('Settings', 'config'),
  '.gitattributes': icon('Settings', 'config'),
  '.dockerignore': icon('Settings', 'config'),
  '.editorconfig': icon('Settings', 'config'),
  '.npmrc': icon('Settings', 'config'),
  '.nvmrc': icon('Settings', 'config'),
  '.env': icon('Settings', 'config'),
  license: icon('FileText', 'doc'),
  licence: icon('FileText', 'doc'),
}

/**
 * 第二级:扩展名(已小写,不含点)。
 * 一族一行,行内的成员共享同一形 —— 「同族一形」这条规矩在这里读得出来。
 */
const BY_EXT: Record<string, FileGlyph> = {}

function family(glyph: FileGlyph, exts: readonly string[]): void {
  for (const ext of exts) BY_EXT[ext] = glyph
}

/*
 * ── 字标族:官方色表上有名有姓的那几门 ─────────────────────────────────────
 * 这张表**只列定稿点名的那几格**。别的语言不硬凑一个「差不多的色」:
 * 官方色是数据,编一个出来就是假数据(留账见文件尾)。
 */
family(brand('ts'), ['ts', 'tsx', 'mts', 'cts'])
family(brand('py'), ['py', 'pyi', 'pyw'])
family(brand('lua'), ['lua'])
family(brand('md'), ['md', 'markdown', 'mdx'])
family(brand('json'), ['json', 'jsonc', 'json5'])
/* POSIX shell 归 SH;ps1 / bat / cmd 不是它,走终端图标(见下)。 */
family(brand('sh'), ['sh', 'bash', 'zsh', 'fish'])
/* 二进制:打开也看不成文本,字标先把这件事说在前面。 */
family(brand('bin'), [
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'wasm', 'class', 'pyc', 'node',
])

/*
 * ── 图标族:说不出语言的那些 + 官方色表上没有的语言 ────────────────────────
 * 代码族仍按语言族分色:「这是源码」认得出来,「是哪一门」由色相提示,
 * 但不冒充一枚官方字标。
 */
family(icon('FileCode', 'js'), ['js', 'jsx', 'mjs', 'cjs'])
family(icon('FileCode', 'rb'), ['rb', 'erb', 'rake', 'gemspec'])
family(icon('FileCode', 'rust'), ['rs'])
family(icon('FileCode', 'go'), ['go'])
family(icon('FileCode', 'jvm'), ['java', 'kt', 'kts', 'scala', 'groovy'])
/* 网页与样式:模板与样式表是同一件事的两面,合一族。 */
family(icon('FileCode', 'web'), [
  'html', 'htm', 'vue', 'svelte', 'astro', 'css', 'scss', 'sass', 'less',
])
family(icon('FileCode', 'code'), [
  'c', 'h', 'cpp', 'cxx', 'cc', 'hpp', 'hh', 'm', 'mm',
  'php', 'swift', 'cs', 'dart', 'ex', 'exs', 'erl', 'hs', 'ml',
  'pl', 'r', 'jl', 'sql', 'zig', 'nim', 'vim', 'el', 'proto',
  'graphql', 'gql', 'diff', 'patch',
])

/* 非 POSIX 的脚本:图标换成终端 —— 它不是「读的源码」,是「跑的东西」。 */
family(icon('FileTerminal', 'shell'), ['ps1', 'bat', 'cmd'])

/* 结构化数据(json 已经进字标族了)。表格类换 FileSpreadsheet,同族同色。 */
family(icon('FileBraces', 'data'), ['yaml', 'yml', 'toml', 'xml', 'plist', 'ini', 'conf', 'cfg'])
family(icon('FileSpreadsheet', 'data'), ['csv', 'tsv', 'xls', 'xlsx'])

/* 读物(md 已经进字标族了)。 */
family(icon('FileText', 'doc'), ['txt', 'text', 'rst', 'adoc', 'org', 'pdf'])

/* 媒体:三种图标一个色 —— 图标已经把「图 / 声 / 影」分开了。图取 Image(定稿点名)。 */
family(icon('Image', 'media'), [
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'ico', 'bmp', 'tif', 'tiff',
])
family(icon('FileMusic', 'media'), ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'])
family(icon('FilePlay', 'media'), ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'])

/* 压缩包。 */
family(icon('FileArchive', 'archive'), ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst'])

/* 配置族里靠扩展名认得出来的那几个(整名表管不过来的长尾)。 */
family(icon('Settings', 'config'), ['lock', 'properties', 'env'])

/**
 * 隐藏文件:`.` 开头(`.` / `..` 不算 —— 那是路径语法不是文件)。
 * 树上整行淡显靠它,不靠正则散在组件里。
 */
export function isHiddenName(name: string): boolean {
  return name.startsWith('.') && name !== '.' && name !== '..'
}

/** 扩展名(小写,不含点)。没有扩展名、或点在头一位(隐藏文件)= 没有扩展名。 */
export function extensionOf(name: string): string {
  const at = name.lastIndexOf('.')
  if (at <= 0) return ''
  return name.slice(at + 1).toLowerCase()
}

/** 一个文件该画什么。整名优先,扩展名兜底,都不中回 `···` 字标。 */
export function fileGlyphOf(name: string): FileGlyph {
  const byName = BY_NAME[name.toLowerCase()]
  if (byName) return byName
  const ext = extensionOf(name)
  if (!ext) return UNKNOWN_FILE_GLYPH
  return BY_EXT[ext] ?? UNKNOWN_FILE_GLYPH
}

/**
 * 树上一行(或详情浮层上那枚大标)该画什么。目录与文件在这里合流,
 * 所以调用方一处判据都不用自己写。
 */
export function glyphOf(
  name: string,
  type: 'file' | 'directory',
  expanded = false,
): FileGlyph {
  if (type === 'directory') return expanded ? DIRECTORY_OPEN_GLYPH : DIRECTORY_GLYPH
  return fileGlyphOf(name)
}

/** tone → CSS 变量引用。色值一个都不在 JS 里。 */
export function toneVar(tone: FileTone): string {
  return `var(--ft-${tone})`
}

/**
 * brand → 那一对 CSS 变量引用(底色 / 字色)。同样,**色值一个都不在 JS 里** ——
 * 官方色的字面值只在 tokens.css 的数据节里出现一次。
 */
export function brandVars(name: FileBrand): { bg: string; fg: string } {
  return { bg: `var(--fb-${name}-bg)`, fg: `var(--fb-${name}-fg)` }
}

/**
 * ── 留账:字标族只有八格 ────────────────────────────────────────────────────
 * Go / Rust / Ruby / Java / Vue 这些都有自己的官方色,但定稿只点名了八格。
 * 补进来是**扩数据表**(要逐条核对官方色,属拍板件),所以本批不补:它们照旧走
 * 「FileCode + 类型色」那一形,不冒充字标,也不编一个近似色。
 */
