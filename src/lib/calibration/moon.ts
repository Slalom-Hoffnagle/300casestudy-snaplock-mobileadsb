import { getMoonPosition } from 'suncalc'
import { normalizeAngle } from '../positioning'

export type MoonTarget = {
  azimuth: number
  altitude: number
  distanceKm: number
  visible: boolean
  recommended: boolean
  reason: string | null
}

export function getMoonTarget(latitude: number, longitude: number, date = new Date()): MoonTarget {
  const position = getMoonPosition(date, latitude, longitude)
  const altitude = position.altitude
  const azimuth = normalizeAngle(position.azimuth + 180)
  const visible = altitude > 5
  const recommended = altitude >= 15
  return {
    azimuth,
    altitude,
    distanceKm: position.distance,
    visible,
    recommended,
    reason: !visible
      ? 'The Moon is below or too close to the horizon right now.'
      : !recommended
        ? 'The Moon is low in the sky, so alignment may be less precise.'
        : null,
  }
}

export function cardinalDirection(bearing: number) {
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  return directions[Math.round(normalizeAngle(bearing) / 45) % 8]
}
