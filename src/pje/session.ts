/**
 * A conversation with the Consulta Pública.
 *
 *   open()          GET the landing page: cookies, ViewState, the `fPP` form and
 *                   the hidden `executarPesquisa` control.
 *   search(...)     A4J POST of the search form with the given criteria; patches
 *                   the live document with the response and parses the table.
 *   getDetail(ca)   GET of a process detail page (independent of the list state).
 *
 * THE SEARCH CONTROL. The visible button reads
 *     onclick="return executarReCaptcha();;A4J.AJAX.Submit('fPP', …, {'parameters':{'fPP:searchProcessos':…}})"
 * `executarReCaptcha()` returns undefined, so the `return` exits before the
 * visible submit ever runs. What really fires is `executarPesquisa`, an
 * `a4j:jsFunction` defined elsewhere in the page:
 *     executarPesquisa=function(){A4J.AJAX.Submit('fPP',null,{…,'parameters':{'fPP:j_id244':'fPP:j_id244'}})}
 * Submitting `fPP:searchProcessos` only re-renders the messages panel; submitting
 * the jsFunction control renders the results grid. Its id is read from the page
 * on every open, never hard-coded. There is no CAPTCHA to solve: the reCAPTCHA
 * branch is compiled to `if (false)`.
 *
 * The portal requires at least one criterion, and `nomeParte` needs two words.
 * The crawler always searches by `dataAutuacao` range, which is what makes the
 * whole corpus enumerable despite the 30-row cap (see crawl/discover.ts).
 */
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { CONFIG } from '../config';
import { HttpClient } from '../http/client';
import { log } from '../util/logger';
import { SessionExpiredError, UnexpectedStructureError } from '../util/retry';
import { applyA4jResponse, buildA4jBody, FormPairs, isViewExpired, parseA4jParameters } from './a4j';
import { MovementsPager } from './detailParser';
import { ListPage, parseListPage } from './listParser';

export interface SearchCriteria {
  /** `dd/MM/yyyy` */
  dateFrom?: string;
  dateTo?: string;
  /** Free text matched against the class name (LIKE). */
  className?: string;
  /** At least two words, or the portal rejects it. */
  partyName?: string;
  /** Full CNJ number with mask. */
  processNumber?: string;
}

/** Field name suffixes of the `fPP` form (prefixes carry instance-specific `j_idNNN`). */
const FIELD = {
  dateFrom: ':dataAutuacaoInicioInputDate',
  dateTo: ':dataAutuacaoFimInputDate',
  className: ':classeJudicial',
  partyName: ':nomeParte',
  processNumber: ':numProcesso-inputNumeroProcesso',
} as const;

export class PjeSession {
  private $?: CheerioAPI;
  private searchControl?: [string, string];
  private formId = 'fPP';
  public searches = 0;

  constructor(public readonly http: HttpClient = new HttpClient()) {}

  /** Requests made through this session's HTTP client. */
  get requestCount(): number {
    return this.http.requestCount;
  }

  get isOpen(): boolean {
    return this.$ !== undefined;
  }

  /** Opens (or reopens) the landing page and reads the search contract from it. */
  async open(): Promise<void> {
    this.http.resetSession();
    const res = await this.http.get(CONFIG.paths.list);
    if (res.status !== 200) throw new UnexpectedStructureError(`landing page returned HTTP ${res.status}`);
    const $ = cheerio.load(res.text);
    const form = $('form[id="fPP"]');
    if (form.length === 0) throw new UnexpectedStructureError('landing page has no form#fPP: unknown template');
    this.formId = 'fPP';
    this.searchControl = findSearchControl(res.text);
    this.$ = $;
    this.searches = 0;
    log.info(`session opened: cookies=[${this.http.cookieNames().join(', ')}] viewState=${$('input[name="javax.faces.ViewState"]').first().attr('value')} searchControl=${this.searchControl[0]}`);
  }

  private doc(): CheerioAPI {
    if (!this.$) throw new Error('session not open: call open() first');
    return this.$;
  }

