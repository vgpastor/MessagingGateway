-- Message log: global `seq`, per-account contiguous `account_seq`, WhatsApp message id dedupe,
-- provider `sent_at`, the sender's stable identity (`sender_phone`, `sender_lid`) and the raw provider payload (PostgreSQL).
--
-- The migration runner wraps this script and its `_migrations` record in ONE transaction:
-- either the whole upgrade of existing rows applies (and is recorded) or nothing does.
-- Existing rows get `seq` from the table rewrite of ADD COLUMN (heap order) and `account_seq`
-- is numbered per account by `created_at`, then `seq`.

-- Unused GIN index over every message body: expensive to maintain, and dropping it first
-- spares the full-table UPDATEs below from rewriting it for every row.
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

-- WhatsApp message id lives in the channel details; empty means "unknown" (NULL never conflicts)
UPDATE messages SET wa_message_id = NULLIF(channel_details_json->>'messageId', '');

-- Drop duplicates (same account + WhatsApp id), keeping the BEST row of each group:
-- a row with content beats an empty text stub (Baileys upserts `{type:'text', body:''}` for a
-- message it could not decrypt and the real one arrives later with the same id), then the
-- oldest by created_at, then the lowest seq.
DELETE FROM messages m USING (
    SELECT id, row_number() OVER (
      PARTITION BY account_id, wa_message_id
      ORDER BY CASE WHEN content_json->>'type' = 'text' AND COALESCE(content_json->>'body', '') = '' THEN 1 ELSE 0 END,
               created_at, seq
    ) AS rn
    FROM messages
    WHERE wa_message_id IS NOT NULL
  ) d
  WHERE m.id = d.id AND d.rn > 1;

-- Contiguous 1..n per account, in arrival order (created_at, then seq)
UPDATE messages m SET account_seq = s.rn
  FROM (SELECT id, row_number() OVER (PARTITION BY account_id ORDER BY created_at, seq) AS rn FROM messages) s
  WHERE m.id = s.id;

-- Per-account counters: the row lock on the counter serializes concurrent inserts of an account,
-- which is what keeps `account_seq` gap-free. Kept apart from `messages` so retention
-- (DELETE) never makes a number get reused.
CREATE TABLE account_counters (
  account_id TEXT PRIMARY KEY,
  n BIGINT NOT NULL
);

INSERT INTO account_counters (account_id, n)
  SELECT account_id, max(account_seq) FROM messages GROUP BY account_id;

CREATE UNIQUE INDEX uq_messages_account_wa ON messages(account_id, wa_message_id) WHERE wa_message_id IS NOT NULL;
CREATE UNIQUE INDEX uq_messages_account_seq ON messages(account_id, account_seq);
CREATE UNIQUE INDEX uq_messages_seq ON messages(seq);

-- Retention (DELETE ... WHERE created_at < ...) and pending-media recovery at boot
CREATE INDEX idx_messages_created_at ON messages(created_at);
CREATE INDEX idx_messages_media_pending ON messages(seq) WHERE (content_json->'media'->>'status') = 'pending';
