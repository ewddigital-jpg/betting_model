import { env, hasEmailConfig } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { maybeAutoTrainDecisionPolicies } from "../analysis/decisionTrainingService.js";
import { maybeAutoTrainModel } from "../analysis/trainingService.js";
import {
  getUpcomingMatchPressure,
  sendUpcomingBetReminderEmails,
  sendUpcomingLineupReadyEmails
} from "../analysis/reminderService.js";
import { runCollector } from "../data/collectorService.js";

const state = {
  startedAt: null,
  collector: {
    running: false,
    intervalMinutes: Math.max(30, env.collectorIntervalMinutes || 30),
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    lastUrgentRunAt: null,
    timer: null
  },
  reminders: {
    running: false,
    intervalMinutes: Math.max(5, env.reminderIntervalMinutes || 10),
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    timer: null
  },
  training: {
    running: false,
    intervalHours: Math.max(6, env.trainingIntervalHours || 24),
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    lastModelResult: null,
    lastDecisionResult: null,
    timer: null
  }
};

async function runCollectorJob(triggerSource = "background") {
  if (state.collector.running) {
    return;
  }

  state.collector.running = true;
  state.collector.lastRunAt = new Date().toISOString();
  state.collector.lastError = null;

  try {
    const result = await runCollector({ triggerSource });
    state.collector.lastStatus = result.status;
    if (triggerSource === "background-urgent") {
      state.collector.lastUrgentRunAt = new Date().toISOString();
    }
    logger.info("Background collector finished", {
      status: result.status
    });
  } catch (error) {
    state.collector.lastStatus = "failed";
    state.collector.lastError = error.message;
    logger.error("Background collector failed", { message: error.message });
  } finally {
    state.collector.running = false;
  }
}

function minutesSince(timestamp) {
  if (!timestamp) {
    return Number.POSITIVE_INFINITY;
  }

  return (Date.now() - new Date(timestamp).getTime()) / 60_000;
}

function collectorUrgencyWindow() {
  const pressure = getUpcomingMatchPressure();

  if (pressure.nextKickoffHours !== null && pressure.nextKickoffHours <= 1) {
    return {
      ...pressure,
      mode: "final-hour",
      collectorRefreshMinutes: 2
    };
  }

  if (pressure.hasWithinTwoHours) {
    return {
      ...pressure,
      mode: "lineup-watch",
      collectorRefreshMinutes: 3
    };
  }

  if (pressure.nextKickoffHours !== null && pressure.nextKickoffHours <= 3) {
    return {
      ...pressure,
      mode: "late-board",
      collectorRefreshMinutes: 5
    };
  }

  if (pressure.hasWithinSixHours) {
    return {
      ...pressure,
      mode: "pre-kickoff",
      collectorRefreshMinutes: 8
    };
  }

  if (pressure.nextKickoffHours !== null && pressure.nextKickoffHours <= 24) {
    return {
      ...pressure,
      mode: "upcoming-board",
      collectorRefreshMinutes: 25
    };
  }

  return {
    ...pressure,
    mode: "normal",
    collectorRefreshMinutes: null
  };
}

async function runReminderJob() {
  if (state.reminders.running) {
    return;
  }

  state.reminders.running = true;
  state.reminders.lastRunAt = new Date().toISOString();
  state.reminders.lastError = null;

  try {
    const urgency = collectorUrgencyWindow();

    if (
      urgency.collectorRefreshMinutes &&
      minutesSince(state.collector.lastRunAt) >= urgency.collectorRefreshMinutes &&
      minutesSince(state.collector.lastUrgentRunAt) >= urgency.collectorRefreshMinutes
    ) {
      await runCollectorJob("background-urgent");
    }

    const betEmails = await sendUpcomingBetReminderEmails(2);
    const lineupEmails = await sendUpcomingLineupReadyEmails(6);
    const status = [betEmails.status, lineupEmails.status].includes("failed")
      ? ([betEmails.status, lineupEmails.status].includes("success") || [betEmails.status, lineupEmails.status].includes("partial") ? "partial" : "failed")
      : [betEmails.status, lineupEmails.status].includes("partial")
        ? "partial"
        : "success";
    state.reminders.lastStatus = status;
    logger.info("Background reminder check finished", {
      status,
      betEmails,
      lineupEmails,
      mode: urgency.mode,
      nextKickoffHours: urgency.nextKickoffHours
    });
  } catch (error) {
    state.reminders.lastStatus = "failed";
    state.reminders.lastError = error.message;
    logger.error("Background reminder check failed", { message: error.message });
  } finally {
    state.reminders.running = false;
  }
}

