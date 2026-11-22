-- Initial schema, verbatim from the original data model.
-- Subjects / study domains
CREATE TABLE subjects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,                 -- "Linear Algebra", "Modern Philosophy"
  slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'general' CHECK (kind IN ('computable_math','general')),
  course_notation TEXT,               -- course notation notes (GL-012, GL-080 P12)
  lh_source_folder TEXT,              -- associated LH source folder (source-organization), optional
  created_at TEXT NOT NULL,
  archived_at TEXT
);

-- Concepts (D1): domain unit
CREATE TABLE concepts (
  id TEXT PRIMARY KEY,
  subject_id TEXT REFERENCES subjects(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL,          -- 1–3 sentences, written by the curator
  computable INTEGER NOT NULL DEFAULT 0,  -- does it admit a deterministic template?
  optional INTEGER NOT NULL DEFAULT 0,    -- optional general method (GL-012)
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','merged','retired')),
  merged_into TEXT REFERENCES concepts(id),
  created_by TEXT NOT NULL CHECK (created_by IN ('curator','agent','pwa')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- LH propositions mirrored here (logically read-only; the source is LH)
CREATE TABLE lh_propositions (
  id TEXT PRIMARY KEY,                -- "n_…" from LH, stable
  name TEXT NOT NULL,
  statement TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  provenance_json TEXT NOT NULL DEFAULT '[]', -- [{chatId,messageId}]
  deleted INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_synced_at TEXT NOT NULL
);

CREATE TABLE lh_chains (
  id TEXT PRIMARY KEY,                -- "arg_…"
  premises_json TEXT NOT NULL,
  conclusion TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  last_synced_at TEXT NOT NULL
);

-- Proposition → concept membership (one proposition in 1 concept; can be reassigned)
CREATE TABLE concept_propositions (
  proposition_id TEXT PRIMARY KEY REFERENCES lh_propositions(id),
  concept_id TEXT NOT NULL REFERENCES concepts(id),
  assigned_by TEXT NOT NULL CHECK (assigned_by IN ('curator','agent','pwa')),
  assigned_at TEXT NOT NULL
);

-- Prerequisites between concepts (A → B: "B requires A")
CREATE TABLE concept_edges (
  from_concept TEXT NOT NULL REFERENCES concepts(id),
  to_concept TEXT NOT NULL REFERENCES concepts(id),
  relation TEXT NOT NULL DEFAULT 'requires' CHECK (relation IN ('requires','illustrates')),
  confidence TEXT NOT NULL CHECK (confidence IN ('high','medium','low')),
  chain_support INTEGER NOT NULL DEFAULT 0,  -- number of LH chains that support it
  source TEXT NOT NULL CHECK (source IN ('derived','curator','manual')),
  removed INTEGER NOT NULL DEFAULT 0,        -- removed by hand (not re-derived)
  justification TEXT,
  PRIMARY KEY (from_concept, to_concept)
);

-- Evidence: append-only log (source of truth)
CREATE TABLE evidence_events (
  id TEXT PRIMARY KEY,
  concept_id TEXT NOT NULL REFERENCES concepts(id),
  at TEXT NOT NULL,                   -- when it happened (not when it was recorded)
  source TEXT NOT NULL CHECK (source IN (
    'lh_quiz','lh_probe','lh_recall','lh_practice',
    'hub_exercise','hub_diagnostic','flashcard','declaration','confirmation')),
  correct INTEGER,                    -- NULL for declarations
  response_format TEXT CHECK (response_format IN ('open','mcq')),
  inferred INTEGER NOT NULL DEFAULT 0, -- correctness judged by an LLM
  weight REAL NOT NULL DEFAULT 1.0,    -- 0.5 for flashcards (D26)
  confidence INTEGER,                  -- 0–100 (LH quiz), analytics
  target_state TEXT CHECK (target_state IN ('solid','review','weak')), -- declarations
  justification TEXT,                  -- declarations (GL-013)
  ref_json TEXT NOT NULL DEFAULT '{}', -- {chatId,toolCallId} | {instanceId} | {cardId} | {declarationId}
  ingested_at TEXT NOT NULL,
  UNIQUE (source, ref_json)            -- ingest idempotency
);

-- Materialized state per concept (derivable from the log; recalculated)
CREATE TABLE concept_state (
  concept_id TEXT PRIMARY KEY REFERENCES concepts(id),
  probability REAL NOT NULL,          -- P without decay (after the last event)
  decay_class TEXT NOT NULL CHECK (decay_class IN ('reasoned','quick','strain','manual_pending','manual_confirmed')),
  source TEXT NOT NULL CHECK (source IN ('grade','manual')),
  manual_confirmation TEXT CHECK (manual_confirmation IN ('pending','confirmed')),
  updated_at TEXT NOT NULL            -- `at` of the last event
);

-- Declarations (D3/D4): confirmation lifecycle
CREATE TABLE declarations (
  id TEXT PRIMARY KEY,
  concept_id TEXT NOT NULL REFERENCES concepts(id),
  target_state TEXT NOT NULL,
  justification TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('agent','pwa')),
  raw_text TEXT,                      -- what the user said (transcript), if it comes from the agent
  weak_prereqs_json TEXT NOT NULL DEFAULT '[]', -- snapshot of the warning
  ack_weak_prereqs INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('pending','confirmed','refuted','expired')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

-- Templates (methods) — GL-003 without a global layer
CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  concept_id TEXT NOT NULL REFERENCES concepts(id),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  method_summary TEXT,                -- "summary sheet" (GL-039.3)
  method_limits TEXT,                 -- GL-012
  general_template_id TEXT REFERENCES templates(id),
  recipe_json TEXT NOT NULL,          -- recipe_v1 normalized by eval
  level TEXT NOT NULL DEFAULT 'base', -- difficulty band
  status TEXT NOT NULL CHECK (status IN ('active','failed','retired')),
  validation_json TEXT,               -- last response from /v1/recipes/validate
  created_at TEXT NOT NULL
);

CREATE TABLE template_errors (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES templates(id),
  key TEXT NOT NULL,                  -- snake_case
  description TEXT NOT NULL,
  expr TEXT NOT NULL,                 -- recipe_v1 expression that reproduces the error
  origin TEXT NOT NULL CHECK (origin IN ('recipe','personal')),
  times_seen INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  UNIQUE (template_id, key)
);

CREATE TABLE instances (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES templates(id),
  payload_json TEXT NOT NULL,         -- output of eval /v1/generate (includes the solution; never sent to the client)
  client_json TEXT NOT NULL,          -- RecipeClientPayload
  created_at TEXT NOT NULL
);

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES instances(id),
  context TEXT NOT NULL CHECK (context IN ('exercise','diagnostic','confirmation','exam_sim')),
  user_input_json TEXT NOT NULL,
  correct INTEGER NOT NULL,
  matched_error_id TEXT REFERENCES template_errors(id),
  unknown_pattern INTEGER NOT NULL DEFAULT 0,
  hints_used INTEGER NOT NULL DEFAULT 0,
  learner_explanation TEXT,           -- GL-010 step 3 (optional)
  response_ms INTEGER,
  created_at TEXT NOT NULL
);

-- Unknown errors pending conversion into a personal error
CREATE TABLE unknown_errors (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  template_id TEXT NOT NULL REFERENCES templates(id),
  hypothesis_json TEXT,               -- {key, description, expr} proposed by an LLM
  status TEXT NOT NULL CHECK (status IN ('open','promoted','rejected')),
  created_at TEXT NOT NULL
);

-- Flashcards (GL-025)
CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  concept_id TEXT REFERENCES concepts(id),
  proposition_ids_json TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL CHECK (kind IN ('mcq','cloze','text')),
  purpose TEXT NOT NULL DEFAULT 'review' CHECK (purpose IN ('review','confirmation')),
  front_text TEXT,                    -- with $…$
  instance_id TEXT REFERENCES instances(id), -- if it comes from a template
  options_json TEXT,                  -- MCQ: [{id,value}]
  answer_json TEXT NOT NULL,          -- {optionId} | {text, accepted:[…]}
  source_chat_id TEXT,                -- source LH session
  declaration_id TEXT REFERENCES declarations(id),
  ease REAL NOT NULL, interval_days REAL NOT NULL, repetitions INTEGER NOT NULL,
  t_ref INTEGER NOT NULL,             -- ms epoch
  reviewed INTEGER NOT NULL DEFAULT 0,
  retired INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE card_reviews (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id),
  correct INTEGER NOT NULL,
  response_ms INTEGER,
  early INTEGER NOT NULL,
  override INTEGER NOT NULL DEFAULT 0,
  given_json TEXT,
  schedule_before_json TEXT NOT NULL,
  reviewed_at TEXT NOT NULL
);

