import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CALIBRATION,
  calibrationIsStale,
  captureHorizon,
  captureTarget,
  fitTwoReferenceHeading,
  parseCalibration,
  validateLandmark,
  type OrientationSample,
} from './calibration'
import { calculatePositions, type PositioningInput } from './positioning'
import { cameraFrameFromAngles } from './orientation'
import { cardinalDirection, getMoonTarget } from './calibration/moon'

function samples(heading: number, pitch: number, roll = 0): OrientationSample[] {
  return Array.from({ length: 15 }, (_, index) => ({
    heading: heading + (index % 2 ? 0.1 : -0.1),
    pitch: pitch + (index % 2 ? 0.1 : -0.1),
    roll,
  }))
}

describe('calibration captures', () => {
  it('captures horizon pitch and roll offsets from stable samples', () => {
    const result = captureHorizon(samples(20, 3, 2))
    expect(result.stable).toBe(true)
    expect(result.pitchOffset).toBeCloseTo(-3, 1)
    expect(result.rollOffset).toBeCloseTo(-2, 1)
  })

  it('rejects unstable horizon samples', () => {
    const unstable = Array.from({ length: 15 }, (_, index) => ({ heading: index * 20, pitch: index, roll: index }))
    expect(captureHorizon(unstable).stable).toBe(false)
  })

  it('handles heading wraparound while aligning a target', () => {
    const result = captureTarget(samples(359, 0), 1, 0)
    expect(result.stable).toBe(true)
    expect(result.headingOffset).toBeCloseTo(2, 1)
  })
})

describe('landmark and persistence validation', () => {
  it('rejects a nearby landmark', () => {
    expect(validateLandmark(47.6, -122.3, 20, 47.6001, -122.3001).valid).toBe(false)
  })

  it('warns when GPS accuracy is limited', () => {
    const result = validateLandmark(47.6, -122.3, 90, 47.62, -122.3)
    expect(result.valid).toBe(true)
    expect(result.confidence).toBe('medium')
  })

  it('parses valid calibration and rejects excessive offsets', () => {
    expect(parseCalibration(JSON.stringify(DEFAULT_CALIBRATION))).not.toBeNull()
    expect(parseCalibration(JSON.stringify({ ...DEFAULT_CALIBRATION, headingOffset: 181 }))).toBeNull()
  })

  it('rejects beta-only calibration offsets from the previous orientation model', () => {
    expect(parseCalibration(JSON.stringify({ ...DEFAULT_CALIBRATION, version: 2 }))).toBeNull()
  })

  it('marks old calibration stale', () => {
    const calibration = { ...DEFAULT_CALIBRATION, calibratedAt: 1 }
    expect(calibrationIsStale(calibration, 24 * 60 * 60 * 1000 + 2)).toBe(true)
  })
})

describe('two-reference heading model', () => {
  it('fits a normal heading convention', () => {
    const result = fitTwoReferenceHeading({ measured: 20, target: 30 }, { measured: 100, target: 110 })
    expect(result).toMatchObject({ valid: true, polarity: 1 })
    expect(result.offset).toBeCloseTo(10, 5)
  })

  it('detects a reversed heading convention', () => {
    const result = fitTwoReferenceHeading({ measured: 10, target: 100 }, { measured: 290, target: 180 })
    expect(result).toMatchObject({ valid: true, polarity: -1 })
    expect(result.offset).toBeCloseTo(110, 5)
  })

  it('rejects opposite references because polarity is ambiguous', () => {
    const result = fitTwoReferenceHeading({ measured: 0, target: 0 }, { measured: 180, target: 180 })
    expect(result.valid).toBe(false)
  })
})

