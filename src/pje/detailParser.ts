/**
 * Parser of the process detail page
 * (`DetalheProcessoConsultaPublica/listView.seam?ca=<hash>`).
 *
 * Sections, as rendered by the portal (ids carry instance-specific prefixes,
 * so everything is matched by suffix):
 *
 *   "Dados do Processo"   div.propertyView > .name / .value pairs
 *   "Polo ativo"          table[id$=":processoPartesPoloAtivoResumidoList"]     (rich:dataTable + datascroller)
 *   "Polo Passivo"        table[id$=":processoPartesPoloPassivoResumidoList"]
 *   "Outros interessados" table[id$=":processoParteOutrosInteressadosResumidoList"]
 *   "Movimentações"       table[id$=":processoEvento"]   15 rows per page, total in the
 *                         span "N resultados encontrados", pages selected with a
 *                         rich:inputNumberSlider (see PjeSession.getMovementsPage)
 *   "Documentos"          table[id$=":processoDocumentoGridTab"]
 *
 * Every document row publishes one of two download routes (both verified live):
 *   binary  <a href="…/listView.seam?idBin=N&numeroDocumento=…&nomeArqProcDocBin=…&idProcessoDocumento=N&actionMethod=…setDownloadInstance(row)">
 *   viewer  onclick="openPopUp('NpopUpDocumento','…/documentoSemLoginHTML.seam?ca=<hash96>&idProcessoDoc=N')"
 * and optionally a receipt: openPopUp('NpopUpComprovante','/pjeconsulta/Processo/reportReciboPDF.seam?idBin=…&idProcessoDoc=…&idProcessoTrf=…').
 * Viewer hashes are bound to the session that fetched the page, so the
 * downloader re-reads them from a fresh detail page instead of trusting stored ones.
 */
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { Cheerio } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DocumentRecord, Movement, Party } from '../types';
import { brDateTimeToIso, brToIso } from '../util/dates';
import { clean, decodeEntities, documentId } from '../util/text';
import { UnexpectedStructureError } from '../util/retry';

/** A document row as found in the detail page, before it is merged into a record. */
export interface DetailDocument {
  idProcessoDocumento: string;
  idBin?: string;
  date?: string;
  title: string;
  type?: string;
  certificate?: string;
  /** Session-bound download route, valid only for the session that fetched the page. */
  binaryHref?: string;
  viewerUrl?: string;
  receiptUrl?: string;
}

export interface MovementsPager {
  /** Form that wraps the slider. */
  formId: string;
  /** Slider input name (the page number travels here). */
  pageField: string;
  /** `a4j:support` control fired by the slider's onchange. */
  control: string;
  /** Ajax region (`containerId`) the request belongs to. */
  containerId?: string;
  pages: number;
}

export interface ParsedDetail {
  /** `Dados do Processo` label → value. */
  details: Record<string, string>;
  number?: string;
  className?: string;
  distributionDate?: string;
  parties: Party[];
  movements: Movement[];
  /** Total announced for movements (only the first page is in `movements`). */
  movementsTotal: number;
  movementsPager?: MovementsPager;
  documents: DetailDocument[];
  /** `idProcessoTrf` published by the "Imprimir" control, when present. */
  idProcessoTrf?: string;
}

export function parseDetail(html: string): ParsedDetail {
  const $ = cheerio.load(html);
  if ($('[id$=":processoDocumentoGridTab"]').length === 0 && $('.propertyView').length === 0) {
    throw new UnexpectedStructureError('detail page has neither Dados do Processo nor the documents grid');
  }
  const details = parseProperties($);
  const parties = [
    ...parseParties($, '[id$=":processoPartesPoloAtivoResumidoList"]', 'ATIVO'),
    ...parseParties($, '[id$=":processoPartesPoloPassivoResumidoList"]', 'PASSIVO'),
    ...parseParties($, '[id$=":processoParteOutrosInteressadosResumidoList"]', 'OUTROS'),
  ];
  const { movements, total, pager } = parseMovements($, html);
  const documents = parseDocuments($);
  const idProcessoTrf = /reportPDF\.seam\?idProcessoTrf=(\d+)/.exec(html)?.[1];
  return {
    details,
    number: details['Número Processo'],
    className: details['Classe Judicial'],
    distributionDate: brToIso(details['Data da Distribuição']),
    parties,
    movements,
    movementsTotal: total,
    movementsPager: pager,
    documents,
    idProcessoTrf,
  };
}

