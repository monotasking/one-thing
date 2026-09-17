import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ARM_END_DEG,
  ARM_LENGTH,
  ARM_PIVOT,
  ARM_START_DEG,
  LABEL_ARC_LENGTH,
  LABEL_FONT,
  LABEL_TRACKING,
  NEEDLE_END_R,
  NEEDLE_START_R,
  RECORD_CENTER,
  SCENE_CROP,
  SCENE_CROP_BELOW,
  SCENE_H,
  SCENE_MAX_SCALE,
  SCENE_W,
  angleAtScenePoint,
  angleForNeedleRadius,
  angleForProgress,
  arcLabelText,
  clientToScene,
  needleRadiusAt,
  progressForAngle,
  sceneToContainer,
  sceneViewport,
  sleeveColorsFor,
} from '../scene-geometry'

const RAD = Math.PI / 180

/** 唱臂在 `deg` 时唱针落在画布的哪一点(测试自己算一遍,不借被测函数)。 */
function needlePoint(deg: number) {
  return { x: ARM_PIVOT.x - ARM_LENGTH * Math.sin(deg * RAD), y: ARM_PIVOT.y + ARM_LENGTH * Math.cos(deg * RAD) }
}

describe('唱针几何', () => {
  it('圆心是唱片那一格的中心', () => {
    expect(RECORD_CENTER).toEqual({ x: 250, y: 280 })
  })

  it('开头落在外圈 112、结尾落在内圈 60(二分误差 < 0.01px)', () => {
    expect(needleRadiusAt(ARM_START_DEG)).toBeCloseTo(NEEDLE_START_R, 2)
    expect(needleRadiusAt(ARM_END_DEG)).toBeCloseTo(NEEDLE_END_R, 2)
    // 越往里转角度越大
    expect(ARM_END_DEG).toBeGreaterThan(ARM_START_DEG)
    expect(ARM_START_DEG).toBeGreaterThan(0)
  })

  it('半径 → 角度 → 半径 是同一个数', () => {
    for (const r of [60, 75, 90, 112]) expect(needleRadiusAt(angleForNeedleRadius(r))).toBeCloseTo(r, 2)
  })

  it('进度 → 角度 → 进度 是同一个数;两头夹住;非数当开头', () => {
    for (const p of [0, 0.25, 0.5, 0.9, 1]) expect(progressForAngle(angleForProgress(p))).toBeCloseTo(p, 3)
    expect(angleForProgress(-1)).toBeCloseTo(ARM_START_DEG, 6)
    expect(angleForProgress(2)).toBeCloseTo(ARM_END_DEG, 6)
    expect(angleForProgress(Number.NaN)).toBeCloseTo(ARM_START_DEG, 6)
    expect(progressForAngle(0)).toBe(0)
    expect(progressForAngle(ARM_END_DEG + 2)).toBe(1)
  })

  it('指针正落在唱针上 → 就是那个角度', () => {
    const deg = angleForProgress(0.4)
    const at = needlePoint(deg)
    expect(angleAtScenePoint(at.x, at.y)).toBeCloseTo(deg, 6)
  })

  it('指针拖出唱片 → 夹在开头与结尾之间', () => {
    // 轴心正下方(0°)在开头之外
    expect(angleAtScenePoint(ARM_PIVOT.x, ARM_PIVOT.y + 100)).toBe(ARM_START_DEG)
    // 拖到唱片左边很远
    expect(angleAtScenePoint(0, ARM_PIVOT.y)).toBe(ARM_END_DEG)
  })
})

