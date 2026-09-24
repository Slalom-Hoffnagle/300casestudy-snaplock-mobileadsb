import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchNearbyAircraft } from './adsb'

afterEach(() => vi.restoreAllMocks())

describe('ADS-B altitude parsing', () => {
  it('preserves explicit ground state without inventing an altitude', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ac: [{ hex: 'abc123', lat: 47.6, lon: -122.3, alt_baro: 'ground', alt_geom: 450 }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    const result = await fetchNearbyAircraft(47.6, -122.3, 50)
    expect(result).toHaveLength(1)
    expect(result[0].onGround).toBe(true)
    expect(result[0].altBaro).toBeNull()
    expect(result[0].altGeom).toBe(450)
  })
})