/** `Dados do Processo`: every `.propertyView` with a `.name` label and a `.value`. */
function parseProperties($: CheerioAPI): Record<string, string> {
  const out: Record<string, string> = {};
  $('.propertyView').each((_, el) => {
    const name = clean($(el).find('.name').first().text());
    const value = clean($(el).find('.value').first().text());
    if (name && value && out[name] === undefined) out[name] = value;
  });
  return out;
}

function parseParties($: CheerioAPI, tableSelector: string, pole: Party['pole']): Party[] {
  const out: Party[] = [];
  const table = $(`table${tableSelector}`).first();
  table.find('> tbody > tr').each((_, tr) => {
    const cells = $(tr).children('td');
    const cell = cells.first();
    const main = cell.find('span.text-bold').first();
    const nameSpan = main.length ? main : cell.find('div.col-sm-12 > span').first();
    const raw = clean(nameSpan.text());
    if (!raw) return;
    const note = clean(cell.find('ul li small').text()) || undefined;
    const situation = clean(cells.eq(1).text()) || undefined;
    out.push({ pole, ...splitParty(raw), isRepresentative: main.length === 0, note, situation });
  });
  return out;
}

/** "NOME - OAB PE22439 - CPF: 008.888.214-41 (ADVOGADO)" → name / document / role. */
export function splitParty(raw: string): { raw: string; name: string; role?: string; document?: string } {
  let rest = raw;
  let role: string | undefined;
  const roleMatch = /\(([^()]+)\)\s*$/.exec(rest);
  if (roleMatch) {
    role = clean(roleMatch[1]);
    rest = clean(rest.slice(0, roleMatch.index));
  }
  const docMatch = /(?:CPF|CNPJ|OAB|RG|Passaporte)[:\s][^-]+$/i.exec(rest);
  let document: string | undefined;
  const parts = rest.split(' - ');
  const name = clean(parts[0] ?? rest);
  const docs = parts.slice(1).map(clean).filter(Boolean);
  if (docs.length > 0) document = docs.join(' - ');
  else if (docMatch) document = clean(docMatch[0]);
  return { raw, name, role, document };
}

function parseMovements($: CheerioAPI, html: string): { movements: Movement[]; total: number; pager?: MovementsPager } {
  const table = $('table[id$=":processoEvento"]').first();
  const movements: Movement[] = [];
  table.find('> tbody > tr').each((_, tr) => {
    const m = parseMovementRow($(tr));
    if (m) movements.push(m);
  });
  const totalText = clean(table.nextAll('span.text-muted').first().text() || table.parent().find('span.text-muted').first().text());
  const totalMatch = /(\d[\d.]*)\s*resultado/i.exec(totalText);
  const total = totalMatch ? Number(totalMatch[1]!.replace(/\./g, '')) : movements.length;
  return { movements, total, pager: findMovementsPager(html, table) };
}

/** Rows read from a movements page (first page or a later one). */
export function parseMovementRows($: CheerioAPI): Movement[] {
  const out: Movement[] = [];
  $('table[id$=":processoEvento"]').first().find('> tbody > tr').each((_, tr) => {
    const m = parseMovementRow($(tr));
    if (m) out.push(m);
  });
  return out;
}

function parseMovementRow(tr: Cheerio<AnyNode>): Movement | undefined {
  const cells = tr.children('td');
  const text = clean(cells.first().text());
  if (!text) return undefined;
  const date = brDateTimeToIso(text);
  const body = clean(text.replace(/^\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2}(?::\d{2})?)?\s*-\s*/, ''));
  const documentLabel = clean(cells.eq(1).text()) || undefined;
  return { date, text: body, documentLabel };
}

/**
 * The movements pager is a `rich:inputNumberSlider` inside its own form, right
 * after the table:
 *   <form id="X:j_id561" action="javascript:A4J.AJAX.SubmitForm('X:j_id561',{…})">
 *     <input name="X:j_id561:j_id562" value="1">   ← page
 *     new Richfaces.Slider("X:j_id561:j_id562",{'minValue':'1','maxValue':'7',…,
 *        'onchange':'A4J.AJAX.Submit(\'X:j_id561\',event,{…\'containerId\':\'X:j_id474\',\'parameters\':{\'X:j_id561:j_id563\':\'X:j_id561:j_id563\'}})'})
 */
