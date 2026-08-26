/** Tests for identifier construction and safe file naming. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documentId, extractCnj, processId, safeFileName, unescapeJs } from '../util/text';

test('builds a country-source-key process id', () => {
  assert.equal(processId('0800041-77.2020.4.05.8302', 'abc'), 'BR-TRF5-0800041-77.2020.4.05.8302');
  assert.equal(processId(undefined, 'deadbeef'), 'BR-TRF5-ca-deadbeef');
});

test('document id derives from the process id', () => {
  assert.equal(documentId('BR-TRF5-0800041-77.2020.4.05.8302', '9643227'), 'BR-TRF5-0800041-77.2020.4.05.8302-DOC-9643227');
});

test('extracts a CNJ number from noisy text', () => {
  assert.equal(extractCnj('ApCiv 0000619-36.2021.4.05.8109 - Aposentadoria'), '0000619-36.2021.4.05.8109');
  assert.equal(extractCnj('no number'), undefined);
});

test('safeFileName strips accents and reserved characters', () => {
  assert.equal(safeFileName('Decisão (Acórdão)'), 'Decisao_Acordao');
  assert.equal(safeFileName('a/b\\c:d*e?'), 'a_b_c_d_e');
  assert.ok(safeFileName('x'.repeat(200)).length <= 80);
  assert.equal(safeFileName(''), 'sin_nombre');
});

test('unescapes JSF \\xNN sequences', () => {
  assert.equal(unescapeJs('tt\\x2Dconsulta'), 'tt-consulta');
});
