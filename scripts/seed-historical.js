/**
 * Seed script: populates the DB with realistic historical UCL/EL match data
 * so that blind evaluation, Elo calibration, and trust scoring can run.
 *
 * Uses a deterministic seeded PRNG + Poisson scoring — no real API needed.
 * Run with:  node scripts/seed-historical.js
 */

import { getDb } from "../src/db/database.js";

// ─── Seeded PRNG (mulberry32) ────────────────────────────────────────────────
function mulberry32(seed) {
  let s = seed;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0xdeadbeef);

function poissonRandom(lambda) {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rand(); } while (p > L);
  return Math.min(k - 1, 7);
}

// ─── Team definitions (name, short, tla, strength 1-10) ─────────────────────
const UCL_2324_GROUPS = [
  { group: "A", teams: [
    { name: "Bayern Munich",       short: "Bayern",      tla: "FCB", str: 9.2 },
    { name: "Manchester United",   short: "Man United",  tla: "MUN", str: 7.5 },
    { name: "FC Copenhagen",       short: "Copenhagen",  tla: "FCK", str: 5.2 },
    { name: "Galatasaray",         short: "Galatasaray", tla: "GAL", str: 6.0 }]},
  { group: "B", teams: [
    { name: "Sevilla",             short: "Sevilla",     tla: "SEV", str: 6.5 },
    { name: "Arsenal",             short: "Arsenal",     tla: "ARS", str: 8.0 },
    { name: "PSV Eindhoven",       short: "PSV",         tla: "PSV", str: 6.8 },
    { name: "RC Lens",             short: "Lens",        tla: "LEN", str: 6.2 }]},
  { group: "C", teams: [
    { name: "Napoli",              short: "Napoli",      tla: "NAP", str: 7.8 },
    { name: "Real Madrid",         short: "Real Madrid", tla: "RMA", str: 9.5 },
    { name: "SC Braga",            short: "Braga",       tla: "SCB", str: 5.5 },
    { name: "Union Berlin",        short: "Union Berlin",tla: "UNB", str: 5.8 }]},
  { group: "D", teams: [
    { name: "Benfica",             short: "Benfica",     tla: "BEN", str: 7.2 },
    { name: "Inter Milan",         short: "Inter Milan", tla: "INT", str: 8.3 },
    { name: "Real Sociedad",       short: "Sociedad",    tla: "RSO", str: 6.5 },
    { name: "RB Salzburg",         short: "Salzburg",    tla: "RBS", str: 6.0 }]},
  { group: "E", teams: [
    { name: "Atletico Madrid",     short: "Atletico",    tla: "ATL", str: 8.0 },
    { name: "Feyenoord",           short: "Feyenoord",   tla: "FEY", str: 7.2 },
    { name: "Lazio",               short: "Lazio",       tla: "LAZ", str: 7.0 },
    { name: "Celtic",              short: "Celtic",      tla: "CEL", str: 6.0 }]},
  { group: "F", teams: [
    { name: "Paris Saint-Germain", short: "PSG",         tla: "PSG", str: 8.8 },
    { name: "Borussia Dortmund",   short: "Dortmund",    tla: "BVB", str: 7.8 },
    { name: "AC Milan",            short: "AC Milan",    tla: "ACM", str: 7.5 },
    { name: "Newcastle United",    short: "Newcastle",   tla: "NEW", str: 6.8 }]},
  { group: "G", teams: [
    { name: "Manchester City",     short: "Man City",    tla: "MCI", str: 9.3 },
    { name: "RB Leipzig",          short: "RB Leipzig",  tla: "RBL", str: 7.5 },
    { name: "Young Boys",          short: "Young Boys",  tla: "YBS", str: 4.5 },
    { name: "Red Star Belgrade",   short: "Red Star",    tla: "CZV", str: 5.5 }]},
  { group: "H", teams: [
    { name: "Barcelona",           short: "Barcelona",   tla: "BAR", str: 8.5 },
    { name: "Porto",               short: "Porto",       tla: "POR", str: 7.0 },
    { name: "Shakhtar Donetsk",    short: "Shakhtar",    tla: "SHA", str: 6.2 },
    { name: "Royal Antwerp",       short: "Antwerp",     tla: "ANT", str: 4.8 }]}
];

