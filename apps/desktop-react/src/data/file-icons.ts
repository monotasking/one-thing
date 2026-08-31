/**
 * 文件名 → 图标 + 类型色。**一张纯表,一个纯函数**,不 import React、不 import
 * lucide —— 所以它能被单测逐条钉死,而渲染层只负责把这两个字符串兑成组件与颜色。
 *
 * ── 为什么是「名字」不是组件 ────────────────────────────────────────────────
 * `icon` 是 `components/icons.ts` 那张 REGISTRY 的**键**(与 items 表写图标名同一条
 * 判例):这张表将来可以来自 JSON / 后端而不牵动渲染层,单测也不必把 lucide 拖进来。
 * `tone` 同理是**色的名字**,不是色值 —— 值只在 `styles/tokens.css` 的
 * 「文件类型色板」一节出现一次,从既有色系(--ws-* / --face-g* / --text-*)推导。
 * 组件里一个字面色值都没有。
 *
 * ── 两级判据:先整名,后扩展名 ─────────────────────────────────────────────
 * 有一批文件**没有扩展名或扩展名说不了话**:`Dockerfile` / `Makefile` /
 * `bun.lock` / `.gitignore` —— 它们靠整个文件名认。所以查表分两级:整名(小写)
 * 优先,扩展名兜底,都不中 = `File` + `plain`(**这不是错误**,是这台不认识它,
 * 与 files-source 的 `langOfPath` 认不出就退素文本同一条口径)。
 *
 * ── 色的复用规矩 ──────────────────────────────────────────────────────────
 * 色板只有七八个能拉开的色相,而族比色多。规矩是:**图标是第一判据,色是第二判据**
 * —— 同一个色允许在**不同图标族**之间复用(压缩包与 rust 都是琥珀,但一个是
 * FileArchive 一个是 FileCode,不会看混),同一个图标族里的两个语言必须换色。
 *
 * ── 留账:没有 per-language 品牌标 ──────────────────────────────────────────
 * lucide 没有 TS 蓝方块 / Python 双蛇那种**语言 logo**,它只有通用的
 * 「带尖括号的纸」。要真 logo 得 vendor 一套 MIT 协议的 SVG 资产进仓(离线自包是
 * 可行的,壳的字体已经是这么办的),但那是**引入资产**,属拍板件,本批不做。
 * 今天的分辨力全靠「图标族 × 类型色」这两维。
 */

/**
 * 类型色的名字。每一格在 `styles/tokens.css` 里有且只有一条 `--ft-<tone>`
 * ——`file-icons.test.ts` 逐条比对这两处,少一条当场红。
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

export interface FileIconSpec {
  /** `components/icons.ts` REGISTRY 的键。 */
  icon: string
  tone: FileTone
}

/** 目录:合着一枚 Folder,展开换 FolderOpen。色是 accent —— 目录在树里是路标。 */
export const DIRECTORY_ICON: FileIconSpec = { icon: 'Folder', tone: 'dir' }
export const DIRECTORY_OPEN_ICON: FileIconSpec = { icon: 'FolderOpen', tone: 'dir' }

/** 认不出的那一格。 */
export const UNKNOWN_FILE_ICON: FileIconSpec = { icon: 'File', tone: 'plain' }

/**
 * 第一级:整个文件名(已小写)。锁文件 / 构建脚本 / 点开头的配置 —— 这些靠扩展名
 * 认不出来,或者认出来会说错话(`bun.lock` 的扩展名是 `lock`,不是某种语言)。
 */
const BY_NAME: Record<string, FileIconSpec> = {
  dockerfile: { icon: 'FileCog', tone: 'config' },
  makefile: { icon: 'FileCog', tone: 'config' },
  procfile: { icon: 'FileCog', tone: 'config' },
  'package-lock.json': { icon: 'FileLock', tone: 'config' },
  'bun.lock': { icon: 'FileLock', tone: 'config' },
  'bun.lockb': { icon: 'FileLock', tone: 'config' },
  'yarn.lock': { icon: 'FileLock', tone: 'config' },
  'pnpm-lock.yaml': { icon: 'FileLock', tone: 'config' },
  'cargo.lock': { icon: 'FileLock', tone: 'config' },
  'poetry.lock': { icon: 'FileLock', tone: 'config' },
  'gemfile.lock': { icon: 'FileLock', tone: 'config' },
  'composer.lock': { icon: 'FileLock', tone: 'config' },
  '.gitignore': { icon: 'FileCog', tone: 'config' },
  '.gitattributes': { icon: 'FileCog', tone: 'config' },
  '.dockerignore': { icon: 'FileCog', tone: 'config' },
  '.editorconfig': { icon: 'FileCog', tone: 'config' },
  '.npmrc': { icon: 'FileCog', tone: 'config' },
  '.nvmrc': { icon: 'FileCog', tone: 'config' },
  '.env': { icon: 'FileCog', tone: 'config' },
  license: { icon: 'FileText', tone: 'doc' },
  licence: { icon: 'FileText', tone: 'doc' },
}

