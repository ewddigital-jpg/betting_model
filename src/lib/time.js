export function hoursBetween(fromDate, toDate) {
  return (toDate.getTime() - fromDate.getTime()) / 3_600_000;
}

export function daysBetween(fromDate, toDate) {
  return hoursBetween(fromDate, toDate) / 24;
}

export function isoNow() {
  return new Date().toISOString();
}

export function formatKickoff(isoDate) {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Zurich"
  }).format(new Date(isoDate));
}
