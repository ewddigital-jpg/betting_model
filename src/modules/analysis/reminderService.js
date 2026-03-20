import { env, hasEmailConfig } from "../../config/env.js";
import { getDb } from "../../db/database.js";
import { isoNow } from "../../lib/time.js";
import { analyzeMatch } from "./analysisService.js";
import { getTeamRatingsMap, refreshTeamRatings } from "./eloEngine.js";
import { importAvailabilityData } from "../data/importers/availabilityImporter.js";
import { sendSmtpEmail } from "../notifications/emailService.js";

function upcomingMatchesWithin(hoursAhead = 2) {
  const db = getDb();
  return db.prepare(`
    SELECT id, utc_date
    FROM matches
    WHERE status != 'FINISHED'
      AND datetime(utc_date) >= datetime('now')
      AND datetime(utc_date) <= datetime('now', ?)
    ORDER BY datetime(utc_date) ASC
  `).all(`+${hoursAhead} hours`);
}

export function hasUpcomingMatchesWithin(hoursAhead = 6) {
  return upcomingMatchesWithin(hoursAhead).length > 0;
}

export function getUpcomingMatchPressure() {
  const withinTwo = upcomingMatchesWithin(2);
  const withinSix = upcomingMatchesWithin(6);
  const nextKickoff = withinSix[0]?.utc_date ?? null;
  const nextKickoffHours = nextKickoff
    ? (new Date(nextKickoff).getTime() - Date.now()) / 3_600_000
    : null;

  return {
    hasWithinTwoHours: withinTwo.length > 0,
    hasWithinSixHours: withinSix.length > 0,
    withinTwoHoursCount: withinTwo.length,
    withinSixHoursCount: withinSix.length,
    nextKickoff,
    nextKickoffHours
  };
}

function lineupStatusFromAnalysis(analysis) {
  const homeHasProjectedXi = (analysis.features.home.expectedLineup?.length ?? 0) >= 9;
  const awayHasProjectedXi = (analysis.features.away.expectedLineup?.length ?? 0) >= 9;
  const homeOfficial = analysis.features.home.strongestLineupSource === "uefa-lineups";
  const awayOfficial = analysis.features.away.strongestLineupSource === "uefa-lineups";

  if (homeHasProjectedXi && awayHasProjectedXi && homeOfficial && awayOfficial) {
    return "Official";
  }

  if (homeHasProjectedXi && awayHasProjectedXi) {
    return "Predicted";
  }

  return (analysis.features.context.hoursToKickoff ?? 99) <= 2
    ? "Pending"
    : "No lineup read";
}

function pickLeadMarket(analysis) {
  return analysis.betting.bestBet?.hasBet
    ? Object.values(analysis.betting.markets).find((entry) => entry.name === analysis.betting.bestBet.marketName)
    : analysis.betting.markets.oneXTwo;
}

function attentionFromAnalysis(analysis) {
  const leadMarket = pickLeadMarket(analysis);
  const credibilityScore = leadMarket?.recommendation?.credibilityScore ?? 0;
  const lineupStatus = lineupStatusFromAnalysis(analysis);
  const hasOdds = Object.values(analysis.betting.markets).some((market) => market.hasOdds);
  const hasBet = Boolean(analysis.betting.bestBet?.hasBet);
  const hoursToKickoff = analysis.features.context.hoursToKickoff ?? null;
  const disagreement = leadMarket?.bestOption?.disagreement ?? 0;
  const isSpeculativeOneXTwo = leadMarket?.name === "1X2" && (leadMarket?.bestOption?.bookmakerOdds ?? 0) >= 4.2 && disagreement > 0.12;

  if (!hasOdds) {
    return {
      label: "Ignore",
      note: "No usable odds stored yet."
    };
  }

  if (isSpeculativeOneXTwo) {
    return {
      label: "Watch",
      note: "The number is big, but the market disagreement still makes this a speculative price leg."
    };
  }

  if (hasBet && credibilityScore >= 65 && (lineupStatus === "Official" || lineupStatus === "Predicted" || (hoursToKickoff !== null && hoursToKickoff > 6))) {
    return {
      label: "Playable",
      note: "Credibility and price are both strong enough."
    };
  }

  if (hasBet && credibilityScore >= 50) {
    return {
      label: "Watch",
      note: lineupStatus === "No lineup read" || lineupStatus === "Pending"
        ? "The angle is live, but lineup clarity still matters."
        : "The angle is live, but not clean enough to force."
    };
  }

  if (credibilityScore >= 50) {
    return {
      label: "Watch",
      note: "There is a lean here, but not a clean bet yet."
    };
  }

  return {
    label: "Ignore",
    note: "The setup is still too fragile."
  };
}

