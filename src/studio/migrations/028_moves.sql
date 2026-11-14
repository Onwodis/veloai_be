-- Performance moves (be/src/moves).
-- 1. Custom moves: a user's own moves (made, remixed from the library, or copied
--    from another creator with the move id + key). At most 100 live per user
--    (enforced in the service). move_id is public; share_key is the secret the
--    owner shares. origin keeps the ORIGINAL creator of a copied move, forever.
CREATE TABLE IF NOT EXISTS custom_moves (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  move_id     varchar(16) NOT NULL UNIQUE,
  share_key   varchar(32) NOT NULL,
  owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  domain      varchar(8) NOT NULL CHECK (domain IN ('MUSIC', 'AD')),
  category    varchar(24) NOT NULL,
  name        varchar(80) NOT NULL,
  cue         varchar(420) NOT NULL,
  detail      text NOT NULL DEFAULT '',
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  based_on    varchar(32),
  origin      jsonb,
  copies      integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX IF NOT EXISTS custom_moves_owner_idx ON custom_moves (owner_id, created_at DESC) WHERE deleted_at IS NULL;

-- 2. Favourite moves (library ids or custom move ids), per user.
CREATE TABLE IF NOT EXISTS move_favourites (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  move_ref    varchar(40) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, move_ref)
);

-- 3. Wrong move-key attempts (slows down guessing keys).
CREATE TABLE IF NOT EXISTS move_key_failures (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS move_key_failures_idx ON move_key_failures (user_id, at DESC);

-- 4. Moves placed on characters in a scene (a frozen copy each, woven into the shot prompt).
ALTER TABLE studio_scenes ADD COLUMN IF NOT EXISTS moves jsonb NOT NULL DEFAULT '[]'::jsonb;
