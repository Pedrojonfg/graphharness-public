-- ADR 108: educational TikZ figures + code-comprehension kinds.
PRAGMA foreign_keys = OFF;

-- subjects.kind: + programming
CREATE TABLE subjects_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'general' CHECK (kind IN ('computable_math','general','programming')),
  course_notation TEXT,
  lh_source_folder TEXT,
  created_at TEXT NOT NULL,
  archived_at TEXT
);
INSERT INTO subjects_new SELECT id, name, slug, kind, course_notation, lh_source_folder, created_at, archived_at FROM subjects;
DROP TABLE subjects;
ALTER TABLE subjects_new RENAME TO subjects;

-- figures (compiled TikZ assets)
CREATE TABLE figures (
  id TEXT PRIMARY KEY,
  concept_id TEXT REFERENCES concepts(id),
  family TEXT NOT NULL DEFAULT 'custom',
  mode TEXT NOT NULL DEFAULT 'teaching' CHECK (mode IN ('teaching','research')),
  title TEXT,
  source_tikz TEXT NOT NULL,
  svg_path TEXT,
  pdf_path TEXT,
  libraries_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL CHECK (created_by IN ('agent','hub','llm')),
  created_at TEXT NOT NULL
);
CREATE INDEX figures_by_concept ON figures(concept_id);

-- cards.kind: + parsons, predict, spot_bug; figure_id optional
CREATE TABLE cards_new (
  id TEXT PRIMARY KEY,
  concept_id TEXT REFERENCES concepts(id),
  proposition_ids_json TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL CHECK (kind IN ('mcq','cloze','text','parsons','predict','spot_bug')),
  purpose TEXT NOT NULL DEFAULT 'review' CHECK (purpose IN ('review','confirmation')),
  front_text TEXT,
  instance_id TEXT REFERENCES instances(id),
  options_json TEXT,
  answer_json TEXT NOT NULL,
  source_chat_id TEXT,
  declaration_id TEXT REFERENCES declarations(id),
  ease REAL NOT NULL, interval_days REAL NOT NULL, repetitions INTEGER NOT NULL,
  t_ref INTEGER NOT NULL,
  reviewed INTEGER NOT NULL DEFAULT 0,
  retired INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  figure_id TEXT REFERENCES figures(id)
);
INSERT INTO cards_new (
  id, concept_id, proposition_ids_json, kind, purpose, front_text, instance_id, options_json, answer_json,
  source_chat_id, declaration_id, ease, interval_days, repetitions, t_ref, reviewed, retired, created_at, figure_id
)
SELECT
  id, concept_id, proposition_ids_json, kind, purpose, front_text, instance_id, options_json, answer_json,
  source_chat_id, declaration_id, ease, interval_days, repetitions, t_ref, reviewed, retired, created_at, NULL
FROM cards;
DROP TABLE cards;
ALTER TABLE cards_new RENAME TO cards;
CREATE INDEX cards_by_concept ON cards(concept_id);

ALTER TABLE templates ADD COLUMN method_figure_id TEXT REFERENCES figures(id);

PRAGMA foreign_keys = ON;
