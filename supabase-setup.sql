-- Entre bicis y libros — Supabase schema setup
-- Run in the ExecutionAI Lab project (shared sandbox) SQL editor.
-- AFTER running:
--   1. Settings → API → Exposed schemas → add "bookclub" → Save
--   2. Storage → New bucket → name "bookclub-pdfs" → Public access OFF (private)

-- 1. Schema
CREATE SCHEMA IF NOT EXISTS bookclub;

-- 2. Members (Paola creates them; login = name picker + PIN)
CREATE TABLE IF NOT EXISTS bookclub.members (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text UNIQUE NOT NULL,
  pin_hash     text NOT NULL,              -- scrypt "salt:hex"
  joined_at    date NOT NULL DEFAULT now(), -- backdatable → "miembro desde"
  is_active    boolean NOT NULL DEFAULT true,
  avatar_color text,
  created_at   timestamptz DEFAULT now()
);

-- 3. Sessions (member auth tokens)
CREATE TABLE IF NOT EXISTS bookclub.sessions (
  token      text PRIMARY KEY,
  member_id  uuid NOT NULL REFERENCES bookclub.members(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- 4. Books
-- Lifecycle: suggested → picked (raffle) → reading → read (event completed)
CREATE TABLE IF NOT EXISTS bookclub.books (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title           text NOT NULL,
  author          text,
  year            int,
  isbn            text,
  cover_url       text,
  description     text,
  status          text NOT NULL DEFAULT 'suggested'
                  CHECK (status IN ('suggested','picked','reading','read')),
  read_at         date,          -- set when event completed; orders the carousel
  pdf_path        text,          -- Storage object path in bookclub-pdfs; NULL = no PDF
  pdf_uploaded_at timestamptz,
  created_at      timestamptz DEFAULT now()
);

-- 5. Events
CREATE TABLE IF NOT EXISTS bookclub.events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title                 text NOT NULL,
  description           text,
  location              text,
  event_at              timestamptz NOT NULL,
  raffle_at             timestamptz,   -- scheduled raffle moment (informational)
  status                text NOT NULL DEFAULT 'planned'
                        CHECK (status IN ('planned','raffled','completed','cancelled')),
  selection_method      text NOT NULL DEFAULT 'raffle'
                        CHECK (selection_method IN ('raffle','vote')),
  theme                 text,          -- temática del mes (admin-set)
  vote_deadline         timestamptz,   -- blocks member votes after this (vote events)
  vote_round            int NOT NULL DEFAULT 1,
  runoff_candidate_ids  uuid[],        -- current round's allowed suggestions; NULL = all
  winning_book_id       uuid REFERENCES bookclub.books(id),
  winning_suggestion_id uuid,          -- FK added below (suggestions created after events)
  drawn_at              timestamptz,   -- idempotency guard + late-joiner logic
  created_at            timestamptz DEFAULT now()
);

-- 5b. Idempotent ALTERs for existing databases (new columns above)
ALTER TABLE bookclub.events ADD COLUMN IF NOT EXISTS selection_method text NOT NULL DEFAULT 'raffle';
ALTER TABLE bookclub.events ADD COLUMN IF NOT EXISTS theme text;
ALTER TABLE bookclub.events ADD COLUMN IF NOT EXISTS vote_deadline timestamptz;
ALTER TABLE bookclub.events ADD COLUMN IF NOT EXISTS vote_round int NOT NULL DEFAULT 1;
ALTER TABLE bookclub.events ADD COLUMN IF NOT EXISTS runoff_candidate_ids uuid[];

-- 6. Suggestions — multiple per member per event, locked once drawn or once votes exist
CREATE TABLE IF NOT EXISTS bookclub.suggestions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   uuid NOT NULL REFERENCES bookclub.events(id) ON DELETE CASCADE,
  member_id  uuid NOT NULL REFERENCES bookclub.members(id),
  book_id    uuid NOT NULL REFERENCES bookclub.books(id),
  created_at timestamptz DEFAULT now()
);

