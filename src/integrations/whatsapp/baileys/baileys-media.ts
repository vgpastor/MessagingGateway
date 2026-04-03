import {
  downloadContentFromMessage,
  extractMessageContent,
  getContentType,
  type proto,
} from '@whiskeysockets/baileys';
import { getLogger } from '../../../core/logger/logger.port.js';

type WAMessage = proto.IWebMessageInfo;

const MEDIA_TYPES = new Set([
  'imageMessage', 'audioMessage', 'videoMessage',
  'documentMessage', 'documentWithCaptionMessage', 'stickerMessage',
]);

/**
 * Download media from a Baileys WAMessage.
 * Returns base64-encoded content or undefined if no media / download fails.
 */
export async function downloadBaileysMedia(
  msg: WAMessage,
): Promise<{ base64: string; mimeType: string; filename?: string } | undefined> {
  try {
    const content = extractMessageContent(msg.message);
    if (!content) return undefined;

    const contentType = getContentType(content);
    if (!contentType || !MEDIA_TYPES.has(contentType)) return undefined;

    // Handle documentWithCaptionMessage wrapper
    let mediaMessage: Record<string, unknown> | undefined;
    if (contentType === 'documentWithCaptionMessage') {
      mediaMessage = content.documentWithCaptionMessage?.message?.documentMessage as Record<string, unknown> | undefined;
    } else {
      mediaMessage = content[contentType] as Record<string, unknown> | undefined;
    }

    if (!mediaMessage) return undefined;

    const mediaKey = mediaMessage['mediaKey'] as Uint8Array | undefined;
    const directPath = mediaMessage['directPath'] as string | undefined;
    const url = mediaMessage['url'] as string | undefined;
    const mimetype = (mediaMessage['mimetype'] as string) ?? 'application/octet-stream';
    const filename = mediaMessage['fileName'] as string | undefined;

    if (!mediaKey && !directPath && !url) return undefined;

    // Map content type to Baileys media type for decryption
    const mediaTypeMap: Record<string, string> = {
      imageMessage: 'image',
      audioMessage: 'audio',
      videoMessage: 'video',
      documentMessage: 'document',
      documentWithCaptionMessage: 'document',
      stickerMessage: 'sticker',
    };
    const baileysMediaType = mediaTypeMap[contentType] ?? 'document';

    const stream = await downloadContentFromMessage(
      { mediaKey, directPath, url },
      baileysMediaType as Parameters<typeof downloadContentFromMessage>[1],
    );

    // Buffer the stream
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);
    const base64 = buffer.toString('base64');

    return { base64, mimeType: mimetype, filename };
  } catch (err) {
    const msgId = msg.key?.id ?? 'unknown';
    getLogger().warn('Failed to download media', { module: 'baileys-media', msgId, error: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}
