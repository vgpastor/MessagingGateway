/** Extension <-> MIME type for the media the gateway stores. Anything unknown is an opaque `.bin`. */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  '3gp': 'video/3gpp',
  mov: 'video/quicktime',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  amr: 'audio/amr',
  pdf: 'application/pdf',
  zip: 'application/zip',
  txt: 'text/plain',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(MIME_BY_EXTENSION).map(([ext, mime]) => [mime, ext])),
  'image/jpg': 'jpg',
  'audio/x-m4a': 'm4a',
};

export const OPAQUE_EXTENSION = 'bin';
export const OPAQUE_MIME_TYPE = 'application/octet-stream';

/** File extension (without dot) for a MIME type; parameters like `; codecs=opus` are ignored. */
export function extensionForMimeType(mimeType: string | undefined): string {
  const base = mimeType?.split(';')[0]?.trim().toLowerCase() ?? '';
  return EXTENSION_BY_MIME[base] ?? OPAQUE_EXTENSION;
}

/** MIME type served for a stored file extension. */
export function mimeTypeForExtension(extension: string): string {
  return MIME_BY_EXTENSION[extension.toLowerCase()] ?? OPAQUE_MIME_TYPE;
}