const UCL_2223_GROUPS = [
  { group: "A", teams: [
    { name: "Napoli",              short: "Napoli",      tla: "NAP", str: 8.2 },
    { name: "Liverpool",           short: "Liverpool",   tla: "LIV", str: 8.5 },
    { name: "Ajax",                short: "Ajax",        tla: "AJX", str: 6.5 },
    { name: "Rangers",             short: "Rangers",     tla: "RAN", str: 5.0 }]},
  { group: "B", teams: [
    { name: "Porto",               short: "Porto",       tla: "POR", str: 7.2 },
    { name: "Club Brugge",         short: "Club Brugge", tla: "CLB", str: 6.0 },
    { name: "Atletico Madrid",     short: "Atletico",    tla: "ATL", str: 8.2 },
    { name: "Bayer Leverkusen",    short: "Leverkusen",  tla: "LEV", str: 7.0 }]},
  { group: "C", teams: [
    { name: "Bayern Munich",       short: "Bayern",      tla: "FCB", str: 9.0 },
    { name: "Barcelona",           short: "Barcelona",   tla: "BAR", str: 8.3 },
    { name: "Inter Milan",         short: "Inter Milan", tla: "INT", str: 7.8 },
    { name: "Viktoria Plzen",      short: "Plzen",       tla: "VPL", str: 3.5 }]},
  { group: "D", teams: [
    { name: "Eintracht Frankfurt", short: "Eintracht",   tla: "SGE", str: 6.8 },
    { name: "Tottenham Hotspur",   short: "Tottenham",   tla: "TOT", str: 7.5 },
    { name: "Sporting CP",         short: "Sporting CP", tla: "SCP", str: 6.2 },
    { name: "Marseille",           short: "Marseille",   tla: "MAR", str: 6.8 }]},
  { group: "E", teams: [
    { name: "Chelsea",             short: "Chelsea",     tla: "CHE", str: 7.8 },
    { name: "AC Milan",            short: "AC Milan",    tla: "ACM", str: 7.5 },
    { name: "RB Salzburg",         short: "Salzburg",    tla: "RBS", str: 5.8 },
    { name: "Dinamo Zagreb",       short: "Din. Zagreb", tla: "GNK", str: 4.5 }]},
  { group: "F", teams: [
    { name: "Real Madrid",         short: "Real Madrid", tla: "RMA", str: 9.5 },
    { name: "RB Leipzig",          short: "RB Leipzig",  tla: "RBL", str: 7.3 },
    { name: "Celtic",              short: "Celtic",      tla: "CEL", str: 5.8 },
    { name: "Shakhtar Donetsk",    short: "Shakhtar",    tla: "SHA", str: 6.0 }]},
  { group: "G", teams: [
    { name: "Manchester City",     short: "Man City",    tla: "MCI", str: 9.2 },
    { name: "Sevilla",             short: "Sevilla",     tla: "SEV", str: 7.0 },
    { name: "Borussia Dortmund",   short: "Dortmund",    tla: "BVB", str: 7.5 },
    { name: "FC Copenhagen",       short: "Copenhagen",  tla: "FCK", str: 5.0 }]},
  { group: "H", teams: [
    { name: "Paris Saint-Germain", short: "PSG",         tla: "PSG", str: 8.5 },
    { name: "Juventus",            short: "Juventus",    tla: "JUV", str: 7.8 },
    { name: "Benfica",             short: "Benfica",     tla: "BEN", str: 7.2 },
    { name: "Maccabi Haifa",       short: "Maccabi",     tla: "MHF", str: 3.5 }]}
];

