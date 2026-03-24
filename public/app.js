const state = {
  competition: "CL",
  selectedMatchId: window.__APP_CONTEXT__?.initialMatchId ?? null,
  analysisMode: "simple",
  detailSection: "summary",
  cardDensity: window.localStorage?.getItem("matchCardDensity") ?? "comfortable",
  scanFilter: window.localStorage?.getItem("matchScanFilter") ?? "all",
  pinnedMatchIds: (() => {
    try {
      const saved = JSON.parse(window.localStorage?.getItem("pinnedMatchIds") ?? "[]");
      return Array.isArray(saved) ? saved.map((value) => Number(value)).filter(Number.isFinite) : [];
    } catch {
      return [];
    }
  })(),
  currentDetail: null,
  matches: []
};

const matchListEl = document.getElementById("match-list");
const detailViewEl = document.getElementById("detail-view");
const statusBannerEl = document.getElementById("status-banner");
const collectorBannerEl = document.getElementById("collector-banner");
const shortlistPanelEl = document.getElementById("shortlist-panel");
const reminderPanelEl = document.getElementById("reminder-panel");
const comboBoardPanelEl = document.getElementById("combo-board-panel");
const ticketBuilderPanelEl = document.getElementById("ticket-builder-panel");
const syncButtonEl = document.getElementById("sync-button");
const backtestViewEl = document.getElementById("backtest-view");
const backtestFilterEl = document.getElementById("backtest-filter");
const providerStackEl = document.getElementById("provider-stack");
const pipelineCopyEl = document.getElementById("pipeline-copy");
const automationDeskEl = document.getElementById("automation-desk");
const densityToggleButtons = document.querySelectorAll("[data-density]");
const scanFilterButtons = document.querySelectorAll("[data-scan-filter]");
const matchListMetaEl = document.getElementById("match-list-meta");

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatEdge(value) {
  if (value === null || value === undefined) {
    return "n/a";
  }

  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatOdds(value) {
  return value === null || value === undefined ? "n/a" : Number(value).toFixed(2);
}

function formatTimestamp(value) {
  if (!value) {
    return "n/a";
  }

  return new Date(value).toLocaleString();
}

function formatSchedule(value) {
  if (!value) {
    return "n/a";
  }

  if (value === "FREQ=HOURLY;INTERVAL=1") {
    return "Every hour";
  }

  if (value === "FREQ=HOURLY;INTERVAL=24") {
    return "Every 24 hours";
  }

  const hourlyMatch = value.match(/^FREQ=HOURLY;INTERVAL=(\d+)$/u);
  if (hourlyMatch) {
    return `Every ${hourlyMatch[1]} hours`;
  }

  return value;
}

function coverageLabel(value) {
  if ((value ?? 0) >= 0.8) {
    return "Strong";
  }

  if ((value ?? 0) >= 0.55) {
    return "Moderate";
  }

  return "Thin";
}

function coveragePercent(value) {
  return `${Math.round((value ?? 0) * 100)}%`;
}

function shortKickoff(value) {
  if (!value) {
    return "n/a";
  }

  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function pillTone(value, kind = "default") {
  const normalized = String(value ?? "").toLowerCase();

  if (kind === "support") {
    if (normalized.includes("+") || normalized.includes("edge") || normalized.includes("value") || normalized.includes("stored")) return "support";
    if (normalized.includes("risk") || normalized.includes("thin")) return "caution";
    return "neutral";
  }

  if (kind === "combo") {
    if (normalized.includes("core")) return "positive";
    if (normalized.includes("support")) return "support";
    if (normalized.includes("price")) return "caution";
    if (normalized.includes("late")) return "neutral";
    return "negative";
  }

  if (kind === "lineup") {
    if (normalized.includes("official")) return "positive";
    if (normalized.includes("predicted")) return "support";
    if (normalized.includes("pending")) return "caution";
    return "negative";
  }

  if (kind === "credibility" || kind === "trust") {
    if (normalized.includes("high") || normalized.includes("strong")) return "positive";
    if (normalized.includes("good") || normalized.includes("fair")) return "support";
    if (normalized.includes("moderate") || normalized.includes("watch")) return "caution";
    return "negative";
  }

  if (kind === "source") {
    if (normalized.includes("official")) return "positive";
    if (normalized.includes("structured")) return "support";
    return "neutral";
  }

  if (kind === "attention") {
    if (normalized.includes("playable")) return "positive";
    if (normalized.includes("watch") || normalized.includes("check")) return "caution";
    return "negative";
  }

  if (kind === "coverage") {
    if (normalized.includes("strong")) return "positive";
    if (normalized.includes("moderate")) return "support";
    return "negative";
  }

  if (normalized.includes("high") || normalized.includes("strong") || normalized.includes("playable")) {
    return "positive";
  }

  if (normalized.includes("good") || normalized.includes("predicted") || normalized.includes("structured")) {
    return "support";
  }

  if (normalized.includes("watch") || normalized.includes("pending") || normalized.includes("late")) {
    return "caution";
  }

  if (normalized.includes("avoid") || normalized.includes("fragile") || normalized.includes("no ")) {
    return "negative";
  }

  return "neutral";
}

function renderPill(label, kind = "default") {
  return `<span class="tag tag--${pillTone(label, kind)}">${escapeHtml(label)}</span>`;
}

function renderStatusLozenge(label, tone = "neutral") {
  return `<span class="status-lozenge status-lozenge--${escapeHtml(tone)}">${escapeHtml(label)}</span>`;
}

function isPinnedMatch(matchId) {
  return state.pinnedMatchIds.includes(Number(matchId));
}

function persistPinnedMatches() {
  window.localStorage?.setItem("pinnedMatchIds", JSON.stringify(state.pinnedMatchIds));
}

function togglePinnedMatch(matchId) {
  const numericMatchId = Number(matchId);
  if (!Number.isFinite(numericMatchId)) {
    return;
  }

  if (isPinnedMatch(numericMatchId)) {
    state.pinnedMatchIds = state.pinnedMatchIds.filter((value) => value !== numericMatchId);
  } else {
    state.pinnedMatchIds = [numericMatchId, ...state.pinnedMatchIds].slice(0, 12);
  }

  persistPinnedMatches();
}

function matchCardTone(match) {
  const attention = String(match.attention?.label ?? "").toLowerCase();
  const combo = String(match.combo?.label ?? "").toLowerCase();
  const lineup = String(match.lineupStatus ?? "").toLowerCase();

  if (attention.includes("playable") || combo.includes("core")) {
    return "positive";
  }

  if (combo.includes("support") || lineup.includes("official") || lineup.includes("predicted")) {
    return "support";
  }

  if (attention.includes("watch") || combo.includes("price") || combo.includes("late")) {
    return "caution";
  }

  return "negative";
}

function filterMatchesForScan(matches) {
  const now = Date.now();

  switch (state.scanFilter) {
    case "focus":
      return matches.filter((match) => {
        const attention = match.attention?.label ?? "";
        const combo = match.combo?.label ?? "";
        return attention === "Playable" || attention === "Watch" || combo === "Core Leg" || combo === "Support Leg";
      });
    case "playable":
      return matches.filter((match) => (match.attention?.label ?? "") === "Playable" || (match.combo?.label ?? "") === "Core Leg");
    case "tonight":
      return matches.filter((match) => {
        const kickoff = new Date(match.kickoffTime).getTime();
        const diffHours = (kickoff - now) / 3_600_000;
        return diffHours >= -2 && diffHours <= 12;
      });
    default:
      return matches;
  }
}

function buildReadinessReport(payload) {
  const forward = payload.dashboard?.summary ?? {};
  const blind = payload.blindTest?.summary ?? {};
  const collector = payload.collectorStatus?.latestRun ?? null;
  const collectorSummary = collector?.summary ?? {};
  const oddsCoverage = payload.oddsCoverage ?? {};
  const advancedStats = collectorSummary.advancedStats ?? null;
  const analysisSummary = collectorSummary.analysis ?? {};

  const technicalMissing = [];
  if (!collector) {
    technicalMissing.push("Collector has not completed a real run yet.");
  } else if (collector.status === "failed") {
    technicalMissing.push("Latest collector run failed.");
  }

  if ((oddsCoverage.totalSnapshots ?? 0) <= 0) {
    technicalMissing.push("Odds archive has not stored any snapshots yet.");
  }

  if ((oddsCoverage.totalQuotes ?? 0) <= 0) {
    technicalMissing.push("Normalized quote history is still empty.");
  }

  if (!advancedStats) {
    technicalMissing.push("Advanced stats importer has not run yet.");
  } else if ((advancedStats.matchedRows ?? 0) <= 0) {
    technicalMissing.push("No xG or advanced-stat rows have been matched yet.");
  }

  if ((analysisSummary.withOdds ?? 0) <= 0) {
    technicalMissing.push("Upcoming match analysis still has no stored odds.");
  }

  const validationMissing = [];
  if ((oddsCoverage.finishedMatchesWithPreKickoffOdds ?? 0) <= 0) {
    validationMissing.push("No finished matches have archived pre-kickoff odds.");
  }

  if ((forward.trackedMatches ?? 0) < 50) {
    validationMissing.push(`Only ${forward.trackedMatches ?? 0} forward-tracked matches are stored.`);
  }

  if ((forward.settledBets ?? 0) < 25) {
    validationMissing.push(`Only ${forward.settledBets ?? 0} settled forward bets are available.`);
  }

  if (forward.averageClv === null || forward.averageClv === undefined) {
    validationMissing.push("Closing line value is not measurable yet.");
  }

  if ((blind.bets ?? 0) <= 0) {
    validationMissing.push("Blind historical replay still triggers zero priced bets.");
  }

  return {
    collector,
    oddsCoverage,
    forward,
    blind,
    technicalReady: technicalMissing.length === 0,
    validationReady: validationMissing.length === 0,
    technicalMissing,
    validationMissing
  };
}

function renderReadinessPanel(payload) {
  const report = buildReadinessReport(payload);
  const finishedCoverage = report.oddsCoverage.totalFinishedMatches
    ? `${report.oddsCoverage.finishedPreKickoffCoveragePercent ?? 0}%`
    : "n/a";

  return `
    <article class="panel readiness-panel">
      <div class="detail-header">
        <div>
          <h3>System Readiness</h3>
          <p class="analysis-copy">This is the blunt status board: one answer for whether the stack is wired properly, and one answer for whether the betting layer is actually validated.</p>
        </div>
        <div class="detail-actions">
          ${renderStatusLozenge(`Technical ${report.technicalReady ? "Yes" : "No"}`, report.technicalReady ? "positive" : "negative")}
          ${renderStatusLozenge(`Validation ${report.validationReady ? "Yes" : "No"}`, report.validationReady ? "positive" : "negative")}
        </div>
      </div>

      <div class="grid grid-two">
        <article class="panel panel-embedded readiness-card">
          <div class="readiness-card-top">
            <div>
              <span class="eyebrow">Technical status</span>
              <strong>${report.technicalReady ? "Yes" : "No"}</strong>
            </div>
            ${renderStatusLozenge(report.collector?.status ? `Collector ${report.collector.status}` : "Collector missing", report.collector?.status === "success" ? "positive" : report.collector?.status === "partial" ? "caution" : "negative")}
          </div>
          <div class="readiness-metrics">
            <div class="mini-metric">
              <span>Odds snapshots</span>
              <strong>${report.oddsCoverage.totalSnapshots ?? 0}</strong>
            </div>
            <div class="mini-metric">
              <span>Quote rows</span>
              <strong>${report.oddsCoverage.totalQuotes ?? 0}</strong>
            </div>
            <div class="mini-metric">
              <span>Upcoming odds matches</span>
              <strong>${report.oddsCoverage.matchesWithAnySnapshots ?? 0}</strong>
            </div>
            <div class="mini-metric">
              <span>xG matches</span>
              <strong>${report.collector?.summary?.advancedStats?.matchedRows ?? 0}</strong>
            </div>
          </div>
          ${
            report.technicalMissing.length
              ? `<ul class="analysis-list">${report.technicalMissing.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
              : `<p class="muted">Collector, archive, and advanced-stat pipeline are all live.</p>`
          }
        </article>

        <article class="panel panel-embedded readiness-card readiness-card-validation">
          <div class="readiness-card-top">
            <div>
              <span class="eyebrow">Validation status</span>
              <strong>${report.validationReady ? "Yes" : "No"}</strong>
            </div>
            ${renderStatusLozenge(report.validationReady ? "Betting validation earned" : "Evidence still thin", report.validationReady ? "positive" : "negative")}
          </div>
          <div class="readiness-metrics">
            <div class="mini-metric">
              <span>Finished pre-kickoff odds</span>
              <strong>${report.oddsCoverage.finishedMatchesWithPreKickoffOdds ?? 0}</strong>
            </div>
            <div class="mini-metric">
              <span>Finished coverage</span>
              <strong>${finishedCoverage}</strong>
            </div>
            <div class="mini-metric">
              <span>Forward tracked</span>
              <strong>${report.forward.trackedMatches ?? 0}</strong>
            </div>
            <div class="mini-metric">
              <span>Average CLV</span>
              <strong>${report.forward.averageClv === null || report.forward.averageClv === undefined ? "n/a" : report.forward.averageClv}</strong>
            </div>
          </div>
          ${
            report.validationMissing.length
              ? `<ul class="analysis-list">${report.validationMissing.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
              : `<p class="muted">Archived odds, CLV, and settled forward bets are now deep enough to call the betting layer validated.</p>`
          }
        </article>
      </div>
    </article>
  `;
}

function renderAdvancedStatsPanel(payload) {
  const diagnostics = payload.advancedStats ?? {};
  const latestImport = payload.collectorStatus?.latestRun?.summary?.advancedStats ?? null;
  const unmatchedRows = latestImport?.results ?? [];
  const hasFiles = (diagnostics.fileCount ?? 0) > 0;
  const importWorked = (latestImport?.matchedRows ?? 0) > 0;

  return `
    <article class="panel advanced-stats-panel">
      <div class="detail-header">
        <div>
          <h3>xG Import Helper</h3>
          <p class="analysis-copy">This shows whether the advanced-stats folder actually has files, whether the importer matched any rows, and which rows are still failing to map to your matches.</p>
        </div>
        <div class="detail-actions">
          ${renderStatusLozenge(hasFiles ? `${diagnostics.fileCount ?? 0} file${(diagnostics.fileCount ?? 0) === 1 ? "" : "s"} found` : "No xG files", hasFiles ? "support" : "negative")}
          ${renderStatusLozenge(importWorked ? `${latestImport?.matchedRows ?? 0} rows matched` : "No matched xG rows", importWorked ? "positive" : "caution")}
          <button class="button button-primary button-compact" type="button" data-run-xg-import>Run xG Import</button>
        </div>
      </div>

      <div class="grid grid-four">
        <article class="metric">
          <span>Folder rows</span>
          <strong>${diagnostics.sourceRowCount ?? 0}</strong>
        </article>
        <article class="metric">
          <span>Stored xG rows</span>
          <strong>${diagnostics.storedRowCount ?? 0}</strong>
        </article>
        <article class="metric">
          <span>Matched matches</span>
          <strong>${diagnostics.matchedMatchCount ?? 0}</strong>
        </article>
        <article class="metric">
          <span>Last extract</span>
          <strong>${escapeHtml(diagnostics.latestExtractedAt ? formatTimestamp(diagnostics.latestExtractedAt) : "n/a")}</strong>
        </article>
      </div>

      <div class="grid grid-two">
        <article class="panel panel-embedded">
          <h3>Folder status</h3>
          <ul class="analysis-list">
            <li>Import path: ${escapeHtml(diagnostics.importPath ?? "n/a")}</li>
            <li>Path exists: ${diagnostics.pathExists ? "yes" : "no"}</li>
            <li>Files detected: ${diagnostics.fileCount ?? 0}</li>
            <li>Latest run matched rows: ${latestImport?.matchedRows ?? 0}</li>
            <li>Latest run unmatched rows: ${latestImport?.unmatchedRows ?? 0}</li>
          </ul>
          ${
            diagnostics.files?.length
              ? `<p class="muted">Files: ${escapeHtml(diagnostics.files.join(", "))}</p>`
              : `<p class="muted">Drop CSV or JSON advanced-stat files into the import folder, then run Sync Data or \`npm.cmd run xg:import\`.</p>`
          }
        </article>
        <article class="panel panel-embedded">
          <h3>First unmatched rows</h3>
          ${
            unmatchedRows.length
              ? `
                <div class="advanced-stats-unmatched-list">
                  ${unmatchedRows.slice(0, 6).map((row) => `
                    <article class="advanced-stats-unmatched-item">
                      <strong>${escapeHtml((row.homeTeam && row.awayTeam) ? `${row.homeTeam} vs ${row.awayTeam}` : "Unmatched row")}</strong>
                      <span>${escapeHtml(row.team || "Unknown team")} | ${escapeHtml(row.matchDate || "Unknown date")}</span>
                      <small>${escapeHtml(row.file || "Unknown file")}</small>
                    </article>
                  `).join("")}
                </div>
              `
              : `<p class="muted">No unmatched preview rows were stored on the latest import.</p>`
          }
        </article>
      </div>
    </article>
  `;
}

function topResult(probabilities, match) {
  const options = [
    { label: match.homeTeam, probability: probabilities.homeWin ?? 0 },
    { label: "Draw", probability: probabilities.draw ?? 0 },
    { label: match.awayTeam, probability: probabilities.awayWin ?? 0 }
  ].sort((left, right) => right.probability - left.probability);

  return options[0];
}

function normalizeDetail(detail) {
  return {
    ...detail,
    overview: {
      dataCoverageScore: detail?.overview?.dataCoverageScore ?? 0,
      coverageBlend: detail?.overview?.coverageBlend ?? 0,
      trustScore: detail?.overview?.trustScore ?? 0,
      trustLabel: detail?.overview?.trustLabel ?? "Fragile",
      credibilityScore: detail?.overview?.credibilityScore ?? 0,
      credibilityLabel: detail?.overview?.credibilityLabel ?? "Fragile",
      expectedGoals: {
        home: detail?.overview?.expectedGoals?.home ?? 0,
        away: detail?.overview?.expectedGoals?.away ?? 0
      },
      probabilities: {
        homeWin: detail?.overview?.probabilities?.homeWin ?? 0,
        draw: detail?.overview?.probabilities?.draw ?? 0,
        awayWin: detail?.overview?.probabilities?.awayWin ?? 0
      }
    },
      analysis: {
        summary: detail?.analysis?.summary ?? "No written analysis available for this match yet.",
        modelLean: detail?.analysis?.modelLean ?? "No model-lean note available.",
        priceView: detail?.analysis?.priceView ?? "No market-price note available.",
        verdict: detail?.analysis?.verdict ?? "No final verdict available.",
        whyNot: detail?.analysis?.whyNot ?? "No risk note available.",
        keyReasons: detail?.analysis?.keyReasons ?? [],
        riskFactors: detail?.analysis?.riskFactors ?? [],
        watchTriggers: detail?.analysis?.watchTriggers ?? [],
        confidence: {
          level: detail?.analysis?.confidence?.level ?? "Low",
          reasons: detail?.analysis?.confidence?.reasons ?? []
        },
      scorelines: detail?.analysis?.scorelines ?? []
    },
    bestBet: detail?.bestBet ?? {
      hasBet: false,
      headline: "No Bet across the three main markets."
    },
    markets: detail?.markets ?? {
      oneXTwo: {
        name: "1X2",
          bestOption: { shortLabel: "No Bet", modelProbability: 0, fairOdds: null, bookmakerOdds: null, impliedProbability: 0, edge: null, targetOdds: null, movement: null, averageOdds: null },
          recommendation: { action: "No Bet", confidence: "Low", headline: "No Bet", shortReason: "No market assessment available.", riskNote: "No market assessment available.", triggerNote: "No market assessment available.", confidenceReasons: [], trustScore: 0, trustLabel: "Fragile", trustReasons: [], isNoBet: true }
        },
        totals25: {
          name: "Over / Under 2.5",
          bestOption: { shortLabel: "No Bet", modelProbability: 0, fairOdds: null, bookmakerOdds: null, impliedProbability: 0, edge: null, targetOdds: null, movement: null, averageOdds: null },
          recommendation: { action: "No Bet", confidence: "Low", headline: "No Bet", shortReason: "No market assessment available.", riskNote: "No market assessment available.", triggerNote: "No market assessment available.", confidenceReasons: [], trustScore: 0, trustLabel: "Fragile", trustReasons: [], isNoBet: true }
        },
        btts: {
          name: "BTTS",
          bestOption: { shortLabel: "No Bet", modelProbability: 0, fairOdds: null, bookmakerOdds: null, impliedProbability: 0, edge: null, targetOdds: null, movement: null, averageOdds: null },
          recommendation: { action: "No Bet", confidence: "Low", headline: "No Bet", shortReason: "No market assessment available.", riskNote: "No market assessment available.", triggerNote: "No market assessment available.", confidenceReasons: [], trustScore: 0, trustLabel: "Fragile", trustReasons: [], isNoBet: true }
        }
      },
    market: detail?.market ?? { rows: [], selectedBookmaker: null },
    match: {
      id: detail?.match?.id ?? detail?.id ?? null,
      homeTeam: detail?.match?.homeTeam ?? "Home team",
      awayTeam: detail?.match?.awayTeam ?? "Away team",
      competitionName: detail?.match?.competitionName ?? "",
      name: detail?.match?.name ?? "",
      kickoffLabel: detail?.match?.kickoffLabel ?? "",
      stage: detail?.match?.stage ?? "",
      leg: detail?.match?.leg ?? "",
      status: detail?.match?.status ?? ""
    },
    form: {
      homeRecentMatches: detail?.form?.homeRecentMatches ?? [],
      awayRecentMatches: detail?.form?.awayRecentMatches ?? []
    },
    availability: {
      home: {
        injuryImpactScore: detail?.availability?.home?.injuryImpactScore ?? 0,
        suspensionImpactScore: detail?.availability?.home?.suspensionImpactScore ?? 0,
        lineupCertaintyScore: detail?.availability?.home?.lineupCertaintyScore ?? 0.5,
        sourceConflictScore: detail?.availability?.home?.sourceConflictScore ?? 0,
        strongestLineupSource: detail?.availability?.home?.strongestLineupSource ?? null,
        strongestAbsenceSource: detail?.availability?.home?.strongestAbsenceSource ?? null,
        structuredLineupSource: detail?.availability?.home?.structuredLineupSource ?? false,
        structuredAbsenceSource: detail?.availability?.home?.structuredAbsenceSource ?? false,
        latestLineupExtractedAt: detail?.availability?.home?.latestLineupExtractedAt ?? null,
        latestAvailabilityExtractedAt: detail?.availability?.home?.latestAvailabilityExtractedAt ?? null,
        lineupUpdateAgeHours: detail?.availability?.home?.lineupUpdateAgeHours ?? null,
        hoursToKickoff: detail?.availability?.home?.hoursToKickoff ?? null,
        missingStartersCount: detail?.availability?.home?.missingStartersCount ?? 0,
        missingKeyPositions: detail?.availability?.home?.missingKeyPositions ?? [],
        injuries: detail?.availability?.home?.injuries ?? [],
        suspensions: detail?.availability?.home?.suspensions ?? [],
        expectedLineup: detail?.availability?.home?.expectedLineup ?? [],
        sources: detail?.availability?.home?.sources ?? []
      },
      away: {
        injuryImpactScore: detail?.availability?.away?.injuryImpactScore ?? 0,
        suspensionImpactScore: detail?.availability?.away?.suspensionImpactScore ?? 0,
        lineupCertaintyScore: detail?.availability?.away?.lineupCertaintyScore ?? 0.5,
        sourceConflictScore: detail?.availability?.away?.sourceConflictScore ?? 0,
        strongestLineupSource: detail?.availability?.away?.strongestLineupSource ?? null,
        strongestAbsenceSource: detail?.availability?.away?.strongestAbsenceSource ?? null,
        structuredLineupSource: detail?.availability?.away?.structuredLineupSource ?? false,
        structuredAbsenceSource: detail?.availability?.away?.structuredAbsenceSource ?? false,
        latestLineupExtractedAt: detail?.availability?.away?.latestLineupExtractedAt ?? null,
        latestAvailabilityExtractedAt: detail?.availability?.away?.latestAvailabilityExtractedAt ?? null,
        lineupUpdateAgeHours: detail?.availability?.away?.lineupUpdateAgeHours ?? null,
        hoursToKickoff: detail?.availability?.away?.hoursToKickoff ?? null,
        missingStartersCount: detail?.availability?.away?.missingStartersCount ?? 0,
        missingKeyPositions: detail?.availability?.away?.missingKeyPositions ?? [],
        injuries: detail?.availability?.away?.injuries ?? [],
        suspensions: detail?.availability?.away?.suspensions ?? [],
        expectedLineup: detail?.availability?.away?.expectedLineup ?? [],
        sources: detail?.availability?.away?.sources ?? []
      }
    },
    news: {
      home: detail?.news?.home ?? [],
      away: detail?.news?.away ?? []
    },
    context: {
      venueName: detail?.context?.venueName ?? null,
      venueCity: detail?.context?.venueCity ?? null,
      venueCapacity: detail?.context?.venueCapacity ?? null,
      venueSurface: detail?.context?.venueSurface ?? null,
      hoursToKickoff: detail?.context?.hoursToKickoff ?? null,
      lineupStatus: detail?.context?.lineupStatus ?? "No lineup read",
      attention: detail?.context?.attention ?? { label: "Watch", note: "This match still needs a closer look." },
      shortlist: detail?.context?.shortlist ?? { label: "Check Again", note: "Still needs another late look." },
      leg: detail?.context?.leg ?? null,
      hasPremiumOdds: detail?.context?.hasPremiumOdds ?? false,
      weatherSummary: detail?.context?.weatherSummary ?? null
    },
    combo: detail?.combo ?? {
      label: "Avoid",
      note: "No combo fit yet.",
      rank: 0,
      sourceQuality: "Soft",
      marketName: "1X2",
      selectionLabel: "No Bet",
      currentOdds: null,
      fairOdds: null,
      targetOdds: null,
      edge: null,
      disagreement: null,
      credibilityScore: 0
    },
    standings: detail?.standings ?? { home: null, away: null },
    technical: {
      impliedGap: detail?.technical?.impliedGap ?? null,
      factors: detail?.technical?.factors ?? [],
      diagnostics: {
        coverageBlend: detail?.technical?.diagnostics?.coverageBlend ?? 0,
        baselineExpectedGoals: {
          home: detail?.technical?.diagnostics?.baselineExpectedGoals?.home ?? 0,
          away: detail?.technical?.diagnostics?.baselineExpectedGoals?.away ?? 0
        },
        featureDrivenExpectedGoals: {
          home: detail?.technical?.diagnostics?.featureDrivenExpectedGoals?.home ?? 0,
          away: detail?.technical?.diagnostics?.featureDrivenExpectedGoals?.away ?? 0
        }
      }
    },
    recommendationHistory: detail?.recommendationHistory ?? []
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function fetchJson(path, options) {
  const response = await fetch(path, options);
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Request failed.");
  }

  return payload;
}

function setStatus(message, type = "neutral") {
  statusBannerEl.textContent = message;
  statusBannerEl.dataset.type = type;
}

function setCollectorStatus(message, type = "neutral") {
  collectorBannerEl.textContent = message;
  collectorBannerEl.dataset.type = type;
}

function renderShortlist(matches) {
  if (!shortlistPanelEl) {
    return;
  }

  const tomorrowMatches = (matches ?? [])
    .filter((match) => match.competitionCode === "CL")
    .filter((match) => {
      const diffHours = (new Date(match.kickoffTime).getTime() - Date.now()) / 3_600_000;
      return diffHours >= -2 && diffHours <= 36;
    })
    .sort((left, right) => {
      const order = { "Playable Late": 0, "Check Again": 1, "Ignore Completely": 2 };
      const leftRank = order[left.shortlist?.label] ?? 3;
      const rightRank = order[right.shortlist?.label] ?? 3;

      return leftRank - rightRank || (right.credibility?.score ?? 0) - (left.credibility?.score ?? 0);
    })
    .slice(0, 6);

  if (!tomorrowMatches.length) {
    shortlistPanelEl.innerHTML = `<p class="muted">No UCL shortlist built yet.</p>`;
    return;
  }

  shortlistPanelEl.innerHTML = tomorrowMatches.map((match) => `
    <article class="reminder-mini-item shortlist-mini-item" data-shortlist-match-id="${match.id}">
      <strong>${escapeHtml(match.homeTeam)} vs ${escapeHtml(match.awayTeam)}</strong>
      <span>${renderPill(match.shortlist?.label || "Check Again", "attention")} ${renderPill(match.lineupStatus || "No lineup read", "lineup")}</span>
      <span>${escapeHtml(match.kickoffLabel)}</span>
      <span>${escapeHtml(match.shortlist?.note || match.attention?.note || "Still needs a closer look.")}</span>
    </article>
  `).join("");

  shortlistPanelEl.querySelectorAll("[data-shortlist-match-id]").forEach((element) => {
    element.addEventListener("click", () => openMatch(Number(element.dataset.shortlistMatchId)));
  });
}

function renderComboBoard(matches) {
  if (!comboBoardPanelEl) {
    return;
  }

  const tonightMatches = (matches ?? [])
    .filter((match) => match.competitionCode === "CL")
    .filter((match) => {
      const diffHours = (new Date(match.kickoffTime).getTime() - Date.now()) / 3_600_000;
      return diffHours >= -1 && diffHours <= 12;
    })
    .sort((left, right) => {
      const leftRank = rightRankMap(left.combo?.label);
      const rightRank = rightRankMap(right.combo?.label);
      return rightRank - leftRank || (right.credibility?.score ?? 0) - (left.credibility?.score ?? 0);
    });

  const usable = tonightMatches.filter((match) => ["Core Leg", "Support Leg", "Price Leg"].includes(match.combo?.label));
  const bestTwo = usable.filter((match) => match.combo?.label !== "Price Leg").slice(0, 2);
  const bestThree = usable.slice(0, 3);

  comboBoardPanelEl.innerHTML = `
    ${
      usable.length
        ? `
          <div class="reminder-mini-block combo-mini-block">
            <span class="eyebrow">Best 2-Leg</span>
            ${
              bestTwo.length >= 2
                ? `
                  <article class="combo-ticket">
                    ${bestTwo.map((match) => `
                      <div class="combo-ticket-row" data-combo-match-id="${match.id}">
                        <strong>${escapeHtml(match.combo.marketName)}: ${escapeHtml(match.combo.selectionLabel)}</strong>
                        <span>${escapeHtml(match.homeTeam)} vs ${escapeHtml(match.awayTeam)}</span>
                        <span>${renderPill(match.combo.label, "combo")} ${renderPill(match.lineupStatus, "lineup")} ${renderPill(`${match.credibility?.score ?? 0} credibility`, "credibility")}</span>
                        <span>Now ${formatOdds(match.combo.currentOdds)} | Fair ${formatOdds(match.combo.fairOdds)} | ${renderPill(`${match.sourceQuality || "Soft"} sources`, "source")}</span>
                      </div>
                    `).join("")}
                    <div class="combo-ticket-total">Approx combo odds ${formatOdds(bestTwo.reduce((product, match) => product * (match.combo.currentOdds ?? 1), 1))}</div>
                  </article>
                `
                : `<p class="muted">Not enough clean legs for a disciplined 2-leg combo yet.</p>`
            }
          </div>
          <div class="reminder-mini-block combo-mini-block">
            <span class="eyebrow">Best 3-Leg</span>
            ${
              bestThree.length >= 3
                ? `
                  <article class="combo-ticket">
                    ${bestThree.map((match) => `
                      <div class="combo-ticket-row" data-combo-match-id="${match.id}">
                        <strong>${escapeHtml(match.combo.marketName)}: ${escapeHtml(match.combo.selectionLabel)}</strong>
                        <span>${escapeHtml(match.homeTeam)} vs ${escapeHtml(match.awayTeam)}</span>
                        <span>${renderPill(match.combo.label, "combo")} ${renderPill(match.lineupStatus, "lineup")} ${renderPill(`${match.credibility?.score ?? 0} credibility`, "credibility")}</span>
                        <span>Now ${formatOdds(match.combo.currentOdds)} | Fair ${formatOdds(match.combo.fairOdds)} | ${renderPill(`${match.sourceQuality || "Soft"} sources`, "source")}</span>
                      </div>
                    `).join("")}
                    <div class="combo-ticket-total">Approx combo odds ${formatOdds(bestThree.reduce((product, match) => product * (match.combo.currentOdds ?? 1), 1))}</div>
                  </article>
                `
                : `<p class="muted">The slate is still too messy for a sensible 3-leg combo.</p>`
            }
          </div>
        `
        : `<p class="muted">No clean UCL combo legs for tonight yet.</p>`
    }
    <div class="reminder-mini-block">
      <span class="eyebrow">Leg Grades</span>
      <div class="reminder-mini-list">
        ${
          tonightMatches.length
            ? tonightMatches.slice(0, 6).map((match) => `
              <article class="reminder-mini-item combo-grade-item" data-combo-match-id="${match.id}">
                <strong>${escapeHtml(match.homeTeam)} vs ${escapeHtml(match.awayTeam)}</strong>
                <span>${renderPill(match.combo?.label || "Avoid", "combo")} ${escapeHtml(match.combo?.marketName || "1X2")}: ${escapeHtml(match.combo?.selectionLabel || "No Bet")}</span>
                <span>${escapeHtml(match.combo?.note || "No combo note.")}</span>
                <span>${renderPill(match.lineupStatus || "No lineup read", "lineup")} ${renderPill(`${match.sourceQuality || "Soft"} sources`, "source")} ${renderPill(`${match.credibility?.score ?? 0} credibility`, "credibility")}</span>
              </article>
            `).join("")
            : `<p class="muted">No UCL matches in tonight's window.</p>`
        }
      </div>
    </div>
  `;

  comboBoardPanelEl.querySelectorAll("[data-combo-match-id]").forEach((element) => {
    element.addEventListener("click", () => openMatch(Number(element.dataset.comboMatchId)));
  });
}

function buildTicketCandidate(matches) {
  const pinnedLegs = (matches ?? [])
    .filter((match) => isPinnedMatch(match.id))
    .filter((match) => ["Core Leg", "Support Leg", "Price Leg"].includes(match.combo?.label))
    .filter((match) => Number.isFinite(match.combo?.currentOdds))
    .slice(0, 4);

  if (pinnedLegs.length) {
    return {
      source: "Pinned matches",
      legs: pinnedLegs
    };
  }

  const autoLegs = (matches ?? [])
    .filter((match) => match.competitionCode === "CL")
    .filter((match) => {
      const diffHours = (new Date(match.kickoffTime).getTime() - Date.now()) / 3_600_000;
      return diffHours >= -1 && diffHours <= 12;
    })
    .filter((match) => ["Core Leg", "Support Leg"].includes(match.combo?.label))
    .filter((match) => Number.isFinite(match.combo?.currentOdds))
    .sort((left, right) => (right.credibility?.score ?? 0) - (left.credibility?.score ?? 0))
    .slice(0, 3);

  return {
    source: "Auto build",
    legs: autoLegs
  };
}

function renderTicketBuilder(matches) {
  if (!ticketBuilderPanelEl) {
    return;
  }

  const ticket = buildTicketCandidate(matches);
  const legs = ticket.legs ?? [];

  if (!legs.length) {
    ticketBuilderPanelEl.innerHTML = `<p class="muted">No clean legs for a ticket yet. Pin a few matches or wait for a clearer late board.</p>`;
    return;
  }

  const totalOdds = legs.reduce((product, match) => product * (match.combo?.currentOdds ?? 1), 1);
  const ticketText = legs.map((match, index) => `${index + 1}. ${match.homeTeam} vs ${match.awayTeam} - ${match.combo?.marketName}: ${match.combo?.selectionLabel} @ ${formatOdds(match.combo?.currentOdds)}`).join("\n");

  ticketBuilderPanelEl.innerHTML = `
    <div class="reminder-mini-block">
      <span class="eyebrow">${escapeHtml(ticket.source)}</span>
      <article class="ticket-builder-card">
        ${legs.map((match) => `
          <div class="ticket-builder-leg" data-ticket-match-id="${match.id}">
            <strong>${escapeHtml(match.combo?.marketName || "1X2")}: ${escapeHtml(match.combo?.selectionLabel || "No Bet")}</strong>
            <span>${escapeHtml(match.homeTeam)} vs ${escapeHtml(match.awayTeam)}</span>
            <span>${renderPill(match.combo?.label || "Watch", "combo")} ${renderPill(match.lineupStatus || "No lineup read", "lineup")} ${renderPill(`${match.credibility?.score ?? 0} credibility`, "credibility")}</span>
            <span>Odds ${formatOdds(match.combo?.currentOdds)} | Fair ${formatOdds(match.combo?.fairOdds)}</span>
          </div>
        `).join("")}
        <div class="ticket-builder-footer">
          <div>
            <span class="eyebrow">Approx combo odds</span>
            <strong>${formatOdds(totalOdds)}</strong>
          </div>
          <button class="button button-primary button-compact" type="button" data-copy-ticket="${escapeHtml(ticketText)}">Copy Ticket</button>
        </div>
      </article>
    </div>
  `;

  ticketBuilderPanelEl.querySelectorAll("[data-ticket-match-id]").forEach((element) => {
    element.addEventListener("click", () => openMatch(Number(element.dataset.ticketMatchId)));
  });

  ticketBuilderPanelEl.querySelector("[data-copy-ticket]")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(ticketText);
      setStatus("Ticket copied to clipboard.", "success");
    } catch {
      setStatus("Could not copy the ticket automatically.", "warning");
    }
  });
}

function rightRankMap(label) {
  const ranks = {
    "Core Leg": 4,
    "Support Leg": 3,
    "Price Leg": 2,
    "Late Check": 1,
    "Avoid": 0
  };

  return ranks[label] ?? 0;
}

function renderReminderPanel(payload) {
  if (!reminderPanelEl) {
    return;
  }

  const upcoming = payload?.upcoming ?? [];
  const lineupAlerts = payload?.lineupAlerts ?? [];
  const history = payload?.history ?? [];

  reminderPanelEl.innerHTML = `
    ${
      lineupAlerts.length
        ? `
          <div class="reminder-mini-block">
            <span class="eyebrow">Lineups Ready Soon</span>
            <div class="reminder-mini-list">
              ${lineupAlerts.slice(0, 3).map((item) => `
                <article class="reminder-mini-item">
                  <strong>${escapeHtml(item.matchName)}</strong>
                  <span>${renderPill(item.lineupStatus, "lineup")} ${renderPill(item.attentionLabel, "attention")}</span>
                  <span>${escapeHtml(formatTimestamp(item.kickoffTime))}</span>
                  <span>${renderPill(`${item.credibility} credibility`, "credibility")} ${renderPill(`${item.confidence} confidence`, "trust")} ${renderPill(`${item.trust} trust`, "trust")}</span>
                </article>
              `).join("")}
            </div>
          </div>
        `
        : `<p class="muted">No lineup-ready alerts yet.</p>`
    }
    ${
      upcoming.length
        ? `
          <div class="reminder-mini-block">
            <span class="eyebrow">Bet Reminder Candidates</span>
            <div class="reminder-mini-list">
            ${upcoming.slice(0, 3).map((item) => `
              <article class="reminder-mini-item">
                <strong>${escapeHtml(item.matchName)}</strong>
                <span>${renderPill(item.market, "source")} ${escapeHtml(item.selection)}</span>
                <span>${escapeHtml(formatTimestamp(item.kickoffTime))}</span>
                <span>${renderPill(`Edge ${formatEdge(item.edge)}`, "support")} ${renderPill(`${item.confidence} confidence`, "trust")} ${renderPill(`${item.trust} trust`, "trust")}</span>
              </article>
            `).join("")}
            </div>
          </div>
        `
        : `<p class="muted">No bet reminder candidates right now.</p>`
    }
    ${
      history.length
        ? `
          <div class="reminder-mini-block">
            <span class="eyebrow">Recent Reminder Emails</span>
            <div class="reminder-mini-list">
            ${history.slice(0, 2).map((item) => `
              <article class="reminder-mini-item">
                <strong>${escapeHtml(item.summary?.matchName ?? item.subject)}</strong>
                <span>${escapeHtml(item.channel === "email-lineup" ? "Lineup ready" : item.market_name)}: ${escapeHtml(item.selection_label)}</span>
                <span>${escapeHtml(formatTimestamp(item.sent_at))}</span>
                <span class="reminder-mini-history ${item.status === "sent" ? "sent" : "failed"}">${escapeHtml(item.status)}</span>
              </article>
            `).join("")}
            </div>
          </div>
        `
        : ""
    }
  `;
}

function renderPromptBlock(prompt) {
  if (!prompt) {
    return "<p class=\"muted\">No prompt stored.</p>";
  }

  return `<pre class="automation-prompt">${escapeHtml(prompt)}</pre>`;
}

function renderAuditFindings(audit) {
  if (!audit?.topFindings?.length) {
    return "<p class=\"muted\">No stored reviewer findings yet.</p>";
  }

  return `
    <div class="automation-findings">
      ${audit.topFindings.map((finding) => `
        <article class="automation-note">
          <span class="tag">${escapeHtml(finding.priority || "Info")}</span>
          <strong>${escapeHtml(finding.title)}</strong>
          <p>${escapeHtml(finding.detail || "")}</p>
          <small>${escapeHtml(finding.action || "")}</small>
        </article>
      `).join("")}
    </div>
  `;
}

function renderRecentChanges(changes) {
  if (!changes?.length) {
    return "<p class=\"muted\">No recent project file activity found.</p>";
  }

  return `
    <div class="automation-changes">
      ${changes.map((change) => `
        <article class="automation-change">
          <strong>${escapeHtml(change.path)}</strong>
          <span>${escapeHtml(formatTimestamp(change.modifiedAt))}</span>
          <small>${escapeHtml(`${Math.max(1, Math.round((change.size ?? 0) / 1024))} KB`)}</small>
        </article>
      `).join("")}
    </div>
  `;
}

function renderAutomationCard(title, automation, extraContent) {
  if (!automation) {
    return `
      <article class="automation-card">
        <div class="panel-header panel-header-tight">
          <h3>${escapeHtml(title)}</h3>
        </div>
        <p class="muted">Automation config not found.</p>
      </article>
    `;
  }

  return `
    <article class="automation-card">
      <div class="panel-header panel-header-tight">
        <h3>${escapeHtml(title)}</h3>
        <span class="tag">${escapeHtml(automation.status || "UNKNOWN")}</span>
      </div>
      <div class="automation-meta-grid">
        <div>
          <span>Schedule</span>
          <strong>${escapeHtml(formatSchedule(automation.schedule))}</strong>
        </div>
        <div>
          <span>Updated</span>
          <strong>${escapeHtml(formatTimestamp(automation.updatedAt))}</strong>
        </div>
      </div>
      <details class="automation-detail" open>
        <summary>Prompt</summary>
        ${renderPromptBlock(automation.prompt)}
      </details>
      ${extraContent}
    </article>
  `;
}

function renderAutomationDesk(payload) {
  if (!automationDeskEl) {
    return;
  }

  const reviewerExtra = `
    <div class="automation-section">
      <div class="panel-header panel-header-tight">
        <h4>Latest reviewer findings</h4>
      </div>
      <p class="analysis-copy">
        Latest stored audit: ${escapeHtml(formatTimestamp(payload?.audit?.generatedAt))} | Health score: ${escapeHtml(String(payload?.audit?.healthScore ?? "n/a"))}/100
      </p>
      ${renderAuditFindings(payload?.audit)}
      <details class="automation-detail">
        <summary>Best next prompt</summary>
        ${renderPromptBlock(payload?.audit?.bestNextPrompt)}
      </details>
    </div>
  `;

  const implementerExtra = `
    <div class="automation-section">
      <div class="panel-header panel-header-tight">
        <h4>Recent project changes</h4>
      </div>
      <p class="analysis-copy">Latest workspace activity, so you can see what the implementation loop has been touching.</p>
      ${renderRecentChanges(payload?.recentProjectChanges)}
    </div>
  `;

  automationDeskEl.innerHTML = `
    <section class="automation-grid">
      ${renderAutomationCard("Project Reviewer", payload?.reviewer, reviewerExtra)}
      ${renderAutomationCard("Project Implementer", payload?.implementer, implementerExtra)}
    </section>
  `;
}

function renderProviderChip(label, active) {
  return `<span class="provider-chip ${active ? "active" : "inactive"}">${escapeHtml(label)}</span>`;
}

function renderMatches(matches) {
  if (!matches.length) {
    matchListEl.classList.toggle("match-list--compact", state.cardDensity === "compact");
    if (matchListMetaEl) {
      matchListMetaEl.textContent = "0 matches";
    }
    matchListEl.innerHTML = `
      <div class="empty-state compact">
        <h3>No upcoming matches found</h3>
        <p>Run a sync after adding API keys to load the next UCL and UEL fixtures.</p>
      </div>
    `;
      return;
  }

  const sortedMatches = [...matches].sort((left, right) => {
    const leftPinned = isPinnedMatch(left.id) ? 1 : 0;
    const rightPinned = isPinnedMatch(right.id) ? 1 : 0;
    if (leftPinned !== rightPinned) {
      return rightPinned - leftPinned;
    }

    const leftScore = (left.attention?.label === "Playable" ? 200 : left.attention?.label === "Watch" ? 100 : 0) + (left.credibility?.score ?? 0);
    const rightScore = (right.attention?.label === "Playable" ? 200 : right.attention?.label === "Watch" ? 100 : 0) + (right.credibility?.score ?? 0);

    if (left.competitionCode === right.competitionCode) {
      return rightScore - leftScore || new Date(left.kickoffTime).getTime() - new Date(right.kickoffTime).getTime();
    }

    return new Date(left.kickoffTime).getTime() - new Date(right.kickoffTime).getTime();
  });

  const visibleMatches = filterMatchesForScan(sortedMatches);

  if (matchListMetaEl) {
    matchListMetaEl.textContent = `${visibleMatches.length} of ${sortedMatches.length} matches`;
  }

  matchListEl.classList.toggle("match-list--compact", state.cardDensity === "compact");
  matchListEl.innerHTML = visibleMatches.length
    ? visibleMatches.map((match) => `
    <article class="match-card match-card--${matchCardTone(match)} ${state.selectedMatchId === match.id ? "is-selected" : ""} ${state.cardDensity === "compact" ? "match-card--compact" : ""}" data-match-id="${match.id}">
      <div class="match-card-top">
        <div class="match-card-top-left">
          <span class="competition-pill">${escapeHtml(match.competitionCode)}</span>
          ${isPinnedMatch(match.id) ? `<span class="match-card-pin-label">Pinned</span>` : ""}
        </div>
        <div class="match-card-top-right">
          <span class="match-status-dot match-status-dot--${sidebarDecisionState(match).tone}"></span>
          <span class="kickoff match-card-kickoff">${escapeHtml(shortKickoff(match.kickoffTime))}</span>
        </div>
      </div>
      <h3>${escapeHtml(match.homeTeam)} <span>vs</span> ${escapeHtml(match.awayTeam)}</h3>
      ${
        match.probabilities
          ? `
            <section class="match-card-decision">
              <strong>${escapeHtml(match.recommendation?.assessment && match.recommendation.assessment !== "No Bet"
                ? decisionLabelForSelection(
                    match,
                    String(match.recommendation.assessment).split(":")[0]?.trim() || "1X2",
                    String(match.recommendation.assessment).split(":").slice(1).join(":").trim()
                  )
                : "NO BET")}</strong>
              <span>${escapeHtml(sidebarDecisionState(match).label)}</span>
            </section>
            <p class="match-card-reason">${escapeHtml(humanizeUiCopy(match.attention?.note || match.recommendation?.assessment || "No clear call yet."))}</p>
            <div class="match-card-meta-row">
              <span>Model: ${escapeHtml(topResult(match.probabilities, match).label)} ${percent(topResult(match.probabilities, match).probability)}</span>
              <span>Odds: ${formatOdds(match.combo?.currentOdds)}</span>
              <span>${escapeHtml(match.hasOdds ? "Price on board" : "Price pending")}</span>
            </div>
          `
          : `<p class="bet-opinion muted">${escapeHtml(match.warning || "Analysis not available yet.")}</p>`
      }
    </article>
  `).join("")
    : `
      <div class="empty-state compact">
        <h3>No matches fit this filter</h3>
        <p>Try a wider scan mode or switch competition tabs.</p>
      </div>
    `;

  renderShortlist(sortedMatches);
  renderComboBoard(sortedMatches);
  renderTicketBuilder(sortedMatches);

  document.querySelectorAll("[data-match-id]").forEach((element) => {
    element.addEventListener("click", () => openMatch(Number(element.dataset.matchId)));
  });
}

function lineupStatusMeta(detail) {
  const status = detail.context.lineupStatus ?? "No lineup read";
  const hours = detail.context.hoursToKickoff;

  if (status === "Official") {
    return {
      label: "Lineups",
      value: "Official",
      note: "Both starting XIs are backed by official lineup sources"
    };
  }

  if (status === "Pending") {
    return {
      label: "Lineups",
      value: "Pending",
      note: hours !== null ? `${Math.round(hours)}h to kickoff and still waiting on a clear lineup read` : "Still waiting on a clear lineup read"
    };
  }

  if (status === "Predicted") {
    return {
      label: "Lineups",
      value: "Predicted",
      note: "The app has a projected XI, but not official starting lineups yet"
    };
  }

  return {
    label: "Lineups",
    value: "No lineup read",
    note: "Too early for an official or projected XI"
  };
}

function renderProbabilityBars(probabilities, match) {
  return [
    { label: `${match.homeTeam} win`, value: probabilities.homeWin, theme: "home" },
    { label: "Draw", value: probabilities.draw, theme: "draw" },
    { label: `${match.awayTeam} win`, value: probabilities.awayWin, theme: "away" }
  ].map((item) => `
    <div class="bar-row">
      <div class="bar-label">${escapeHtml(item.label)}</div>
      <div class="bar-track"><div class="bar-fill ${item.theme}" style="width:${item.value * 100}%"></div></div>
      <div class="bar-value">${percent(item.value)}</div>
    </div>
  `).join("");
}

function renderBestBet(bestBet) {
  if (!bestBet?.hasBet) {
    return `
      <section class="best-bet-banner muted-banner">
        <span class="eyebrow">Best Bet Across All Markets</span>
        <strong>No Bet across the three main markets.</strong>
      </section>
    `;
  }

  return `
    <section class="best-bet-banner">
      <span class="eyebrow">Best Bet Across All Markets</span>
      <strong>${escapeHtml(bestBet.marketName)}: ${escapeHtml(bestBet.selectionLabel)}</strong>
      <div class="best-bet-meta">
        <span>Market: ${escapeHtml(bestBet.marketName)}</span>
        <span>Edge: ${formatEdge(bestBet.edge)}</span>
        <span>Confidence: ${escapeHtml(bestBet.confidence)}</span>
        <span>Credibility: ${escapeHtml(bestBet.credibility || bestBet.trust || "n/a")}</span>
      </div>
      <p>${escapeHtml(bestBet.reason)}</p>
    </section>
  `;
}

function bestCurrentAngle(markets) {
  const candidates = Object.values(markets ?? {})
    .filter((market) => market?.bestOption)
    .sort((left, right) => {
      const leftEdge = left.bestOption.edge ?? -999;
      const rightEdge = right.bestOption.edge ?? -999;
      if (rightEdge !== leftEdge) {
        return rightEdge - leftEdge;
      }

      return (right.bestOption.modelProbability ?? 0) - (left.bestOption.modelProbability ?? 0);
    });

  return candidates[0] ?? null;
}

function humanizeUiCopy(text) {
  return String(text ?? "")
    .replaceAll("No usable odds stored yet.", "No reliable price available yet.")
    .replaceAll("No usable bookmaker price is stored yet.", "No reliable price available yet.")
    .replaceAll("The setup is still too fragile.", "Data quality is too weak for a bet.")
    .replaceAll("There is a lean here, but not a clean bet yet.", "There is a lean here, but not a bet yet.")
    .replaceAll("No lineup read", "Lineups not clear yet")
    .trim();
}

function sidebarDecisionState(match) {
  if (!match?.probabilities) {
    return { label: "Pending", tone: "pending" };
  }

  if (match.recommendation?.assessment && match.recommendation.assessment !== "No Bet") {
    return { label: "Bet", tone: "bet" };
  }

  if (match.hasOdds) {
    return { label: "No bet", tone: "no-bet" };
  }

  return { label: "Pending", tone: "pending" };
}

function marketKeyFromName(marketName) {
  if (marketName === "Over / Under 2.5") {
    return "totals25";
  }

  if (marketName === "BTTS") {
    return "btts";
  }

  return "oneXTwo";
}

function decisionLabelForSelection(match, marketName, selectionLabel) {
  if (!selectionLabel) {
    return "BET";
  }

  if (marketName === "1X2") {
    if (selectionLabel === "Draw") {
      return "BET: DRAW";
    }

    if (selectionLabel === match.homeTeam) {
      return "BET: HOME WIN";
    }

    if (selectionLabel === match.awayTeam) {
      return "BET: AWAY WIN";
    }
  }

  return `BET: ${selectionLabel.toUpperCase()}`;
}

function plainDataQualityLabel(detail, focusMarket) {
  const hasAnyOdds = Object.values(detail.markets ?? {}).some((market) => market.hasOdds);
  const focusHasOdds = Boolean(focusMarket?.hasOdds && focusMarket?.bestOption?.bookmakerOdds);

  if (!hasAnyOdds || !focusHasOdds) {
    return "No reliable price available yet";
  }

  if (detail.bestBet?.hasBet) {
    return "Price looks usable";
  }

  return "Price quality is too weak";
}

function buildDecisionReason(detail, focusMarket) {
  if (detail.bestBet?.hasBet) {
    return humanizeUiCopy(detail.bestBet.reason || detail.analysis.verdict);
  }

  if (!Object.values(detail.markets ?? {}).some((market) => market.hasOdds)) {
    return "No reliable price available yet. The model may have a lean, but there is nothing trustworthy enough to bet.";
  }

  return humanizeUiCopy(
    detail.context.attention?.note ||
    focusMarket?.recommendation?.shortReason ||
    detail.analysis.verdict
  );
}

function buildModelMarketSummary(detail, focusMarket) {
  const option = focusMarket?.bestOption;
  const lean = topResult(detail.overview.probabilities, detail.match);

  if (!option?.bookmakerOdds) {
    return `${escapeHtml(lean.label)} is the top model lean at ${percent(lean.probability)}, but there is no reliable price to compare yet.`;
  }

  const marketProbability = option.impliedProbability ? percent(option.impliedProbability) : "n/a";
  return `${escapeHtml(focusMarket.name)} leans ${escapeHtml(option.shortLabel)} at ${percent(option.modelProbability)} on the model versus ${marketProbability} on the market. Book ${formatOdds(option.bookmakerOdds)} versus fair ${formatOdds(option.fairOdds)}.`;
}

function renderDecisionBanner(detail) {
  const focusMarket = detail.bestBet?.hasBet
    ? detail.markets[marketKeyFromName(detail.bestBet.marketName)]
    : bestCurrentAngle(detail.markets);
  const option = focusMarket?.bestOption ?? null;
  const decisionLabel = detail.bestBet?.hasBet
    ? decisionLabelForSelection(detail.match, detail.bestBet.marketName, detail.bestBet.selectionLabel)
    : "NO BET";
  const decisionTone = detail.bestBet?.hasBet ? "bet" : "no-bet";
  const statusLine = [
    detail.bestBet?.hasBet ? `${detail.bestBet.marketName}` : "Discipline first",
    detail.analysis?.confidence?.level ?? "Low",
    plainDataQualityLabel(detail, focusMarket)
  ].filter(Boolean).join(" · ");
  const reason = buildDecisionReason(detail, focusMarket);
  const modelMarketSummary = buildModelMarketSummary(detail, focusMarket);

  return `
    <section class="decision-banner decision-banner--${decisionTone}">
      <div class="decision-banner-main">
        <span class="eyebrow">Current decision</span>
        <strong class="decision-title">${escapeHtml(decisionLabel)}</strong>
        <p class="decision-status-line">${escapeHtml(statusLine)}</p>
        <p class="decision-reason">${escapeHtml(reason)}</p>
      </div>
      <div class="decision-banner-side">
        <article class="decision-mini">
          <span>Reason</span>
          <strong>${escapeHtml(detail.bestBet?.hasBet ? "Model and price line up" : "No clean bet setup")}</strong>
        </article>
        <article class="decision-mini">
          <span>Model vs market</span>
          <strong>${option?.bookmakerOdds ? `${percent(option.modelProbability)} / ${option.impliedProbability ? percent(option.impliedProbability) : "n/a"}` : `${percent(topResult(detail.overview.probabilities, detail.match).probability)} model lean`}</strong>
        </article>
        <article class="decision-mini">
          <span>Book vs fair</span>
          <strong>${option?.bookmakerOdds ? `${formatOdds(option.bookmakerOdds)} / ${formatOdds(option.fairOdds)}` : "n/a"}</strong>
        </article>
        <article class="decision-mini">
          <span>Data quality</span>
          <strong>${escapeHtml(plainDataQualityLabel(detail, focusMarket))}</strong>
        </article>
      </div>
      <p class="decision-banner-summary">${modelMarketSummary}</p>
    </section>
  `;
}

function renderDecisionCard(detail) {
  return renderDecisionBanner(detail);
}

function renderMatchHeader(detail, lineupMeta, pinned) {
  return `
    <div class="detail-hero">
      <div class="detail-header detail-header-simple">
        <div class="detail-hero-copy">
          <p class="eyebrow">${escapeHtml(detail.match.competitionName)}</p>
          <h2>${escapeHtml(detail.match.name)}</h2>
          <p class="meta">${escapeHtml(detail.match.kickoffLabel)} | ${escapeHtml(detail.match.stage || "Stage n/a")} | ${escapeHtml(detail.match.status)}</p>
          <div class="detail-hero-tags">
            ${renderPill(lineupMeta.value, "lineup")}
            ${renderPill(detail.bestBet?.hasBet ? "Bet live" : "No bet", detail.bestBet?.hasBet ? "attention" : "coverage")}
          </div>
        </div>
        <button class="match-pin-button match-pin-button-detail ${pinned ? "is-pinned" : ""}" type="button" data-pin-current-match="${detail.match?.id ?? state.selectedMatchId}" aria-label="${pinned ? "Unpin match" : "Pin match"}">${pinned ? "Pinned match" : "Pin match"}</button>
      </div>
    </div>
  `;
}

function renderModelLean(detail) {
  const lean = topResult(detail.overview.probabilities, detail.match);
  const hasAnyOdds = Object.values(detail.markets ?? {}).some((market) => market.hasOdds);
  const note = hasAnyOdds
    ? "Most likely result on the model. That does not automatically make it a bet."
    : "Most likely result on the model. Betting call stays No Bet until usable odds are stored.";

  return `
    <section class="panel summary-panel">
      <h3>Model Lean</h3>
      <p class="analysis-copy"><strong>${escapeHtml(lean.label)}</strong> at ${percent(lean.probability)}. ${escapeHtml(note)}</p>
    </section>
  `;
}

function renderMarketPanel(panel) {
  const option = panel.bestOption;
  const implied = option.impliedProbability ? percent(option.impliedProbability) : "n/a";
  const price = option.bookmakerOdds ? formatOdds(option.bookmakerOdds) : "n/a";
  const watchPrice = option.targetOdds ? formatOdds(option.targetOdds) : "n/a";
  const disagreement = option.disagreement === null || option.disagreement === undefined
    ? "n/a"
    : `${(option.disagreement * 100).toFixed(1)} pts`;
  const moveText = option.movement === null || option.movement === undefined
    ? "n/a"
    : `${option.movement > 0 ? "+" : ""}${option.movement.toFixed(2)}`;
  const actionLabel = panel.recommendation.isNoBet ? "No Bet" : panel.recommendation.action;

  return `
    <article class="market-card">
      <div class="market-card-header">
        <div>
          <span class="eyebrow">${escapeHtml(panel.name)}</span>
          <h3>${escapeHtml(option.shortLabel || "No Bet")}</h3>
          <p class="market-headline">${escapeHtml(panel.recommendation.isNoBet ? "Lean only for now." : panel.recommendation.headline)}</p>
        </div>
        <span class="market-call ${panel.recommendation.isNoBet ? "no-bet" : "playable"}">${escapeHtml(actionLabel)}</span>
      </div>
      <div class="market-line"><span>Model / Market</span><strong>${percent(option.modelProbability)} / ${implied}</strong></div>
      <div class="market-line"><span>Book / Fair</span><strong>${price} / ${formatOdds(option.fairOdds)}</strong></div>
      <div class="market-line"><span>Edge / Credibility</span><strong>${formatEdge(option.edge)} / ${escapeHtml(panel.recommendation.credibilityLabel || panel.recommendation.trustLabel)}</strong></div>
      <div class="market-line"><span>Now / Bet above</span><strong>${price} / ${watchPrice}</strong></div>
      <div class="market-line"><span>Market gap</span><strong>${disagreement}</strong></div>
      <div class="market-line"><span>Market move</span><strong>${moveText}</strong></div>
      <p class="market-copy"><strong>Why:</strong> ${escapeHtml(panel.recommendation.shortReason)}</p>
      <p class="market-copy"><strong>Risk:</strong> ${escapeHtml(panel.recommendation.riskNote)}</p>
      <p class="market-copy"><strong>Next:</strong> ${escapeHtml(panel.recommendation.triggerNote)}</p>
    </article>
  `;
}

function renderDetailTabs() {
  const tabs = [
    { key: "summary", label: "Summary" },
    { key: "market", label: "Market vs Model" },
    { key: "quality", label: "Data Quality" }
  ];

  return `
    <div class="detail-nav">
      ${tabs.map((tab) => `
        <button class="detail-tab ${state.detailSection === tab.key ? "is-active" : ""}" data-detail-section="${tab.key}" type="button">
          ${escapeHtml(tab.label)}
        </button>
      `).join("")}
    </div>
  `;
}

function renderInsightList(title, items, emptyText = "No additional notes.") {
  return `
    <article class="panel">
      <h3>${escapeHtml(title)}</h3>
      ${
        items?.length
          ? `<ul class="analysis-list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
          : `<p class="muted">${escapeHtml(emptyText)}</p>`
      }
    </article>
  `;
}

function renderTextPanel(title, text) {
  return `
    <article class="panel">
      <h3>${escapeHtml(title)}</h3>
      <p class="analysis-copy">${escapeHtml(text)}</p>
    </article>
  `;
}

function renderScorelines(scorelines) {
  if (!scorelines?.length) {
    return `<p class="muted">No scoreline summary available.</p>`;
  }

  return `
    <ul class="analysis-list">
      ${scorelines.map((item) => `
        <li>
          <strong>${escapeHtml(item.score)}</strong>
          <span>${escapeHtml(item.note)}</span>
        </li>
      `).join("")}
    </ul>
  `;
}

function renderOddsTable(detail) {
  const rows = detail.market.rows;

  if (!rows?.length) {
    return `<p class="muted">No 1X2 odds snapshot stored yet for this match.</p>`;
  }

  return `
    <table class="odds-table">
      <thead>
        <tr>
          <th>Bookmaker</th>
          <th>${escapeHtml(detail.match.homeTeam)}</th>
          <th>Draw</th>
          <th>${escapeHtml(detail.match.awayTeam)}</th>
          <th>Edge ${escapeHtml(detail.match.homeTeam)}</th>
          <th>Edge Draw</th>
          <th>Edge ${escapeHtml(detail.match.awayTeam)}</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => `
          <tr>
            <td>${escapeHtml(row.bookmakerTitle)}</td>
            <td>${formatOdds(row.homeOdds)}</td>
            <td>${formatOdds(row.drawOdds)}</td>
            <td>${formatOdds(row.awayOdds)}</td>
            <td>${formatEdge(row.edgeHome)}</td>
            <td>${formatEdge(row.edgeDraw)}</td>
            <td>${formatEdge(row.edgeAway)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderRecommendationHistory(rows) {
  if (!rows?.length) {
    return `<p class="muted">No stored recommendation history yet for this match.</p>`;
  }

  return `
    <div class="history-list">
      ${rows.map((row) => `
        <article class="history-item">
          <div class="history-top">
            <strong>${escapeHtml(row.best_market || "1X2")} - ${escapeHtml(row.selection_label || "No Bet")}</strong>
            <span class="history-badge ${row.bet_result === "won" ? "won" : row.bet_result === "lost" ? "lost" : "pass"}">${escapeHtml(row.bet_result || "open")}</span>
          </div>
          <div class="history-meta">
            <span>${escapeHtml(formatTimestamp(row.generated_at))}</span>
            <span>${escapeHtml(row.confidence)} confidence</span>
            <span>${escapeHtml(row.trust_label)} trust</span>
          </div>
          <p class="muted">${escapeHtml(row.grade_note || "Still open.")}</p>
        </article>
      `).join("")}
    </div>
  `;
}

function renderRecentMatches(title, matches) {
  if (!matches?.length) {
    return `
      <article class="panel">
        <h3>${escapeHtml(title)}</h3>
        <p class="muted">No recent results stored.</p>
      </article>
    `;
  }

  return `
    <article class="panel">
      <h3>${escapeHtml(title)}</h3>
      <ul class="analysis-list">
        ${matches.map((item) => `
          <li>
            <strong>${escapeHtml(item.result)} ${escapeHtml(item.scoreline)}</strong>
            <span>${escapeHtml(item.venue)} vs ${escapeHtml(item.opponent)}</span>
          </li>
        `).join("")}
      </ul>
    </article>
  `;
}

function renderContextPanel(detail) {
  const lines = [
    detail.context.venueName ? `Venue: ${detail.context.venueName}` : null,
    detail.context.venueCity ? `City: ${detail.context.venueCity}` : null,
    detail.context.venueCapacity ? `Capacity: ${detail.context.venueCapacity}` : null,
    detail.context.venueSurface ? `Surface: ${detail.context.venueSurface}` : null,
    detail.match.leg ? `Leg: ${detail.match.leg}` : null,
    detail.context.weatherSummary ? `Weather: ${detail.context.weatherSummary}` : null,
    detail.context.hasPremiumOdds ? "Premium odds flag available" : null
  ].filter(Boolean);

  return `
    <article class="panel">
      <h3>Match Context</h3>
      ${
        lines.length
          ? `<ul class="analysis-list">${lines.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
          : `<p class="muted">No extra venue or tie context stored yet.</p>`
      }
    </article>
  `;
}

function availabilityHeadline(teamName, availability) {
  if (availability.strongestLineupSource === "uefa-lineups" && (availability.expectedLineup?.length ?? 0) >= 9) {
    return `${teamName} has an official lineup source behind the XI read.`;
  }

  if ((availability.expectedLineup?.length ?? 0) >= 9 && (availability.lineupCertaintyScore ?? 0.5) >= 0.85) {
    return `${teamName} has a strong predicted lineup read.`;
  }

  if ((availability.missingStartersCount ?? 0) >= 2) {
    return `${teamName} may be short ${availability.missingStartersCount} likely starters.`;
  }

  if ((availability.missingStartersCount ?? 0) === 1) {
    const position = availability.missingKeyPositions?.[0];
    return position
      ? `${teamName} may be missing a key ${position}.`
      : `${teamName} may be missing one likely starter.`;
  }

  if ((availability.lineupCertaintyScore ?? 0.5) < 0.6) {
    return `${teamName} still has lineup uncertainty.`;
  }

  return `${teamName} looks close to full strength.`;
}

function availabilityNotes(availability) {
  const notes = [];

  if (availability.injuries?.length) {
    notes.push(`Injuries: ${availability.injuries.slice(0, 3).map((item) => item.player).join(", ")}`);
  }

  if (availability.suspensions?.length) {
    notes.push(`Suspensions: ${availability.suspensions.slice(0, 2).map((item) => item.player).join(", ")}`);
  }

  if (availability.expectedLineup?.length) {
    notes.push(`Predicted XI certainty: ${Math.round((availability.lineupCertaintyScore ?? 0.5) * 100)}%`);
  }

  if (availability.structuredLineupSource && availability.strongestLineupSource) {
    notes.push(`Lineup source: ${availability.strongestLineupSource === "uefa-lineups" ? "official lineup feed" : availability.strongestLineupSource}`);
  }

  if (availability.structuredAbsenceSource && availability.strongestAbsenceSource) {
    notes.push(`Absence source: ${availability.strongestAbsenceSource}`);
  }

  if ((availability.sourceConflictScore ?? 0) >= 0.18) {
    notes.push("Public team-news sources are conflicting right now.");
  }

  if (availability.latestLineupExtractedAt) {
    notes.push(`Latest lineup pull: ${formatTimestamp(availability.latestLineupExtractedAt)}`);
  } else if (availability.hoursToKickoff !== null && availability.hoursToKickoff <= 6) {
    notes.push("No expected lineup stored yet inside the pre-match window.");
  }

  if (availability.sources?.length) {
    notes.push(`Sources: ${availability.sources.join(", ")}`);
  }

  return notes;
}

function renderAvailabilityPanel(detail) {
  const home = detail.availability.home;
  const away = detail.availability.away;

  return `
    <section class="grid grid-two">
      <article class="panel">
        <h3>${escapeHtml(detail.match.homeTeam)} Availability</h3>
        <p class="analysis-copy">${escapeHtml(availabilityHeadline(detail.match.homeTeam, home))}</p>
        <ul class="analysis-list">
          ${availabilityNotes(home).length
            ? availabilityNotes(home).map((item) => `<li>${escapeHtml(item)}</li>`).join("")
            : `<li>No public availability detail stored yet.</li>`}
        </ul>
      </article>
      <article class="panel">
        <h3>${escapeHtml(detail.match.awayTeam)} Availability</h3>
        <p class="analysis-copy">${escapeHtml(availabilityHeadline(detail.match.awayTeam, away))}</p>
        <ul class="analysis-list">
          ${availabilityNotes(away).length
            ? availabilityNotes(away).map((item) => `<li>${escapeHtml(item)}</li>`).join("")
            : `<li>No public availability detail stored yet.</li>`}
        </ul>
      </article>
    </section>
  `;
}

function renderNewsList(items, emptyMessage) {
  if (!items?.length) {
    return `<p class="muted">${escapeHtml(emptyMessage)}</p>`;
  }

  return `
    <ul class="analysis-list">
      ${items.map((item) => `
        <li>
          <strong>${escapeHtml(item.title)}</strong>
          ${item.summary ? `<div class="muted">${escapeHtml(item.summary)}</div>` : ""}
          <div class="muted">${escapeHtml(item.provider)}${item.published_at ? ` | ${escapeHtml(formatTimestamp(item.published_at))}` : ""}</div>
        </li>
      `).join("")}
    </ul>
  `;
}

function renderNewsPanel(detail) {
  return `
    <section class="grid grid-two">
      <article class="panel">
        <h3>${escapeHtml(detail.match.homeTeam)} News Watch</h3>
        <p class="analysis-copy">Supplemental public headlines only. These do not override structured injuries or lineups.</p>
        ${renderNewsList(detail.news.home, "No stored public headlines for this team yet.")}
      </article>
      <article class="panel">
        <h3>${escapeHtml(detail.match.awayTeam)} News Watch</h3>
        <p class="analysis-copy">Useful for context, but not treated as confirmed team news on its own.</p>
        ${renderNewsList(detail.news.away, "No stored public headlines for this team yet.")}
      </article>
    </section>
  `;
}

function renderTechnicalPanel(detail) {
  return `
    <section class="panel technical-panel">
      <h3>Technical Details</h3>
      <div class="stats-grid">
        <div class="metric">
          <span>Coverage blend</span>
          <strong>${coveragePercent(detail.technical.diagnostics.coverageBlend)}</strong>
        </div>
        <div class="metric">
          <span>Baseline expected goals</span>
          <strong>${detail.technical.diagnostics.baselineExpectedGoals.home} - ${detail.technical.diagnostics.baselineExpectedGoals.away}</strong>
        </div>
        <div class="metric">
          <span>Feature-driven expected goals</span>
          <strong>${detail.technical.diagnostics.featureDrivenExpectedGoals.home} - ${detail.technical.diagnostics.featureDrivenExpectedGoals.away}</strong>
        </div>
        <div class="metric">
          <span>Implied gap</span>
          <strong>${detail.technical.impliedGap ? `${formatEdge(detail.technical.impliedGap.home * 100)} / ${formatEdge(detail.technical.impliedGap.away * 100)}` : "n/a"}</strong>
        </div>
      </div>
      <div class="technical-factor-list">
        ${detail.technical.factors.map((factor) => `
          <div class="factor-row">
            <div class="factor-copy">
              <strong>${escapeHtml(factor.label)}</strong>
              <span>${escapeHtml(String(factor.value))}</span>
            </div>
            <div class="factor-track">
              <div class="factor-fill ${factor.impact >= 0 ? "positive" : "negative"}" style="width:${Math.min(Math.abs(factor.impact) * 120, 100)}%"></div>
            </div>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function bindModeToggle() {
  detailViewEl.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.analysisMode = button.dataset.mode;
      if (state.currentDetail) {
        renderDetail(state.currentDetail);
      }
    });
  });
}

function bindDetailTabs() {
  detailViewEl.querySelectorAll("[data-detail-section]").forEach((button) => {
    button.addEventListener("click", () => {
      state.detailSection = button.dataset.detailSection;
      if (state.currentDetail) {
        renderDetail(state.currentDetail);
      }
    });
  });
}

function renderSummarySection(detail) {
  const lineupMeta = lineupStatusMeta(detail);
  const focusMarket = detail.bestBet?.hasBet
    ? detail.markets[marketKeyFromName(detail.bestBet.marketName)]
    : bestCurrentAngle(detail.markets);

  return `
    ${renderDecisionCard(detail)}

    <section class="grid grid-two">
      ${renderTextPanel("Why this call", humanizeUiCopy(detail.analysis.verdict))}
      ${renderTextPanel("Model vs market", buildModelMarketSummary(detail, focusMarket))}
    </section>

    <section class="grid grid-two">
      ${renderTextPanel("Most likely result", humanizeUiCopy(detail.analysis.modelLean))}
      ${renderTextPanel("What could change it", humanizeUiCopy(detail.analysis.watchTriggers?.[0] || detail.analysis.whyNot))}
    </section>

    <details class="panel secondary-details" open>
      <summary>Open decision details</summary>
      <div class="decision-mini-grid">
        <article class="decision-mini">
          <span>Lineups</span>
          <strong>${escapeHtml(lineupMeta.value)}</strong>
          <small>${escapeHtml(lineupMeta.note)}</small>
        </article>
        <article class="decision-mini">
          <span>Confidence</span>
          <strong>${escapeHtml(detail.analysis.confidence.level)}</strong>
          <small>${escapeHtml((detail.analysis.confidence.reasons ?? [])[0] || "No extra confidence note stored.")}</small>
        </article>
        <article class="decision-mini">
          <span>Data depth</span>
          <strong>${coveragePercent(detail.overview.dataCoverageScore)}</strong>
          <small>${escapeHtml(coverageLabel(detail.overview.dataCoverageScore))} match context</small>
        </article>
        <article class="decision-mini">
          <span>Current focus</span>
          <strong>${escapeHtml(focusMarket?.name ?? "No market")}</strong>
          <small>${escapeHtml(focusMarket?.bestOption?.shortLabel || "No reliable price available yet.")}</small>
        </article>
      </div>
    </details>
  `;
}

function renderMarketVsModelSection(detail) {
  return `
    <section class="grid grid-two">
      <article class="panel">
        <h3>Model lean</h3>
        ${renderProbabilityBars(detail.overview.probabilities, detail.match)}
      </article>
      <article class="panel">
        <h3>Most likely scorelines</h3>
        ${renderScorelines(detail.analysis.scorelines)}
      </article>
    </section>

    <section class="market-grid">
      ${renderMarketPanel(detail.markets.oneXTwo)}
      ${renderMarketPanel(detail.markets.totals25)}
      ${renderMarketPanel(detail.markets.btts)}
    </section>

    <section class="grid grid-two">
      <article class="panel">
        <h3>Recommendation history</h3>
        ${renderRecommendationHistory(detail.recommendationHistory)}
      </article>
      <article class="panel">
        <h3>Analyst summary</h3>
        <p class="analysis-copy">${escapeHtml(humanizeUiCopy(detail.analysis.summary))}</p>
      </article>
    </section>
  `;
}

function renderDataQualitySection(detail) {
  return `
    <section class="grid grid-two">
      <article class="panel">
        <h3>Price quality</h3>
        <div class="decision-mini-grid">
          <article class="decision-mini">
            <span>Primary bookmaker</span>
            <strong>${escapeHtml(detail.market.selectedBookmaker?.bookmakerTitle || "Not available")}</strong>
            <small>Current comparison source</small>
          </article>
          <article class="decision-mini">
            <span>Last snapshot</span>
            <strong>${escapeHtml(formatTimestamp(detail.market.selectedBookmaker?.retrievedAt))}</strong>
            <small>Latest stored price time</small>
          </article>
          <article class="decision-mini">
            <span>Data depth</span>
            <strong>${coveragePercent(detail.overview.dataCoverageScore)}</strong>
            <small>${escapeHtml(coverageLabel(detail.overview.dataCoverageScore))} match context</small>
          </article>
          <article class="decision-mini">
            <span>Lineups</span>
            <strong>${escapeHtml(lineupStatusMeta(detail).value)}</strong>
            <small>${escapeHtml(lineupStatusMeta(detail).note)}</small>
          </article>
        </div>
      </article>
      <article class="panel">
        <h3>Price notes</h3>
        <ul class="analysis-list">
          <li>${escapeHtml(humanizeUiCopy(detail.markets.oneXTwo.recommendation.triggerNote))}</li>
          <li>${escapeHtml(humanizeUiCopy(detail.markets.totals25.recommendation.triggerNote))}</li>
          <li>${escapeHtml(humanizeUiCopy(detail.markets.btts.recommendation.triggerNote))}</li>
        </ul>
      </article>
    </section>

    ${renderAvailabilityPanel(detail)}
    ${renderNewsPanel(detail)}

    <section class="grid grid-two">
      <article class="panel">
        <h3>Context</h3>
        <div class="stat-pair"><span>Venue</span><strong>${escapeHtml(detail.context.venueName || "n/a")}</strong></div>
        <div class="stat-pair"><span>Weather</span><strong>${escapeHtml(detail.context.weatherSummary || "n/a")}</strong></div>
        <div class="stat-pair"><span>${escapeHtml(detail.match.homeTeam)}</span><strong>${detail.standings.home?.position ? `Pos ${detail.standings.home.position}` : "n/a"}</strong></div>
        <div class="stat-pair"><span>${escapeHtml(detail.match.awayTeam)}</span><strong>${detail.standings.away?.position ? `Pos ${detail.standings.away.position}` : "n/a"}</strong></div>
      </article>
      ${renderTechnicalPanel(detail)}
    </section>

    <section class="panel">
      <h3>1X2 odds table</h3>
      <p class="muted">Primary bookmaker: ${escapeHtml(detail.market.selectedBookmaker?.bookmakerTitle || "n/a")} | Last snapshot: ${escapeHtml(formatTimestamp(detail.market.selectedBookmaker?.retrievedAt))}</p>
      ${renderOddsTable(detail)}
    </section>
  `;
}

function renderTeamNewsSection(detail) {
  return `
    <section class="grid grid-two">
      ${renderRecentMatches(`${detail.match.homeTeam} Recent Results`, detail.form.homeRecentMatches)}
      ${renderRecentMatches(`${detail.match.awayTeam} Recent Results`, detail.form.awayRecentMatches)}
    </section>
    ${renderAvailabilityPanel(detail)}
    ${renderNewsPanel(detail)}
    <section class="grid grid-two">
      <article class="panel">
        <h3>Standings Context</h3>
        <div class="stat-pair"><span>${escapeHtml(detail.match.homeTeam)}</span><strong>${detail.standings.home?.position ? `Pos ${detail.standings.home.position}` : "n/a"}</strong></div>
        <div class="stat-pair"><span>${escapeHtml(detail.match.awayTeam)}</span><strong>${detail.standings.away?.position ? `Pos ${detail.standings.away.position}` : "n/a"}</strong></div>
      </article>
      ${renderContextPanel(detail)}
    </section>
  `;
}

function renderPricesSection(detail) {
  return `
    <section class="grid grid-two">
      <article class="panel">
        <h3>1X2 Win Probabilities</h3>
        <p class="muted">This is the match-result view only. It can differ from the best overall bet above.</p>
        ${renderProbabilityBars(detail.overview.probabilities, detail.match)}
      </article>
      <article class="panel">
        <h3>Most Likely Scorelines</h3>
        ${renderScorelines(detail.analysis.scorelines)}
      </article>
    </section>

    <section class="grid grid-two">
      <article class="panel">
        <h3>1X2 Odds Table</h3>
        <p class="muted">Primary bookmaker: ${escapeHtml(detail.market.selectedBookmaker?.bookmakerTitle || "n/a")} | Last snapshot: ${escapeHtml(formatTimestamp(detail.market.selectedBookmaker?.retrievedAt))}</p>
        ${renderOddsTable(detail)}
      </article>
      <article class="panel">
        <h3>Market Notes</h3>
        <ul class="analysis-list">
          <li>${escapeHtml(detail.markets.oneXTwo.recommendation.triggerNote)}</li>
          <li>${escapeHtml(detail.markets.totals25.recommendation.triggerNote)}</li>
          <li>${escapeHtml(detail.markets.btts.recommendation.triggerNote)}</li>
        </ul>
      </article>
    </section>
  `;
}

function renderHistorySection(detail) {
  return `
    <section class="grid grid-two">
      <article class="panel">
        <h3>Recommendation History</h3>
        ${renderRecommendationHistory(detail.recommendationHistory)}
      </article>
      <article class="panel">
        <h3>Analyst View</h3>
        <p class="analysis-copy">${escapeHtml(detail.analysis.summary)}</p>
      </article>
    </section>
  `;
}

function renderDetail(detail) {
  const safeDetail = normalizeDetail(detail);
  state.currentDetail = safeDetail;
  const lineupMeta = lineupStatusMeta(safeDetail);
  const pinned = isPinnedMatch(safeDetail.match?.id ?? state.selectedMatchId);

  detailViewEl.innerHTML = `
    ${renderMatchHeader(safeDetail, lineupMeta, pinned)}
    ${renderDetailTabs()}

    <section class="detail-section">
      ${
        state.detailSection === "summary"
          ? renderSummarySection(safeDetail)
          : state.detailSection === "market"
            ? renderMarketVsModelSection(safeDetail)
            : renderDataQualitySection(safeDetail)
      }
    </section>
  `;

  bindDetailTabs();
  detailViewEl.querySelector("[data-pin-current-match]")?.addEventListener("click", () => {
    togglePinnedMatch(Number(safeDetail.match?.id ?? state.selectedMatchId));
    renderMatches(state.matches);
    renderDetail(safeDetail);
  });
}

async function loadMatches() {
  setStatus("Loading match list...");
  const query = state.competition ? `?competition=${state.competition}` : "";

  try {
    const payload = await fetchJson(`/api/matches${query}`);
    state.matches = payload.matches;
    renderMatches(payload.matches);
    setStatus(`Loaded ${payload.matches.length} upcoming matches.`);

    if (state.selectedMatchId) {
      const exists = payload.matches.some((match) => match.id === state.selectedMatchId);
      if (exists) {
        await openMatch(state.selectedMatchId, false);
      } else if (payload.matches[0]) {
        await openMatch(payload.matches[0].id, false);
      }
    } else if (payload.matches[0]) {
      await openMatch(payload.matches[0].id, false);
    }
  } catch (error) {
    setStatus(error.message, "error");
    matchListEl.innerHTML = "";
  }
}

async function loadBacktest() {
  backtestViewEl.textContent = "Loading performance dashboard...";

  try {
    const competition = backtestFilterEl.value;
    const query = competition ? `?competition=${competition}` : "";
    const payload = await fetchJson(`/api/performance${query}`);
    const forward = payload.dashboard?.summary ?? {};
    const blind = payload.blindTest?.summary ?? {};
    const marketRows = payload.blindTest?.byMarket ?? [];
    const calibration = payload.blindTest?.calibration ?? {};
    const trustRows = payload.dashboard?.byTrust ?? [];
    const recentRows = payload.dashboard?.recent ?? [];
    const modelStatus = payload.modelStatus ?? {};
    const decisionPolicyStatus = payload.decisionPolicyStatus ?? {};
    const trustReadiness = payload.trustReadiness ?? {};
    const activeModel = modelStatus.active ?? null;
    const latestModel = modelStatus.latest ?? null;
    const activeDecisionPolicy = decisionPolicyStatus.active ?? null;
    const latestDecisionPolicy = decisionPolicyStatus.latest ?? null;

    backtestViewEl.innerHTML = `
      <section class="performance-stack">
        ${renderReadinessPanel(payload)}
        ${renderAdvancedStatsPanel(payload)}

        <article class="panel trust-readiness-panel">
          <div class="detail-header">
            <div>
              <h3>Trust Readiness</h3>
              <p class="analysis-copy">This is the current honesty score for how much the app deserves to be trusted right now, not how confident the model sounds.</p>
            </div>
            <div class="detail-actions">
              <span class="provider-chip ${trustReadiness.status === "ready" ? "active" : trustReadiness.status === "improving" ? "pending" : "inactive"}">
                ${escapeHtml(`${trustReadiness.trustPercent ?? 0}% / ${trustReadiness.targetPercent ?? 80}% target`)}
              </span>
            </div>
          </div>

          <div class="grid grid-four">
            ${Object.values(trustReadiness.components ?? {}).map((component) => `
              <article class="metric">
                <span>${escapeHtml(component.label)}</span>
                <strong>${escapeHtml(String(component.score ?? 0))}%</strong>
                <small class="muted">${escapeHtml(String(component.current ?? "n/a"))}</small>
              </article>
            `).join("")}
          </div>

          <div class="grid grid-two">
            <article class="panel panel-embedded">
              <h3>Main Blockers</h3>
              ${
                trustReadiness.blockers?.length
                  ? `<ul class="analysis-list">${trustReadiness.blockers.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
                  : `<p class="muted">No major blockers right now.</p>`
              }
            </article>
            <article class="panel panel-embedded">
              <h3>What Moves It Toward 80%</h3>
              ${
                trustReadiness.nextSteps?.length
                  ? `<ul class="analysis-list">${trustReadiness.nextSteps.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
                  : `<p class="muted">The app is already close to the trust target.</p>`
              }
            </article>
          </div>
        </article>

        <article class="panel">
          <h3>Active Model</h3>
          ${
            activeModel
              ? `
                <p class="analysis-copy">Live predictions are using a promoted trained parameter set from ${escapeHtml(formatTimestamp(activeModel.trainedAt))}.</p>
                <ul class="analysis-list">
                  <li>Training sample: ${activeModel.sampleCount}</li>
                  <li>Holdout sample: ${activeModel.holdoutCount}</li>
                  <li>Holdout log loss: ${activeModel.holdoutLogLoss ?? "n/a"}</li>
                  <li>Holdout goal MSE: ${activeModel.holdoutGoalMse ?? "n/a"}</li>
                </ul>
              `
              : latestModel
                ? `
                  <p class="analysis-copy">The app is still using default coefficients. The latest trained candidate from ${escapeHtml(formatTimestamp(latestModel.trainedAt))} was ${escapeHtml(latestModel.status)} because it did not beat the current baseline.</p>
                  <ul class="analysis-list">
                    <li>Training sample: ${latestModel.sampleCount}</li>
                    <li>Holdout sample: ${latestModel.holdoutCount}</li>
                    <li>Holdout log loss: ${latestModel.holdoutLogLoss ?? "n/a"}</li>
                    <li>Holdout goal MSE: ${latestModel.holdoutGoalMse ?? "n/a"}</li>
                  </ul>
                `
                : `<p class="analysis-copy">The app is still using default coefficients. Once enough settled matches are available, the training loop can promote a learned parameter set.</p>`
          }
        </article>

        <article class="panel">
          <h3>Decision Layer</h3>
          ${
            activeDecisionPolicy
              ? `
                <p class="analysis-copy">Live market decisions are using a trained policy set from ${escapeHtml(formatTimestamp(activeDecisionPolicy.trainedAt))}.</p>
                <ul class="analysis-list">
                  <li>Training sample: ${activeDecisionPolicy.sampleCount}</li>
                  <li>Holdout sample: ${activeDecisionPolicy.holdoutCount}</li>
                  <li>Holdout ROI: ${activeDecisionPolicy.holdoutRoi ?? "n/a"}%</li>
                  <li>Holdout hit rate: ${activeDecisionPolicy.holdoutHitRate ?? "n/a"}%</li>
                </ul>
              `
              : latestDecisionPolicy
                ? `
                  <p class="analysis-copy">The app is still using default market thresholds. The latest trained decision layer from ${escapeHtml(formatTimestamp(latestDecisionPolicy.trainedAt))} was ${escapeHtml(latestDecisionPolicy.status)}.</p>
                  <ul class="analysis-list">
                    <li>Training sample: ${latestDecisionPolicy.sampleCount}</li>
                    <li>Holdout sample: ${latestDecisionPolicy.holdoutCount}</li>
                    <li>Holdout ROI: ${latestDecisionPolicy.holdoutRoi ?? "n/a"}%</li>
                    <li>Holdout hit rate: ${latestDecisionPolicy.holdoutHitRate ?? "n/a"}%</li>
                  </ul>
                `
                : `<p class="analysis-copy">Market decisions are still using default thresholds. Once enough settled samples with prices exist, the app can promote a trained decision layer for 1X2, Over/Under, and BTTS.</p>`
          }
        </article>

        <div class="grid grid-four">
          <article class="metric">
            <span>Forward-tracked matches</span>
            <strong>${forward.trackedMatches ?? 0}</strong>
          </article>
          <article class="metric">
            <span>Forward ROI</span>
            <strong>${forward.roi === null ? "n/a" : `${forward.roi}%`}</strong>
          </article>
          <article class="metric">
            <span>Blind sample bets</span>
            <strong>${blind.bets ?? 0}</strong>
          </article>
          <article class="metric">
            <span>Blind hit rate</span>
            <strong>${blind.hitRate === null ? "n/a" : `${blind.hitRate}%`}</strong>
          </article>
        </div>

        <div class="grid grid-two">
          <article class="panel">
            <h3>Forward Grading</h3>
            <ul class="analysis-list">
              <li>Tracked matches: ${forward.trackedMatches ?? 0}</li>
              <li>Bets placed: ${forward.bets ?? 0}</li>
              <li>Passes held: ${forward.passes ?? 0}</li>
              <li>Hit rate: ${forward.hitRate === null ? "n/a" : `${forward.hitRate}%`}</li>
              <li>Average ROI: ${forward.roi === null ? "n/a" : `${forward.roi}%`}</li>
            </ul>
          </article>
          <article class="panel">
            <h3>Blind Sample Test</h3>
            <p class="analysis-copy">This replays the last ${blind.modeledMatches ?? 0} settled matches in order, using only the data and odds snapshots that existed before kickoff.</p>
            <ul class="analysis-list">
              <li>Bets found: ${blind.bets ?? 0}</li>
              <li>Passes: ${blind.passes ?? 0}</li>
              <li>Model lean accuracy: ${blind.leanAccuracy === null ? "n/a" : `${blind.leanAccuracy}%`}</li>
              <li>Average ROI: ${blind.averageRoi === null ? "n/a" : `${blind.averageRoi}%`}</li>
              <li>Log loss: ${blind.logLoss ?? "n/a"}</li>
            </ul>
            <p class="muted">${escapeHtml(blind.warning || "")}</p>
          </article>
        </div>

        <article class="panel">
          <h3>Blind Sample by Market</h3>
          <table class="odds-table compact-table">
            <thead>
              <tr>
                <th>Market</th>
                <th>Bets</th>
                <th>Hit Rate</th>
                <th>ROI</th>
                <th>Avg Edge</th>
              </tr>
            </thead>
            <tbody>
              ${marketRows.map((row) => `
                <tr>
                  <td>${escapeHtml(row.market)}</td>
                  <td>${row.bets ?? 0}</td>
                  <td>${row.hitRate === null ? "n/a" : `${row.hitRate}%`}</td>
                  <td>${row.averageRoi === null ? "n/a" : `${row.averageRoi}%`}</td>
                  <td>${row.averageEdge === null ? "n/a" : `${row.averageEdge}%`}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </article>

        <article class="panel">
          <h3>Calibration</h3>
          <table class="odds-table compact-table">
            <thead>
              <tr>
                <th>Market</th>
                <th>Brier</th>
                <th>Sample buckets</th>
              </tr>
            </thead>
            <tbody>
              ${[
                { label: "1X2 lean", row: calibration.oneXTwo },
                { label: "Over 2.5", row: calibration.totals25 },
                { label: "BTTS Yes", row: calibration.btts }
              ].map((item) => `
                <tr>
                  <td>${escapeHtml(item.label)}</td>
                  <td>${item.row?.brier ?? "n/a"}</td>
                  <td>${item.row?.buckets?.length ?? 0}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
          <p class="muted">Lower Brier is better. Buckets compare predicted probability bands against what actually happened.</p>
        </article>

        <article class="panel">
          <h3>Calibration Buckets</h3>
          ${
            calibration.oneXTwo?.buckets?.length
              ? `
                <table class="odds-table compact-table">
                  <thead>
                    <tr>
                      <th>Bucket</th>
                      <th>1X2 Exp</th>
                      <th>1X2 Act</th>
                      <th>Over Exp</th>
                      <th>Over Act</th>
                      <th>BTTS Exp</th>
                      <th>BTTS Act</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${Array.from({ length: Math.max(calibration.oneXTwo?.buckets?.length ?? 0, calibration.totals25?.buckets?.length ?? 0, calibration.btts?.buckets?.length ?? 0) }, (_, index) => {
                      const one = calibration.oneXTwo?.buckets?.[index];
                      const over = calibration.totals25?.buckets?.[index];
                      const btts = calibration.btts?.buckets?.[index];
                      return `
                        <tr>
                          <td>${escapeHtml(one?.bucket ?? over?.bucket ?? btts?.bucket ?? "-")}</td>
                          <td>${one?.expected ?? "n/a"}%</td>
                          <td>${one?.actual ?? "n/a"}%</td>
                          <td>${over?.expected ?? "n/a"}%</td>
                          <td>${over?.actual ?? "n/a"}%</td>
                          <td>${btts?.expected ?? "n/a"}%</td>
                          <td>${btts?.actual ?? "n/a"}%</td>
                        </tr>
                      `;
                    }).join("")}
                  </tbody>
                </table>
              `
              : `<p class="muted">Not enough settled samples yet for calibration buckets.</p>`
          }
        </article>

        <article class="panel">
          <h3>Forward Results by Trust</h3>
          <table class="odds-table compact-table">
            <thead>
              <tr>
                <th>Trust</th>
                <th>Bets</th>
                <th>Hit Rate</th>
                <th>ROI</th>
              </tr>
            </thead>
            <tbody>
              ${trustRows.map((row) => `
                <tr>
                  <td>${escapeHtml(row.trustLabel)}</td>
                  <td>${row.bets ?? 0}</td>
                  <td>${row.hitRate === null ? "n/a" : `${row.hitRate}%`}</td>
                  <td>${row.roi === null ? "n/a" : `${row.roi}%`}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </article>

        <article class="panel">
          <h3>Latest Graded Calls</h3>
          ${
            recentRows.length
              ? `
                <table class="odds-table compact-table">
                  <thead>
                    <tr>
                      <th>Match</th>
                      <th>Call</th>
                      <th>Result</th>
                      <th>ROI</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${recentRows.map((row) => `
                      <tr>
                        <td>${escapeHtml(`${row.homeTeam} vs ${row.awayTeam}`)}</td>
                        <td>${escapeHtml(`${row.market}: ${row.selection}`)}</td>
                        <td>${escapeHtml(row.betResult || "open")}</td>
                        <td>${row.roi === null ? "n/a" : `${(row.roi * 100).toFixed(1)}%`}</td>
                      </tr>
                    `).join("")}
                  </tbody>
                </table>
              `
              : `<p class="muted">No graded calls yet.</p>`
          }
        </article>
      </section>
    `;

    backtestViewEl.querySelector("[data-run-xg-import]")?.addEventListener("click", triggerXgImport);
  } catch (error) {
    backtestViewEl.textContent = error.message;
  }
}

async function loadCollectorStatus() {
  setCollectorStatus("Loading collector status...");

  try {
    const payload = await fetchJson("/api/collector/status");
    const latest = payload.latestRun;

    if (!latest) {
      setCollectorStatus("Collector not run yet.");
      return;
    }

    const summary = latest.summary?.analysis;
    const statusLabel = latest.status === "success"
      ? "Collector OK"
      : latest.status === "partial"
        ? "Collector partial"
        : latest.status === "failed"
          ? "Collector failed"
          : "Collector running";
    const message = [
      statusLabel,
      summary ? `${summary.analyzedMatches} analyzed` : null,
      summary ? `${summary.withOdds} with prices` : null
    ].filter(Boolean).join(" · ");

    setCollectorStatus(message, latest.status === "failed" ? "error" : latest.status === "partial" ? "warning" : "success");
  } catch (error) {
    setCollectorStatus(error.message, "error");
  }
}

async function loadReminderStatus() {
  if (!reminderPanelEl) {
    return;
  }

  reminderPanelEl.textContent = "Loading reminders...";

  try {
    const payload = await fetchJson("/api/reminders/status?hoursAhead=24&limit=4");
    renderReminderPanel(payload);
  } catch (error) {
    reminderPanelEl.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
  }
}

async function loadAutomationDesk() {
  if (!automationDeskEl) {
    return;
  }

  automationDeskEl.textContent = "Loading automation desk...";

  try {
    const payload = await fetchJson("/api/automation-desk");
    renderAutomationDesk(payload);
  } catch (error) {
    automationDeskEl.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
  }
}

async function loadHealth() {
  if (!providerStackEl || !pipelineCopyEl) {
    return;
  }

  try {
    const payload = await fetchJson("/api/health");
    providerStackEl.innerHTML = [
      renderProviderChip("Sportmonks", payload.hasSportmonksConfig),
      renderProviderChip("football-data.org", payload.hasFootballDataConfig),
      renderProviderChip("The Odds API", payload.hasOddsConfig),
      payload.hasApiFootballConfig ? renderProviderChip("API-Football", true) : "",
      payload.backgroundJobs?.enabled ? renderProviderChip("Auto collector", true) : renderProviderChip("Auto collector", false),
      payload.backgroundJobs?.mode === "lineup-watch"
        ? renderProviderChip("Lineup watch", true)
        : payload.backgroundJobs?.mode === "pre-kickoff"
          ? renderProviderChip("Pre-kickoff mode", true)
          : ""
    ].join("");
    pipelineCopyEl.textContent = payload.primaryMatchProvider
      ? `${payload.primaryMatchProvider} is the primary UCL/UEL match feed. Background jobs keep collection every ${payload.backgroundJobs?.collector?.intervalMinutes ?? "?"} minutes and reminder checks every ${payload.backgroundJobs?.reminders?.intervalMinutes ?? "?"} minutes while the server stays online.${payload.backgroundJobs?.mode && payload.backgroundJobs.mode !== "normal" ? ` Current mode: ${payload.backgroundJobs.mode}.` : ""}`
      : "Add a football data provider and odds feed to seed the collector.";
  } catch (error) {
    providerStackEl.innerHTML = renderProviderChip("Health check failed", false);
    pipelineCopyEl.textContent = error.message;
  }
}

async function openMatch(matchId, pushState = true) {
  state.selectedMatchId = matchId;
  document.querySelectorAll(".match-card").forEach((card) => {
    card.classList.toggle("is-selected", Number(card.dataset.matchId) === matchId);
  });

  if (pushState) {
    history.pushState({ matchId }, "", `/matches/${matchId}`);
  }

  detailViewEl.innerHTML = `<div class="panel"><p>Loading analysis...</p></div>`;

  try {
    const payload = await fetchJson(`/api/matches/${matchId}`);
    renderDetail(payload);
  } catch (error) {
    detailViewEl.innerHTML = `<div class="panel"><p>${escapeHtml(error.message)}</p></div>`;
  }
}

async function triggerSync() {
  syncButtonEl.disabled = true;
  setStatus("Collector running...");

  try {
    await fetchJson("/api/collector/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ triggerSource: "ui" })
    });
    setStatus("Collector complete.");
    await Promise.all([loadMatches(), loadBacktest(), loadCollectorStatus(), loadHealth(), loadAutomationDesk()]);
    await loadReminderStatus();
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    syncButtonEl.disabled = false;
  }
}

async function triggerXgImport() {
  setStatus("Running xG import...");

  try {
    const result = await fetchJson("/api/xg/import", {
      method: "POST"
    });

    setStatus(`xG import finished: ${result.matchedRows ?? 0} rows matched, ${result.unmatchedRows ?? 0} unmatched.`, "success");
    await Promise.all([loadBacktest(), loadCollectorStatus()]);
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function applyDensitySelection() {
  densityToggleButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.density === state.cardDensity);
  });
}

function applyScanFilterSelection() {
  scanFilterButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.scanFilter === state.scanFilter);
  });
}

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", async () => {
    state.competition = button.dataset.competition;
    document.querySelectorAll(".tab").forEach((tab) => tab.classList.remove("is-active"));
    button.classList.add("is-active");
    await loadMatches();
  });
});

syncButtonEl.addEventListener("click", triggerSync);
backtestFilterEl.addEventListener("change", loadBacktest);
densityToggleButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    state.cardDensity = button.dataset.density === "compact" ? "compact" : "comfortable";
    window.localStorage?.setItem("matchCardDensity", state.cardDensity);
    applyDensitySelection();
    renderMatches(state.matches);
  });
});
scanFilterButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    state.scanFilter = button.dataset.scanFilter || "all";
    window.localStorage?.setItem("matchScanFilter", state.scanFilter);
    applyScanFilterSelection();
    renderMatches(state.matches);
  });
});
applyDensitySelection();
applyScanFilterSelection();

window.addEventListener("popstate", async () => {
  const parts = window.location.pathname.split("/");
  const maybeId = Number(parts[2]);
  state.selectedMatchId = Number.isFinite(maybeId) ? maybeId : null;
  await loadMatches();
});

await Promise.all([loadMatches(), loadBacktest(), loadHealth(), loadReminderStatus(), loadAutomationDesk()]);
await loadCollectorStatus();
