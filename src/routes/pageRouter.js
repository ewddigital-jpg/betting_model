function renderShell(initialMatchId = null) {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>UCL / UEL Betting Analysis</title>
    <link rel="stylesheet" href="/public/style.css" />
  </head>
  <body>
    <div class="app-shell">
      <header class="app-header">
        <div class="app-header-copy">
          <p class="eyebrow">Data-driven football betting analysis</p>
          <h1>Decision-first UCL / UEL board</h1>
          <p class="hero-copy">
            Open a match and see the call, the plain-language reason, and whether the current price is reliable enough to act on.
          </p>
        </div>
      </header>

      <main class="layout">
        <aside class="sidebar">
          <div class="panel-header">
            <h2>Upcoming Matches</h2>
            <div class="sidebar-actions">
              <button id="sync-button" class="button button-primary" type="button">Sync Data</button>
            </div>
          </div>
          <div class="sidebar-status-strip">
            <div id="status-banner" class="status-banner status-banner--compact">Loading match list...</div>
            <div id="collector-banner" class="status-banner status-banner--compact">Loading collector status...</div>
          </div>
          <div id="competition-tabs" class="tabs">
            <button class="tab" data-competition="">All</button>
            <button class="tab is-active" data-competition="CL">UCL</button>
            <button class="tab" data-competition="EL">UEL</button>
          </div>
          <section class="match-tools panel">
            <div class="panel-header panel-header-tight">
              <h3>Slate</h3>
              <span id="match-list-meta" class="match-list-meta">Loading slate...</span>
            </div>
            <div id="match-filter-bar" class="toggle-group filter-toggle">
              <button class="toggle-button is-active" data-scan-filter="all" type="button">All</button>
              <button class="toggle-button" data-scan-filter="focus" type="button">Focus</button>
              <button class="toggle-button" data-scan-filter="playable" type="button">Playable</button>
              <button class="toggle-button" data-scan-filter="tonight" type="button">Tonight</button>
            </div>
          </section>
          <div id="match-list" class="match-list"></div>
        </aside>

        <section class="content">
          <div id="detail-view" class="detail-view">
            <div class="empty-state">
              <h2>Select a match</h2>
              <p>Choose an upcoming fixture to inspect probabilities, fair odds, edge, and the written analysis.</p>
            </div>
          </div>

          <details class="backtest-panel performance-shell">
            <summary class="performance-summary">Performance Dashboard</summary>
            <div class="panel-header">
              <h2>Performance Dashboard</h2>
              <select id="backtest-filter" class="input">
                <option value="">All competitions</option>
                <option value="CL">UCL</option>
                <option value="EL">UEL</option>
              </select>
            </div>
            <div id="backtest-view" class="backtest-view">Loading performance dashboard...</div>
          </details>

          <details class="backtest-panel automation-shell">
            <summary class="performance-summary">Automation Desk</summary>
            <div class="panel-header">
              <h2>Automation Desk</h2>
              <p class="automation-summary-copy">See what the reviewer and implementer are running, what prompt they use, and which files changed recently.</p>
            </div>
            <div id="automation-desk" class="automation-desk">Loading automation desk...</div>
          </details>
        </section>
      </main>
    </div>

    <script>
      window.__APP_CONTEXT__ = ${JSON.stringify({ initialMatchId })};
    </script>
    <script type="module" src="/public/app.js"></script>
  </body>
</html>`;
}

export function handlePageRequest(response, pathname) {
  let initialMatchId = null;

  if (pathname.startsWith("/matches/")) {
    initialMatchId = Number(pathname.split("/").pop());
  }

  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(renderShell(Number.isFinite(initialMatchId) ? initialMatchId : null));
}