ALTER TABLE bookclub.events
  DROP CONSTRAINT IF EXISTS events_winning_suggestion_fk;
ALTER TABLE bookclub.events
  ADD CONSTRAINT events_winning_suggestion_fk
  FOREIGN KEY (winning_suggestion_id) REFERENCES bookclub.suggestions(id);

-- 6b. Votes — public voting when an event's selection_method = 'vote'.
-- Members can vote for multiple books; one vote per book per member per round.
-- Toggling the same book removes the vote. Ties open a runoff round
-- (events.vote_round + runoff_candidate_ids); old rounds stay archived.
CREATE TABLE IF NOT EXISTS bookclub.votes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL REFERENCES bookclub.events(id) ON DELETE CASCADE,
  member_id     uuid NOT NULL REFERENCES bookclub.members(id) ON DELETE CASCADE,
  suggestion_id uuid NOT NULL REFERENCES bookclub.suggestions(id) ON DELETE CASCADE,
  round         int NOT NULL DEFAULT 1,
  created_at    timestamptz DEFAULT now(),
  UNIQUE (event_id, member_id, suggestion_id, round)
);

-- 6c. Idempotent migrations for existing databases
ALTER TABLE bookclub.suggestions DROP CONSTRAINT IF EXISTS suggestions_event_id_member_id_key;
ALTER TABLE bookclub.votes DROP CONSTRAINT IF EXISTS votes_event_id_member_id_round_key;
ALTER TABLE bookclub.votes DROP COLUMN IF EXISTS updated_at;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'votes_event_id_member_id_suggestion_id_round_key'
  ) THEN
    ALTER TABLE bookclub.votes
      ADD CONSTRAINT votes_event_id_member_id_suggestion_id_round_key
      UNIQUE (event_id, member_id, suggestion_id, round);
  END IF;
END $$;

-- 7. Ratings — 0–10 scale, half-point steps; note is private to the member
CREATE TABLE IF NOT EXISTS bookclub.ratings (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id  uuid NOT NULL REFERENCES bookclub.members(id) ON DELETE CASCADE,
  book_id    uuid NOT NULL REFERENCES bookclub.books(id) ON DELETE CASCADE,
  score      numeric(3,1) NOT NULL
             CHECK (score >= 0 AND score <= 10 AND score * 2 = floor(score * 2)),
  note       text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (member_id, book_id)
);

-- 8. Attendance
CREATE TABLE IF NOT EXISTS bookclub.attendance (
  event_id   uuid NOT NULL REFERENCES bookclub.events(id) ON DELETE CASCADE,
  member_id  uuid NOT NULL REFERENCES bookclub.members(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (event_id, member_id)
);

-- 9. updated_at trigger for ratings
CREATE OR REPLACE FUNCTION bookclub.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ratings_updated_at ON bookclub.ratings;
CREATE TRIGGER ratings_updated_at
  BEFORE UPDATE ON bookclub.ratings
  FOR EACH ROW EXECUTE FUNCTION bookclub.set_updated_at();

-- 10. Grants — service_role only. The browser never talks to Supabase directly;
-- everything goes through api.mjs with the service key. anon/authenticated get
-- nothing (defense in depth alongside RLS below).
GRANT USAGE ON SCHEMA bookclub TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA bookclub TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA bookclub TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA bookclub GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA bookclub GRANT ALL ON SEQUENCES TO service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA bookclub FROM anon, authenticated;
REVOKE USAGE ON SCHEMA bookclub FROM anon, authenticated;

-- 11. RLS — enabled with NO policies = deny-all for anon/authenticated.
-- service_role bypasses RLS, so api.mjs is unaffected. This protects the schema
-- even if the shared Lab project's anon key leaks via a sibling app.
ALTER TABLE bookclub.members     ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookclub.sessions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookclub.books       ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookclub.events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookclub.suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookclub.votes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookclub.ratings     ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookclub.attendance  ENABLE ROW LEVEL SECURITY;
