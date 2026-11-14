-- VeloBot's background review of each finished music-video take
-- (be/src/musicvideo/review.ts): technical checks + a look at frames against
-- the scene, the story, the cast and the song. Shape:
--   { status: RUNNING | DONE | FAILED, verdict: GOOD | FLAG, score 1-10,
--     summary, issues: [{ kind, severity, detail }], fixes: [{ action, label }],
--     at, dismissedAt? }
ALTER TABLE studio_takes ADD COLUMN IF NOT EXISTS review jsonb;