async function runTrainingJob(triggerSource = "background-scheduled") {
  if (state.training.running) {
    return;
  }

  state.training.running = true;
  state.training.lastRunAt = new Date().toISOString();
  state.training.lastError = null;

  try {
    const modelResult = maybeAutoTrainModel();
    const decisionResult = maybeAutoTrainDecisionPolicies();
    state.training.lastModelResult = modelResult;
    state.training.lastDecisionResult = decisionResult;

    const statuses = [modelResult?.status, decisionResult?.status].filter(Boolean);
    state.training.lastStatus = statuses.includes("failed")
      ? "failed"
      : statuses.includes("promoted")
        ? "promoted"
        : statuses.includes("rejected")
          ? "rejected"
          : statuses.includes("skipped")
            ? "skipped"
            : "success";

    logger.info("Background training finished", {
      triggerSource,
      status: state.training.lastStatus,
      modelResult,
      decisionResult
    });
  } catch (error) {
    state.training.lastStatus = "failed";
    state.training.lastError = error.message;
    logger.error("Background training failed", { message: error.message, triggerSource });
  } finally {
    state.training.running = false;
  }
}

export function startBackgroundJobs() {
  if (!env.enableBackgroundJobs) {
    logger.info("Background jobs disabled by config");
    return;
  }

  if (state.startedAt) {
    return;
  }

  state.startedAt = new Date().toISOString();

  logger.info("Background jobs started", {
    collectorIntervalMinutes: state.collector.intervalMinutes,
    reminderIntervalMinutes: state.reminders.intervalMinutes,
    trainingIntervalHours: state.training.intervalHours,
    emailEnabled: hasEmailConfig()
  });

  runCollectorJob("background-start").catch(() => {});
  runReminderJob().catch(() => {});
  runTrainingJob("background-start").catch(() => {});

  state.collector.timer = setInterval(() => {
    runCollectorJob("background-scheduled").catch(() => {});
  }, state.collector.intervalMinutes * 60 * 1000);

  state.reminders.timer = setInterval(() => {
    runReminderJob().catch(() => {});
  }, state.reminders.intervalMinutes * 60 * 1000);

  state.training.timer = setInterval(() => {
    runTrainingJob("background-scheduled").catch(() => {});
  }, state.training.intervalHours * 60 * 60 * 1000);
}

export function getBackgroundJobStatus() {
  const urgency = collectorUrgencyWindow();

  return {
    enabled: env.enableBackgroundJobs,
    startedAt: state.startedAt,
    mode: urgency.mode,
    nextKickoff: urgency.nextKickoff,
    nextKickoffHours: urgency.nextKickoffHours,
    collector: {
      running: state.collector.running,
      intervalMinutes: state.collector.intervalMinutes,
      lastRunAt: state.collector.lastRunAt,
      lastUrgentRunAt: state.collector.lastUrgentRunAt,
      lastStatus: state.collector.lastStatus,
      lastError: state.collector.lastError
    },
    reminders: {
      running: state.reminders.running,
      intervalMinutes: state.reminders.intervalMinutes,
      lastRunAt: state.reminders.lastRunAt,
      lastStatus: state.reminders.lastStatus,
      lastError: state.reminders.lastError
    },
    training: {
      running: state.training.running,
      intervalHours: state.training.intervalHours,
      lastRunAt: state.training.lastRunAt,
      lastStatus: state.training.lastStatus,
      lastError: state.training.lastError,
      lastModelResult: state.training.lastModelResult,
      lastDecisionResult: state.training.lastDecisionResult
    }
  };
}
