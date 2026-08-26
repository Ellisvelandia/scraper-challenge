/**
 * Ajax4jsf (RichFaces 3.3 on JSF 1.2) protocol helpers.
 *
 * The portal never navigates by URL: every interaction is a POST of the whole
 * form by XMLHttpRequest, and the answer is an XML fragment listing which
 * elements to replace (`<meta name="Ajax-Update-Ids">`) plus the next
 * `javax.faces.ViewState`. This module reproduces both halves:
 *
 *  - `serializeForm` collects every input/select/textarea of a form in document
 *    order, exactly like the browser does (JSF 1.2 expects the full form back);
 *  - `buildA4jBody` adds the markers RichFaces sends (`AJAXREQUEST=_viewRoot`,
 *    the form naming itself, the "clicked" control and `AJAX:EVENTS_COUNT=1`);
 *  - `applyA4jResponse` patches the live cheerio document with the updated
 *    fragments and the new view state, so the next request starts from the
 *    real state, again like the browser.
 *
 * Nothing here is located by a full JSF id: `j_idNNN` suffixes change between
 * portal instances and even between deployments, so selectors match by suffix
 * and ids are read from the markup at run time.
 */
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { UnexpectedStructureError } from '../util/retry';

export type FormPairs = Array<[string, string]>;

/** Selector for an element by exact id, escaping JSF colons. */
export function byId(id: string): string {
  return `[id="${id.replace(/"/g, '\\"')}"]`;
}

/**
 * Serialises a form the way a browser submit would: successful controls only,
 * in document order, selected option for selects, checked radios/checkboxes.
 */
export function serializeForm($: CheerioAPI, formId: string): FormPairs {
  const form = $(`form${byId(formId)}`).first();
  if (form.length === 0) throw new UnexpectedStructureError(`form "${formId}" not found`);
  const pairs: FormPairs = [];
  form.find('input, select, textarea').each((_, el) => {
    const e = $(el);
    const name = e.attr('name');
    if (!name) return;
    const tag = el.tagName.toLowerCase();
    const type = (e.attr('type') ?? 'text').toLowerCase();
    if (tag === 'input' && ['button', 'submit', 'image', 'reset', 'file'].includes(type)) return;
    if ((type === 'checkbox' || type === 'radio') && e.attr('checked') === undefined) return;
    let value: string;
    if (tag === 'select') {
      const selected = e.find('option[selected]').first();
      const first = e.find('option').first();
      value = selected.length ? (selected.attr('value') ?? selected.text()) : (first.attr('value') ?? first.text() ?? '');
    } else if (tag === 'textarea') {
      value = e.text();
    } else {
      value = e.attr('value') ?? (type === 'checkbox' || type === 'radio' ? 'on' : '');
    }
    pairs.push([name, value]);
  });
  return pairs;
}

/** Replaces the value of the first pair whose name ends with `suffix`. Returns whether a field matched. */
export function setFieldBySuffix(pairs: FormPairs, suffix: string, value: string): boolean {
  const idx = pairs.findIndex(([name]) => name === suffix || name.endsWith(suffix));
  if (idx < 0) return false;
  pairs[idx] = [pairs[idx]![0], value];
  return true;
}

export interface A4jRequest {
  /** Form to submit (first argument of `A4J.AJAX.Submit`). */
  formId: string;
  /** Control that "was clicked": sent as `<control>=<control>` unless `controlValue` is given. */
  control: string;
  controlValue?: string;
  /** Extra parameters RichFaces puts in `parameters` (e.g. `ajaxSingle`, scroller page). */
  extra?: FormPairs;
}

/** Builds the body of an A4J POST from the current document. */
export function buildA4jBody($: CheerioAPI, req: A4jRequest, overrides: FormPairs = []): FormPairs {
  const fields = serializeForm($, req.formId);
  for (const [suffix, value] of overrides) {
    if (!setFieldBySuffix(fields, suffix, value)) {
      throw new UnexpectedStructureError(`field ending in "${suffix}" not found in form "${req.formId}"`);
    }
  }
  return [
    ['AJAXREQUEST', '_viewRoot'],
    ...fields,
    [req.control, req.controlValue ?? req.control],
    ...(req.extra ?? []),
    ['AJAX:EVENTS_COUNT', '1'],
  ];
}

export interface A4jResponse {
  /** Ids the server asked to replace. Empty when the response only carried messages. */
  updatedIds: string[];
  /** New view state, when the server sent one. */
  viewState?: string;
  /** Parsed response document (fragments live in its body). */
  $response: CheerioAPI;
}

/**
 * Parses an A4J XML response and patches `$` in place: every element listed in
 * `Ajax-Update-Ids` is replaced by its fresh copy and every ViewState input is
 * refreshed. Throws `SessionExpiredError`-like structure errors when the payload
 * is not an A4J response at all (e.g. the landing page after a session reset).
 */
export function applyA4jResponse($: CheerioAPI, xml: string): A4jResponse {
  const $r = cheerio.load(xml, { xml: false });
  const marker = $r('meta[name="Ajax-Response"]').first();
  const updateMeta = $r('meta[name="Ajax-Update-Ids"]').first();
  if (marker.length === 0 && updateMeta.length === 0) {
    throw new UnexpectedStructureError('not an A4J response (no Ajax-Response marker)');
  }
  const ids = (updateMeta.attr('content') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const id of ids) {
    const fresh = $r(byId(id)).first();
    if (fresh.length === 0) continue;
    const current = $(byId(id)).first();
    if (current.length > 0) current.replaceWith($r.html(fresh));
  }
  const viewState = $r('#ajax-view-state input[name="javax.faces.ViewState"]').first().attr('value');
  if (viewState) $('input[name="javax.faces.ViewState"]').attr('value', viewState);
  return { updatedIds: ids, viewState, $response: $r };
}

/** True when the A4J payload reports an expired view (JSF's ViewExpiredException). */
export function isViewExpired(xml: string): boolean {
  return /ViewExpiredException|view state could not be restored|Sess[aã]o expirada/i.test(xml);
}

/**
 * Reads the `'parameters':{...}` map of an inline `A4J.AJAX.Submit(...)` call.
 * Values may be quoted strings or bare expressions (e.g. `event.memo.page`).
 */
export function parseA4jParameters(js: string): FormPairs {
  const m = /'parameters'\s*:\s*\{([^}]*)\}/.exec(js);
  if (!m) return [];
  const pairs: FormPairs = [];
  const re = /'([^']+)'\s*:\s*(?:'([^']*)'|([^,}]+))/g;
  let x: RegExpExecArray | null;
  while ((x = re.exec(m[1] ?? '')) !== null) {
    pairs.push([x[1]!, (x[2] ?? x[3] ?? '').trim()]);
  }
  return pairs;
}

/** Reads the form id (first argument) of an inline `A4J.AJAX.Submit('form', ...)` call. */
export function parseA4jForm(js: string): string | undefined {
  const m = /A4J\.AJAX\.Submit(?:Form)?\(\s*'([^']+)'/.exec(js);
  return m?.[1];
}