export async function getUpcomingBetReminders(hoursAhead = 2, { refreshAvailability = true } = {}) {
  const upcoming = upcomingMatchesWithin(hoursAhead);
  const matchIds = upcoming.map((row) => row.id);

  if (refreshAvailability && matchIds.length) {
    await importAvailabilityData({ matchIds, limitDays: 1 });
  }

  let ratings = getTeamRatingsMap();
  if (!ratings.size) {
    refreshTeamRatings();
    ratings = getTeamRatingsMap();
  }

  return upcoming
    .map((row) => {
      const analysis = analyzeMatch(row.id, ratings, { storeReport: false });
      const top = analysis.betting.bestBet;
      const lineupStatus = lineupStatusFromAnalysis(analysis);
      const hoursToKickoff = analysis.features.context.hoursToKickoff ?? null;

      if (!top?.hasBet) {
        return null;
      }

      if (hoursToKickoff !== null && hoursToKickoff <= 2 && lineupStatus !== "Official") {
        return null;
      }

      const market = Object.values(analysis.betting.markets)
        .find((entry) => entry.name === top.marketName);
      const disagreement = market?.bestOption?.disagreement ?? 0;

      if (market?.name === "1X2" && (market?.bestOption?.bookmakerOdds ?? 0) >= 4.2 && disagreement > 0.12 && lineupStatus !== "Official") {
        return null;
      }

      return {
        matchId: row.id,
        kickoffTime: row.utc_date,
        matchName: `${analysis.features.home.name} vs ${analysis.features.away.name}`,
        market: top.marketName,
        selection: top.selectionLabel,
        edge: top.edge,
        confidence: top.confidence,
        trust: top.trust,
        reason: top.reason,
        lineupStatus,
        bookmaker: market?.recommendation.bestBookmakerTitle ?? null,
        currentOdds: market?.bestOption.bookmakerOdds ?? null,
        targetOdds: market?.bestOption.targetOdds ?? null
      };
    })
    .filter(Boolean);
}

export async function getUpcomingLineupReadyAlerts(hoursAhead = 6, { refreshAvailability = true } = {}) {
  const upcoming = upcomingMatchesWithin(hoursAhead);
  const matchIds = upcoming.map((row) => row.id);

  if (refreshAvailability && matchIds.length) {
    await importAvailabilityData({ matchIds, limitDays: 1 });
  }

  let ratings = getTeamRatingsMap();
  if (!ratings.size) {
    refreshTeamRatings();
    ratings = getTeamRatingsMap();
  }

  return upcoming
    .map((row) => {
      const analysis = analyzeMatch(row.id, ratings, { storeReport: false });
      const lineupStatus = lineupStatusFromAnalysis(analysis);
      const attention = attentionFromAnalysis(analysis);
      const leadMarket = pickLeadMarket(analysis);
      const hoursToKickoff = analysis.features.context.hoursToKickoff ?? null;
      const hasOdds = Object.values(analysis.betting.markets).some((market) => market.hasOdds);

      if (!["Predicted", "Official"].includes(lineupStatus)) {
        return null;
      }

      if (!hasOdds || attention.label === "Ignore") {
        return null;
      }

      return {
        matchId: row.id,
        kickoffTime: row.utc_date,
        matchName: `${analysis.features.home.name} vs ${analysis.features.away.name}`,
        lineupStatus,
        attentionLabel: attention.label,
        attentionNote: attention.note,
        credibility: leadMarket?.recommendation?.credibilityLabel ?? "Fragile",
        credibilityScore: leadMarket?.recommendation?.credibilityScore ?? 0,
        confidence: leadMarket?.recommendation?.confidence ?? analysis.betting.bestBet?.confidence ?? "Low",
        hoursToKickoff,
        hasBet: Boolean(analysis.betting.bestBet?.hasBet),
        bestMarket: analysis.betting.bestBet?.marketName ?? null,
        bestSelection: analysis.betting.bestBet?.selectionLabel ?? null,
        bestReason: analysis.betting.bestBet?.reason ?? null,
        targetOdds: leadMarket?.bestOption?.targetOdds ?? null,
        currentOdds: leadMarket?.bestOption?.bookmakerOdds ?? null,
        bookmaker: leadMarket?.selectedBookmaker?.bookmakerTitle ?? null
      };
    })
    .filter(Boolean);
}

