/**
 * Data contract shared by every module of the scraper.
 *
 * Identifiers follow the convention COUNTRY-SOURCE-<unique source key>:
 *   - a process is `BR-TRF5-<CNJ number>` (e.g. `BR-TRF5-0800041-77.2020.4.05.8302`),
 *     or `BR-TRF5-ca-<hash>` for processes the portal lists without a number
 *     (segredo de justiça), using the portal's own access hash;
 *   - a document is `<process id>-DOC-<idProcessoDocumento>`.
 * These ids are stable across runs, so records can be merged and de-duplicated.
 */

/** A party (or lawyer / representative) as listed in the detail page. */
export interface Party {
  /** `ATIVO`, `PASSIVO` or `OUTROS` (outros interessados). */
  pole: 'ATIVO' | 'PASSIVO' | 'OUTROS';
  /** Full text as published, e.g. `FAZENDA NACIONAL - CNPJ: 00.394.460/0001-41 (APELADO)`. */
  raw: string;
  /** Name portion of `raw`, before the document / role suffixes. */
  name: string;
  /** Role in parentheses at the end of `raw` (APELANTE, APELADO, ADVOGADO...). */
  role?: string;
  /** CPF, CNPJ or OAB number when the portal publishes it inline. */
  document?: string;
  /** True for lawyers / representatives, rendered indented under a party. */
  isRepresentative: boolean;
  /** Extra text under the name (e.g. `Procuradoria da Fazenda Nacional`). */
  note?: string;
  /** Second column of the parties table (`Situação`). */
  situation?: string;
}

/** One row of the "Movimentações do Processo" table. */
export interface Movement {
  /** ISO-8601 local timestamp derived from `dd/MM/yyyy HH:mm:ss`. */
  date?: string;
  /** Movement text without the leading timestamp. */
  text: string;
  /** Text of the "Documento" column, when present. */
  documentLabel?: string;
}

/**
 * How a document's PDF is obtained. Verified against the live portal:
 *   - `binary`: GET the Seam action href (`listView.seam?idBin=…&actionMethod=…setDownloadInstance`)
 *     → 302 to `/pjeconsulta/download.seam?cid=N` → `application/pdf`.
 *   - `viewer`: GET `documentoSemLoginHTML.seam?ca=…&idProcessoDoc=…`, then POST the
 *     viewer form's `downloadPDF` command (`ca` + `idProcDocBin`) → `application/pdf`.
 *   - `none`: the row exposes no download control (not publicly available).
 */
export type DownloadKind = 'binary' | 'viewer' | 'none';

export type DownloadStatus = 'pending' | 'downloaded' | 'failed' | 'unavailable';

/** A document ("Documentos juntados ao processo") of a process. */
export interface DocumentRecord {
  /** `<process id>-DOC-<idProcessoDocumento>`. */
  id: string;
  /** Portal id of the document (`idProcessoDocumento` / `idProcessoDoc`). */
  idProcessoDocumento: string;
  /** Portal id of the binary (`idBin` / `idProcDocBin`) when published. */
  idBin?: string;
  /** Timestamp shown in the grid (`dd/MM/yyyy HH:mm:ss`) as ISO-8601. */
  date?: string;
  /** Title shown in the grid, e.g. `Inteiro Teor`. */
  title: string;
  /** Type in parentheses, e.g. `Acórdão`. */
  type?: string;
  /** Text of the "Certidão" column, when present. */
  certificate?: string;
  /** Download route. Session-bound URLs are re-read from the detail page at download time. */
  download: DownloadKind;
  /** Receipt PDF (`reportReciboPDF.seam`) URL, when the row publishes one. */
  receiptUrl?: string;
  status: DownloadStatus;
  /** Path of the saved PDF, relative to the output directory. */
  file?: string;
  /** Size in bytes of the saved PDF. */
  bytes?: number;
  /** Last error message when `status` is `failed`. */
  error?: string;
}

/** A judicial process: what the list row publishes plus what the detail page adds. */
export interface ProcessRecord {
  /** `BR-TRF5-<CNJ number>` or `BR-TRF5-ca-<hash>`. */
  id: string;
  source: 'BR-TRF5';
  /** CNJ number `NNNNNNN-DD.AAAA.J.TR.OOOO`; absent for processes in segredo de justiça. */
  number?: string;
  /** Access hash of the detail page (`listView.seam?ca=<hash>`), stable across sessions. */
  ca: string;
  /** Class acronym shown in the list (`ApCiv`, `AgRCiv`...). */
  classAcronym?: string;
  /** Class name shown in the list / detail (`APELAÇÃO CÍVEL`). */
  className?: string;
  /** Subject as shown in the list row. */
  subject?: string;
  /** "Polo ativo X Polo passivo" summary from the list row. */
  activePoleSummary?: string;
  passivePoleSummary?: string;
  /** Last movement text and timestamp (ISO-8601) from the list row. */
  lastMovement?: string;
  lastMovementDate?: string;
  /** Search partition (dataAutuacao day range) that surfaced this process. */
  foundInRange?: { from: string; to: string };
  /** Dados do Processo, keyed by the portal's own labels (Número Processo, Assunto, Jurisdição...). */
  details?: Record<string, string>;
  /** Distribution date (`Data da Distribuição`) as ISO date. */
  distributionDate?: string;
  parties?: Party[];
  movements?: Movement[];
  documents?: DocumentRecord[];
  /** Whether the detail page has been fetched and parsed. */
  detailFetched: boolean;
  /** ISO timestamps of the first and last time this record was written. */
  firstSeenAt: string;
  updatedAt: string;
}

/** A closed date interval, ISO `yyyy-MM-dd` inclusive on both ends. */
export interface DateRange {
  from: string;
  to: string;
}

/** One entry of failed.json: what failed, why, and how many times it was tried. */
export interface FailedItem {
  /** Process id, document id, or `range:<from>:<to>`. */
  key: string;
  stage: 'search' | 'detail' | 'document';
  reason: string;
  attempts: number;
  lastAttemptAt: string;
  /** HTTP status of the last failure when known (429, 500...). */
  httpStatus?: number;
}

/** Persisted crawl state so runs can resume where they stopped. */
export interface CrawlState {
  /** Date ranges whose listing is complete (count below the cap, all rows stored). */
  completedRanges: DateRange[];
  /** Single days that still returned the cap even after every secondary split: coverage there is partial. */
  saturatedDays: Array<{ day: string; classSplitDone: boolean; note?: string }>;
  /** Total announced by the portal for an unfiltered query, when measured. */
  measuredTotal?: number;
  measuredAt?: string;
  /** Last update of this file. */
  updatedAt: string;
}
