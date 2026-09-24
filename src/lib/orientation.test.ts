import { describe, expect, it } from 'vitest'
import { deriveCameraOrientation } from './orientation'
import { smoothSignedAngle } from './sensors'

describe('portrait rear-camera orientation', () => {
  it('points north at the horizon for alpha 0, beta 90, gamma 0', () => {
    const orientation = deriveCameraOrientation(0, 90, 0)
    expect(orientation.heading).toBeCloseTo(0, 5)
    expect(orientation.elevation).toBeCloseTo(0, 5)
    expect(orientation.roll).toBeCloseTo(0, 5)
  })

  it('points east at the horizon for alpha 90', () => {
    const orientation = deriveCameraOrientation(90, 90, 0)
    expect(orientation.heading).toBeCloseTo(90, 5)
    expect(orientation.elevation).toBeCloseTo(0, 5)
  })

  it('makes skyward rear-camera tilt positive above the horizon', () => {
    expect(deriveCameraOrientation(0, 120, 0).elevation).toBeCloseTo(30, 5)
    expect(deriveCameraOrientation(0, 60, 0).elevation).toBeCloseTo(-30, 5)
  })

  it('keeps horizon elevation stable when Euler gamma changes at gimbal lock', () => {
    const level = deriveCameraOrientation(35, 90, 0)
    const rolledRepresentation = deriveCameraOrientation(55, 90, 20)
    expect(rolledRepresentation.elevation).toBeCloseTo(level.elevation, 5)
    expect(rolledRepresentation.heading).toBeCloseTo(level.heading, 5)
  })

  it('returns finite values near vertical pointing', () => {
    const orientation = deriveCameraOrientation(45, 179.9, 30)
    expect(Number.isFinite(orientation.heading)).toBe(true)
    expect(Number.isFinite(orientation.elevation)).toBe(true)
    expect(Number.isFinite(orientation.roll)).toBe(true)
  })
})

describe('derived roll smoothing', () => {
  it('takes the short path across the signed wrap boundary', () => {
    const result = smoothSignedAngle(179, -179, 0.5)
    expect(Math.abs(result)).toBeCloseTo(180, 5)
  })
})
