/**
 * `pet:` 自述过契约门,且 §9.3 那几格(单例地址、效果上界、哪几条事件是时刻)照表写着。
 */
import { describe, expect, it } from 'vitest'
import { describeResourceSpecProblem } from '@onething/core/resource'
import { PetRegistry, BUILTIN_PETS } from '../registry.js'
import { PET_CURRENT_REF, petResourceSpec } from '../resource-spec.js'

describe('pet resource spec', () => {
  it('passes the resource contract', () => {
    expect(describeResourceSpecProblem(petResourceSpec)).toBeNull()
    expect(PET_CURRENT_REF).toBe('pet:current')
  })

  it('declares the §9.3 effects and moments', () => {
    expect(petResourceSpec.ops.adopt.effects).toEqual(['ui_change'])
    expect(petResourceSpec.ops.say.effects).toEqual(['ui_change'])
    expect(petResourceSpec.ops.poke.effects).toEqual([])
    expect(petResourceSpec.ops.stroke.effects).toEqual([])
    expect(petResourceSpec.events.poked.moment?.weight).toBe('low')
    expect(petResourceSpec.events.stroked.moment?.weight).toBe('low')
    expect(petResourceSpec.events.utterance.moment).toBeUndefined()
    expect(petResourceSpec.events.hushed.moment).toBeUndefined()
  })

  it('the builtin roster starts with heidou, matching the shell rig id', () => {
    const roster = new PetRegistry()
    expect(roster.fallback()).toMatchObject({ id: 'heidou', rig: 'heidou-svg' })
    expect(() => new PetRegistry([...BUILTIN_PETS, ...BUILTIN_PETS])).toThrow('heidou')
  })
})
