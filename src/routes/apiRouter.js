import { hasApiFootballConfig, hasFootballDataConfig, hasOddsConfig, hasSportmonksConfig } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { runBacktest, runBlindEvaluation } from "../modules/analysis/backtestService.js";
import { getDecisionPolicyStatus } from "../modules/analysis/decisionPolicyParameters.js";
import { getModelTrainingStatus } from "../modules/analysis/modelParameters.js";
import { buildProjectAudit } from "../modules/analysis/projectAuditService.js";
import { buildTrustReadiness } from "../modules/analysis/trustReadinessService.js";
import { trainDecisionPolicies } from "../modules/analysis/decisionTrainingService.js";
import {
  getReminderNotificationHistory,
  getUpcomingBetReminders,
  getUpcomingLineupReadyAlerts,
  sendUpcomingBetReminderEmails,
  sendUpcomingLineupReadyEmails
} from "../modules/analysis/reminderService.js";
import { trainModelParameters } from "../modules/analysis/trainingService.js";
import { getCollectorStatus, getForwardValidationReport, getPerformanceDashboard, getRecommendationHistory, runCollector } from "../modules/data/collectorService.js";
import { importNewsData } from "../modules/data/importers/newsImporter.js";
import { getOddsCoverageDiagnostics } from "../modules/data/oddsCoverageService.js";
import { getAdvancedStatsDiagnostics, importAdvancedStatsData } from "../modules/data/importers/xgImporter.js";
import { syncAllCompetitions, syncCompetition } from "../modules/data/syncService.js";
import { getBackgroundJobStatus } from "../modules/runtime/backgroundJobs.js";
import { getAutomationDesk } from "../modules/runtime/automationDeskService.js";
import { getMatchDetailView, getUpcomingMatchesView } from "../modules/reporting/viewModels.js";

