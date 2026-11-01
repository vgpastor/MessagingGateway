-- Message log: global `seq`, per-account contiguous `account_seq`, WhatsApp message id dedupe,
-- provider `sent_at`, the sender's stable identity (`sender_phone`, `sender_lid`) and the raw provider payload (PostgreSQL).
--
-- The migration runner wraps this script and its `_migrations` record in ONE transaction:
-- either the whole upgrade of existing rows applies (and is recorded) or nothing does.
-- Existing rows get `seq` from the table rewrite of ADD COLUMN (heap order) and inbound rows get
-- `account_seq` per account by `created_at`, then `seq`. Outbound rows have no `account_seq`.

-- Unused GIN index over every message body: expensive to maintain, and dropping it first
-- spares the full-table UPDATE below from rewriting it for every row.
DROP INDEX IF EXISTS idx_messages_content_json;

ALTER TABLE messages
  ADD COLUMN seq BIGSERIAL,
  ADD COLUMN account_seq BIGINT,
  ADD COLUMN wa_message_id TEXT,
  ADD COLUMN sent_at TIMESTAMPTZ,
  -- Sender identity as exposed by the channel (E.164 phone, WhatsApp LID). NULL for legacy rows: nothing is backfilled.
  ADD COLUMN sender_phone TEXT,
  ADD COLUMN sender_lid TEXT,
  ADD COLUMN raw_json JSONB;

-- Every row the dedupe removes is kept here, with the id of the row that won.
CREATE TABLE messages_dedupe_archive (
  LIKE messages,
  kept_id TEXT NOT NULL,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Drop duplicates (same account + WhatsApp id; an empty id means "unknown" and never conflicts),
-- keeping the BEST row of each group: a row with content beats a placeholder (an empty text stub
-- from a message Baileys could not decrypt, whose real copy arrives later with the same id, or the
-- text the Baileys mapper writes for a type it cannot map), then the oldest by created_at, then the lowest seq.
WITH ranked AS (
    SELECT id, row_number() OVER w AS rn, first_value(id) OVER w AS kept_id
    FROM messages
    WHERE NULLIF(channel_details_json->>'messageId', '') IS NOT NULL
    WINDOW w AS (
      PARTITION BY account_id, channel_details_json->>'messageId'
      ORDER BY CASE WHEN content_json->>'type' = 'text'
                     AND (COALESCE(content_json->>'body', '') IN ('', '[Edited message]')
                          OR content_json->>'body' LIKE '[Unsupported message type:%') THEN 1 ELSE 0 END,
               created_at, seq
    )
  ), removed AS (
    DELETE FROM messages m USING ranked r
    WHERE m.id = r.id AND r.rn > 1
    RETURNING m.*, r.kept_id
  )
INSERT INTO messages_dedupe_archive SELECT * FROM removed;

-- One single pass over the table: each UPDATE of every row writes a full new copy of it.
-- `account_seq` is contiguous 1..n per account over inbound rows only, in arrival order.
UPDATE messages m
  SET wa_message_id = NULLIF(m.channel_details_json->>'messageId', ''),
      account_seq = s.account_seq
  FROM (
    SELECT id, CASE direction WHEN 'inbound'
             THEN row_number() OVER (PARTITION BY account_id, direction ORDER BY created_at, seq) END AS account_seq
    FROM messages
  ) s
  WHERE m.id = s.id;

-- Per-account counters: the row lock on the counter serializes concurrent inserts of an account,
-- which is what keeps `account_seq` gap-free. Kept apart from `messages` so retention
-- (DELETE) never makes a number get reused.
CREATE TABLE account_counters (
  account_id TEXT PRIMARY KEY,
  n BIGINT NOT NULL
);

INSERT INTO account_counters (account_id, n)
  SELECT account_id, max(account_seq) FROM messages WHERE account_seq IS NOT NULL GROUP BY account_id;

CREATE UNIQUE INDEX uq_messages_account_wa ON messages(account_id, wa_message_id) WHERE wa_message_id IS NOT NULL;
CREATE UNIQUE INDEX uq_messages_account_seq ON messages(account_id, account_seq);
CREATE UNIQUE INDEX uq_messages_seq ON messages(seq);

-- Retention (DELETE ... WHERE created_at < ...) and pending-media recovery at boot
CREATE INDEX idx_messages_created_at ON messages(created_at);
CREATE INDEX idx_messages_media_pending ON messages(seq) WHERE (content_json->'media'->>'status') = 'pending';

-- The rewrite left the planner statistics out of date.
ANALYZE messages;