describe('positioning integration', () => {
  it('applies heading calibration before FOV mapping', () => {
    const input: PositioningInput = {
      aircraft: [{ icao24: 'test', callsign: 'TEST', latitude: 1, longitude: 0, altBaro: 10000, altGeom: null, groundSpeed: null, track: null, lastSeen: 0 }],
      user: { latitude: 0, longitude: 0, heading: 10, pitch: 0 },
      viewport: { width: 600, height: 450, horizontalFov: 60, verticalFov: 45 },
      now: 0,
    }
    const uncalibrated = calculatePositions(input).positions[0]
    const calibrated = calculatePositions({ ...input, user: { ...input.user, headingOffset: -10 } }).positions[0]
    expect(Math.abs(calibrated.horizontalOffset)).toBeLessThan(Math.abs(uncalibrated.horizontalOffset))
    expect(calibrated.x).toBeCloseTo(300, 0)
  })

  it('applies roll calibration to projected coordinates', () => {
    const input: PositioningInput = {
      aircraft: [{ icao24: 'east', callsign: 'EAST', latitude: 0, longitude: 0.1, altBaro: 10000, altGeom: null, groundSpeed: null, track: null, lastSeen: 0 }],
      user: { latitude: 0, longitude: 0, heading: 80, pitch: 0, roll: 10 },
      viewport: { width: 600, height: 450, horizontalFov: 60, verticalFov: 45 },
      now: 0,
    }
    const tilted = calculatePositions(input).positions[0]
    const leveled = calculatePositions({ ...input, user: { ...input.user, rollOffset: -10 } }).positions[0]
    expect(leveled.y).not.toBeCloseTo(tilted.y, 0)
  })

  it('keeps horizontal position fixed during pitch-only camera motion', () => {
    const input: PositioningInput = {
      aircraft: [{ icao24: 'north', callsign: 'NORTH', latitude: 0.1, longitude: 0, altBaro: null, altGeom: 10_000, groundSpeed: null, track: null, lastSeen: 0 }],
      user: {
        latitude: 0,
        longitude: 0,
        heading: 0,
        pitch: 0,
        elevationMeters: 0,
        elevationSource: 'gps',
        elevationConfidence: 'high',
        elevationAccuracyMeters: 5,
        elevationTimestamp: 0,
        cameraFrame: cameraFrameFromAngles(0, -10, 0),
      },
      viewport: { width: 600, height: 900, horizontalFov: 60, verticalFov: 45 },
      now: 0,
    }
    const down = calculatePositions(input).positions[0]
    const up = calculatePositions({ ...input, user: { ...input.user, cameraFrame: cameraFrameFromAngles(0, 10, 0) } }).positions[0]
    expect(down.x).toBeCloseTo(300, 5)
    expect(up.x).toBeCloseTo(300, 5)
    expect(down.y).not.toBeCloseTo(up.y, 0)
  })

  it('keeps behind-camera targets finite and out of FOV', () => {
    const input: PositioningInput = {
      aircraft: [{ icao24: 'south', callsign: 'SOUTH', latitude: -0.1, longitude: 0, altBaro: null, altGeom: 10_000, groundSpeed: null, track: null, lastSeen: 0 }],
      user: { latitude: 0, longitude: 0, heading: 0, pitch: 0, elevationMeters: 0, elevationSource: 'gps', elevationConfidence: 'high', elevationAccuracyMeters: 5, elevationTimestamp: 0, cameraFrame: cameraFrameFromAngles(0, 0, 0) },
      viewport: { width: 600, height: 900, horizontalFov: 60, verticalFov: 45 },
      now: 0,
    }
    const position = calculatePositions(input).positions[0]
    expect(position.inFov).toBe(false)
    expect(Number.isFinite(position.edgeX)).toBe(true)
    expect(Number.isFinite(position.edgeY)).toBe(true)
  })
})

describe('Moon calibration target', () => {
  it('returns normalized horizontal coordinates and a physical altitude', () => {
    const moon = getMoonTarget(47.6062, -122.3321, new Date('2026-09-23T06:00:00Z'))
    expect(moon.azimuth).toBeGreaterThanOrEqual(0)
    expect(moon.azimuth).toBeLessThan(360)
    expect(moon.altitude).toBeGreaterThanOrEqual(-90)
    expect(moon.altitude).toBeLessThanOrEqual(90)
    expect(moon.distanceKm).toBeGreaterThan(300000)
  })

  it('formats normalized cardinal directions', () => {
    expect(cardinalDirection(0)).toBe('N')
    expect(cardinalDirection(91)).toBe('E')
    expect(cardinalDirection(359)).toBe('N')
  })
})