describe('视口', () => {
  it('还没布局 → 原大、不裁', () => {
    expect(sceneViewport(0)).toEqual({ viewX: 0, scale: 1, offsetX: 0, height: SCENE_H, cropped: false })
  })

  it('≥ 520 → 整张画布按宽缩放', () => {
    const view = sceneViewport(600)
    expect(view.cropped).toBe(false)
    expect(view.scale).toBeCloseTo(600 / SCENE_W, 10)
    expect(view.height).toBeCloseTo(SCENE_H * (600 / SCENE_W), 10)
    expect(view.offsetX).toBe(0)
  })

  it('再宽 → 封顶 1.25 倍,两边留墙居中', () => {
    const view = sceneViewport(1000)
    expect(view.scale).toBe(SCENE_MAX_SCALE)
    expect(view.offsetX).toBeCloseTo((1000 - SCENE_W * SCENE_MAX_SCALE) / 2, 10)
    expect(view.height).toBe(SCENE_H * SCENE_MAX_SCALE)
  })

  it('< 520 → 视口从 x=118 起、宽 522、高 400', () => {
    const view = sceneViewport(SCENE_CROP_BELOW - 1)
    expect(view.cropped).toBe(true)
    expect(view.viewX).toBe(118)
    expect(view.scale).toBeCloseTo((SCENE_CROP_BELOW - 1) / SCENE_CROP.w, 10)
    expect(view.height).toBeCloseTo(SCENE_CROP.h * view.scale, 10)
    // 裁切视口右边缘恰好是画布右边缘
    expect(SCENE_CROP.x + SCENE_CROP.w).toBe(SCENE_W)
  })

  it('画布 ↔ 容器 ↔ client 往返是同一点', () => {
    for (const width of [360, 620, 1040]) {
      const view = sceneViewport(width)
      const shown = sceneToContainer(view, 430, 175)
      const back = clientToScene(view, { left: 20, top: 30 }, shown.x + 20, shown.y + 30)
      expect(back.x).toBeCloseTo(430, 6)
      expect(back.y).toBeCloseTo(175, 6)
    }
  })
})

describe('标签那一圈字', () => {
  const width = (text: string) =>
    Array.from(text).reduce((sum, g) => sum + (/[⺀-鿿]/.test(g) ? 1 : 0.6) * LABEL_FONT + LABEL_TRACKING, 0)

  it('短名照印,带转速', () => {
    expect(arcLabelText('雨棚下', '旧电扇')).toBe('雨棚下 · 旧电扇 · 33⅓ RPM · ')
    expect(arcLabelText('Rain', '')).toBe('Rain · 33⅓ RPM · ')
  })

  it('空歌名 → 空串', () => {
    expect(arcLabelText('', '谁')).toBe('')
  })

  it('超量:收成省略号,绕得下一圈', () => {
    const text = arcLabelText('一首名字特别特别特别长的歌用来看看截断', '一位名字也很长的乐队主唱与他的朋友们')
    expect(text).toContain('…')
    expect(text.endsWith(' · 33⅓ RPM · ')).toBe(true)
    expect(width(text)).toBeLessThanOrEqual(LABEL_ARC_LENGTH)
  })
})

describe('封套颜色', () => {
  it('同一首歌永远同一张封套;不同歌名换色', () => {
    expect(sleeveColorsFor('雨棚下 - 旧电扇')).toEqual(sleeveColorsFor('雨棚下 - 旧电扇'))
    expect(sleeveColorsFor('雨棚下 - 旧电扇')).not.toEqual(sleeveColorsFor('慢车 - 林间录音'))
    expect(sleeveColorsFor('x').dark).toMatch(/^hsl\(\d+ 22% 38%\)$/)
  })
})

describe('画布数与 tokens.css 同一对数', () => {
  const tokens = readFileSync(path.resolve(__dirname, '../../../styles/tokens.css'), 'utf-8')
  const px = (name: string) => {
    const m = new RegExp(`${name}\\s*:\\s*([0-9.]+)px\\s*;`).exec(tokens)
    return m ? Number(m[1]) : undefined
  }

  it.each([
    ['--music-scene-w', SCENE_W],
    ['--music-scene-h', SCENE_H],
    ['--music-scene-crop-below', SCENE_CROP_BELOW],
  ])('%s', (name, value) => {
    expect(px(name), `tokens.css 里找不到 ${name}`).toBe(value)
  })

  it('--music-scene-ratio 是画布宽高', () => {
    expect(tokens).toMatch(new RegExp(`--music-scene-ratio:\\s*${SCENE_W} / ${SCENE_H};`))
  })
})
