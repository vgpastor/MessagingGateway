-- Message log: global `seq`, per-account contiguous `account_seq`, WhatsApp message id dedupe,
-- provider `sent_at` and the raw provider payload (PostgreSQL).
--
-- Runs as ONE multi-statement simple query, i.e. a single implicit transaction:
-- either the whole upgrade of existing rows applies or nothing does.
-- Existing rows get `seq` from the table rewrite of ADD COLUMN (heap order, which is insertion
-- order for this append-only table) and `account_seq` is derived from `seq` per account.

ALTER TABLE messages
  ADD COLUMN seq BIGSERIAL,
  ADD COLUMN account_seq BIGINT,
  ADD COLUMN wa_message_id TEXT,
  ADD COLUMN sent_at TIMESTAMPTZ,
  ADD COLUMN raw_json JSONB;

-- WhatsApp message id lives in the channel details; empty means "unknown" (NULL never conflicts)
UPDATE messages SET wa_message_id = NULLIF(channel_details_json->>'messageId', '');

-- Drop duplicates (same account + WhatsApp id), keeping the oldest row (lowest seq)
DELETE FROM messages a USING messages b
  WHERE a.account_id = b.account_id
    AND a.wa_message_id = b.wa_message_id
    AND a.seq > b.seq;

-- Contiguous 1..n per account, in insertion order
UPDATE messages m SET account_seq = s.rn
  FROM (SELECT id, row_number() OVER (PARTITION BY account_id ORDER BY seq) AS rn FROM messages) s
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

-- Unused GIN index over every message body: expensive to maintain on each insert
DROP INDEX IF EXISTS idx_messages_content_json;