function reminderAlreadySent(reminder, recipient, channel = "email", marketName = reminder.market, selectionLabel = reminder.selection) {
  const db = getDb();
  const row = db.prepare(`
    SELECT id
    FROM reminder_notifications
    WHERE match_id = ?
      AND kickoff_time = ?
      AND recipient = ?
      AND channel = ?
      AND market_name = ?
      AND selection_label = ?
      AND status = 'sent'
    LIMIT 1
  `).get(
    reminder.matchId,
    reminder.kickoffTime,
    recipient,
    channel,
    marketName,
    selectionLabel
  );

  return Boolean(row);
}

function storeReminderNotification(
  reminder,
  recipient,
  status,
  subject,
  messageId = null,
  errorMessage = null,
  {
    channel = "email",
    marketName = reminder.market,
    selectionLabel = reminder.selection
  } = {}
) {
  const db = getDb();
  db.prepare(`
    INSERT INTO reminder_notifications (
      match_id, kickoff_time, recipient, channel, market_name, selection_label,
      subject, status, sent_at, message_id, error_message, summary_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(match_id, kickoff_time, recipient, channel, market_name, selection_label) DO UPDATE SET
      subject = excluded.subject,
      status = excluded.status,
      sent_at = excluded.sent_at,
      message_id = excluded.message_id,
      error_message = excluded.error_message,
      summary_json = excluded.summary_json
  `).run(
    reminder.matchId,
    reminder.kickoffTime,
    recipient,
    channel,
    marketName,
    selectionLabel,
    subject,
    status,
    isoNow(),
    messageId,
    errorMessage,
    JSON.stringify(reminder)
  );
}

function buildReminderEmail(reminder) {
  const subject = `Bet reminder: ${reminder.matchName} - ${reminder.market} - ${reminder.selection}`;
  const lines = [
    `Match: ${reminder.matchName}`,
    `Kickoff: ${new Date(reminder.kickoffTime).toLocaleString("en-GB", { timeZone: "Europe/Zurich" })}`,
    `Market: ${reminder.market}`,
    `Selection: ${reminder.selection}`,
    `Edge: ${reminder.edge === null || reminder.edge === undefined ? "n/a" : `${reminder.edge.toFixed(2)}%`}`,
    `Confidence: ${reminder.confidence}`,
    `Trust: ${reminder.trust}`,
    `Current odds: ${reminder.currentOdds ?? "n/a"}`,
    `Target odds: ${reminder.targetOdds ?? "n/a"}`,
    `Bookmaker: ${reminder.bookmaker ?? "n/a"}`,
    "",
    `Reason: ${reminder.reason}`,
    "",
    "This reminder was generated automatically from the current UCL/UEL betting app."
  ];

  return {
    subject,
    text: lines.join("\n")
  };
}

function buildLineupReadyEmail(alert) {
  const subject = `Lineup update: ${alert.matchName} - ${alert.lineupStatus}`;
  const lines = [
    `Match: ${alert.matchName}`,
    `Kickoff: ${new Date(alert.kickoffTime).toLocaleString("en-GB", { timeZone: "Europe/Zurich" })}`,
    `Lineup status: ${alert.lineupStatus}`,
    `Attention: ${alert.attentionLabel}`,
    `Credibility: ${alert.credibility} (${alert.credibilityScore}%)`,
    `Confidence: ${alert.confidence}`,
    "",
    alert.hasBet
      ? `Best angle right now: ${alert.bestMarket} - ${alert.bestSelection}`
      : "There is no clean bet yet, but the match is now worth re-checking.",
    alert.hasBet
      ? `Current / target odds: ${alert.currentOdds ?? "n/a"} / ${alert.targetOdds ?? "n/a"}`
      : `Current / target odds: ${alert.currentOdds ?? "n/a"} / ${alert.targetOdds ?? "n/a"}`,
    `Bookmaker: ${alert.bookmaker ?? "n/a"}`,
    "",
    `Why check it now: ${alert.attentionNote}`,
    alert.bestReason ? `Current read: ${alert.bestReason}` : null,
    "",
    "This lineup update was generated automatically from the current UCL/UEL betting app."
  ].filter(Boolean);

  return {
    subject,
    text: lines.join("\n")
  };
}

