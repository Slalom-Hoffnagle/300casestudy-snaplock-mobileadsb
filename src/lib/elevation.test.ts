import { describe, expect, it } from 'vitest'
import {
  resolveObserverElevation,
  selectAircraftAltitude,
  solveElevation,
  sphericalElevationDegrees,
  type ObserverElevation,
} from './elevation'

const terrainObserver: ObserverElevation = {
  meters: 500,
  datum: 'msl',
  source: 'terrain',
  confidence: 'medium',
  accuracyMeters: 30,
  timestamp: 1,
}

describe('observer and aircraft altitude selection', () => {
  it('prefers a fresh accurate GPS altitude over terrain', () => {
    const observer = resolveObserverElevation({ gpsMeters: 120, gpsAccuracyMeters: 10, gpsTimestamp: 1000, terrainMeters: 95, now: 1500 })
    expect(observer.source).toBe('gps')
    expect(observer.datum).toBe('wgs84-ellipsoid')
  })

  it('falls back to terrain instead of assuming sea level', () => {
    const observer = resolveObserverElevation({ gpsMeters: null, gpsAccuracyMeters: null, gpsTimestamp: 1000, terrainMeters: 820, terrainTimestamp: 900, now: 1500 })
    expect(observer.source).toBe('terrain')
    expect(observer.meters).toBe(820)
  })

  it('prefers geometric altitude with WGS84 GPS and barometric with terrain', () => {
    const gpsObserver = resolveObserverElevation({ gpsMeters: 100, gpsAccuracyMeters: 10, gpsTimestamp: 1000, now: 1000 })
    expect(selectAircraftAltitude({ altGeomFeet: 10_100, altBaroFeet: 10_000 }, gpsObserver).source).toBe('geometric')
    expect(selectAircraftAltitude({ altGeomFeet: 10_100, altBaroFeet: 10_000 }, terrainObserver).source).toBe('barometric')
  })
})

describe('curvature-aware elevation', () => {
  it('places equal-height distant targets below the geometric horizon', () => {
    expect(sphericalElevationDegrees(50_000, 100, 100)).toBeLessThan(0)
  })

  it('refraction reduces curvature depression without reversing it', () => {
    const geometric = sphericalElevationDegrees(50_000, 100, 100)
    const apparent = sphericalElevationDegrees(50_000, 100, 100, 0.13)
    expect(apparent).toBeGreaterThan(geometric)
    expect(apparent).toBeLessThan(0)
  })

  it('keeps a cruising aircraft above a high observer', () => {
    const target = selectAircraftAltitude({ altGeomFeet: null, altBaroFeet: 35_000 }, terrainObserver)
    const solution = solveElevation(50_000, terrainObserver, target)
    expect(solution.apparentDegrees).toBeGreaterThan(0)
  })

  it('keeps aircraft below a mountain observer as a valid negative angle', () => {
    const target = selectAircraftAltitude({ altGeomFeet: null, altBaroFeet: 1_000 }, terrainObserver)
    const solution = solveElevation(10_000, terrainObserver, target)
    expect(solution.apparentDegrees).toBeLessThan(0)
  })

  it('returns unavailable rather than false precision without observer elevation', () => {
    const observer = resolveObserverElevation({ gpsMeters: null, terrainMeters: null })
    const target = selectAircraftAltitude({ altGeomFeet: 10_000, altBaroFeet: 10_000 }, observer)
    expect(solveElevation(10_000, observer, target).apparentDegrees).toBeNull()
  })
})