function findMovementsPager(html: string, table: Cheerio<AnyNode>): MovementsPager | undefined {
  const form = table.nextAll('div').find('form').first();
  const formId = form.attr('id');
  if (!formId) return undefined;
  const sliderInput = form.find('input.rich-inslider-field').first();
  const pageField = sliderInput.attr('name');
  if (!pageField) return undefined;
  const at = html.indexOf(`new Richfaces.Slider("${pageField}"`);
  if (at < 0) return undefined;
  const js = html.slice(at, at + 2000);
  const pages = Number(/'maxValue'\s*:\s*'(\d+)'/.exec(js)?.[1] ?? '1');
  const own = [...js.matchAll(/\\'([^\\']+)\\'\s*:\s*\\'([^\\']+)\\'/g)].map((m) => [m[1]!, m[2]!] as const).find(([k, v]) => k === v);
  if (!own) return undefined;
  const containerId = /containerId\\'\s*:\s*\\'([^\\']+)/.exec(js)?.[1];
  return { formId, pageField, control: own[0], containerId, pages: Number.isFinite(pages) && pages > 0 ? pages : 1 };
}

function parseDocuments($: CheerioAPI): DetailDocument[] {
  const out: DetailDocument[] = [];
  $('table[id$=":processoDocumentoGridTab"]').first().find('> tbody > tr').each((_, tr) => {
    const $tr = $(tr);
    const cells = $tr.children('td');
    const first = cells.first();
    const rowHtml = decodeEntities($.html($tr));

    const binary = first.find('a[href*="setDownloadInstance"]').first();
    const binaryHref = binary.attr('href') ? decodeEntities(binary.attr('href')!) : undefined;
    const viewerMatch = /documentoSemLoginHTML\.seam\?ca=([0-9a-fA-F]+)&idProcessoDoc=(\d+)/.exec(rowHtml);
    const idFromBinary = /idProcessoDocumento=(\d+)/.exec(binaryHref ?? '')?.[1];
    const idProcessoDocumento = idFromBinary ?? viewerMatch?.[2] ?? /idProcessoDoc=(\d+)/.exec(rowHtml)?.[1];
    if (!idProcessoDocumento) return;
    const idBin = /idBin=(\d+)/.exec(binaryHref ?? '')?.[1] ?? /idBin=(\d+)/.exec(rowHtml)?.[1];
    const receipt = /(\/[^'"\s]*reportReciboPDF\.seam\?[^'"\s)]+)/.exec(rowHtml)?.[1];

    // "28/10/2021 14:34:55 - Decisão (Decisão)"
    const label = clean(first.text().replace(/function\s+abrirPopUp[\s\S]*$/, '').replace(/Visualizar documentos?/i, ''));
    const date = brDateTimeToIso(label);
    const body = clean(label.replace(/^\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2}(?::\d{2})?)?\s*-\s*/, ''));
    const typeMatch = /\(([^()]+)\)\s*$/.exec(body);
    const title = typeMatch ? clean(body.slice(0, typeMatch.index)) : body;
    const type = typeMatch ? clean(typeMatch[1]) : undefined;
    const certificate = clean(cells.eq(1).text().replace(/function\s+abrirPopUp[\s\S]*$/, '')) || undefined;

    out.push({
      idProcessoDocumento,
      idBin,
      date,
      title: title || `documento_${idProcessoDocumento}`,
      type,
      certificate,
      binaryHref,
      viewerUrl: viewerMatch ? `documentoSemLoginHTML.seam?ca=${viewerMatch[1]}&idProcessoDoc=${viewerMatch[2]}` : undefined,
      receiptUrl: receipt,
    });
  });
  return out;
}

/** Builds the persistent document record for a process from a parsed row. */
export function toDocumentRecord(processId: string, d: DetailDocument): DocumentRecord {
  return {
    id: documentId(processId, d.idProcessoDocumento),
    idProcessoDocumento: d.idProcessoDocumento,
    idBin: d.idBin,
    date: d.date,
    title: d.title,
    type: d.type,
    certificate: d.certificate,
    download: d.binaryHref ? 'binary' : d.viewerUrl ? 'viewer' : 'none',
    receiptUrl: d.receiptUrl,
    status: d.binaryHref || d.viewerUrl ? 'pending' : 'unavailable',
  };
}
