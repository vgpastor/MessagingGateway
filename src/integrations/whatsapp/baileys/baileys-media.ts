import {
  downloadContentFromMessage,
  extractMessageContent,
  getContentType,
  type proto,
} from '@whiskeysockets/baileys';

type WAMessage = proto.IWebMessageInfo;

const MEDIA_TYPES = new Set([
  'imageMessage', 'audioMessage', 'videoMessage',
  'documentMessage', 'documentWithCaptionMessage', 'stickerMessage',
]);

/** Content type -> the media type Baileys needs to decrypt it. */
const BAILEYS_MEDIA_TYPE: Record<string, string> = {
  imageMessage: 'image',
  audioMessage: 'audio',
  videoMessage: 'video',
  documentMessage: 'document',
  documentWithCaptionMessage: 'document',
  stickerMessage: 'sticker',
};

export type BaileysMediaResult =
  | { data: Buffer; mimeType: string; filename?: string }
  | { skipped: 'too_large' };

/** `fileLength` may be a number, a numeric string (normalized raw) or a protobuf `Long`. */
function declaredLength(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const length = Number(String(value));
  return Number.isFinite(length) ? length : undefined;
}

/**
 * Download the media of a Baileys WAMessage into memory.
 *
 * Resolves to `{ skipped: 'too_large' }` when it exceeds `maxBytes`: decided from
 * the declared `fileLength` before touching the network, and again while
 * streaming in case that length was missing or wrong. Resolves to `undefined`
 * when the message carries no downloadable media, and rejects when the download fails.
 */
export async function downloadBaileysMedia(msg: WAMessage, maxBytes: number): Promise<BaileysMediaResult | undefined> {
  const content = extractMessageContent(msg.message);
  if (!content) return undefined;

  const contentType = getContentType(content);
  if (!contentType || !MEDIA_TYPES.has(contentType)) return undefined;

  // documentWithCaptionMessage wraps the actual documentMessage
  const mediaMessage = (contentType === 'documentWithCaptionMessage'
    ? content.documentWithCaptionMessage?.message?.documentMessage
    : content[contentType]) as Record<string, unknown> | undefined;
  if (!mediaMessage) return undefined;

  const mediaKey = mediaMessage['mediaKey'] as Uint8Array | undefined;
  const directPath = mediaMessage['directPath'] as string | undefined;
  const url = mediaMessage['url'] as string | undefined;
  if (!mediaKey && !directPath && !url) return undefined;

  const declared = declaredLength(mediaMessage['fileLength']);
  if (declared !== undefined && declared > maxBytes) return { skipped: 'too_large' };

  const stream = await downloadContentFromMessage(
    { mediaKey, directPath, url },
    (BAILEYS_MEDIA_TYPE[contentType] ?? 'document') as Parameters<typeof downloadContentFromMessage>[1],
  );

  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of stream) {
    const buffer = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
    received += buffer.length;
    if (received > maxBytes) {
      stream.destroy();
      return { skipped: 'too_large' };
    }
    chunks.push(buffer);
  }

  return {
    data: Buffer.concat(chunks),
    mimeType: (mediaMessage['mimetype'] as string | undefined) ?? 'application/octet-stream',
    filename: mediaMessage['fileName'] as string | undefined,
  };
}
