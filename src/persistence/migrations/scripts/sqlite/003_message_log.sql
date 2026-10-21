-- Message log: global `seq`, per-account contiguous `account_seq`, WhatsApp message id dedupe,
-- provider `sent_at` and the raw provider payload (SQLite).
--
-- Existing rows are renumbered in their original insertion order (rowid).

ALTER TABLE messages ADD COLUMN seq INTEGER;
ALTER TABLE messages ADD COLUMN account_seq INTEGER;
ALTER TABLE messages ADD COLUMN wa_message_id TEXT;
ALTER TABLE messages ADD COLUMN sent_at TEXT;
ALTER TABLE messages ADD COLUMN raw_json TEXT;

UPDATE messages SET seq = rowid;

-- WhatsApp message id lives in the channel details; empty means "unknown" (NULL never conflicts)
UPDATE messages SET wa_message_id = NULLIF(json_extract(channel_details_json, '$.messageId'), '');

-- Drop duplicates (same account + WhatsApp id), keeping the oldest row (lowest seq)
DELETE FROM messages
  WHERE wa_message_id IS NOT NULL
    AND seq NOT IN (
      SELECT min(seq) FROM messages WHERE wa_message_id IS NOT NULL GROUP BY account_id, wa_message_id
    );

-- Contiguous 1..n per account, in insertion order
UPDATE messages SET account_seq = s.rn
  FROM (SELECT id, row_number() OVER (PARTITION BY account_id ORDER BY seq) AS rn FROM messages) s
  WHERE messages.id = s.id;

-- Per-account counters, kept apart from `messages` so retention never makes a number get reused
CREATE TABLE account_counters (
  account_id TEXT PRIMARY KEY,
  n INTEGER NOT NULL
);

INSERT INTO account_counters (account_id, n)
  SELECT account_id, max(account_seq) FROM messages GROUP BY account_id;

CREATE UNIQUE INDEX uq_messages_account_wa ON messages(account_id, wa_message_id) WHERE wa_message_id IS NOT NULL;
CREATE UNIQUE INDEX uq_messages_account_seq ON messages(account_id, account_seq);
CREATE UNIQUE INDEX uq_messages_seq ON messages(seq);

CREATE INDEX idx_messages_created_at ON messages(created_at);
CREATE INDEX idx_messages_media_pending ON messages(seq) WHERE json_extract(content_json, '$.media.status') = 'pending';

-- Rows inserted through save() (outbound) get the next global seq automatically.
-- insertInbound() sets account_seq itself, inside its transaction.
CREATE TRIGGER messages_seq_ai AFTER INSERT ON messages WHEN new.seq IS NULL BEGIN
  UPDATE messages SET seq = (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages) WHERE rowid = new.rowid;
END;
