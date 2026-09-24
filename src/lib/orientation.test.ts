import { describe, expect, it } from 'vitest'
import { cameraFrameFromAngles, deriveAnchoredCameraFrame, deriveCameraOrientation } from './orientation'
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

describe('anchored camera basis', () => {
  it('anchors heading to the selected compass source while retaining elevation', () => {
    const frame = deriveAnchoredCameraFrame(240, 120, 0, 75)
    expect(frame.heading).toBeCloseTo(75, 5)
    expect(frame.elevation).toBeCloseTo(30, 5)
  })

  it('returns an orthonormal basis', () => {
    const frame = cameraFrameFromAngles(42, 18, 13)
    const dot = (left: typeof frame.forward, right: typeof frame.forward) => left.x * right.x + left.y * right.y + left.z * right.z
    expect(dot(frame.forward, frame.right)).toBeCloseTo(0, 10)
    expect(dot(frame.forward, frame.up)).toBeCloseTo(0, 10)
    expect(dot(frame.right, frame.up)).toBeCloseTo(0, 10)
    expect(Math.hypot(frame.forward.x, frame.forward.y, frame.forward.z)).toBeCloseTo(1, 10)
  })

  it('points camera up toward world up at a level north-facing pose', () => {
    const frame = cameraFrameFromAngles(0, 0, 0)
    expect(frame.forward.x).toBeCloseTo(0, 10)
    expect(frame.forward.y).toBeCloseTo(1, 10)
    expect(frame.forward.z).toBeCloseTo(0, 10)
    expect(frame.right.x).toBeCloseTo(1, 10)
    expect(frame.right.y).toBeCloseTo(0, 10)
    expect(frame.right.z).toBeCloseTo(0, 10)
    expect(frame.up.x).toBeCloseTo(0, 10)
    expect(frame.up.y).toBeCloseTo(0, 10)
    expect(frame.up.z).toBeCloseTo(1, 10)
  })
})
