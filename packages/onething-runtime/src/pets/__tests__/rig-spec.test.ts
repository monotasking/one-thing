/**
 * `validateRigSpec`(宠物 P5,正本 §12.6 第一条):每条问题各一例;两只内置宠物零问题。
 */
import { describe, expect, it } from 'vitest'
import { ALU_RIG } from '../builtin/alu.rig.js'
import { petManifestProblems, type PetManifest } from '../manifest.js'
import { BUILTIN_PETS, PetRegistry, PetRigInvalidError } from '../registry.js'
import {
  isRigColor,
  RIG_MAX_PARTS,
  RIG_POSES,
  validateRigSpec,
  type DeclarativeRigSpec,
  type RigPart,
} from '../rig-spec.js'

/** 一份最小合格的形象:一个组、一个圆,嘴各一格。 */
function minimal(): DeclarativeRigSpec {
  return {
    viewBox: [0, 0, 100, 100],
    palette: { ink: '#123', paper: 'rgba(255, 255, 255, 0.5)' },
    parts: [
      { id: 'body', shape: 'group' },
      { id: 'dot', parent: 'body', shape: 'circle', cx: 50, cy: 50, r: 10, fill: 'ink' },
      { id: 'mouthOpen', shape: 'ellipse', cx: 50, cy: 70, rx: 4, ry: 2, fill: 'paper', hidden: true },
    ],
    poses: { sitting: { parts: { body: { motion: 'sway', transform: { translate: [0, 2], rotate: 3, scale: [1, 1.1] } } } } },
    mouth: { closed: ['dot'], talking: ['mouthOpen'] },
    oneShots: { love: 'body' },
  }
}

function withParts(parts: RigPart[]): DeclarativeRigSpec {
  return { ...minimal(), parts, mouth: { closed: [], talking: [] }, poses: {}, oneShots: {} }
}

function paths(spec: unknown): string[] {
  return validateRigSpec(spec).map(problem => problem.path)
}

