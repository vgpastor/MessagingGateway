// Types representing the wwebjs-api Docker container's HTTP API

export interface WwebjsSendTextRequest {
  chatId: string;
  text: string;
  quotedMessageId?: string;
}

export interface WwebjsSendMediaRequest {
  chatId: string;
  mediaUrl?: string;
  mediaBase64?: string;
  mimeType: string;
  fileName?: string;
  caption?: string;
  quotedMessageId?: string;
}

export interface WwebjsSendLocationRequest {
  chatId: string;
  latitude: number;
  longitude: number;
  title?: string;
  address?: string;
}

export interface WwebjsSendResponse {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface WwebjsMessageStatusResponse {
  messageId: string;
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'played' | 'error';
  timestamp?: string;
}

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
