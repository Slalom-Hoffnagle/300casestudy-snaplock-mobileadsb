export type SensorReading = {
  heading: number
  pitch: number
  roll: number
  declination: number
  latitude: number | null
  longitude: number | null
}

type DeclinationPoint = {
  latitude: number
  longitude: number
  value: number
}

const declinationTable: DeclinationPoint[] = [
  { latitude: 60, longitude: -120, value: 16 },
  { latitude: 40, longitude: -100, value: 4 },
  { latitude: 25, longitude: -80, value: -6 },
  { latitude: 50, longitude: 0, value: 2 },
  { latitude: 35, longitude: 140, value: -8 },
  { latitude: 0, longitude: 0, value: 0 },
  { latitude: -30, longitude: 20, value: -12 },
  { latitude: -35, longitude: 150, value: 13 },
]

export function normalizeAngle(angle: number) {
  return ((angle % 360) + 360) % 360
}

export function smoothAngle(previous: number | null, next: number, factor = 0.18) {
  if (previous === null) return normalizeAngle(next)
  const delta = ((next - previous + 540) % 360) - 180
  return normalizeAngle(previous + delta * factor)
}

export function smoothLinear(previous: number | null, next: number, factor = 0.18) {
  return previous === null ? next : previous + (next - previous) * factor
}

export function magneticDeclination(latitude: number, longitude: number) {
  let closest = declinationTable[0]
  let closestDistance = Number.POSITIVE_INFINITY

  for (const point of declinationTable) {
    const distance = Math.hypot(point.latitude - latitude, point.longitude - longitude)
    if (distance < closestDistance) {
      closest = point
      closestDistance = distance
    }
  }

  return closest.value
}

export function applyDeclination(magneticHeading: number, declination: number) {
  return normalizeAngle(magneticHeading + declination)
}
