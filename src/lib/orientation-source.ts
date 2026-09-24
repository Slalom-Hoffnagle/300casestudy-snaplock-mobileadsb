import { normalizeAngle } from './sensors'

export type HeadingSource = 'webkit-compass' | 'absolute-alpha' | 'relative-alpha'
export type HeadingDatum = 'true' | 'magnetic' | 'relative'

export type WebKitDeviceOrientationEvent = DeviceOrientationEvent & {
  webkitCompassHeading?: number
  webkitCompassAccuracy?: number
}

export type OrientationSample = {
  alpha: number
  beta: number
  gamma: number
  heading: number
  headingAccuracy: number | null
  source: HeadingSource
  datum: HeadingDatum
  timestamp: number
}

const ABSOLUTE_SOURCE_TTL_MS = 3000

export class OrientationSourceAdapter {
  private absoluteSourceSeenAt = 0

  process(event: DeviceOrientationEvent, now = Date.now()): OrientationSample | null {
    if (event.alpha === null || event.beta === null || event.gamma === null) return null
    const webkitEvent = event as WebKitDeviceOrientationEvent
    const webkitHeading = webkitEvent.webkitCompassHeading
    if (typeof webkitHeading === 'number' && Number.isFinite(webkitHeading)) {
      this.absoluteSourceSeenAt = now
      return {
        alpha: event.alpha,
        beta: event.beta,
        gamma: event.gamma,
        heading: normalizeAngle(webkitHeading),
        headingAccuracy: typeof webkitEvent.webkitCompassAccuracy === 'number' ? webkitEvent.webkitCompassAccuracy : null,
        source: 'webkit-compass',
        datum: 'true',
        timestamp: now,
      }
    }

    const absolute = event.type === 'deviceorientationabsolute' || event.absolute === true
    if (absolute) {
      this.absoluteSourceSeenAt = now
      return {
        alpha: event.alpha,
        beta: event.beta,
        gamma: event.gamma,
        heading: normalizeAngle(event.alpha),
        headingAccuracy: null,
        source: 'absolute-alpha',
        datum: 'magnetic',
        timestamp: now,
      }
    }

    if (now - this.absoluteSourceSeenAt < ABSOLUTE_SOURCE_TTL_MS) return null
    return {
      alpha: event.alpha,
      beta: event.beta,
      gamma: event.gamma,
      heading: normalizeAngle(event.alpha),
      headingAccuracy: null,
      source: 'relative-alpha',
      datum: 'relative',
      timestamp: now,
    }
  }

  reset() {
    this.absoluteSourceSeenAt = 0
  }
}

export function resolveTrueHeading(heading: number, datum: HeadingDatum, declination: number) {
  return datum === 'magnetic' ? normalizeAngle(heading + declination) : normalizeAngle(heading)
}
