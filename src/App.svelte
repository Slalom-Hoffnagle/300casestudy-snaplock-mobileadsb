<svelte:head>
  <meta
    name="description"
    content="Point your phone at the sky and identify nearby aircraft with live ADS-B data."
  />
</svelte:head>

<main class="scanner-shell">
  <div class="sky" aria-hidden="true"></div>
  <div class="scrim" aria-hidden="true"></div>

  <header class="app-header">
    <a class="brand" href="/" aria-label="SnapLock home">
      <img src="/snaplock-mark.svg" width="36" height="36" alt="" />
      <span>SnapLock</span>
    </a>
    <span class="status"><i></i> Foundation online</span>
  </header>

  <section class="viewfinder" aria-labelledby="welcome-title">
    <div class="reticle" aria-hidden="true">
      <span></span><span></span><span></span><span></span>
      <div class="aircraft">✈</div>
    </div>
    <p class="eyebrow">Visual aircraft identification</p>
    <h1 id="welcome-title">Look up.<br />Lock on.</h1>
    <p class="lede">Live aircraft identification is taking shape.</p>
  </section>

  <footer class="app-footer">
    <div class="milestone">
      <span class="milestone-label">Build status</span>
      <strong>Project foundation complete</strong>
    </div>
    <a href="https://adsb.fi" target="_blank" rel="noreferrer">Flight data provided by adsb.fi</a>
  </footer>
</main>
