/**
 * Exports processes.csv and documents.csv (UTF-8 with BOM so Excel keeps the
 * accents). Fully synchronous on purpose: the export is the last act of a run
 * and of the SIGINT handler, both of which end in `process.exit`, which would
 * discard the buffers of an async stream. Writes go line by line through a
 * file descriptor (memory stays flat) into `.tmp` files renamed at the end,
 * and any I/O error propagates to the caller instead of killing the process
 * from an unhandled 'error' event.
 */
import * as fs from 'fs';
import { CONFIG } from '../config';
import { ProcessRecord } from '../types';
import { renameSyncWithRetry } from '../util/fs';

const PROCESS_COLUMNS = [
  'id', 'number', 'classAcronym', 'className', 'subject', 'distributionDate', 'activePoleSummary', 'passivePoleSummary',
  'lastMovement', 'lastMovementDate', 'detailFetched', 'parties', 'movements', 'movementsTotal', 'documents', 'documentsDownloaded', 'ca', 'detailUrl',
];
const DOCUMENT_COLUMNS = ['id', 'processId', 'processNumber', 'idProcessoDocumento', 'idBin', 'date', 'title', 'type', 'download', 'status', 'file', 'bytes', 'error'];

/** Writes both CSVs from the records the iterable yields (one shard in memory at a time). */
export function exportCsv(records: Iterable<ProcessRecord>): void {
  const pTmp = `${CONFIG.output.processesCsv}.tmp`;
  const dTmp = `${CONFIG.output.documentsCsv}.tmp`;
  const pFd = fs.openSync(pTmp, 'w');
  const dFd = fs.openSync(dTmp, 'w');
  try {
    fs.writeSync(pFd, '\u{FEFF}' + PROCESS_COLUMNS.join(',') + '\r\n');
    fs.writeSync(dFd, '\u{FEFF}' + DOCUMENT_COLUMNS.join(',') + '\r\n');
    for (const p of records) {
      fs.writeSync(pFd, csvLine([
        p.id, p.number ?? '', p.classAcronym ?? '', p.className ?? '', p.subject ?? p.details?.['Assunto'] ?? '', p.distributionDate ?? '',
        p.activePoleSummary ?? '', p.passivePoleSummary ?? '', p.lastMovement ?? '', p.lastMovementDate ?? '', String(p.detailFetched),
        String(p.parties?.length ?? ''), String(p.movements?.length ?? ''), p.movementsTotal !== undefined ? String(p.movementsTotal) : '',
        String(p.documents?.length ?? ''), String(p.documents?.filter((d) => d.status === 'downloaded').length ?? ''),
        p.ca, `${CONFIG.baseUrl}${CONFIG.paths.detail}?ca=${p.ca}`,
      ]));
      for (const d of p.documents ?? []) {
        fs.writeSync(dFd, csvLine([
          d.id, p.id, p.number ?? '', d.idProcessoDocumento, d.idBin ?? '', d.date ?? '', d.title, d.type ?? '',
          d.download, d.status, d.file ?? '', d.bytes !== undefined ? String(d.bytes) : '', d.error ?? '',
        ]));
      }
    }
  } finally {
    fs.closeSync(pFd);
    fs.closeSync(dFd);
  }
  renameSyncWithRetry(pTmp, CONFIG.output.processesCsv);
  renameSyncWithRetry(dTmp, CONFIG.output.documentsCsv);
}

function csvLine(values: string[]): string {
  const esc = (v: string) => (/[",\r\n;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return values.map(esc).join(',') + '\r\n';
}