/**
 * 第二级:扩展名(已小写,不含点)。
 * 一族一行,行内的成员共享图标与色 —— 「同族一色」这条规矩在这里读得出来。
 */
const BY_EXT: Record<string, FileIconSpec> = {}

function family(icon: string, tone: FileTone, exts: readonly string[]): void {
  for (const ext of exts) BY_EXT[ext] = { icon, tone }
}

/* 代码族:按语言族分色。 */
family('FileCode', 'js', ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'])
family('FileCode', 'py', ['py', 'pyi', 'pyw'])
family('FileCode', 'rb', ['rb', 'erb', 'rake', 'gemspec'])
family('FileCode', 'rust', ['rs'])
family('FileCode', 'go', ['go'])
family('FileCode', 'jvm', ['java', 'kt', 'kts', 'scala', 'groovy'])
family('FileCode', 'lua', ['lua'])
/* 网页与样式:模板与样式表是同一件事的两面,合一族。 */
family('FileCode', 'web', ['html', 'htm', 'vue', 'svelte', 'astro', 'css', 'scss', 'sass', 'less'])
/*
 * 代码族兜底:有语言但色板上没给它单独一格的那些。它们仍然是 FileCode ——
 * 「这是源码」这件事认得出来,只是「是哪一门」这台不装懂。
 */
family('FileCode', 'code', [
  'c', 'h', 'cpp', 'cxx', 'cc', 'hpp', 'hh', 'm', 'mm',
  'php', 'swift', 'cs', 'dart', 'ex', 'exs', 'erl', 'hs', 'ml',
  'pl', 'r', 'jl', 'sql', 'zig', 'nim', 'vim', 'el', 'proto',
  'graphql', 'gql', 'diff', 'patch',
])

/* 脚本:图标换成终端 —— 它不是「读的源码」,是「跑的东西」。 */
family('FileTerminal', 'shell', ['sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd'])

/* 结构化数据。表格类换 FileSpreadsheet,同族同色。 */
family('FileBraces', 'data', [
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'xml', 'plist', 'ini', 'conf', 'cfg',
])
family('FileSpreadsheet', 'data', ['csv', 'tsv', 'xls', 'xlsx'])

/* 读物。 */
family('FileText', 'doc', ['md', 'markdown', 'mdx', 'txt', 'text', 'rst', 'adoc', 'org', 'pdf'])

/* 媒体:三种图标一个色 —— 图标已经把「图 / 声 / 影」分开了。 */
family('FileImage', 'media', ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'ico', 'bmp', 'tif', 'tiff'])
family('FileMusic', 'media', ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'])
family('FilePlay', 'media', ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'])

/* 压缩包。 */
family('FileArchive', 'archive', ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst'])

/* 配置族里靠扩展名认得出来的那几个(整名表管不过来的长尾)。 */
family('FileCog', 'config', ['lock', 'properties', 'env'])

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

/** 一个文件该画什么。整名优先,扩展名兜底,都不中回 `File` + `plain`。 */
export function fileIconOf(name: string): FileIconSpec {
  const byName = BY_NAME[name.toLowerCase()]
  if (byName) return byName
  const ext = extensionOf(name)
  if (!ext) return UNKNOWN_FILE_ICON
  return BY_EXT[ext] ?? UNKNOWN_FILE_ICON
}

/**
 * 树上一行(或详情面上那枚大图标)该画什么。目录与文件在这里合流,
 * 所以调用方一处判据都不用自己写。
 */
export function iconSpecOf(
  name: string,
  type: 'file' | 'directory',
  expanded = false,
): FileIconSpec {
  if (type === 'directory') return expanded ? DIRECTORY_OPEN_ICON : DIRECTORY_ICON
  return fileIconOf(name)
}

/** tone → CSS 变量引用。色值一个都不在 JS 里。 */
export function toneVar(tone: FileTone): string {
  return `var(--ft-${tone})`
}
