// Types representing the wwebjs-api (avoylenko/wwebjs-api) HTTP API

// --- Outbound (our gateway → wwebjs-api) ---

export interface WwebjsSendMessageRequest {
  chatId: string;
  content: string | WwebjsMediaPayload | WwebjsMediaFromUrlPayload | WwebjsLocationPayload;
  contentType: 'string' | 'MessageMedia' | 'MessageMediaFromURL' | 'Location' | 'Contact' | 'Poll';
  options?: WwebjsSendOptions;
}

export interface WwebjsMediaPayload {
  mimetype: string;
  data: string; // base64
  filename?: string;
  filesize?: number;
}

export interface WwebjsMediaFromUrlPayload {
  url: string;
}

export interface WwebjsLocationPayload {
  latitude: number;
  longitude: number;
  description?: string;
}

export interface WwebjsSendOptions {
  quotedMessageId?: string;
  caption?: string;
  media?: WwebjsMediaPayload;
}

export interface WwebjsSendResponse {
  success: boolean;
  message?: {
    id: { _serialized: string };
    from: string;
    to: string;
    timestamp: number;
    type: string;
  };
  error?: string;
}

// --- Download media ---

export interface WwebjsDownloadMediaRequest {
  messageId: string;
  chatId: string;
}

export interface WwebjsDownloadMediaResponse {
  success: boolean;
  messageMedia?: {
    mimetype: string;
    data: string; // base64
    filename?: string;
    filesize?: number;
  };
  error?: string;
}

// --- Message info ---

export interface WwebjsMessageInfoRequest {
  messageId: string;
  chatId: string;
}

export interface WwebjsMessageInfoResponse {
  success: boolean;
  info?: {
    delivery?: Array<{ id: { _serialized: string }; t: number }>;
    read?: Array<{ id: { _serialized: string }; t: number }>;
    played?: Array<{ id: { _serialized: string }; t: number }>;
  } | null;
  error?: string;
}

// --- Session status ---

export interface WwebjsSessionStatusResponse {
  success: boolean;
  state?: string;
  message?: string;
}

// --- Ping ---

export interface WwebjsPingResponse {
  success: boolean;
  message: string;
}

// --- Inbound (wwebjs-api → our gateway via webhook) ---

export interface WwebjsInboundPayload {
  event: string;
  data: {
    id: { _serialized: string };
    from: string;
    to: string;
    body?: string;
    type: string;
    timestamp: number;
    fromMe: boolean;
    hasMedia: boolean;
    hasQuotedMsg: boolean;
    isForwarded: boolean;
    forwardingScore?: number;
    isStatus: boolean;
    isEphemeral?: boolean;
    duration?: number;
    isGif?: boolean;
    vCards?: string[];
    location?: { latitude: number; longitude: number; description?: string };
    mentionedIds?: string[];
    groupMentions?: string[];
    author?: string;
    deviceType?: string;
    _data?: Record<string, unknown>;
    chat?: {
      id: { _serialized: string };
      name?: string;
      isGroup: boolean;
      groupMetadata?: {
        subject: string;
        desc?: string;
        participants: Array<{
          id: { _serialized: string };
          isAdmin: boolean;
          isSuperAdmin: boolean;
        }>;
        creation: number;
        announce: boolean;
      };
    };
    notifyName?: string;
    mediaUrl?: string;
    mimetype?: string;
    filename?: string;
    filesize?: number;
    caption?: string;
  };
}

export interface WwebjsStatusPayload {
  event: string;
  data: {
    id: { _serialized: string };
    status: number;
    timestamp: number;
    to: string;
    error?: string;
  };
}
