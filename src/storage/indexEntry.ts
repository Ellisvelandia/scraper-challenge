/**
 * The light per-process projection kept in memory and in index.json: enough
 * for dedupe, iteration and progress without loading a full shard.
 */
import { DocumentRecord, ProcessRecord } from '../types';

/** Small per-process summary kept in memory and in index.json. */
export interface IndexEntry {
  id: string;
  number?: string;
  ca: string;
  className?: string;
  detailFetched: boolean;
  docsTotal: number;
  docsDownloaded: number;
  docsPending: number;
  docsFailed: number;
  docsUnavailable: number;
  updatedAt: string;
}

export function toIndexEntry(p: ProcessRecord): IndexEntry {
  const docs = p.documents ?? [];
  const by = (s: DocumentRecord['status']) => docs.filter((d) => d.status === s).length;
  return {
    id: p.id,
    number: p.number,
    ca: p.ca,
    className: p.className,
    detailFetched: p.detailFetched,
    docsTotal: docs.length,
    docsDownloaded: by('downloaded'),
    docsPending: by('pending'),
    docsFailed: by('failed'),
    docsUnavailable: by('unavailable'),
    updatedAt: p.updatedAt,
  };
}
