-- ADR 106: source data for the evidence weight multipliers. `weight` already includes the multiplier;
-- these columns are for analysis (hub_profile, calibration) and are not part of UNIQUE(source, ref_json).
ALTER TABLE evidence_events ADD COLUMN miss_class TEXT CHECK (miss_class IN ('cue','discrimination','execution','careless','structural'));
ALTER TABLE evidence_events ADD COLUMN response_ms INTEGER;
ALTER TABLE evidence_events ADD COLUMN weight_multiplier REAL;