function json(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function readBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

export async function handleApiRequest(request, response, url) {
  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      return json(response, 200, {
        ok: true,
        hasFootballDataConfig: hasFootballDataConfig(),
        hasApiFootballConfig: hasApiFootballConfig(),
        hasSportmonksConfig: hasSportmonksConfig(),
        hasOddsConfig: hasOddsConfig(),
        primaryMatchProvider: hasSportmonksConfig() ? "Sportmonks" : hasFootballDataConfig() ? "football-data.org" : null,
        backgroundJobs: getBackgroundJobStatus()
      });
    }

    if (request.method === "GET" && url.pathname === "/api/matches") {
      const competition = url.searchParams.get("competition");
      return json(response, 200, {
        matches: getUpcomingMatchesView(competition || null)
      });
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/matches/")) {
      const matchId = Number(url.pathname.split("/").pop());
      return json(response, 200, getMatchDetailView(matchId));
    }

    if (request.method === "GET" && url.pathname === "/api/backtest") {
      const competition = url.searchParams.get("competition");
      const limit = Number(url.searchParams.get("limit") ?? 80);
      return json(response, 200, runBacktest(competition || null, limit));
    }

    if (request.method === "GET" && url.pathname === "/api/performance") {
      const competition = url.searchParams.get("competition");
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const dashboard = getPerformanceDashboard(limit, competition || null);
      const blindTest = runBlindEvaluation(competition || null, limit);
      const modelStatus = getModelTrainingStatus();
      const decisionPolicyStatus = getDecisionPolicyStatus();
      const collectorStatus = getCollectorStatus();
      const oddsCoverage = getOddsCoverageDiagnostics();
      const advancedStats = getAdvancedStatsDiagnostics();
      return json(response, 200, {
        dashboard,
        blindTest,
        modelStatus,
        decisionPolicyStatus,
        collectorStatus,
        oddsCoverage,
        advancedStats,
        trustReadiness: buildTrustReadiness({
          competitionCode: competition || null,
          dashboard,
          blindTest,
          modelStatus,
          decisionPolicyStatus
        })
      });
    }

    if (request.method === "GET" && url.pathname === "/api/forward-validation") {
      const competition = url.searchParams.get("competition");
      const limit = Number(url.searchParams.get("limit") ?? 300);
      return json(response, 200, getForwardValidationReport(limit, competition || null));
    }

    if (request.method === "GET" && url.pathname === "/api/project-audit") {
      const competition = url.searchParams.get("competition");
      const limit = Number(url.searchParams.get("limit") ?? 100);
      return json(response, 200, buildProjectAudit({
        competitionCode: competition || null,
        blindLimit: limit
      }));
    }

    if (request.method === "GET" && url.pathname === "/api/automation-desk") {
      return json(response, 200, getAutomationDesk());
    }

    if (request.method === "GET" && url.pathname === "/api/model/status") {
      return json(response, 200, getModelTrainingStatus());
    }

    if (request.method === "GET" && url.pathname === "/api/decision-policy/status") {
      return json(response, 200, getDecisionPolicyStatus());
    }

    if (request.method === "GET" && url.pathname === "/api/collector/status") {
      return json(response, 200, getCollectorStatus());
    }

    if (request.method === "GET" && url.pathname === "/api/odds-coverage") {
      return json(response, 200, getOddsCoverageDiagnostics());
    }

    if (request.method === "GET" && url.pathname === "/api/recommendations/history") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      return json(response, 200, {
        snapshots: getRecommendationHistory(limit)
      });
    }

    if (request.method === "GET" && url.pathname === "/api/reminders/upcoming") {
      const hoursAhead = Number(url.searchParams.get("hoursAhead") ?? 2);
      return json(response, 200, {
        reminders: await getUpcomingBetReminders(hoursAhead, { refreshAvailability: true })
      });
    }

    if (request.method === "GET" && url.pathname === "/api/reminders/status") {
      const hoursAhead = Number(url.searchParams.get("hoursAhead") ?? 24);
      const historyLimit = Number(url.searchParams.get("limit") ?? 6);
      return json(response, 200, {
        upcoming: await getUpcomingBetReminders(Math.min(hoursAhead, 6), { refreshAvailability: false }),
        lineupAlerts: await getUpcomingLineupReadyAlerts(hoursAhead, { refreshAvailability: false }),
        history: getReminderNotificationHistory(historyLimit)
      });
    }

    if (request.method === "POST" && url.pathname === "/api/reminders/send") {
      const body = await readBody(request);
      const hoursAhead = Number(body.hoursAhead ?? 2);
      return json(response, 200, await sendUpcomingBetReminderEmails(hoursAhead));
    }

    if (request.method === "POST" && url.pathname === "/api/reminders/send-lineups") {
      const body = await readBody(request);
      const hoursAhead = Number(body.hoursAhead ?? 6);
      return json(response, 200, await sendUpcomingLineupReadyEmails(hoursAhead));
    }

    if (request.method === "POST" && url.pathname === "/api/collector/run") {
      const body = await readBody(request);
      const result = await runCollector({
        triggerSource: body.triggerSource ?? "manual"
      });
      return json(response, 200, result);
    }

    if (request.method === "POST" && url.pathname === "/api/news/import") {
      const body = await readBody(request);
      return json(response, 200, await importNewsData({
        limitDays: Number(body.limitDays ?? 7)
      }));
    }

    if (request.method === "POST" && url.pathname === "/api/xg/import") {
      return json(response, 200, importAdvancedStatsData());
    }

    if (request.method === "POST" && url.pathname === "/api/model/train") {
      const body = await readBody(request);
      const result = trainModelParameters({
        limit: Number(body.limit ?? 450)
      });
      return json(response, 200, result);
    }

    if (request.method === "POST" && url.pathname === "/api/decision-policy/train") {
      const body = await readBody(request);
      const result = trainDecisionPolicies({
        limit: Number(body.limit ?? 240)
      });
      return json(response, 200, result);
    }

    if (request.method === "POST" && url.pathname === "/api/sync") {
      const body = await readBody(request);
      const competition = body.competition;
      const result = competition ? [await syncCompetition(competition)] : await syncAllCompetitions();
      return json(response, 200, { results: result });
    }

    return json(response, 404, { error: "API route not found." });
  } catch (error) {
    logger.error("API request failed", {
      path: url.pathname,
      message: error.message
    });
    return json(response, 500, { error: error.message });
  }
}
