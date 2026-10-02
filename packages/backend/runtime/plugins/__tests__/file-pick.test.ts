/**
 * `file-pick` 节点 + `storage:` 寻址的判据(B 期,用户壁纸)。
 *
 * 钉住的是这一期的**核心裁决**,不是实现细节:
 *  1. accept 只能**收窄** —— 超出宿主白名单的扩展名当场拒;
 *  2. maxBytes 是**钳制**的那一个旋钮(声明更大按硬顶算),别的形状错误照拒;
 *  3. 文件名清洗只留 `[a-zA-Z0-9._-]`,并且**不覆盖**同名旧文件;
 *  4. 拷贝闸(扩展名 / 尺寸)在拷之前就说人话;
 *  5. `storage:` 的路径判据 = 包内资产那一份(穿越 / 绝对 / 编码变体全拒);
 *  6. 运行期换图只走 `storage:`,包内路径在这里止步。
 */
import { describe, it, expect } from 'vitest'
import {
  PLUGIN_FILE_PICK_EXTENSIONS,
  PLUGIN_FILE_PICK_MAX_BYTES,
  PLUGIN_SETTINGS_FILE_IMPORT_FORMAT,
  clampPluginFilePickMaxBytes,
  describePluginFileImportDeclarationProblem,
  describePluginFileImportProblem,
  describePluginFilePickNodeProblem,
  nextAvailablePluginImportFileName,
  resolvePluginFilePickAccept,
  sanitizePluginImportFileName,
} from '../file-pick.js'
import {
  PLUGIN_STORAGE_IMAGE_PREFIX,
  describePluginRuntimeBackgroundImageProblem,
  parsePluginStorageImageRef,
  pluginBackgroundImageUrl,
} from '../background.js'
import { validatePluginPanelTree } from '../panel.js'

function tree(body: unknown): unknown {
  return { version: 2, body }
}

const VALID_NODE = { type: 'file-pick', label: 'Choose wallpaper', actionId: 'picked' }

// ── 1. 节点校验 ─────────────────────────────

describe('file-pick node validation', () => {
  it('accepts the minimal shape', () => {
    expect(validatePluginPanelTree(tree(VALID_NODE))).toBeNull()
  })

  it('requires a label and an actionId (no callbacks — same rule as button)', () => {
    expect(validatePluginPanelTree(tree({ type: 'file-pick', actionId: 'x' })))
      .toMatch(/label must be a non-empty string/)
    expect(validatePluginPanelTree(tree({ type: 'file-pick', label: 'Pick' })))
      .toMatch(/actionId must be a non-empty string/)
  })

  it('narrows accept to a subset of the host whitelist', () => {
    expect(validatePluginPanelTree(tree({ ...VALID_NODE, accept: ['png', 'webp'] }))).toBeNull()
    // 大小写不该变成第二条规矩。
    expect(validatePluginPanelTree(tree({ ...VALID_NODE, accept: ['PNG'] }))).toBeNull()
  })

  it('rejects an accept entry outside the whitelist (accept can only narrow)', () => {
    const problem = validatePluginPanelTree(tree({ ...VALID_NODE, accept: ['png', 'exe'] }))
    expect(problem).toMatch(/"exe" is outside the host whitelist/)
    expect(problem).toMatch(/can only narrow/)
  })

  it('rejects an empty or non-array accept', () => {
    expect(validatePluginPanelTree(tree({ ...VALID_NODE, accept: [] })))
      .toMatch(/accept must be a non-empty array/)
    expect(validatePluginPanelTree(tree({ ...VALID_NODE, accept: 'png' })))
      .toMatch(/accept must be a non-empty array/)
  })

  it('accepts an oversized maxBytes (it is clamped, not rejected) but rejects a nonsense one', () => {
    expect(validatePluginPanelTree(tree({ ...VALID_NODE, maxBytes: 999_000_000 }))).toBeNull()
    expect(validatePluginPanelTree(tree({ ...VALID_NODE, maxBytes: 0 })))
      .toMatch(/maxBytes must be a positive finite number/)
    expect(validatePluginPanelTree(tree({ ...VALID_NODE, maxBytes: 'big' })))
      .toMatch(/maxBytes must be a positive finite number/)
  })

  it('still bans function members inside a file-pick node (constitution #2)', () => {
    expect(validatePluginPanelTree(tree({ ...VALID_NODE, onPick: () => {} })))
      .toMatch(/must be pure data/)
  })
})

