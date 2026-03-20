export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS competitions (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sport_key TEXT NOT NULL,
  last_synced_at TEXT
);

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_team_id INTEGER UNIQUE,
  name TEXT NOT NULL,
  short_name TEXT,
  tla TEXT,
  crest TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_match_id INTEGER UNIQUE,
  competition_code TEXT NOT NULL,
  season INTEGER,
  utc_date TEXT NOT NULL,
  status TEXT NOT NULL,
  matchday INTEGER,
  stage TEXT,
  group_name TEXT,
  home_team_id INTEGER NOT NULL,
  away_team_id INTEGER NOT NULL,
  home_score INTEGER,
  away_score INTEGER,
  winner TEXT,
  odds_event_id TEXT,
  last_synced_at TEXT NOT NULL,
  FOREIGN KEY (competition_code) REFERENCES competitions(code),
  FOREIGN KEY (home_team_id) REFERENCES teams(id),
  FOREIGN KEY (away_team_id) REFERENCES teams(id)
);

CREATE TABLE IF NOT EXISTS standings_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  competition_code TEXT NOT NULL,
  season INTEGER,
  stage TEXT,
  group_name TEXT,
  team_id INTEGER NOT NULL,
  position INTEGER,
  points INTEGER,
  played_games INTEGER,
  wins INTEGER,
  draws INTEGER,
  losses INTEGER,
  goals_for INTEGER,
  goals_against INTEGER,
  goal_difference INTEGER,
  fetched_at TEXT NOT NULL,
  FOREIGN KEY (competition_code) REFERENCES competitions(code),
  FOREIGN KEY (team_id) REFERENCES teams(id)
);

CREATE TABLE IF NOT EXISTS team_ratings (
  team_id INTEGER PRIMARY KEY,
  elo REAL NOT NULL,
  matches_played INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(id)
);

CREATE TABLE IF NOT EXISTS odds_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL,
  bookmaker_key TEXT NOT NULL,
  bookmaker_title TEXT NOT NULL,
  source_provider TEXT,
  source_label TEXT,
  market TEXT NOT NULL,
  home_price REAL,
  draw_price REAL,
  away_price REAL,
  is_live INTEGER NOT NULL DEFAULT 0,
  retrieved_at TEXT NOT NULL,
  FOREIGN KEY (match_id) REFERENCES matches(id)
);

CREATE TABLE IF NOT EXISTS odds_quote_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER,
  match_id INTEGER NOT NULL,
  bookmaker_key TEXT NOT NULL,
  bookmaker_title TEXT NOT NULL,
  source_provider TEXT,
  source_label TEXT,
  market TEXT NOT NULL,
  outcome_key TEXT NOT NULL,
  odds REAL NOT NULL,
  is_live INTEGER NOT NULL DEFAULT 0,
  recorded_at TEXT NOT NULL,
  FOREIGN KEY (snapshot_id) REFERENCES odds_snapshots(id),
  FOREIGN KEY (match_id) REFERENCES matches(id)
);

CREATE TABLE IF NOT EXISTS team_match_advanced_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL,
  team_id INTEGER NOT NULL,
  source_provider TEXT NOT NULL,
  xg REAL,
  xga REAL,
  shots INTEGER,
  shots_on_target INTEGER,
  big_chances INTEGER,
  possession REAL,
  extracted_at TEXT NOT NULL,
  UNIQUE(match_id, team_id, source_provider),
  FOREIGN KEY (match_id) REFERENCES matches(id),
  FOREIGN KEY (team_id) REFERENCES teams(id)
);

CREATE TABLE IF NOT EXISTS historical_enrichment_repairs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_provider TEXT NOT NULL,
  competition_code TEXT,
  source_match_date TEXT,
  source_home_team TEXT,
  source_away_team TEXT,
  normalized_home TEXT,
  normalized_away TEXT,
  reason_code TEXT NOT NULL,
  reason_details TEXT,
  candidate_matches_json TEXT,
  raw_payload_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS analysis_reports (
  match_id INTEGER PRIMARY KEY,
  generated_at TEXT NOT NULL,
  home_win_prob REAL NOT NULL,
  draw_prob REAL NOT NULL,
  away_win_prob REAL NOT NULL,
  fair_home_odds REAL NOT NULL,
  fair_draw_odds REAL NOT NULL,
  fair_away_odds REAL NOT NULL,
  edge_home REAL,
  edge_draw REAL,
  edge_away REAL,
  recommended_bet TEXT,
  confidence TEXT NOT NULL,
  explanation TEXT NOT NULL,
  factors_json TEXT NOT NULL,
  market_json TEXT NOT NULL,
  FOREIGN KEY (match_id) REFERENCES matches(id)
);

CREATE TABLE IF NOT EXISTS match_context (
  match_id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  venue_name TEXT,
  venue_city TEXT,
  venue_capacity INTEGER,
  venue_surface TEXT,
  leg TEXT,
  has_premium_odds INTEGER NOT NULL DEFAULT 0,
  weather_summary TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (match_id) REFERENCES matches(id)
);

