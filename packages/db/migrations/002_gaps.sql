-- Schema gaps that the features need (ADR 102). Additive: changes nothing from 001.

-- Maintenance: curator suggestions (merges/splits), never applied automatically.
CREATE TABLE concept_suggestions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('merge','split')),
  payload_json TEXT NOT NULL,          -- merge: {sourceIds[], targetId} · split: {conceptId, parts:[{name,description,propositionIds[]}]}
  rationale TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','dismissed')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

-- Diagnostic: a single pass (cap of 20 questions); the answers are attempts(context='diagnostic').
CREATE TABLE diagnostics (
  id TEXT PRIMARY KEY,
  exam_id TEXT NOT NULL REFERENCES exams(id),
  status TEXT NOT NULL CHECK (status IN ('open','done')),
  state_json TEXT NOT NULL,            -- concept queue, questions asked, instance in progress
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- LH questions without a concept (evidence_events.concept_id is NOT NULL) → reprocessable with session-reingest; metric R2.
CREATE TABLE unassigned_questions (
  chat_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  source TEXT NOT NULL,
  payload_json TEXT NOT NULL,          -- the event without a concept (correct, at, response_format, …) + context to reassign it
  created_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, tool_call_id)
);

-- Automatic closing: needs to know whether a turn is in progress.
ALTER TABLE lh_sessions ADD COLUMN last_turn_started_at TEXT;

-- Step 3: hint rephrased by an LLM, cached per error.
ALTER TABLE template_errors ADD COLUMN hint TEXT;

-- Operational key-value store (last backup, repo size, last sync…), for /health.
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX evidence_by_concept ON evidence_events(concept_id, at);
CREATE INDEX jobs_ready ON jobs(status, run_after);
CREATE INDEX cards_by_concept ON cards(concept_id);
