import { BufferJSON, proto } from '@whiskeysockets/baileys';

/** Fields that are only previews/streaming helpers: large and useless once the media is downloaded. */
const DROPPED_KEYS = /^(jpegThumbnail|pngThumbnail|thumbnail.*|streamingSidecar|waveform)$/;

/** Safety net: any other binary above this size is not worth keeping in the log. */
const MAX_BINARY_BYTES = 1024;

/**
 * A decoded Baileys message is a protobufjs instance whose `toJSON` turns bytes
 * into base64 strings *before* any JSON replacer runs, which hides every binary
 * from {@link BufferJSON.replacer} and the size net. Convert it to a plain
 * object first so binaries stay `Buffer`s (and longs become strings).
 */
function toPlainObject(message: unknown): unknown {
  try {
    const info = proto.WebMessageInfo.fromObject(message as proto.IWebMessageInfo);
    return proto.WebMessageInfo.toObject(info, { longs: String, defaults: false });
  } catch {
    return walkPlain(message);
  }
}

/** Fallback for input `fromObject` rejects: copy own fields, bypassing any `toJSON`. */
function walkPlain(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map(walkPlain);
  const candidate = value as { low?: unknown; high?: unknown };
  if (typeof candidate.low === 'number' && typeof candidate.high === 'number') return String(value); // Long
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, walkPlain(inner)]));
}

/**
 * Serialize a Baileys `WAMessage` so it can be stored as JSON and used later to
 * re-download its media after a restart.
 *
 * Keeps `mediaKey`, `directPath`, `url` and the hashes (small Buffers, encoded
 * with `BufferJSON` so `BufferJSON.reviver` brings them back as Buffers). Drops
 * thumbnails and any other large binary, at any depth (quoted messages too).
 */
export function toStorableRaw(message: unknown): unknown {
  const json = JSON.stringify(toPlainObject(message), function (this: Record<string, unknown>, key: string, value: unknown) {
    if (DROPPED_KEYS.test(key)) return undefined;
    const original = this[key];
    if (original instanceof Uint8Array && original.byteLength > MAX_BINARY_BYTES) return undefined;
    return BufferJSON.replacer(key, value);
  });
  return json === undefined ? undefined : JSON.parse(json);
}