CREATE TABLE IF NOT EXISTS collector_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  trigger_source TEXT NOT NULL,
  status TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS recommendation_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collector_run_id INTEGER,
  match_id INTEGER NOT NULL,
  generated_at TEXT NOT NULL,
  competition_code TEXT NOT NULL,
  best_market TEXT,
  selection_label TEXT,
  action TEXT NOT NULL,
  confidence TEXT NOT NULL,
  trust_label TEXT NOT NULL,
  trust_score REAL NOT NULL,
  edge REAL,
  bookmaker_title TEXT,
  bookmaker_odds REAL,
  odds_at_prediction REAL,
  odds_snapshot_at TEXT,
  odds_freshness_minutes REAL,
  odds_freshness_score REAL,
  odds_refreshed_recently INTEGER,
  odds_coverage_status TEXT,
  bookmaker_count INTEGER,
  stale_odds_flag INTEGER NOT NULL DEFAULT 0,
  quota_degraded_flag INTEGER NOT NULL DEFAULT 0,
  data_completeness_score REAL,
  board_provider TEXT,
  board_source_label TEXT,
  board_source_mode TEXT,
  source_reliability_score REAL,
  board_quality_tier TEXT,
  board_quality_score REAL,
  fallback_used_flag INTEGER NOT NULL DEFAULT 0,
  price_quality_status TEXT,
  price_trustworthy_flag INTEGER NOT NULL DEFAULT 0,
  price_block_reasons_json TEXT,
  recommendation_downgrade_reason TEXT,
  market_probability REAL,
  opening_odds REAL,
  closing_odds REAL,
  closing_line_value REAL,
  fair_odds REAL,
  model_probability REAL,
  has_odds INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL,
  probabilities_json TEXT NOT NULL,
  markets_json TEXT NOT NULL,
  settled_at TEXT,
  outcome_label TEXT,
  bet_result TEXT,
  is_correct INTEGER,
  roi REAL,
  grade_note TEXT,
  FOREIGN KEY (collector_run_id) REFERENCES collector_runs(id),
  FOREIGN KEY (match_id) REFERENCES matches(id)
);

CREATE TABLE IF NOT EXISTS model_parameter_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_name TEXT NOT NULL,
  trained_at TEXT NOT NULL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  holdout_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'candidate',
  is_active INTEGER NOT NULL DEFAULT 0,
  train_log_loss REAL,
  holdout_log_loss REAL,
  train_goal_mse REAL,
  holdout_goal_mse REAL,
  improvement_vs_active REAL,
  parameters_json TEXT NOT NULL,
  summary_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decision_policy_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trained_at TEXT NOT NULL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  holdout_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'candidate',
  is_active INTEGER NOT NULL DEFAULT 0,
  train_roi REAL,
  holdout_roi REAL,
  train_hit_rate REAL,
  holdout_hit_rate REAL,
  improvement_vs_active REAL,
  policies_json TEXT NOT NULL,
  summary_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS availability_source_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER,
  team_id INTEGER,
  provider TEXT NOT NULL,
  source_type TEXT NOT NULL,
  url TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider, source_type, url),
  FOREIGN KEY (match_id) REFERENCES matches(id),
  FOREIGN KEY (team_id) REFERENCES teams(id)
);

CREATE TABLE IF NOT EXISTS injury_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER,
  team_id INTEGER NOT NULL,
  player_name TEXT NOT NULL,
  player_role TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  expected_return TEXT,
  importance_score REAL NOT NULL DEFAULT 0.5,
  source_provider TEXT NOT NULL,
  source_url TEXT,
  extracted_at TEXT NOT NULL,
  FOREIGN KEY (match_id) REFERENCES matches(id),
  FOREIGN KEY (team_id) REFERENCES teams(id)
);

CREATE TABLE IF NOT EXISTS suspension_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER,
  team_id INTEGER NOT NULL,
  player_name TEXT NOT NULL,
  player_role TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  return_date TEXT,
  importance_score REAL NOT NULL DEFAULT 0.5,
  source_provider TEXT NOT NULL,
  source_url TEXT,
  extracted_at TEXT NOT NULL,
  FOREIGN KEY (match_id) REFERENCES matches(id),
  FOREIGN KEY (team_id) REFERENCES teams(id)
);

CREATE TABLE IF NOT EXISTS expected_lineup_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL,
  team_id INTEGER NOT NULL,
  player_name TEXT NOT NULL,
  player_role TEXT,
  lineup_slot INTEGER,
  expected_start INTEGER NOT NULL DEFAULT 1,
  certainty_score REAL NOT NULL DEFAULT 0.5,
  source_provider TEXT NOT NULL,
  source_url TEXT,
  extracted_at TEXT NOT NULL,
  FOREIGN KEY (match_id) REFERENCES matches(id),
  FOREIGN KEY (team_id) REFERENCES teams(id)
);

