/**
 * Command-line entry point.
 *
 *   npm run discover       phase 1: enumerate every process (date partitioning)
 *   npm run download       phase 2: detail pages + PDF downloads of what was discovered
 *   npm run all            both, in order
 *   npm run retry-failed   retry the items recorded in output/failed.json
 *   npm run status         print progress from the output files, no network
 *
 * Every knob is an environment variable (see README.md), e.g.
 *   MAX_SEARCHES=40 npm run discover
 *   MAX_DOCUMENTS=10 npm run download
 */
import { CONFIG } from './config';
import { Discoverer } from './crawl/discover';
import { Enricher } from './crawl/enrich';
import { Store } from './storage/store';
import { log, describeError } from './util/logger';
import { WafBlockedError } from './util/retry';

type Command = 'discover' | 'download' | 'all' | 'retry-failed' | 'status';

const COMMANDS: Command[] = ['discover', 'download', 'all', 'retry-failed', 'status'];

async function main(argv: string[]): Promise<number> {
  const command = (argv[0] ?? 'all') as Command;
  if (!COMMANDS.includes(command)) {
    process.stderr.write(`Unknown command "${command}". Use one of: ${COMMANDS.join(', ')}\n`);
    return 2;
  }
  log.setDebug(CONFIG.debug);
  log.setFile(CONFIG.output.log);
  log.info(`command=${command} base=${CONFIG.baseUrl} output=${CONFIG.output.dir}`);

  const store = new Store();
  const stop = () => {
    log.warn('interrupted: saving progress');
    store.save(true);
    store.exportCsv();
    process.exit(130);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  switch (command) {
    case 'status':
      printStatus(store);
      return 0;
    case 'discover': {
      const s = await new Discoverer(store).run();
      log.info(`discovery done: ${s.searches} searches, ${s.newProcesses} new processes (${store.count()} total), ${s.saturatedDays} saturated day(s)${s.stoppedByLimit ? ', stopped by limit' : ''}`);
      return 0;
    }
    case 'download': {
      const s = await new Enricher(store).run();
      log.info(`download done: ${s.detailsFetched} details, ${s.documentsDownloaded} PDFs downloaded, ${s.documentsFailed} failed, ${s.documentsUnavailable} unavailable${s.stoppedByLimit ? ', stopped by limit' : ''}`);
      return 0;
    }
    case 'all': {
      const d = await new Discoverer(store).run();
      log.info(`discovery: ${d.searches} searches, ${d.newProcesses} new processes (${store.count()} total)`);
      const e = await new Enricher(store).run();
      log.info(`download: ${e.detailsFetched} details, ${e.documentsDownloaded} PDFs, ${e.documentsFailed} failed`);
      return 0;
    }
    case 'retry-failed': {
      const failures = store.failures();
      if (failures.length === 0) {
        log.info('failed.json is empty: nothing to retry');
        return 0;
      }
      const ids = new Set<string>();
      for (const f of failures) {
        if (f.stage === 'detail') ids.add(f.key);
        else if (f.stage === 'document') ids.add(f.key.replace(/-DOC-\d+$/, ''));
      }
      log.info(`retrying ${failures.length} failure(s) across ${ids.size} process(es)`);
      const e = await new Enricher(store).run({ onlyIds: ids, refresh: true });
      log.info(`retry done: ${e.detailsFetched} details, ${e.documentsDownloaded} PDFs, ${e.documentsFailed} still failing`);
      const ranges = failures.filter((f) => f.stage === 'search');
      if (ranges.length > 0) log.info(`${ranges.length} search range(s) failed earlier: run "npm run discover" again, completed ranges are skipped`);
      return 0;
    }
  }
}

function printStatus(store: Store): void {
  const entries = store.entries();
  const sum = (f: (e: (typeof entries)[number]) => number) => entries.reduce((a, e) => a + f(e), 0);
  const state = store.getState();
  const lines = [
    `processes discovered : ${entries.length}${state.measuredTotal ? ` of ${state.measuredTotal} announced by the portal` : ''}`,
    `details fetched      : ${entries.filter((e) => e.detailFetched).length}`,
    `documents            : ${sum((e) => e.docsTotal)} (downloaded ${sum((e) => e.docsDownloaded)}, pending ${sum((e) => e.docsPending)}, failed ${sum((e) => e.docsFailed)}, unavailable ${sum((e) => e.docsUnavailable)})`,
    `completed ranges     : ${state.completedRanges.length}${state.completedRanges.length ? ` (${state.completedRanges[0]!.from} .. ${state.completedRanges[state.completedRanges.length - 1]!.to})` : ''}`,
    `saturated days       : ${state.saturatedDays.length}`,
    `failures to retry    : ${store.failures().length}`,
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof WafBlockedError) {
      log.error('The portal WAF rejected the requests from this IP (Requisição - Rejeitada). Wait a few minutes and run again; do not use VPN or data-center egress.');
    } else {
      log.error(`fatal: ${describeError(err)}`);
      if (CONFIG.debug && err instanceof Error && err.stack) log.debug(err.stack);
    }
    process.exit(1);
  });
