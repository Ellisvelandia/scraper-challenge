/** Tests for the pure store helpers: range merging and document merging. */
import assert from 'node:assert/strict';
import { mergeDocuments, mergeRanges } from '../storage/store';
import { DocumentRecord } from '../types';

test('mergeRanges coalesces adjacent and overlapping ranges', () => {
  const merged = mergeRanges([
    { from: '2020-01-01', to: '2020-01-10' },
    { from: '2020-01-11', to: '2020-01-20' }, // adjacent
    { from: '2020-01-15', to: '2020-01-25' }, // overlapping
    { from: '2020-03-01', to: '2020-03-05' }, // separate
  ]);
  assert.deepEqual(merged, [
    { from: '2020-01-01', to: '2020-01-25' },
    { from: '2020-03-01', to: '2020-03-05' },
  ]);
});

test('mergeDocuments never downgrades a completed download', () => {
  const done: DocumentRecord = { id: 'p-DOC-1', idProcessoDocumento: '1', title: 'A', download: 'binary', status: 'downloaded', file: 'pdfs/a.pdf', bytes: 1000 };
  const rediscovered: DocumentRecord = { id: 'p-DOC-1', idProcessoDocumento: '1', title: 'A', download: 'binary', status: 'pending' };
  const merged = mergeDocuments([done], [rediscovered])!;
  assert.equal(merged[0]!.status, 'downloaded');
  assert.equal(merged[0]!.file, 'pdfs/a.pdf');
  assert.equal(merged[0]!.bytes, 1000);
});

test('a later successful download clears the error kept from an earlier failure', () => {
  const failed: DocumentRecord = { id: 'p-DOC-1', idProcessoDocumento: '1', title: 'A', download: 'binary', status: 'failed', error: 'HTTP 429' };
  const succeeded: DocumentRecord = { id: 'p-DOC-1', idProcessoDocumento: '1', title: 'A', download: 'binary', status: 'downloaded', file: 'pdfs/a.pdf', bytes: 2000 };
  const merged = mergeDocuments([failed], [succeeded])!;
  assert.equal(merged[0]!.status, 'downloaded');
  assert.equal(merged[0]!.error, undefined, 'stale error must not survive a successful download');
});

test('mergeDocuments adds new documents and updates fields of existing ones', () => {
  const current: DocumentRecord[] = [{ id: 'p-DOC-1', idProcessoDocumento: '1', title: 'old', download: 'binary', status: 'pending' }];
  const incoming: DocumentRecord[] = [
    { id: 'p-DOC-1', idProcessoDocumento: '1', title: 'new title', download: 'binary', status: 'failed', error: 'boom' },
    { id: 'p-DOC-2', idProcessoDocumento: '2', title: 'B', download: 'viewer', status: 'pending' },
  ];
  const merged = mergeDocuments(current, incoming)!;
  assert.equal(merged.length, 2);
  assert.equal(merged.find((d) => d.id === 'p-DOC-1')!.title, 'new title');
  assert.equal(merged.find((d) => d.id === 'p-DOC-1')!.status, 'failed');
});
