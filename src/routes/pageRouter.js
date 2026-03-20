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
      <header class="hero">
        <div>
          <p class="eyebrow">Data-driven football betting analysis</p>
          <h1>UEFA Champions League and Europa League value finder</h1>
          <p class="hero-copy">
            Browse upcoming UCL and UEL matches, compare model probabilities against bookmaker prices,
            and see clearly which signals support the bet, where uncertainty remains, and when the model stays cautious.
          </p>
        </div>
        <div class="hero-side">
          <div class="hero-card">
            <p class="hero-stat-label">What this app shows</p>
            <p class="hero-stat-value">Model vs market, with reasons</p>
            <p class="hero-warning">Analysis tool only. No guaranteed profit.</p>
          </div>
          <div class="hero-card hero-card-secondary">
            <p class="hero-stat-label">Data Stack</p>
            <div id="provider-stack" class="provider-stack">
              <span class="provider-chip pending">Checking Sportmonks</span>
              <span class="provider-chip pending">Checking football-data.org</span>
              <span class="provider-chip pending">Checking odds feed</span>
            </div>
            <p id="pipeline-copy" class="hero-warning">Collector runs twice a day and keeps a local archive of snapshots.</p>
          </div>
        </div>
      </header>

      <main class="layout">
        <aside class="sidebar">
          <div class="panel-header">
            <h2>Upcoming Matches</h2>
            <div class="sidebar-actions">
              <div id="density-toggle" class="toggle-group density-toggle">
                <button class="toggle-button is-active" data-density="comfortable" type="button">Comfortable</button>
                <button class="toggle-button" data-density="compact" type="button">Compact</button>
              </div>
              <button id="sync-button" class="button button-primary" type="button">Sync Data</button>
            </div>
          </div>
          <div id="status-banner" class="status-banner">Loading match list...</div>
          <div id="collector-banner" class="status-banner">Loading collector status...</div>
          <section class="shortlist-panel-mini">
            <div class="panel-header panel-header-tight">
              <h3>Tomorrow Shortlist</h3>
            </div>
            <div id="shortlist-panel" class="reminder-panel-content">Building shortlist...</div>
          </section>
          <section class="reminder-panel-mini">
            <div class="panel-header panel-header-tight">
              <h3>Bet Reminders</h3>
            </div>
            <div id="reminder-panel" class="reminder-panel-content">Loading reminders...</div>
          </section>
          <section class="reminder-panel-mini combo-panel-mini">
            <div class="panel-header panel-header-tight">
              <h3>Tonight UCL Combo Board</h3>
            </div>
            <div id="combo-board-panel" class="reminder-panel-content">Building tonight board...</div>
          </section>
          <section class="reminder-panel-mini ticket-builder-mini">
            <div class="panel-header panel-header-tight">
              <h3>Ticket Builder</h3>
            </div>
            <div id="ticket-builder-panel" class="reminder-panel-content">Building ticket...</div>
          </section>
          <div id="competition-tabs" class="tabs">
            <button class="tab" data-competition="">All</button>
            <button class="tab is-active" data-competition="CL">UCL</button>
            <button class="tab" data-competition="EL">UEL</button>
          </div>
          <section class="match-tools panel">
            <div class="panel-header panel-header-tight">
              <h3>Scan Board</h3>
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