CREATE TABLE IF NOT EXISTS team_news_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER,
  team_id INTEGER,
  provider TEXT NOT NULL,
  source_type TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  url TEXT NOT NULL,
  published_at TEXT,
  relevance_score REAL NOT NULL DEFAULT 0.5,
  extracted_at TEXT NOT NULL,
  UNIQUE(provider, url),
  FOREIGN KEY (match_id) REFERENCES matches(id),
  FOREIGN KEY (team_id) REFERENCES teams(id)
);

CREATE TABLE IF NOT EXISTS odds_market_boards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL,
  market TEXT NOT NULL,
  source_provider TEXT NOT NULL,
  source_label TEXT,
  source_mode TEXT NOT NULL,
  source_reliability_score REAL,
  board_quality_tier TEXT NOT NULL,
  board_quality_score REAL NOT NULL,
  bookmaker_count INTEGER NOT NULL DEFAULT 0,
  freshness_minutes REAL,
  completeness_score REAL,
  implied_consistency_score REAL,
  quota_degraded_flag INTEGER NOT NULL DEFAULT 0,
  board_recorded_at TEXT,
  board_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(match_id, market, source_mode),
  FOREIGN KEY (match_id) REFERENCES matches(id)
);

CREATE TABLE IF NOT EXISTS odds_source_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  competition_code TEXT NOT NULL,
  sport_key TEXT,
  source_label TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  expires_at TEXT,
  request_status TEXT NOT NULL,
  error_message TEXT,
  UNIQUE(provider, competition_code),
  FOREIGN KEY (competition_code) REFERENCES competitions(code)
);

CREATE TABLE IF NOT EXISTS reminder_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL,
  kickoff_time TEXT NOT NULL,
  recipient TEXT NOT NULL,
  channel TEXT NOT NULL,
  market_name TEXT NOT NULL,
  selection_label TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  message_id TEXT,
  error_message TEXT,
  summary_json TEXT NOT NULL,
  UNIQUE(match_id, kickoff_time, recipient, channel, market_name, selection_label),
  FOREIGN KEY (match_id) REFERENCES matches(id)
);

CREATE TABLE IF NOT EXISTS system_metric_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  competition_code TEXT,
  generated_at TEXT NOT NULL,
  trust_percent REAL,
  blind_brier_avg REAL,
  blind_modeled_matches INTEGER NOT NULL DEFAULT 0,
  forward_tracked_matches INTEGER NOT NULL DEFAULT 0,
  forward_settled_bets INTEGER NOT NULL DEFAULT 0,
  upcoming_matches INTEGER NOT NULL DEFAULT 0,
  upcoming_with_odds INTEGER NOT NULL DEFAULT 0,
  likely_lineups INTEGER NOT NULL DEFAULT 0,
  confirmed_lineups INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_matches_competition_date ON matches(competition_code, utc_date);
CREATE INDEX IF NOT EXISTS idx_matches_status_date ON matches(status, utc_date);
CREATE INDEX IF NOT EXISTS idx_odds_snapshots_match_time ON odds_snapshots(match_id, retrieved_at DESC);
CREATE INDEX IF NOT EXISTS idx_odds_quote_history_match_time ON odds_quote_history(match_id, market, recorded_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_odds_quote_history_snapshot_outcome ON odds_quote_history(snapshot_id, outcome_key);
CREATE INDEX IF NOT EXISTS idx_odds_source_cache_lookup ON odds_source_cache(competition_code, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_team_match_advanced_stats_match_team ON team_match_advanced_stats(match_id, team_id, extracted_at DESC);
CREATE INDEX IF NOT EXISTS idx_historical_enrichment_repairs_lookup ON historical_enrichment_repairs(source_provider, competition_code, source_match_date);
CREATE INDEX IF NOT EXISTS idx_standings_competition ON standings_rows(competition_code, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_collector_runs_started_at ON collector_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_recommendation_snapshots_match_time ON recommendation_snapshots(match_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_recommendation_snapshots_generated_at ON recommendation_snapshots(generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_match_context_updated_at ON match_context(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_parameter_sets_active ON model_parameter_sets(is_active, trained_at DESC);
CREATE INDEX IF NOT EXISTS idx_decision_policy_sets_active ON decision_policy_sets(is_active, trained_at DESC);
CREATE INDEX IF NOT EXISTS idx_availability_source_links_match ON availability_source_links(match_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_injury_records_match_team ON injury_records(match_id, team_id, extracted_at DESC);
CREATE INDEX IF NOT EXISTS idx_suspension_records_match_team ON suspension_records(match_id, team_id, extracted_at DESC);
CREATE INDEX IF NOT EXISTS idx_expected_lineup_records_match_team ON expected_lineup_records(match_id, team_id, extracted_at DESC);
CREATE INDEX IF NOT EXISTS idx_team_news_records_match_team ON team_news_records(match_id, team_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_reminder_notifications_match_time ON reminder_notifications(match_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_metric_snapshots_scope ON system_metric_snapshots(scope, competition_code, generated_at DESC);
`;
