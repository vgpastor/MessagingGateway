// ── Mattermost REST API v4 domain types ────────────────────────

export interface MattermostPost {
  id: string;
  channel_id: string;
  user_id: string;
  message: string;
  root_id?: string;
  parent_id?: string;
  file_ids?: string[];
  create_at: number;
  update_at: number;
  edit_at: number;
  delete_at: number;
  hashtags?: string;
  pending_post_id?: string;
  reply_count?: number;
  metadata?: MattermostPostMetadata;
}

export interface MattermostPostMetadata {
  embeds?: unknown[];
  emojis?: { name: string }[];
  files?: MattermostFileInfo[];
  images?: Record<string, MattermostImageInfo>;
  reactions?: { user_id: string; emoji_name: string }[];
}

export interface MattermostFileInfo {
  id: string;
  name: string;
  extension: string;
  size: number;
  mime_type: string;
  width?: number;
  height?: number;
}

export interface MattermostImageInfo {
  width: number;
  height: number;
}

export interface MattermostUser {
  id: string;
  username: string;
  first_name?: string;
  last_name?: string;
  nickname?: string;
  email?: string;
  auth_service?: string;
  roles?: string;
  is_bot?: boolean;
}

export interface MattermostChannel {
  id: string;
  name: string;
  display_name: string;
  type: 'O' | 'P' | 'D' | 'G';
  team_id?: string;
}

export interface MattermostFileUploadResponse {
  file_infos: MattermostFileInfo[];
}

// ── WebSocket event types ──────────────────────────────────────

export interface MattermostWSEvent {
  event: string;
  data: Record<string, unknown>;
  broadcast: {
    omit_users?: Record<string, boolean>;
    user_id?: string;
    channel_id?: string;
    team_id?: string;
    connection_id?: string;
  };
  seq: number;
}

export interface MattermostPostedEvent {
  channelId: string;
  userId: string;
  rootId?: string;
  parent_id?: string;
  message: string;
  fileIds?: string[];
  post: string; // stringified MattermostPost JSON
}

// ── Content mapping helpers ────────────────────────────────────

export type MattermostMessageContent =
  | { type: 'text'; body: string }
  | { type: 'image'; fileId: string; mimeType: string; caption?: string }
  | { type: 'audio'; fileId: string; mimeType: string }
  | { type: 'video'; fileId: string; mimeType: string; caption?: string }
  | { type: 'document'; fileId: string; mimeType: string; fileName: string }
  | { type: 'unknown'; body?: string };
