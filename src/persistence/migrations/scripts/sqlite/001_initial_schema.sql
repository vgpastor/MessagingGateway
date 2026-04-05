-- Initial schema: messages table with full-text search (SQLite)

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  direction TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_name TEXT,
  recipient_id TEXT NOT NULL,
  content_type TEXT NOT NULL,
  content_preview TEXT,
  content_json TEXT NOT NULL,
  context_json TEXT,
  channel_details_json TEXT,
  gateway_json TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_account ON messages(account_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(content_type);
CREATE INDEX IF NOT EXISTS idx_messages_direction ON messages(direction);

-- Full-text search via FTS5
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  id, content_preview, sender_name,
  content='messages',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(id, content_preview, sender_name)
  VALUES (new.id, new.content_preview, new.sender_name);
END;