-- Exams (D12)
CREATE TABLE exams (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL REFERENCES subjects(id),
  title TEXT NOT NULL,
  date TEXT NOT NULL,                 -- YYYY-MM-DD
  scope_concept_ids_json TEXT NOT NULL DEFAULT '[]', -- empty = the whole subject
  notes TEXT,
  created_at TEXT NOT NULL
);

-- Mirror of LH sessions + their cycle in the Hub
CREATE TABLE lh_sessions (
  chat_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('teaching','practice')),
  subject_id TEXT REFERENCES subjects(id),
  started_by TEXT CHECK (started_by IN ('learner','agent')),
  last_turn_settled_at TEXT,
  hub_state TEXT NOT NULL DEFAULT 'open' CHECK (hub_state IN ('open','closing','closed','failed')),
  closed_at TEXT,
  ingest_cursor_json TEXT NOT NULL DEFAULT '{}' -- last messageId processed by the pipeline
);

-- Mapping of LH plan node → concept (per session)
CREATE TABLE plan_node_map (
  chat_id TEXT NOT NULL,
  plan_node_id TEXT NOT NULL,
  concept_id TEXT REFERENCES concepts(id),
  method TEXT NOT NULL CHECK (method IN ('propositions','llm','manual')),
  PRIMARY KEY (chat_id, plan_node_id)
);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('session','master')),
  chat_id TEXT,                       -- session
  subject_id TEXT,                    -- master
  data_json TEXT NOT NULL,            -- structured report data
  tex TEXT,                           -- LaTeX source
  pdf_path TEXT,                      -- if it was compiled
  omitted_json TEXT NOT NULL DEFAULT '[]', -- omitted sections (GL-058)
  created_at TEXT NOT NULL
);

CREATE TABLE notes (                  -- free-form notes from the agent/PWA about a concept
  id TEXT PRIMARY KEY,
  concept_id TEXT REFERENCES concepts(id),
  text TEXT NOT NULL,
  origin TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  run_after TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE llm_usage (
  id TEXT PRIMARY KEY, task TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
  input_tokens INTEGER, output_tokens INTEGER, ok INTEGER NOT NULL, at TEXT NOT NULL
);

-- Search (resolve free text → concepts)
CREATE VIRTUAL TABLE concept_fts USING fts5(concept_id UNINDEXED, name, description, statements);
