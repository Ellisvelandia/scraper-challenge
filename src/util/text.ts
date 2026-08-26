/**
 * Text helpers: whitespace normalisation, identifier construction and
 * file-system safe names.
 */

/** Collapses runs of whitespace (including NBSP) and trims. */
export function clean(text: string | undefined | null): string {
  return (text ?? '').replace(/[\s ]+/g, ' ').trim();
}

/** CNJ process number: NNNNNNN-DD.AAAA.J.TR.OOOO */
export const CNJ_NUMBER = /\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/;

/** Extracts the first CNJ number in `text`, if any. */
export function extractCnj(text: string): string | undefined {
  const m = CNJ_NUMBER.exec(text);
  return m ? m[0] : undefined;
}

export const SOURCE = 'BR-TRF5' as const;

/** Stable process id: `BR-TRF5-<CNJ>`; `BR-TRF5-ca-<hash>` when the number is not published. */
export function processId(number: string | undefined, ca: string): string {
  return number ? `${SOURCE}-${number}` : `${SOURCE}-ca-${ca}`;
}

/** Stable document id derived from the process id and the portal's document id. */
export function documentId(procId: string, idProcessoDocumento: string): string {
  return `${procId}-DOC-${idProcessoDocumento}`;
}

/**
 * Makes a string safe as a file name on Windows, macOS and Linux: strips
 * accents (NFD + combining-mark removal), whitelists `[A-Za-z0-9._-]` and
 * bounds the length.
 */
export function safeFileName(text: string, maxLength = 80): string {
  const ascii = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+|[._]+$/g, '');
  return (ascii || 'sin_nombre').slice(0, maxLength);
}

/** Decodes HTML entities that appear inside attribute values copied from markup. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** Unescapes `\xNN`-style sequences that JSF emits inside inline JavaScript strings. */
export function unescapeJs(text: string): string {
  return text.replace(/\\x([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}
