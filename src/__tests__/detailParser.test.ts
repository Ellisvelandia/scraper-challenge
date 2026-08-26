/**
 * Tests for the detail-page parser, run offline against a real captured detail
 * page (`fixtures/detail-process.html`) with the session id redacted.
 */
import assert from 'node:assert/strict';
import { parseDetail, splitParty, toDocumentRecord } from '../pje/detailParser';
import { UnexpectedStructureError } from '../util/retry';
import { readFixture } from './fixtures';

const html = readFixture('detail-process.html');

test('parses Dados do Processo into labelled fields', () => {
  const d = parseDetail(html);
  assert.ok(d.number && /^\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}$/.test(d.number));
  assert.ok(d.details['Classe Judicial']);
  assert.ok(d.details['Assunto']);
  assert.ok(d.distributionDate && /^\d{4}-\d{2}-\d{2}$/.test(d.distributionDate));
});

test('parses parties on both poles with roles and representatives', () => {
  const d = parseDetail(html);
  assert.ok(d.parties.length > 0);
  assert.ok(d.parties.some((p) => p.pole === 'ATIVO'));
  assert.ok(d.parties.some((p) => p.pole === 'PASSIVO'));
  assert.ok(d.parties.some((p) => p.isRepresentative), 'lawyers detected as representatives');
});

test('parses the movements table and its announced total', () => {
  const d = parseDetail(html);
  assert.ok(d.movements.length > 0);
  assert.ok(d.movementsTotal >= d.movements.length);
  assert.ok(d.movements[0]!.text.length > 0);
});

test('detects the movements slider pager and its page count', () => {
  const d = parseDetail(html);
  if (d.movementsTotal > d.movements.length) {
    assert.ok(d.movementsPager, 'a multi-page movements table exposes a pager');
    assert.ok(d.movementsPager!.pages > 1);
    assert.ok(d.movementsPager!.control && d.movementsPager!.pageField);
  }
});

test('parses documents with a download route and stable ids', () => {
  const d = parseDetail(html);
  assert.ok(d.documents.length > 0);
  const doc = d.documents[0]!;
  assert.ok(doc.idProcessoDocumento && /^\d+$/.test(doc.idProcessoDocumento));
  assert.ok(doc.binaryHref || doc.viewerUrl, 'every document has a download route');
  const rec = toDocumentRecord('BR-TRF5-X', doc);
  assert.equal(rec.id, `BR-TRF5-X-DOC-${doc.idProcessoDocumento}`);
  assert.ok(['binary', 'viewer'].includes(rec.download));
  assert.equal(rec.status, 'pending');
});

test('splitParty separates name, document and role', () => {
  const p = splitParty('MARCOS ANTONIO INACIO DA SILVA - OAB PE573-A - CPF: 206.448.414-00 (ADVOGADO)');
  assert.equal(p.name, 'MARCOS ANTONIO INACIO DA SILVA');
  assert.equal(p.role, 'ADVOGADO');
  assert.match(p.document!, /OAB PE573-A/);

  const q = splitParty('FAZENDA NACIONAL - CNPJ: 00.394.460/0001-41 (APELADO)');
  assert.equal(q.name, 'FAZENDA NACIONAL');
  assert.equal(q.role, 'APELADO');
  assert.match(q.document!, /CNPJ: 00\.394\.460/);
});

test('a page missing both sections throws', () => {
  assert.throws(() => parseDetail('<html><body>nope</body></html>'), UnexpectedStructureError);
});
