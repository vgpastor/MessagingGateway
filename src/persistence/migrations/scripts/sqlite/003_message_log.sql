-- Message log: global `seq`, per-account contiguous `account_seq`, WhatsApp message id dedupe,
-- provider `sent_at`, the sender's stable identity (`sender_phone`, `sender_lid`) and the raw provider payload (SQLite).
--
-- The migration runner wraps this script and its `_migrations` record in ONE transaction.
-- Existing rows get `seq` from their insertion order (rowid) and inbound rows get `account_seq`
-- per account by `created_at`, then `seq`. Outbound rows have no `account_seq`.

-- The FTS triggers of 001/002 were wrong for an external-content table: the insert did not pass the
-- rowid (the index and `messages` drift apart) and the delete must use the FTS 'delete' command.
-- Dropped first so the dedupe below does not run them; recreated and rebuilt at the end.
DROP TRIGGER IF EXISTS messages_ai;
DROP TRIGGER IF EXISTS messages_ad;

ALTER TABLE messages ADD COLUMN seq INTEGER;
ALTER TABLE messages ADD COLUMN account_seq INTEGER;
ALTER TABLE messages ADD COLUMN wa_message_id TEXT;
ALTER TABLE messages ADD COLUMN sent_at TEXT;
-- Sender identity as exposed by the channel (E.164 phone, WhatsApp LID). NULL for legacy rows: nothing is backfilled.
ALTER TABLE messages ADD COLUMN sender_phone TEXT;
ALTER TABLE messages ADD COLUMN sender_lid TEXT;
ALTER TABLE messages ADD COLUMN raw_json TEXT;

-- Every row the dedupe removes is kept here, with the id of the row that won.
--
-- Duplicates are the same account + WhatsApp id (an empty id means "unknown" and never conflicts).
-- The BEST row of each group stays: a row with content beats a placeholder (an empty text stub from
-- a message Baileys could not decrypt, whose real copy arrives later with the same id, or the text the
-- Baileys mapper writes for a type it cannot map), then the oldest by created_at, then the lowest rowid.
CREATE TABLE messages_dedupe_archive AS
  SELECT m.*, r.kept_id AS kept_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS archived_at
  FROM messages m
  JOIN (
    SELECT id, row_number() OVER w AS rn, first_value(id) OVER w AS kept_id
    FROM messages
    WHERE NULLIF(json_extract(channel_details_json, '$.messageId'), '') IS NOT NULL
    WINDOW w AS (
      PARTITION BY account_id, json_extract(channel_details_json, '$.messageId')
      ORDER BY CASE WHEN json_extract(content_json, '$.type') = 'text'
                     AND (COALESCE(json_extract(content_json, '$.body'), '') IN ('', '[Edited message]')
                          OR json_extract(content_json, '$.body') LIKE '[Unsupported message type:%') THEN 1 ELSE 0 END,
               created_at, rowid
    )
  ) r ON r.id = m.id
  WHERE r.rn > 1;

DELETE FROM messages WHERE id IN (SELECT id FROM messages_dedupe_archive);

-- One single pass over the table. `account_seq` is contiguous 1..n per account over inbound rows only, in arrival order.
UPDATE messages
  SET seq = messages.rowid,
      wa_message_id = NULLIF(json_extract(channel_details_json, '$.messageId'), ''),
      account_seq = s.account_seq
  FROM (
    SELECT id, CASE direction WHEN 'inbound'
             THEN row_number() OVER (PARTITION BY account_id, direction ORDER BY created_at, rowid) END AS account_seq
    FROM messages
  ) s
  WHERE messages.id = s.id;

-- Per-account counters, kept apart from `messages` so retention never makes a number get reused
CREATE TABLE account_counters (
  account_id TEXT PRIMARY KEY,
  n INTEGER NOT NULL
);

INSERT INTO account_counters (account_id, n)
  SELECT account_id, max(account_seq) FROM messages WHERE account_seq IS NOT NULL GROUP BY account_id;

CREATE UNIQUE INDEX uq_messages_account_wa ON messages(account_id, wa_message_id) WHERE wa_message_id IS NOT NULL;
CREATE UNIQUE INDEX uq_messages_account_seq ON messages(account_id, account_seq);
CREATE UNIQUE INDEX uq_messages_seq ON messages(seq);

CREATE INDEX idx_messages_created_at ON messages(created_at);
CREATE INDEX idx_messages_media_pending ON messages(seq) WHERE json_extract(content_json, '$.media.status') = 'pending';

-- Global sequence, kept apart from `messages` for the same reason as the account counters.
CREATE TABLE message_seq_counter (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  n INTEGER NOT NULL
);

INSERT INTO message_seq_counter (id, n) SELECT 1, COALESCE(MAX(seq), 0) FROM messages;

-- Every new row gets the next global seq. insertInbound() sets account_seq itself, inside its transaction.
CREATE TRIGGER messages_seq_ai AFTER INSERT ON messages WHEN new.seq IS NULL BEGIN
  UPDATE message_seq_counter SET n = n + 1;
  UPDATE messages SET seq = (SELECT n FROM message_seq_counter) WHERE rowid = new.rowid;
END;

-- Full-text index kept in step with `messages`, row by row
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, id, content_preview, sender_name)
  VALUES (new.rowid, new.id, new.content_preview, new.sender_name);
END;

CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, id, content_preview, sender_name)
  VALUES ('delete', old.rowid, old.id, old.content_preview, old.sender_name);
END;

CREATE TRIGGER messages_au AFTER UPDATE OF id, content_preview, sender_name ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, id, content_preview, sender_name)
  VALUES ('delete', old.rowid, old.id, old.content_preview, old.sender_name);
  INSERT INTO messages_fts(rowid, id, content_preview, sender_name)
  VALUES (new.rowid, new.id, new.content_preview, new.sender_name);
END;

INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');

-- One row for the write probe of the inbound path: a SELECT answers on a read-only database too.
CREATE TABLE store_health (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  checked_at TEXT NOT NULL
);
INSERT INTO store_health (id, checked_at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- The rewrite left the planner statistics out of date.
ANALYZE messages;