// ── 2. accept / maxBytes 的解析与钳制 ───────

describe('file-pick accept & maxBytes resolution', () => {
  it('defaults accept to the full whitelist', () => {
    expect(resolvePluginFilePickAccept(undefined)).toEqual([...PLUGIN_FILE_PICK_EXTENSIONS])
  })

  it('narrows and de-duplicates, dropping anything outside the whitelist', () => {
    expect(resolvePluginFilePickAccept(['PNG', 'png', 'webp'])).toEqual(['png', 'webp'])
    expect(resolvePluginFilePickAccept(['exe'])).toEqual([...PLUGIN_FILE_PICK_EXTENSIONS])
  })

  it('clamps maxBytes at the 10MB host cap', () => {
    expect(clampPluginFilePickMaxBytes(undefined)).toBe(PLUGIN_FILE_PICK_MAX_BYTES)
    expect(clampPluginFilePickMaxBytes(1024)).toBe(1024)
    expect(clampPluginFilePickMaxBytes(PLUGIN_FILE_PICK_MAX_BYTES * 10)).toBe(PLUGIN_FILE_PICK_MAX_BYTES)
    expect(clampPluginFilePickMaxBytes(-1)).toBe(PLUGIN_FILE_PICK_MAX_BYTES)
  })
})

// ── 3. 文件名清洗与防覆盖 ────────────────────

describe('imported file name sanitising', () => {
  it('keeps only [a-zA-Z0-9._-]', () => {
    expect(sanitizePluginImportFileName('My Wallpaper (1).png')).toBe('MyWallpaper1.png')
    expect(sanitizePluginImportFileName('a_b-c.2.PNG')).toBe('a_b-c.2.png')
  })

  it('falls back when the stem washes out entirely (no hidden dotfiles)', () => {
    expect(sanitizePluginImportFileName('壁纸.png')).toBe('import.png')
    expect(sanitizePluginImportFileName('.hidden.png')).toBe('hidden.png')
    expect(sanitizePluginImportFileName('..png')).toBe('import.png')
  })

  it('drops any directory part — the name is a name, never a path', () => {
    expect(sanitizePluginImportFileName('../../etc/passwd.png')).toBe('passwd.png')
    expect(sanitizePluginImportFileName('C:\\secrets\\x.jpg')).toBe('x.jpg')
  })

  it('never overwrites an existing import', () => {
    const taken = new Set(['paper.png', 'paper-2.png'])
    expect(nextAvailablePluginImportFileName('paper.png', name => taken.has(name))).toBe('paper-3.png')
    expect(nextAvailablePluginImportFileName('fresh.png', name => taken.has(name))).toBe('fresh.png')
  })
})

// ── 4. 拷贝闸 ──────────────────────────────