describe('validateRigSpec', () => {
  it('accepts a minimal well-formed rig', () => {
    expect(validateRigSpec(minimal())).toEqual([])
  })

  it('both builtin pets have zero problems, and both make it into the roster', () => {
    for (const pet of BUILTIN_PETS) expect(petManifestProblems(pet)).toEqual([])
    expect(validateRigSpec(ALU_RIG)).toEqual([])
    expect(new PetRegistry().list().map(pet => pet.id)).toEqual(['heidou', 'alu'])
  })

  it('阿绿 draws all nine poses', () => {
    expect(Object.keys(ALU_RIG.poses).sort()).toEqual([...RIG_POSES].sort())
  })

  it('rejects a non-object', () => {
    expect(paths(null)).toEqual([''])
  })

  it('flags unknown fields at every level', () => {
    expect(paths({ ...minimal(), script: 'alert(1)' })).toEqual(['script'])
    expect(paths(withParts([{ id: 'a', shape: 'circle', cx: 1, cy: 1, r: 1, onclick: 'x' } as unknown as RigPart]))).toEqual(['parts[0].onclick'])
    const poseExtra = { ...minimal(), poses: { sitting: { parts: { body: { style: 'color: red' } } } } }
    expect(paths(poseExtra)).toEqual(['poses.sitting.parts.body.style'])
    const transformExtra = { ...minimal(), poses: { sitting: { parts: { body: { transform: { skew: 3 } } } } } }
    expect(paths(transformExtra)).toEqual(['poses.sitting.parts.body.transform.skew'])
  })

  it('flags colors outside the whitelist', () => {
    expect(paths({ ...minimal(), palette: { ink: 'red', paper: '#fff' } })).toEqual(['palette.ink'])
    expect(paths({ ...minimal(), palette: { ink: 'url(#x)', paper: '#fff' } })).toEqual(['palette.ink'])
    expect(paths({ ...minimal(), palette: { ink: 'rgb(var(--x))', paper: '#fff' } })).toEqual(['palette.ink'])
    expect(isRigColor('#abc')).toBe(true)
    expect(isRigColor('#aabbcc')).toBe(true)
    expect(isRigColor('#aabbccdd')).toBe(false)
    expect(isRigColor('rgb(1, 2, 3)')).toBe(true)
    expect(isRigColor('hsl(1, 2%, 3%)')).toBe(false)
  })

  it('flags a fill that is not a palette name', () => {
    expect(paths(withParts([{ id: 'a', shape: 'circle', cx: 1, cy: 1, r: 1, fill: '#000' }]))).toEqual(['parts[0].fill'])
  })

  it('flags non-path characters in path data', () => {
    expect(paths(withParts([{ id: 'a', shape: 'path', d: 'M0 0 L10 10 Z' }]))).toEqual([])
    expect(paths(withParts([{ id: 'a', shape: 'path', d: 'M0 0"/><script>' }]))).toEqual(['parts[0].d'])
  })

  it('flags an unknown motion', () => {
    const spec = { ...minimal(), poses: { sitting: { parts: { body: { motion: 'moonwalk' } } } } }
    expect(paths(spec)).toEqual(['poses.sitting.parts.body.motion'])
  })

  it('flags an unknown pose name', () => {
    expect(paths({ ...minimal(), poses: { dancing: { parts: {} } } })).toEqual(['poses.dancing'])
  })

  it('flags references to parts that do not exist', () => {
    expect(paths({ ...minimal(), poses: { sitting: { parts: { ghost: { hidden: true } } } } })).toEqual(['poses.sitting.parts.ghost'])
    expect(paths({ ...minimal(), mouth: { closed: ['ghost'], talking: [] } })).toEqual(['mouth.closed[0]'])
    expect(paths({ ...minimal(), oneShots: { love: 'ghost' } })).toEqual(['oneShots.love'])
    expect(paths(withParts([{ id: 'a', shape: 'circle', cx: 1, cy: 1, r: 1, parent: 'ghost' }]))).toEqual(['parts[0].parent'])
  })

  it('flags a parent that is not a group, or that comes later', () => {
    const notGroup = withParts([
      { id: 'a', shape: 'circle', cx: 1, cy: 1, r: 1 },
      { id: 'b', shape: 'circle', cx: 1, cy: 1, r: 1, parent: 'a' },
    ])
    expect(paths(notGroup)).toEqual(['parts[1].parent'])
    const later = withParts([
      { id: 'b', shape: 'circle', cx: 1, cy: 1, r: 1, parent: 'a' },
      { id: 'a', shape: 'group' },
    ])
    expect(paths(later)).toEqual(['parts[0].parent'])
  })

  it('flags nesting deeper than four levels', () => {
    const chain: RigPart[] = [{ id: 'g0', shape: 'group' }]
    for (let depth = 1; depth <= 4; depth += 1) chain.push({ id: `g${depth}`, shape: 'group', parent: `g${depth - 1}` })
    expect(paths(withParts(chain))).toEqual([])
    chain.push({ id: 'g5', shape: 'group', parent: 'g4' })
    expect(paths(withParts(chain))).toEqual(['parts[5].parent'])
  })

  it('flags more than 80 parts', () => {
    const many: RigPart[] = Array.from({ length: RIG_MAX_PARTS + 1 }, (_, i) => ({ id: `p${i}`, shape: 'group' as const }))
    expect(paths(withParts(many))).toEqual(['parts'])
  })

  it('flags a non-positive viewBox', () => {
    expect(paths({ ...minimal(), viewBox: [0, 0, 0, 100] })).toEqual(['viewBox'])
    expect(paths({ ...minimal(), viewBox: [0, 0, 100] })).toEqual(['viewBox'])
  })

  it('flags an unknown shape, missing geometry and geometry that does not apply', () => {
    expect(paths(withParts([{ id: 'a', shape: 'polygon' } as unknown as RigPart]))).toEqual(['parts[0].shape'])
    expect(paths(withParts([{ id: 'a', shape: 'circle', cx: 1, cy: 1 }]))).toEqual(['parts[0].r'])
    expect(paths(withParts([{ id: 'a', shape: 'group', d: 'M0 0' }]))).toEqual(['parts[0].d'])
  })

  it('flags duplicate part ids and unknown one-shots', () => {
    const dup = withParts([{ id: 'a', shape: 'group' }, { id: 'a', shape: 'group' }])
    expect(paths(dup)).toEqual(['parts[1].id'])
    expect(paths({ ...minimal(), oneShots: { explode: 'body' } })).toEqual(['oneShots.explode'])
  })
})

describe('PetRegistry and declarative rigs', () => {
  const broken: PetManifest = {
    id: 'broken',
    name: '坏',
    rig: { ...ALU_RIG, palette: { ...ALU_RIG.palette, green: 'expression(1)' } },
    voice: { pitch: 'low', timbre: 'soft', rate: 'slow' },
    persona: '',
    sample: '',
  }

  it('leaves a pet with a broken rig out of the roster', () => {
    const roster = new PetRegistry([...BUILTIN_PETS, broken])
    expect(roster.get('broken')).toBeNull()
    expect(roster.list()).toHaveLength(BUILTIN_PETS.length)
  })

  it('refuses to register one explicitly', () => {
    expect(() => new PetRegistry().register(broken)).toThrow(PetRigInvalidError)
  })
})