const EL_2324_GROUPS = [
  { group: "A", teams: [
    { name: "Olympiacos",          short: "Olympiacos",  tla: "OLY", str: 5.5 },
    { name: "Eintracht Frankfurt", short: "Eintracht",   tla: "SGE", str: 7.2 },
    { name: "PAOK",                short: "PAOK",        tla: "PAO", str: 5.0 },
    { name: "Sporting CP",         short: "Sporting CP", tla: "SCP", str: 6.5 }]},
  { group: "B", teams: [
    { name: "West Ham United",     short: "West Ham",    tla: "WHU", str: 7.0 },
    { name: "Olympique Lyonnais",  short: "Lyon",        tla: "OLG", str: 7.2 },
    { name: "SC Freiburg",         short: "Freiburg",    tla: "SCF", str: 6.5 },
    { name: "Ferencvaros",         short: "Ferencvaros", tla: "FTC", str: 5.0 }]},
  { group: "C", teams: [
    { name: "Ajax",                short: "Ajax",        tla: "AJX", str: 6.5 },
    { name: "Brighton",            short: "Brighton",    tla: "BHA", str: 7.0 },
    { name: "Marseille",           short: "Marseille",   tla: "MAR", str: 6.8 },
    { name: "AEK Athens",          short: "AEK Athens",  tla: "AEK", str: 5.2 }]},
  { group: "D", teams: [
    { name: "AS Roma",             short: "Roma",        tla: "ASR", str: 7.2 },
    { name: "Servette",            short: "Servette",    tla: "SER", str: 4.5 },
    { name: "Sheriff Tiraspol",    short: "Sheriff",     tla: "SHE", str: 4.8 },
    { name: "Slavia Prague",       short: "Slavia",      tla: "SLA", str: 6.0 }]},
  { group: "E", teams: [
    { name: "Villarreal",          short: "Villarreal",  tla: "VIL", str: 7.0 },
    { name: "Rennes",              short: "Rennes",      tla: "REN", str: 6.2 },
    { name: "Maccabi Tel Aviv",    short: "Maccabi TA",  tla: "MTA", str: 4.5 },
    { name: "Panathinaikos",       short: "Panathinaiko",tla: "PAN", str: 5.0 }]},
  { group: "F", teams: [
    { name: "Atalanta",            short: "Atalanta",    tla: "ATA", str: 7.5 },
    { name: "Sporting CP",         short: "Sporting CP", tla: "SCP", str: 6.5 },
    { name: "Rakow Czestochowa",   short: "Rakow",       tla: "RAK", str: 5.0 },
    { name: "SK Sturm Graz",       short: "Sturm Graz",  tla: "STU", str: 5.2 }]},
  { group: "G", teams: [
    { name: "Liverpool",           short: "Liverpool",   tla: "LIV", str: 8.2 },
    { name: "LASK",                short: "LASK",        tla: "LAS", str: 5.5 },
    { name: "Toulouse",            short: "Toulouse",    tla: "TLS", str: 5.8 },
    { name: "Union Saint-Gilloise",short: "Union SG",    tla: "USG", str: 6.5 }]},
  { group: "H", teams: [
    { name: "Bayer Leverkusen",    short: "Leverkusen",  tla: "LEV", str: 8.0 },
    { name: "Molde",               short: "Molde",       tla: "MOL", str: 5.0 },
    { name: "Hacken",              short: "Hacken",      tla: "HAC", str: 4.8 },
    { name: "BK Häcken",           short: "BK Häcken",   tla: "BKH", str: 4.8 }]}
];

// ─── Score generation ────────────────────────────────────────────────────────
const HOME_ADV = 0.35; // extra lambda for home team

function simulateScore(homeStr, awayStr) {
  const relHome = homeStr / 10;
  const relAway = awayStr / 10;
  const lambdaHome = Math.max(0.3, relHome * 2.2 - relAway * 0.6 + HOME_ADV);
  const lambdaAway = Math.max(0.2, relAway * 1.9 - relHome * 0.5);
  return { homeScore: poissonRandom(lambdaHome), awayScore: poissonRandom(lambdaAway) };
}

// ─── Match schedule for 4-team group (12 matches: each pair home+away) ───────
function groupSchedule(teams) {
  // Standard round-robin rotation
  const pairs = [
    [0, 3], [1, 2],
    [3, 1], [0, 2],
    [2, 0], [3, 1],
    [3, 0], [2, 1],
    [1, 0], [2, 3],
    [0, 1], [3, 2]  // ensure each pair plays once each way
  ];
  return pairs.map(([h, a]) => ({ home: teams[h], away: teams[a] }));
}

