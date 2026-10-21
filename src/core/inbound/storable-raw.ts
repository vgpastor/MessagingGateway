import { BufferJSON } from '@whiskeysockets/baileys';

/** Fields that are only previews/streaming helpers: large and useless once the media is downloaded. */
const DROPPED_KEYS = /^(jpegThumbnail|pngThumbnail|thumbnail.*|streamingSidecar|waveform)$/;

/** Safety net: any other binary above this size is not worth keeping in the log. */
const MAX_BINARY_BYTES = 1024;

/**
 * Serialize a provider message (a Baileys `WAMessage`) so it can be stored as
 * JSON and used later to re-download its media after a restart.
 *
 * Keeps `mediaKey`, `directPath`, `url` and the hashes (small Buffers, encoded
 * with Baileys' `BufferJSON` so `BufferJSON.reviver` brings them back as
 * Buffers). Drops thumbnails and any other large binary.
 */
export function toStorableRaw(message: unknown): unknown {
  const json = JSON.stringify(message, function (this: Record<string, unknown>, key: string, value: unknown) {
    if (DROPPED_KEYS.test(key)) return undefined;
    const original = this[key];
    if (original instanceof Uint8Array && original.byteLength > MAX_BINARY_BYTES) return undefined;
    return BufferJSON.replacer(key, value);
  });
  return json === undefined ? undefined : JSON.parse(json);
}
