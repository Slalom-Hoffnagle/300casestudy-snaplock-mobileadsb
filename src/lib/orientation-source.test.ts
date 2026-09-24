import { describe, expect, it } from 'vitest'
import { OrientationSourceAdapter, resolveTrueHeading, type WebKitDeviceOrientationEvent } from './orientation-source'

function event(type: string, values: Partial<WebKitDeviceOrientationEvent>) {
  return { type, alpha: 10, beta: 90, gamma: 0, absolute: false, ...values } as WebKitDeviceOrientationEvent
}

describe('orientation source adapter', () => {
  it('prefers WebKit true heading and accuracy', () => {
    const adapter = new OrientationSourceAdapter()
    const sample = adapter.process(event('deviceorientation', { webkitCompassHeading: 275, webkitCompassAccuracy: 8 }), 1000)
    expect(sample).toMatchObject({ heading: 275, source: 'webkit-compass', datum: 'true', headingAccuracy: 8 })
  })

  it('uses absolute alpha as magnetic heading', () => {
    const adapter = new OrientationSourceAdapter()
    const sample = adapter.process(event('deviceorientationabsolute', { alpha: 80, absolute: true }), 1000)
    expect(sample).toMatchObject({ heading: 80, source: 'absolute-alpha', datum: 'magnetic' })
  })

  it('suppresses relative events while an absolute source is fresh', () => {
    const adapter = new OrientationSourceAdapter()
    adapter.process(event('deviceorientationabsolute', { absolute: true }), 1000)
    expect(adapter.process(event('deviceorientation', { alpha: 220 }), 2000)).toBeNull()
    expect(adapter.process(event('deviceorientation', { alpha: 220 }), 5000)?.source).toBe('relative-alpha')
  })
})

describe('heading datum normalization', () => {
  it('does not add declination to WebKit true heading', () => {
    expect(resolveTrueHeading(100, 'true', 16)).toBe(100)
  })

  it('adds declination exactly once to magnetic alpha', () => {
    expect(resolveTrueHeading(100, 'magnetic', 16)).toBe(116)
  })

  it('leaves relative heading unchanged', () => {
    expect(resolveTrueHeading(100, 'relative', 16)).toBe(100)
  })
})