// ─── Date helpers ────────────────────────────────────────────────────────────
function matchDate(baseYear, baseMonth, weekOffset, timeHour = 20) {
  const d = new Date(Date.UTC(baseYear, baseMonth - 1, 1));
  d.setUTCDate(d.getUTCDate() + weekOffset * 7);
  d.setUTCHours(timeHour, 0, 0, 0);
  return d.toISOString();
}

// UCL 2023-24: Sep 2023 → Dec 2023 (MD1–MD6), then knockouts Feb–Jun 2024
// UCL 2022-23: Sep 2022 → Dec 2022, knockouts Feb–May 2023
// EL 2023-24:  Sep 2023 → Dec 2023

const SEASON_CONFIG = {
  UCL_2324: { compCode: "CL", season: 2023, groupStart: [2023, 9], knockoutStart: [2024, 2] },
  UCL_2223: { compCode: "CL", season: 2022, groupStart: [2022, 9], knockoutStart: [2023, 2] },
  EL_2324:  { compCode: "EL", season: 2023, groupStart: [2023, 9], knockoutStart: [2024, 2] }
};

// ─── Main seeding ────────────────────────────────────────────────────────────
function seedHistoricalData() {
  const db = getDb();

  // Remove old test-only data (IDs in 990xxx range)
  const testMatchIds = db.prepare("SELECT id FROM matches WHERE id >= 990000").all().map(r => r.id);
  if (testMatchIds.length) {
    const placeholders = testMatchIds.map(() => "?").join(", ");
    // odds_quote_history FK → odds_snapshots, so delete it first
    const snapshotIds = db.prepare(`SELECT id FROM odds_snapshots WHERE match_id IN (${placeholders})`).all(...testMatchIds).map(r => r.id);
    if (snapshotIds.length) {
      const sp = snapshotIds.map(() => "?").join(", ");
      db.prepare(`DELETE FROM odds_quote_history WHERE snapshot_id IN (${sp})`).run(...snapshotIds);
    }
    const childTables = [
      "odds_snapshots", "team_match_advanced_stats",
      "analysis_reports", "match_context", "recommendation_snapshots",
      "availability_source_links", "injury_records", "suspension_records",
      "expected_lineup_records", "team_news_records", "odds_market_boards",
      "reminder_notifications"
    ];
    for (const tbl of childTables) {
      db.prepare(`DELETE FROM ${tbl} WHERE match_id IN (${placeholders})`).run(...testMatchIds);
    }
    db.prepare(`DELETE FROM matches WHERE id IN (${placeholders})`).run(...testMatchIds);
  }
  // Remove test teams (no remaining matches referencing them)
  db.prepare(`
    DELETE FROM teams WHERE id >= 990000
      AND NOT EXISTS (SELECT 1 FROM matches WHERE home_team_id = teams.id OR away_team_id = teams.id)
  `).run();
  console.log("Cleared test data.");

  // Ensure competitions exist
  for (const code of ["CL", "EL"]) {
    db.prepare(`
      INSERT OR IGNORE INTO competitions (code, name, sport_key, last_synced_at)
      VALUES (?, ?, '', datetime('now'))
    `).run(code, code === "CL" ? "UEFA Champions League" : "UEFA Europa League");
  }

  // ── Upsert team and return id ──
  const teamCache = new Map(); // name → id
  function upsertTeam(team) {
    if (teamCache.has(team.name)) return teamCache.get(team.name);
    const existing = db.prepare("SELECT id FROM teams WHERE lower(name) = lower(?)").get(team.name);
    if (existing) {
      teamCache.set(team.name, existing.id);
      return existing.id;
    }
    const row = db.prepare(`
      INSERT INTO teams (source_team_id, name, short_name, tla, crest, created_at, updated_at)
      VALUES (NULL, ?, ?, ?, NULL, datetime('now'), datetime('now'))
      RETURNING id
    `).get(team.name, team.short, team.tla);
    teamCache.set(team.name, row.id);
    return row.id;
  }

  // ── Insert a finished match ──
  let matchIdCounter = 10000;
  const insertMatch = db.prepare(`
    INSERT OR IGNORE INTO matches
      (id, source_match_id, competition_code, season, utc_date, status, matchday, stage,
       home_team_id, away_team_id, home_score, away_score, winner, last_synced_at)
    VALUES (?, ?, ?, ?, ?, 'FINISHED', ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  function seedGroupStage(groups, cfg) {
    const [sy, sm] = cfg.groupStart;
    let inserted = 0;
    groups.forEach(({ group, teams }) => {
      const schedule = groupSchedule(teams);
      schedule.forEach((fixture, idx) => {
        const homeId = upsertTeam(fixture.home);
        const awayId = upsertTeam(fixture.away);
        const { homeScore, awayScore } = simulateScore(fixture.home.str, fixture.away.str);
        const winner = homeScore > awayScore ? "HOME_TEAM" : homeScore < awayScore ? "AWAY_TEAM" : "DRAW";
        const md = Math.floor(idx / 2) + 1;
        const date = matchDate(sy, sm, md + (group.charCodeAt(0) - 65) * 0.14, 20);
        insertMatch.run(
          matchIdCounter++, matchIdCounter, cfg.compCode, cfg.season,
          date, md, "GROUP_STAGE", homeId, awayId, homeScore, awayScore, winner
        );
        inserted++;
      });
    });
    return inserted;
  }

  // ── Knockout fixture generator ──
  function topTeamsFromGroups(groups, count = 2) {
    // Pick top 'count' teams from each group by seeded-random strength weighting
    return groups.flatMap(({ teams }) =>
      [...teams]
        .sort((a, b) => (b.str + rand() * 2) - (a.str + rand() * 2))
        .slice(0, count)
    );
  }

  function seedKnockout(advancers, stageName, cfg, weekOffsetBase) {
    const [sy, sm] = cfg.knockoutStart;
    let inserted = 0;
    const shuffled = [...advancers].sort(() => rand() - 0.5);
    for (let i = 0; i < shuffled.length - 1; i += 2) {
      const home = shuffled[i], away = shuffled[i + 1];
      if (!home || !away) continue;
      const homeId = upsertTeam(home);
      const awayId = upsertTeam(away);

      // Leg 1
      const s1 = simulateScore(home.str, away.str);
      const w1 = s1.homeScore > s1.awayScore ? "HOME_TEAM" : s1.homeScore < s1.awayScore ? "AWAY_TEAM" : "DRAW";
      insertMatch.run(matchIdCounter++, matchIdCounter, cfg.compCode, cfg.season,
        matchDate(sy, sm, weekOffsetBase, 20), null, stageName,
        homeId, awayId, s1.homeScore, s1.awayScore, w1);
      inserted++;

      // Leg 2 (reversed)
      const s2 = simulateScore(away.str, home.str);
      const w2 = s2.homeScore > s2.awayScore ? "HOME_TEAM" : s2.homeScore < s2.awayScore ? "AWAY_TEAM" : "DRAW";
      insertMatch.run(matchIdCounter++, matchIdCounter, cfg.compCode, cfg.season,
        matchDate(sy, sm, weekOffsetBase + 1, 20), null, stageName,
        awayId, homeId, s2.homeScore, s2.awayScore, w2);
      inserted++;
    }
    return inserted;
  }

  // ── Seed all seasons ──────────────────────────────────────────────────────
  let total = 0;
  const cfgUCL2324 = SEASON_CONFIG.UCL_2324;
  const cfgUCL2223 = SEASON_CONFIG.UCL_2223;
  const cfgEL2324  = SEASON_CONFIG.EL_2324;

  total += seedGroupStage(UCL_2324_GROUPS, cfgUCL2324);
  const r16UCL2324 = topTeamsFromGroups(UCL_2324_GROUPS, 2);
  total += seedKnockout(r16UCL2324, "LAST_16", cfgUCL2324, 0);
  const qfUCL2324 = r16UCL2324.slice(0, 8).sort(() => rand() - 0.5);
  total += seedKnockout(qfUCL2324, "QUARTER_FINALS", cfgUCL2324, 3);
  const sfUCL2324 = qfUCL2324.slice(0, 4).sort(() => rand() - 0.5);
  total += seedKnockout(sfUCL2324, "SEMI_FINALS", cfgUCL2324, 6);
  // Final (single leg)
  {
    const finalists = sfUCL2324.slice(0, 2);
    if (finalists[0] && finalists[1]) {
      const homeId = upsertTeam(finalists[0]), awayId = upsertTeam(finalists[1]);
      const s = simulateScore(finalists[0].str, finalists[1].str);
      const w = s.homeScore > s.awayScore ? "HOME_TEAM" : s.homeScore < s.awayScore ? "AWAY_TEAM" : "DRAW";
      insertMatch.run(matchIdCounter++, matchIdCounter, "CL", 2023,
        matchDate(2024, 6, 0, 20), null, "FINAL", homeId, awayId, s.homeScore, s.awayScore, w);
      total++;
    }
  }

  total += seedGroupStage(UCL_2223_GROUPS, cfgUCL2223);
  const r16UCL2223 = topTeamsFromGroups(UCL_2223_GROUPS, 2);
  total += seedKnockout(r16UCL2223, "LAST_16", cfgUCL2223, 0);
  const qfUCL2223 = r16UCL2223.slice(0, 8).sort(() => rand() - 0.5);
  total += seedKnockout(qfUCL2223, "QUARTER_FINALS", cfgUCL2223, 3);
  const sfUCL2223 = qfUCL2223.slice(0, 4).sort(() => rand() - 0.5);
  total += seedKnockout(sfUCL2223, "SEMI_FINALS", cfgUCL2223, 6);
  {
    const finalists = sfUCL2223.slice(0, 2);
    if (finalists[0] && finalists[1]) {
      const homeId = upsertTeam(finalists[0]), awayId = upsertTeam(finalists[1]);
      const s = simulateScore(finalists[0].str, finalists[1].str);
      const w = s.homeScore > s.awayScore ? "HOME_TEAM" : s.homeScore < s.awayScore ? "AWAY_TEAM" : "DRAW";
      insertMatch.run(matchIdCounter++, matchIdCounter, "CL", 2022,
        matchDate(2023, 6, 0, 20), null, "FINAL", homeId, awayId, s.homeScore, s.awayScore, w);
      total++;
    }
  }

  total += seedGroupStage(EL_2324_GROUPS, cfgEL2324);
  const r16EL2324 = topTeamsFromGroups(EL_2324_GROUPS, 2);
  total += seedKnockout(r16EL2324, "LAST_16", cfgEL2324, 0);
  const qfEL2324 = r16EL2324.slice(0, 8).sort(() => rand() - 0.5);
  total += seedKnockout(qfEL2324, "QUARTER_FINALS", cfgEL2324, 3);
  const sfEL2324 = qfEL2324.slice(0, 4).sort(() => rand() - 0.5);
  total += seedKnockout(sfEL2324, "SEMI_FINALS", cfgEL2324, 6);
  {
    const finalists = sfEL2324.slice(0, 2);
    if (finalists[0] && finalists[1]) {
      const homeId = upsertTeam(finalists[0]), awayId = upsertTeam(finalists[1]);
      const s = simulateScore(finalists[0].str, finalists[1].str);
      const w = s.homeScore > s.awayScore ? "HOME_TEAM" : s.homeScore < s.awayScore ? "AWAY_TEAM" : "DRAW";
      insertMatch.run(matchIdCounter++, matchIdCounter, "EL", 2023,
        matchDate(2024, 5, 3, 20), null, "FINAL", homeId, awayId, s.homeScore, s.awayScore, w);
      total++;
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const counts = db.prepare(`
    SELECT competition_code, COUNT(*) AS c
    FROM matches WHERE status = 'FINISHED'
    GROUP BY competition_code
  `).all();
  const teamCount = db.prepare("SELECT COUNT(*) AS c FROM teams").get().c;

  console.log(`\nSeeded ${total} finished matches across ${teamCount} teams`);
  console.log("By competition:", Object.fromEntries(counts.map((r) => [r.competition_code, r.c])));
}

getDb();
seedHistoricalData();
