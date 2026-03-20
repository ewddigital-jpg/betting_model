import { logger } from "../src/lib/logger.js";
import {
  getUpcomingBetReminders,
  getUpcomingLineupReadyAlerts,
  sendUpcomingBetReminderEmails,
  sendUpcomingLineupReadyEmails
} from "../src/modules/analysis/reminderService.js";

const hoursAhead = Number(process.argv[2] ?? 2);
const reminders = await getUpcomingBetReminders(hoursAhead, { refreshAvailability: true });
const lineupAlerts = await getUpcomingLineupReadyAlerts(Math.max(6, hoursAhead), { refreshAvailability: false });
const delivery = await sendUpcomingBetReminderEmails(hoursAhead);
const lineupDelivery = await sendUpcomingLineupReadyEmails(Math.max(6, hoursAhead));

logger.info("Reminder check complete", {
  hoursAhead,
  remindersFound: reminders.length,
  reminders,
  lineupAlertsFound: lineupAlerts.length,
  lineupAlerts,
  delivery,
  lineupDelivery
});