describe('file import gate (extension + size)', () => {
  const base = { accept: ['png', 'webp'], maxBytes: 1024 }

  it('passes a legal file', () => {
    expect(describePluginFileImportProblem({ ...base, name: 'a.png', size: 512 })).toBeNull()
  })

  it('rejects an extension outside the declared accept', () => {
    expect(describePluginFileImportProblem({ ...base, name: 'a.gif', size: 10 }))
      .toMatch(/isn't supported here/)
    expect(describePluginFileImportProblem({ ...base, name: 'noext', size: 10 }))
      .toMatch(/isn't supported here/)
  })

  it('rejects an oversized file and says both numbers', () => {
    const problem = describePluginFileImportProblem({ ...base, name: 'a.png', size: 2048 })
    expect(problem).toMatch(/too large/)
    expect(problem).toMatch(/2 KB/)
    expect(problem).toMatch(/1 KB/)
  })
})

// ── 5. storage: 寻址的路径判据 ────────────────

describe('storage: addressing', () => {
  it('parses a legal ref', () => {
    expect(parsePluginStorageImageRef('storage:imports/paper.png')).toBe('imports/paper.png')
  })

  it('rejects traversal, absolute paths, encoding variants and extra schemes', () => {
    for (const bad of [
      'storage:../../etc/passwd.png',
      'storage:/etc/passwd.png',
      'storage:%2e%2e/x.png',
      'storage:imports/../../x.png',
      'storage:a\\b.png',
      'storage:imports//x.png',
      'storage:https://evil.example/x.png',
    ]) {
      expect(parsePluginStorageImageRef(bad), bad).toBeNull()
    }
  })

  it('rejects a non-image extension inside the data zone', () => {
    expect(parsePluginStorageImageRef('storage:imports/x.html')).toBeNull()
    expect(parsePluginStorageImageRef('storage:imports/x.js')).toBeNull()
  })

  it('routes a storage ref to the data-zone URL and a package path to the code-zone URL', () => {
    expect(pluginBackgroundImageUrl('ink', 'storage:imports/paper.png'))
      .toBe('onething-plugin://ink/__storage__/imports/paper.png')
    expect(pluginBackgroundImageUrl('ink', 'bg/paper.png'))
      .toBe('onething-plugin://ink/bg/paper.png')
  })
})

// ── 6. 运行期换图的值域 ──────────────────────

describe('runtime background image value domain', () => {
  it('accepts a storage ref', () => {
    expect(describePluginRuntimeBackgroundImageProblem('storage:imports/a.png')).toBeNull()
  })

  it('rejects a package-relative path — swapping the shipped image means shipping a version', () => {
    const problem = describePluginRuntimeBackgroundImageProblem('bg/paper.png')
    expect(problem).toMatch(new RegExp(`must start with "${PLUGIN_STORAGE_IMAGE_PREFIX}"`))
    expect(problem).toMatch(/new version/)
  })

  it('rejects empty / non-string / traversal', () => {
    expect(describePluginRuntimeBackgroundImageProblem('')).toMatch(/non-empty string/)
    expect(describePluginRuntimeBackgroundImageProblem(42)).toMatch(/non-empty string/)
    expect(describePluginRuntimeBackgroundImageProblem('storage:../x.png')).toMatch(/".." segments/)
  })
})

/**
 * 设置页 schema 的文件导入声明与面板节点**共用同一份判据**。
 *
 * 抽出来不是为了少写几行:两处各写一份,今天逐字相同,明天白名单变了就只改
 * 一边,得到的是"面板里能导入、设置页说不支持"这种没人能解释的分裂。
 */
describe('file-import declaration — shared by the panel node and the settings schema', () => {
  it('accept can only narrow the host whitelist', () => {
    expect(describePluginFileImportDeclarationProblem({ accept: ['png'] }, '"wallpaper"')).toBeNull()
    expect(describePluginFileImportDeclarationProblem({ accept: ['exe'] }, '"wallpaper"'))
      .toMatch(/outside the host whitelist/)
    expect(describePluginFileImportDeclarationProblem({ accept: [] }, '"wallpaper"'))
      .toMatch(/non-empty array/)
    expect(describePluginFileImportDeclarationProblem({ accept: [''] }, '"wallpaper"'))
      .toMatch(/non-empty strings/)
  })

  it('maxBytes rejects only non-positive shapes — "bigger than the cap" is clamped, not refused', () => {
    expect(describePluginFileImportDeclarationProblem({ maxBytes: 999_000_000 }, '"wallpaper"')).toBeNull()
    expect(describePluginFileImportDeclarationProblem({ maxBytes: 0 }, '"wallpaper"'))
      .toMatch(/positive finite number/)
    expect(clampPluginFilePickMaxBytes(999_000_000)).toBe(PLUGIN_FILE_PICK_MAX_BYTES)
  })

  it('the node validator routes through the very same判据 (one implementation, not two)', () => {
    const node = { label: 'Pick', actionId: 'picked', accept: ['exe'] }
    expect(describePluginFilePickNodeProblem(node, 'panel.body[0]'))
      .toBe(describePluginFileImportDeclarationProblem(node, 'panel.body[0]'))
  })

  it('the settings-schema format value is the one the host advertises', () => {
    expect(PLUGIN_SETTINGS_FILE_IMPORT_FORMAT).toBe('file-import')
  })
})
