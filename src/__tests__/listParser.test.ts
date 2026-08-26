/**
 * Tests for the results-table parser, run offline against a real captured
 * response (`fixtures/search-results.xml`, 30 rows, session id redacted) plus
 * synthetic empty and shape-changed inputs.
 */
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { parseListPage } from '../pje/listParser';
import { UnexpectedStructureError } from '../util/retry';
import { readFixture } from './fixtures';

const load = (file: string) => cheerio.load(readFixture(file));

test('parses every row of a real results page', () => {
  const page = parseListPage(load('search-results.xml'));
  assert.equal(page.rows.length, 30, 'the captured page has 30 rows');
  assert.equal(page.isCapped, true, '30 rows means the query hit the cap');
  assert.ok(page.announcedTotal >= 30);
});

test('detects the portal overflow banner as the authoritative cap signal', () => {
  const page = parseListPage(load('search-results.xml'));
  assert.equal(page.overflowBanner, true, 'the captured capped response carries the banner');
});

test('a full-but-not-overflowing page is capped for splitting but shows no banner', () => {
  const rows = Array.from({ length: 30 }, (_, i) => `
    <tr class="rich-table-row"><td><a onclick="openPopUp('x','/ctx/DetalheProcessoConsultaPublica/listView.seam?ca=c${i}f')">v</a></td>
    <td>CLASSE <a onclick="openPopUp('x','/ctx/DetalheProcessoConsultaPublica/listView.seam?ca=c${i}f')"><b>ApCiv 000000${String(i).padStart(1, '0')}-00.2020.4.05.8100 - Assunto</b></a> A X B</td>
    <td>Mov (01/01/2020 10:00:00)</td></tr>`).join('');
  const html = `<html><body><table id="x:processosTable"><tbody>${rows}</tbody>
    <tfoot><tr><td><span class="text-muted">30 resultados encontrados</span></td></tr></tfoot></table></body></html>`;
  const page = parseListPage(cheerio.load(html));
  assert.equal(page.rows.length, 30);
  assert.equal(page.isCapped, true);
  assert.equal(page.overflowBanner, false, 'no banner means the portal hid nothing');
});

test('extracts CNJ number, class, subject and poles from a row', () => {
  const page = parseListPage(load('search-results.xml'));
  const withNumber = page.rows.find((r) => r.number);
  assert.ok(withNumber, 'at least one row has a CNJ number');
  assert.match(withNumber!.number!, /^\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}$/);
  assert.ok(withNumber!.ca && /^[0-9a-f]+$/i.test(withNumber!.ca), 'row carries the detail access hash');
  assert.ok(withNumber!.classAcronym, 'class acronym parsed');
});

test('empty result set yields zero rows, not an error', () => {
  const empty = `<?xml version="1.0"?><html><body>
    <table id="fPP:processosTable"><thead><tr><th></th><th>Processo</th><th>Última movimentação</th></tr></thead>
    <tbody id="fPP:processosTable:tb"></tbody>
    <tfoot><tr><td><div title="Paginação"></div><span class="text-muted">resultados encontrados</span></td></tr></tfoot>
    </table>
    <meta name="Ajax-Response" content="true"/></body></html>`;
  const page = parseListPage(cheerio.load(empty));
  assert.equal(page.rows.length, 0);
  assert.equal(page.isCapped, false);
});

test('validation message (too few name words) is surfaced, no rows', () => {
  const msg = `<?xml version="1.0"?><html><body>
    <dl class="rich-messages"><dt class="alert alert-danger"><span>É necessário informar ao menos dois nomes.</span></dt></dl>
    </body></html>`;
  const page = parseListPage(cheerio.load(msg));
  assert.equal(page.rows.length, 0);
  assert.match(page.message ?? '', /dois nomes/);
});

test('a row without number nor hash is skipped, one with a hash is kept (segredo de justiça)', () => {
  const html = `<html><body><table id="x:processosTable"><tbody>
    <tr class="rich-table-row">
      <td><a onclick="openPopUp('x','/ctx/DetalheProcessoConsultaPublica/listView.seam?ca=deadbeef')">v</a></td>
      <td>MANDADO DE SEGURANÇA <a onclick="openPopUp('x','/ctx/DetalheProcessoConsultaPublica/listView.seam?ca=deadbeef')"><b>MS - Assunto qualquer</b></a> AUTOR X REU</td>
      <td>Algum movimento (01/02/2020 10:00:00)</td>
    </tr>
    <tr class="rich-table-row"><td>no link here</td><td>no link</td><td></td></tr>
    </tbody>
    <tfoot><tr><td><span class="text-muted">1 resultados encontrados</span></td></tr></tfoot>
    </table></body></html>`;
  const page = parseListPage(cheerio.load(html));
  assert.equal(page.rows.length, 1, 'segredo row kept, link-less row dropped');
  assert.equal(page.rows[0]!.number, undefined, 'segredo row has no CNJ number');
  assert.equal(page.rows[0]!.ca, 'deadbeef');
  assert.equal(page.rows[0]!.lastMovementDate, '2020-02-01T10:00:00');
});

test('a page without the results table and without a message throws', () => {
  assert.throws(() => parseListPage(cheerio.load('<html><body>totally different</body></html>')), UnexpectedStructureError);
});