  /** Runs a search and returns the parsed results table. */
  async search(criteria: SearchCriteria): Promise<ListPage> {
    const $ = this.doc();
    const overrides: FormPairs = [];
    if (criteria.dateFrom !== undefined) overrides.push([FIELD.dateFrom, criteria.dateFrom]);
    if (criteria.dateTo !== undefined) overrides.push([FIELD.dateTo, criteria.dateTo]);
    if (criteria.className !== undefined) overrides.push([FIELD.className, criteria.className]);
    if (criteria.partyName !== undefined) overrides.push([FIELD.partyName, criteria.partyName]);
    if (criteria.processNumber !== undefined) overrides.push([FIELD.processNumber, criteria.processNumber]);
    if (overrides.length === 0) throw new Error('the portal requires at least one search criterion');

    const [control, value] = this.searchControl!;
    const body = buildA4jBody($, { formId: this.formId, control, controlValue: value }, overrides);
    const res = await this.http.post(CONFIG.paths.list, body, { headers: { Referer: CONFIG.baseUrl + CONFIG.paths.list, Accept: '*/*' } });
    this.searches++;
    if (res.status !== 200 || !/xml/i.test(res.contentType)) {
      // A 302 (or an HTML page) here means the server no longer knows this view.
      throw new SessionExpiredError(`search answered HTTP ${res.status} ${res.contentType}`);
    }
    if (isViewExpired(res.text)) throw new SessionExpiredError();
    const applied = applyA4jResponse($, res.text);
    if (applied.updatedIds.length === 0) {
      throw new UnexpectedStructureError('search response updated nothing');
    }
    return parseListPage($);
  }

  /**
   * GETs the detail page of a process. Works in a fresh session too, but the
   * document links inside are bound to the session that fetched the page.
   */
  async getDetail(ca: string): Promise<string> {
    const url = `${CONFIG.paths.detail}?ca=${ca}`;
    const res = await this.http.get(url, { headers: { Referer: CONFIG.baseUrl + CONFIG.paths.list } });
    if (res.status === 302) throw new SessionExpiredError(`detail page redirected to ${res.headers['location'] ?? '?'}`);
    if (res.status !== 200) throw new UnexpectedStructureError(`detail page returned HTTP ${res.status}`);
    if (!/Detalhe do Processo|processoDocumentoGridTab|Dados do Processo/i.test(res.text)) {
      throw new UnexpectedStructureError('detail page does not look like a process detail');
    }
    return res.text;
  }

  /**
   * Requests page `page` of the movements table of the detail page currently
   * open in this session. `$detail` is the live detail document; it is patched
   * in place with the response so the caller can read the rows from it.
   *
   * The pager is a `rich:inputNumberSlider` whose onchange fires an
   * `a4j:support` inside its own form and its own Ajax region:
   *   POST DetalheProcessoConsultaPublica/listView.seam
   *   AJAXREQUEST=<containerId>  <form fields with the slider set to the page>  <control>=<control>  AJAX:EVENTS_COUNT=1
   */
  async getMovementsPage($detail: CheerioAPI, pager: MovementsPager, page: number, ca: string): Promise<void> {
    const body = buildA4jBody($detail, { formId: pager.formId, control: pager.control }, [[pager.pageField, String(page)]]);
    if (pager.containerId) body[0] = ['AJAXREQUEST', pager.containerId];
    const res = await this.http.post(CONFIG.paths.detail, body, {
      headers: { Referer: `${CONFIG.baseUrl}${CONFIG.paths.detail}?ca=${ca}`, Accept: '*/*' },
    });
    if (res.status !== 200 || !/xml/i.test(res.contentType)) throw new SessionExpiredError(`movements page ${page} answered HTTP ${res.status} ${res.contentType}`);
    if (isViewExpired(res.text)) throw new SessionExpiredError();
    const applied = applyA4jResponse($detail, res.text);
    if (applied.updatedIds.length === 0) throw new UnexpectedStructureError(`movements page ${page}: the portal updated nothing`);
  }
}

/**
 * Locates the hidden search control:
 *   executarPesquisa=function(){A4J.AJAX.Submit('fPP',null,{…'parameters':{'fPP:j_id244':'fPP:j_id244'}})}
 * Falls back to the visible button's own parameters if the function is missing.
 */
export function findSearchControl(html: string): [string, string] {
  const at = html.indexOf('executarPesquisa=function');
  if (at >= 0) {
    const pairs = parseA4jParameters(html.slice(at, at + 1200));
    const own = pairs.find(([k, v]) => k === v);
    if (own) return own;
  }
  const btn = /id="([^"]*:searchProcessos)"/.exec(html);
  if (btn) {
    log.warn('executarPesquisa not found in the landing page: falling back to the visible search button');
    return [btn[1]!, btn[1]!];
  }
  throw new UnexpectedStructureError('search control not found in the landing page');
}
