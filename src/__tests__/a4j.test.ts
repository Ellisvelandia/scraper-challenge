/**
 * Tests for the A4J (RichFaces 3.3) request builder and response applier, using
 * the real landing page fixture and a small synthetic A4J response.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { applyA4jResponse, buildA4jBody, parseA4jForm, parseA4jParameters, serializeForm, setFieldBySuffix } from '../pje/a4j';
import { findSearchControl } from '../pje/session';
import { UnexpectedStructureError } from '../util/retry';
import { readFixture } from './fixtures';

const landing = readFixture('landing.html');

test('serializeForm collects the fPP form fields in document order', () => {
  const $ = cheerio.load(landing);
  const fields = serializeForm($, 'fPP');
  assert.ok(fields.length > 5);
  assert.ok(fields.some(([k]) => k === 'javax.faces.ViewState'));
  assert.ok(fields.some(([k]) => k.endsWith(':dataAutuacaoInicioInputDate')));
});

test('findSearchControl reads the hidden executarPesquisa control, not the visible button', () => {
  const [control, value] = findSearchControl(landing);
  assert.equal(control, value);
  assert.doesNotMatch(control, /searchProcessos/, 'the working control is the jsFunction, not the reCAPTCHA button');
});

test('buildA4jBody adds the A4J markers and overrides only the named field', () => {
  const $ = cheerio.load(landing);
  const [control, value] = findSearchControl(landing);
  const body = buildA4jBody($, { formId: 'fPP', control, controlValue: value }, [[':dataAutuacaoInicioInputDate', '01/01/2020']]);
  assert.deepEqual(body[0], ['AJAXREQUEST', '_viewRoot']);
  assert.deepEqual(body[body.length - 1], ['AJAX:EVENTS_COUNT', '1']);
  assert.ok(body.some(([k, v]) => k.endsWith(':dataAutuacaoInicioInputDate') && v === '01/01/2020'));
  assert.ok(body.some(([k, v]) => k === control && v === value));
});

test('buildA4jBody throws when an override targets a missing field', () => {
  const $ = cheerio.load(landing);
  assert.throws(() => buildA4jBody($, { formId: 'fPP', control: 'x' }, [[':doesNotExist', 'y']]), UnexpectedStructureError);
});

test('applyA4jResponse patches the live document and updates the view state', () => {
  const $ = cheerio.load('<html><body><span id="target">old</span><input name="javax.faces.ViewState" value="j_id1"/></body></html>');
  const xml = `<?xml version="1.0"?><html><body>
    <span id="target">new content</span>
    <meta name="Ajax-Update-Ids" content="target"/>
    <span id="ajax-view-state"><input name="javax.faces.ViewState" value="j_id9"/></span>
    <meta id="Ajax-Response" name="Ajax-Response" content="true"/></body></html>`;
  const res = applyA4jResponse($, xml);
  assert.deepEqual(res.updatedIds, ['target']);
  assert.equal(res.viewState, 'j_id9');
  assert.match($('#target').text(), /new content/);
  assert.equal($('input[name="javax.faces.ViewState"]').attr('value'), 'j_id9');
});

test('applyA4jResponse rejects a non-A4J payload (e.g. the landing page)', () => {
  const $ = cheerio.load('<html><body>x</body></html>');
  assert.throws(() => applyA4jResponse($, '<html><body>not ajax</body></html>'), UnexpectedStructureError);
});

test('parseA4jParameters and parseA4jForm read an inline Submit call', () => {
  const js = "A4J.AJAX.Submit('fPP',event,{'similarityGroupingId':'x','parameters':{'fPP:btn':'fPP:btn','ajaxSingle':'fPP:btn'}})";
  assert.equal(parseA4jForm(js), 'fPP');
  const params = parseA4jParameters(js);
  assert.deepEqual(params, [['fPP:btn', 'fPP:btn'], ['ajaxSingle', 'fPP:btn']]);
});

test('setFieldBySuffix replaces by suffix and reports misses', () => {
  const pairs: Array<[string, string]> = [['a:b:field', 'old'], ['other', 'x']];
  assert.equal(setFieldBySuffix(pairs, ':field', 'new'), true);
  assert.equal(pairs[0]![1], 'new');
  assert.equal(setFieldBySuffix(pairs, ':missing', 'v'), false);
});
