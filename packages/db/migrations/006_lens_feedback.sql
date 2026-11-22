-- ADR 109 (decision 7): vote per lens on each core node of an LH session. One vote per (chat, node, label).
CREATE TABLE lens_feedback (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  concept_id TEXT NOT NULL REFERENCES concepts(id),
  node_id TEXT NOT NULL,
  lens_label TEXT NOT NULL,
  liked INTEGER NOT NULL CHECK (liked IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(chat_id, node_id, lens_label)
);
CREATE INDEX lens_feedback_by_concept ON lens_feedback(concept_id);
