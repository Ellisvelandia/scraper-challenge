/**
 * Parser of the search results table (`…:processosTable`).
 *
 * Shape verified against the live portal (2026-08-25):
 *
 *   <table id="fPP:processosTable">
 *     <thead> "" | Processo | Última movimentação </thead>
 *     <tbody>
 *       <tr class="rich-table-row">
 *         <td> <a onclick="openPopUp('Consulta pública','/pjeconsulta/…/DetalheProcessoConsultaPublica/listView.seam?ca=<hash>')">Ver detalhes</a> </td>
 *         <td> CLASSE JUDICIAL <a onclick="openPopUp(…?ca=<hash>)"><b>SIGLA NNNNNNN-DD.AAAA.J.TR.OOOO - Assunto</b></a> POLO ATIVO X POLO PASSIVO </td>
 *         <td> Nome do movimento (dd/MM/yyyy HH:mm:ss) </td>
 *       </tr>
 *     </tbody>
 *     <tfoot> <div title="Paginação"></div> <span class="text-muted">N resultados encontrados</span> </tfoot>
 *   </table>
 *
 * Two facts drive the crawler and are surfaced here:
 *  - the portal caps every filtered query at 30 rows and never renders a pager;
 *    `announcedTotal` is therefore min(real total, 30) and `isCapped` tells the
 *    caller to split its search range;
 *  - processes in segredo de justiça have no number in the <b>; they are still
 *    emitted (with `number` undefined) because the portal does publish their
 *    class, subject and parties, and the `ca` hash identifies them.
 */
import type { CheerioAPI } from 'cheerio';
import { CONFIG } from '../config';
import { brDateTimeToIso } from '../util/dates';
import { clean, decodeEntities, extractCnj } from '../util/text';
import { UnexpectedStructureError } from '../util/retry';

export interface ListRow {
  /** Access hash of the detail page. */
  ca: string;
  number?: string;
  classAcronym?: string;
  className?: string;
  subject?: string;
  activePoleSummary?: string;
  passivePoleSummary?: string;
  lastMovement?: string;
  lastMovementDate?: string;
}

export interface ListPage {
  rows: ListRow[];
  /** Number printed in the footer: min(total, cap). */
  announcedTotal: number;
  /** True when the query hit the cap and the range must be split to see every row. */
  isCapped: boolean;
  /**
   * True when the portal explicitly said rows were hidden ("…somente os N
   * primeiros serão exibidos"). This is the authoritative overflow signal; a
   * day with exactly `cap` processes has `isCapped` but no banner.
   */
  overflowBanner: boolean;
  /** Validation message shown by the portal instead of results, if any. */
  message?: string;
}

/** "Sua consulta retornou muitos processos e somente os 30 primeiros serão exibidos" */
const OVERFLOW_BANNER = /somente\s+os\s+\d+\s+primeiros\s+ser[aã]o\s+exibidos/i;

const CA_RE = /listView\.seam\?ca=([0-9a-fA-F]+)/;

/** Parses the results table out of the live document (after an A4J search). */
export function parseListPage($: CheerioAPI): ListPage {
  const table = $('table[id$=":processosTable"]').first();
  const message = clean($('dl.rich-messages').text()) || undefined;
  if (table.length === 0) {
    if (message) return { rows: [], announcedTotal: 0, isCapped: false, overflowBanner: false, message };
    throw new UnexpectedStructureError('results table (…:processosTable) not found');
  }
  const footer = clean(table.find('tfoot .text-muted').text());
  const totalMatch = /(\d[\d.]*)\s*resultado/i.exec(footer);
  const announcedTotal = totalMatch ? Number(totalMatch[1]!.replace(/\./g, '')) : 0;

  const rows: ListRow[] = [];
  table.find('tbody tr').each((_, tr) => {
    const row = parseRow($, tr);
    if (row) rows.push(row);
  });

  const overflowBanner = OVERFLOW_BANNER.test($.root().text());
  const isCapped = overflowBanner || rows.length >= CONFIG.resultCap;
  return { rows, announcedTotal: announcedTotal || rows.length, isCapped, overflowBanner, message };
}

function parseRow($: CheerioAPI, tr: Parameters<CheerioAPI>[0]): ListRow | undefined {
  const $tr = $(tr);
  const cells = $tr.children('td');
  if (cells.length < 2) return undefined;

  // The detail hash appears in the first cell's link and again in the middle one.
  const html = decodeEntities($.html($tr));
  const ca = CA_RE.exec(html)?.[1];
  if (!ca) return undefined;

  const middle = cells.eq(1);
  const bold = middle.find('b').first();
  const link = middle.find('a').first();
  const boldText = clean(bold.text());

  // "SIGLA NNNNNNN-DD.AAAA.J.TR.OOOO - Assunto"  or  "SIGLA - Assunto" (segredo de justiça)
  const number = extractCnj(boldText);
  let classAcronym: string | undefined;
  let subject: string | undefined;
  if (boldText) {
    const dash = boldText.indexOf(' - ');
    const head = dash >= 0 ? boldText.slice(0, dash) : boldText;
    subject = dash >= 0 ? clean(boldText.slice(dash + 3)) : undefined;
    classAcronym = clean(number ? head.replace(number, '') : head) || undefined;
  }

  // Text before the link is the class name; text after it is "ATIVO X PASSIVO".
  const middleHtml = $.html(middle);
  const linkHtml = link.length ? $.html(link) : '';
  const linkPos = linkHtml ? middleHtml.indexOf(linkHtml) : -1;
  const before = linkPos >= 0 ? middleHtml.slice(0, linkPos) : middleHtml;
  const after = linkPos >= 0 ? middleHtml.slice(linkPos + linkHtml.length) : '';
  const className = clean(stripTags(before)) || undefined;
  const poles = clean(stripTags(after));
  let activePoleSummary: string | undefined;
  let passivePoleSummary: string | undefined;
  if (poles) {
    const sep = poles.indexOf(' X ');
    if (sep >= 0) {
      activePoleSummary = clean(poles.slice(0, sep)) || undefined;
      passivePoleSummary = clean(poles.slice(sep + 3)) || undefined;
    } else {
      activePoleSummary = poles;
    }
  }

  const movementText = clean(cells.eq(2).text());
  const dateMatch = /\((\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2}(?::\d{2})?)?)\)\s*$/.exec(movementText);
  const lastMovement = dateMatch ? clean(movementText.slice(0, dateMatch.index)) : movementText || undefined;
  const lastMovementDate = brDateTimeToIso(dateMatch?.[1]);

  return {
    ca,
    number,
    classAcronym,
    className,
    subject,
    activePoleSummary,
    passivePoleSummary,
    lastMovement: lastMovement || undefined,
    lastMovementDate,
  };
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' '));
}
