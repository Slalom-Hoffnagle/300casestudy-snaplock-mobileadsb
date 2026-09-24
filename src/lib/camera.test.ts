import { describe, expect, it } from 'vitest'
import { effectiveCoverFov } from './camera'

describe('camera cover-crop FOV', () => {
  it('preserves FOV when source and viewport aspect ratios match', () => {
    const effective = effectiveCoverFov({ horizontal: 60, vertical: 45 }, 1080, 1920, 360, 640)
    expect(effective.horizontal).toBeCloseTo(60, 10)
    expect(effective.vertical).toBeCloseTo(45, 10)
  })

  it('reduces horizontal FOV when a wide stream is covered into portrait', () => {
    const effective = effectiveCoverFov({ horizontal: 60, vertical: 45 }, 1920, 1080, 390, 844)
    expect(effective.horizontal).toBeLessThan(60)
    expect(effective.vertical).toBeCloseTo(45, 5)
  })

  it('falls back safely when stream dimensions are unknown', () => {
    expect(effectiveCoverFov({ horizontal: 60, vertical: 45 }, null, null, 390, 844)).toEqual({ horizontal: 60, vertical: 45 })
  })
})