export async function sendUpcomingBetReminderEmails(hoursAhead = 2) {
  const reminders = await getUpcomingBetReminders(hoursAhead, { refreshAvailability: true });

  if (!hasEmailConfig()) {
    return {
      status: "skipped",
      reason: "Email config is incomplete.",
      remindersFound: reminders.length,
      sent: 0,
      skipped: reminders.length
    };
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const reminder of reminders) {
    if (reminderAlreadySent(reminder, env.emailTo)) {
      skipped += 1;
      continue;
    }

    const email = buildReminderEmail(reminder);

    try {
      const result = await sendSmtpEmail({
        to: env.emailTo,
        subject: email.subject,
        text: email.text
      });
      storeReminderNotification(reminder, env.emailTo, "sent", email.subject, result.messageId, null);
      sent += 1;
    } catch (error) {
      storeReminderNotification(reminder, env.emailTo, "failed", email.subject, null, error.message);
      failed += 1;
    }
  }

  return {
    status: failed ? (sent ? "partial" : "failed") : "success",
    remindersFound: reminders.length,
    sent,
    skipped,
    failed
  };
}

export async function sendUpcomingLineupReadyEmails(hoursAhead = 6) {
  const alerts = await getUpcomingLineupReadyAlerts(hoursAhead, { refreshAvailability: true });

  if (!hasEmailConfig()) {
    return {
      status: "skipped",
      reason: "Email config is incomplete.",
      alertsFound: alerts.length,
      sent: 0,
      skipped: alerts.length
    };
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const alert of alerts) {
    if (reminderAlreadySent(alert, env.emailTo, "email-lineup", "Lineups", alert.lineupStatus)) {
      skipped += 1;
      continue;
    }

    const email = buildLineupReadyEmail(alert);

    try {
      const result = await sendSmtpEmail({
        to: env.emailTo,
        subject: email.subject,
        text: email.text
      });
      storeReminderNotification(alert, env.emailTo, "sent", email.subject, result.messageId, null, {
        channel: "email-lineup",
        marketName: "Lineups",
        selectionLabel: alert.lineupStatus
      });
      sent += 1;
    } catch (error) {
      storeReminderNotification(alert, env.emailTo, "failed", email.subject, null, error.message, {
        channel: "email-lineup",
        marketName: "Lineups",
        selectionLabel: alert.lineupStatus
      });
      failed += 1;
    }
  }

  return {
    status: failed ? (sent ? "partial" : "failed") : "success",
    alertsFound: alerts.length,
    sent,
    skipped,
    failed
  };
}

export function getReminderNotificationHistory(limit = 8, channel = null) {
  const db = getDb();
  const safeLimit = Math.max(1, Math.min(Number(limit) || 8, 20));
  const rows = channel
    ? db.prepare(`
    SELECT
      id,
      match_id,
      kickoff_time,
      recipient,
      channel,
      market_name,
      selection_label,
      subject,
      status,
      sent_at,
      message_id,
      error_message,
      summary_json
    FROM reminder_notifications
    WHERE channel = ?
    ORDER BY datetime(sent_at) DESC, id DESC
    LIMIT ?
  `).all(channel, safeLimit)
    : db.prepare(`
    SELECT
      id,
      match_id,
      kickoff_time,
      recipient,
      channel,
      market_name,
      selection_label,
      subject,
      status,
      sent_at,
      message_id,
      error_message,
      summary_json
    FROM reminder_notifications
    ORDER BY datetime(sent_at) DESC, id DESC
    LIMIT ?
  `).all(safeLimit);

  return rows.map((row) => ({
    ...row,
    summary: row.summary_json ? JSON.parse(row.summary_json) : null
  }));
}
