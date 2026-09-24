<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import 'leaflet/dist/leaflet.css'
  import { bearingBetween, haversineDistance } from '../positioning'
  import { validateLandmark } from '../calibration'

  export let userLatitude: number
  export let userLongitude: number
  export let gpsAccuracy: number
  export let onSelect: (target: { latitude: number; longitude: number; bearing: number; distanceNm: number }) => void
  export let onCancel: () => void

  let mapElement: HTMLDivElement
  let map: import('leaflet').Map | null = null
  let marker: import('leaflet').Marker | null = null
  let landmarkLatitude = userLatitude
  let landmarkLongitude = userLongitude
  let message = 'Tap the map or enter coordinates for a visible landmark.'

  $: validation = validateLandmark(userLatitude, userLongitude, gpsAccuracy, landmarkLatitude, landmarkLongitude)
  $: bearing = bearingBetween(userLatitude, userLongitude, landmarkLatitude, landmarkLongitude)
  $: distanceNm = haversineDistance(userLatitude, userLongitude, landmarkLatitude, landmarkLongitude)

  function updateLandmark(latitude: number, longitude: number) {
    landmarkLatitude = Number(latitude.toFixed(6))
    landmarkLongitude = Number(longitude.toFixed(6))
    marker?.setLatLng([landmarkLatitude, landmarkLongitude])
    message = validation.warning ?? 'Landmark is suitable for calibration.'
  }

  function confirmLandmark() {
    if (!validation.valid) return
    onSelect({ latitude: landmarkLatitude, longitude: landmarkLongitude, bearing, distanceNm })
  }

  onMount(async () => {
    const leaflet = await import('leaflet')
    map = leaflet.map(mapElement, { zoomControl: true }).setView([userLatitude, userLongitude], 12)
    leaflet.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    }).addTo(map)
    leaflet.circleMarker([userLatitude, userLongitude], {
      radius: 7,
      color: '#b9f23d',
      fillColor: '#152028',
      fillOpacity: 1,
    }).addTo(map).bindTooltip('Your position')
    const landmarkIcon = leaflet.divIcon({ className: 'landmark-map-marker', html: '<span></span>', iconSize: [28, 28], iconAnchor: [14, 14] })
    marker = leaflet.marker([landmarkLatitude, landmarkLongitude], { draggable: true, icon: landmarkIcon }).addTo(map)
    marker.on('dragend', () => {
      const position = marker?.getLatLng()
      if (position) updateLandmark(position.lat, position.lng)
    })
    map.on('click', (event: import('leaflet').LeafletMouseEvent) => updateLandmark(event.latlng.lat, event.latlng.lng))
  })

  onDestroy(() => map?.remove())
</script>

<div class="landmark-picker">
  <div class="map" bind:this={mapElement} aria-label="Map for selecting a visible landmark"></div>
  <div class="coordinate-grid">
    <label>Latitude<input type="number" step="0.000001" bind:value={landmarkLatitude} onchange={() => updateLandmark(landmarkLatitude, landmarkLongitude)} /></label>
    <label>Longitude<input type="number" step="0.000001" bind:value={landmarkLongitude} onchange={() => updateLandmark(landmarkLatitude, landmarkLongitude)} /></label>
  </div>
  <div class="landmark-summary" aria-live="polite">
    <span>{distanceNm.toFixed(1)} nm away</span>
    <span>{Math.round(bearing)}° true</span>
    <strong class:warning={validation.warning}>{validation.warning ?? message}</strong>
  </div>
  <div class="calibration-actions">
    <button class="secondary-action" type="button" onclick={onCancel}>Back</button>
    <button class="primary-action" type="button" disabled={!validation.valid} onclick={confirmLandmark}>Use this landmark</button>
  </div>
</div>
