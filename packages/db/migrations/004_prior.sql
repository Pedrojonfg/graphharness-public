-- V2 (ADR 105 §6): prior-knowledge reports (19, 20) and syllabus per subject (22).
CREATE TABLE prior_reports (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  paths_json TEXT NOT NULL,          -- LH paths (relative to the materials folder) that were imported
  data_json TEXT NOT NULL,           -- {total, counts, percentages, items}
  created_at TEXT NOT NULL
);
CREATE INDEX idx_prior_reports_subject ON prior_reports(subject_id, created_at);

CREATE TABLE syllabus_items (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL REFERENCES subjects(id),
  position INTEGER NOT NULL,
  level INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  UNIQUE(subject_id, position)
);
