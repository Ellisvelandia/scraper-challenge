# Scraper de la Consulta Pública del PJe TRF5

Scraper en **TypeScript** para el [Desafío de Scraping](https://pjett.trf5.jus.br/pjeconsulta/ConsultaPublica/listView.seam):
recorre **todos** los procesos de la Consulta Pública del PJe del TRF5
(instancia `pjett.trf5.jus.br`), extrae los metadatos completos de cada proceso
y descarga los PDF de sus documentos, con manejo de `429` por backoff
exponencial. Solo peticiones HTTP (`axios`) y parsing (`cheerio`): **sin
Puppeteer, sin Playwright, sin Selenium, sin ningún navegador**.

```
Fase 1 (discover)  particiona el rango de fechas → lista y guarda cada proceso
Fase 2 (download)  abre la ficha de cada proceso → metadatos completos + PDFs
```

Ambas fases son reanudables: se pueden cortar con Ctrl+C y relanzar; continúan
donde iban, sin duplicados. El enunciado no exige descargarlo todo en una
ejecución; los límites (`MAX_*`) permiten una corrida de demostración corta.

---

## Instalación y uso

Requisitos: Node.js ≥ 18. Sin VPN ni proxy de datacenter (el WAF del portal
bloquea esos rangos).

```bash
git clone https://github.com/Ellisvelandia/scraper-challenge
cd scraper-challenge
npm install

# corrida de demostración acotada (unos 2 minutos)
DATE_FROM=1990-01-01 DATE_TO=1994-12-31 MAX_PROCESSES=3 MAX_DOCUMENTS=4 npm run all

# corrida completa (déjala corriendo; es reanudable)
npm run all
```

En PowerShell las variables se fijan antes: `$env:MAX_DOCUMENTS='4'; npm run all`.

### Comandos

| Comando | Qué hace |
|---|---|
| `npm run discover` | Fase 1: enumera todos los procesos particionando por fecha |
| `npm run download` | Fase 2: ficha completa + descarga de PDFs de lo ya descubierto |
| `npm run all` | Las dos fases, en orden |
| `npm run retry-failed` | Reintenta lo anotado en `output/failed.json` |
| `npm run status` | Progreso a partir de los ficheros de salida, sin red |
| `npm test` | Suite de Jest, offline (fixtures reales del portal, sin red) |
| `npm run build` / `npm run typecheck` | Compilación / solo chequeo de tipos |

### Variables de entorno

| Variable | Por defecto | Efecto |
|---|---|---|
| `DATE_FROM` / `DATE_TO` | `1985-01-01` / hoy | Ventana (ISO) que particiona la Fase 1 |
| `MAX_SEARCHES` | 0 = sin límite | Tope de búsquedas de la Fase 1 por ejecución |
| `MAX_DISCOVERED` | 0 = sin límite | Detiene la Fase 1 al tener N procesos almacenados (cuenta los de corridas anteriores) |
| `MAX_PROCESSES` | 0 = sin límite | Tope de fichas de la Fase 2 por ejecución |
| `MAX_DOCUMENTS` | 0 = sin límite | Tope de PDFs descargados por ejecución |
| `SKIP_DOWNLOADS` | off | Fase 2 sin PDFs: abre cada ficha (partes, movimentações, lista de documentos) y no descarga nada; una corrida posterior sin la variable descarga los PDFs pendientes |
| `MIN_DELAY_MS` / `JITTER_MS` | 700 / 300 | Pausa mínima + jitter entre peticiones |
| `REQUEST_TIMEOUT_MS` | 60000 | Timeout por petición HTTP |
| `SESSION_MAX_REQUESTS` | 400 | Peticiones por sesión JSF antes de reciclarla |
| `MAX_ATTEMPTS` | 3 | Intentos por petición antes de anotar el fallo y seguir |
| `RETRY_BASE_MS` / `RETRY_MAX_MS` | 2000 / 120000 | Base y techo del backoff exponencial |
| `WAF_COOLDOWN_MS` | 90000 | Pausa tras la página de bloqueo del WAF |
| `ERROR_PAGE_PAUSE_MS` | 5000 | Pausa tras el 302 a `errorUnexpected.seam` (error determinista por proceso en la corrida observada, no rate limiting) |
| `PJE_BASE_URL` | `https://pjett.trf5.jus.br` | Otra instancia del mismo PJe |
| `INCLUDE_RECEIPTS` | off | Descarga también los comprovantes (`reportReciboPDF`) |
| `OUTPUT_DIR` | `output` | Carpeta de salida |
| `SAVE_RAW` | off | Guarda cada respuesta cruda en `output/raw/` |
| `DEBUG` | off | Traza cada petición HTTP |

### Salida

| Ruta | Contenido |
|---|---|
| `output/processes/<id>.json` | Un fichero por proceso, con id estable `BR-TRF5-<númeroCNJ>` (o `BR-TRF5-ca-<hash>` si el portal no publica el número). Escritura atómica O(1) por actualización: un solo JSON monolítico no aguantaría los 106.763 procesos del corpus. |
| `output/index.json` | Índice ligero (una entrada pequeña por proceso) para dedupe y progreso; se reconstruye desde `processes/` si falta o se corrompe |
| `output/processes.csv` / `output/documents.csv` | Exportación tabular (UTF-8 con BOM, apto para Excel) |
| `output/pdfs/<idProceso>/<idProceso>_<idDoc>_<fecha>_<título>.pdf` | Un PDF por documento, nombre descriptivo y estable |
| `output/state.json` | Rangos completados, días saturados, total medido: el estado de reanudación |
| `output/failed.json` | Cada fallo con su fase, motivo, nº de intentos y última marca de tiempo |
| `output/scraper.log` | Log completo de la ejecución |

### Volumen de la corrida de demostración (2026-08-26)

Corrida acotada con `MAX_*`, reanudable desde `state.json` hasta el final del
corpus. Cifras tomadas de `output/scraper.log` y `npm run status`:

| Métrica | Valor |
|---|---|
| Corpus anunciado por el portal (`state.json.measuredTotal`) | 106.763 procesos |
| Procesos descubiertos (Fase 1) | 2.493, rango 1985-01-01 → 2014-04-13 completado, 0 días saturados |
| Fichas completas (Fase 2) | 4 (37 partes, 520/520 movimentações paginadas, 23 documentos) |
| PDF descargados | 7 (196 KB, validados por content-type y firma `%PDF-`), versionados como muestra en `output/pdfs/` |
| Fallos registrados | 1 ficha (`errorUnexpected.seam` tras 5 intentos con backoff 2 s → 3 s → 8 s → 14 s), pendiente de `npm run retry-failed` |

---

## Cómo funciona (lo que hubo que descubrir)

El portal es JSF 1.2 + RichFaces/Ajax4jsf 3.3 sobre JBoss Seam: no navega por
URL. Cada interacción es un POST del formulario completo con el
`javax.faces.ViewState` vigente, y la respuesta es un XML que dice qué
fragmentos del DOM reemplazar. El scraper mantiene un documento vivo (cheerio)
y lo parchea igual que haría el navegador. El detalle completo, con cada
petición capturada y verificada, está en [`docs/protocolo.md`](docs/protocolo.md).

Los tres hallazgos que definen el diseño:

1. **El botón de buscar es un señuelo.** Su `onclick` hace
   `return executarReCaptcha();;A4J.AJAX.Submit(…)`: el `return` corta antes del
   submit visible. El submit real es un `a4j:jsFunction` oculto
   (`executarPesquisa`), cuyo id cambia entre despliegues y se lee de la página
   en cada sesión. El reCAPTCHA está desactivado en el servidor
   (`if (false) { grecaptcha.execute() }`): no hay CAPTCHA que resolver ni evadir.

2. **No hay paginación.** Toda consulta devuelve como máximo **30 filas** y el
   hueco «Paginação» se renderiza vacío; el pie anuncia `min(total, 30)`.
   «Navegar todas las páginas» se convierte en **particionar el espacio de
   búsqueda**: la Fase 1 parte el rango de fechas de autuação en mitades hasta
   que cada tramo cabe bajo el tope (año → mes → … → día), y si un solo día
   sigue saturado, particiona por clase judicial; si aún así no cabe, el día
   queda registrado en `state.json` como cobertura parcial explícita. El total
   real del corpus (106.763 procesos al 2026-08-26) se mide con una consulta
   que el servidor acepta pero no filtra, y `npm run status` lo contrasta con lo
   descubierto.

3. **Los enlaces de descarga caducan con la sesión.** La ficha de un proceso se
   abre por un hash `ca` estable, pero los enlaces de sus documentos llevan un
   hash ligado a la sesión que abrió la ficha. Por eso la Fase 2 descarga cada
   PDF partiendo de una ficha recién abierta, nunca de URLs guardadas. Hay dos
   rutas de descarga, ambas implementadas: la binaria
   (`…setDownloadInstance` → 302 → `download.seam` → `application/pdf`) y la del
   visor HTML (POST `downloadPDF` con `ca` + `idProcDocBin`). Cada descarga se
   valida (content-type, bytes mágicos `%PDF-`, tamaño) y se escribe como
   `.part` renombrado al final: nunca queda basura con extensión `.pdf`.

### Manejo de errores 429 (y del resto)

`src/util/retry.ts` clasifica antes de reaccionar:

- **429 / 5xx / 408 / cortes de red** → reintento con backoff exponencial con
  jitter (2 s, 4 s, 8 s… hasta 120 s), respetando `Retry-After` si el servidor
  lo envía. Tras `MAX_ATTEMPTS`, el documento/proceso queda en
  `output/failed.json` y **la ejecución continúa con el siguiente** (`npm run
  retry-failed` lo reintenta después).
- **Página de bloqueo del WAF** (HTTP 200 disfrazado) → pausa de 90 s y sesión
  nueva; reintentar rápido convierte un bloqueo blando en uno duro.
- **`errorUnexpected.seam` / `ViewExpiredException`** → sesión nueva y reintento.
- **4xx restantes y HTML donde iba un PDF** → fatales: se anotan y no se reintentan.

### Estructura del proyecto

```
src/
├── index.ts              CLI (discover / download / all / retry-failed / status)
├── config.ts             Configuración y variables de entorno
├── types.ts              Contrato de datos (ProcessRecord, DocumentRecord, …)
├── http/client.ts        Axios + cookies manuales, ISO-8859-1, pausa mínima,
│                         detección de errores disfrazados de 200, sin auto-redirect
├── pje/
│   ├── a4j.ts            Protocolo Ajax4jsf: serializar formulario, cuerpo A4J,
│   │                     parcheo del DOM con la respuesta
│   ├── session.ts        Sesión JSF: abrir, buscar, ficha, páginas de movimentações
│   ├── listParser.ts     Tabla de resultados (30 filas, tope, segredo de justiça)
│   ├── detailParser.ts   Ficha: dados, partes, movimentações, documentos
│   └── documents.ts      Descarga y validación de PDFs (ruta binaria y de visor)
├── crawl/
│   ├── discover.ts       Fase 1: partición por fechas + medición del total
│   └── enrich.ts         Fase 2: fichas completas + descargas
├── storage/
│   ├── store.ts          La clase Store: estado en memoria y rutas de escritura
│   ├── shards.ts         Directorio de shards: nombres, escaneo, reconciliación
│   ├── indexEntry.ts     Proyección ligera por proceso (index.json)
│   ├── merge.ts          Fusión pura de documentos y rangos de fechas
│   ├── csv.ts            Exportación de processes.csv y documents.csv
│   └── jsonFile.ts       Escritura atómica y lectura defensiva de JSON
├── util/                 retry/backoff, fechas, logger, texto e ids
└── __tests__/            Suite offline con fixtures REALES capturados del portal
                          (sesiones redactadas): parsers, A4J, fechas, merge, retry
docs/protocolo.md         El protocolo del portal, petición a petición
```

### Identificadores

Cada proceso recibe un id estable `PAIS-FUENTE-<clave única de la fuente>`:
`BR-TRF5-0800041-77.2020.4.05.8302` (número CNJ, único en Brasil) y cada
documento `…-DOC-<idProcessoDocumento>`. Los procesos en segredo de justiça,
que el portal lista sin número, usan el hash con el que el propio portal los
abre: `BR-TRF5-ca-<hash>`.

## Cumplimiento del enunciado

Cada requisito del desafío, dónde está resuelto y con qué evidencia.
**Probado** = fijado por la suite offline (`npm test`). **En vivo** =
ejercitado contra el portal en la corrida de demostración (`output/scraper.log`).

| Requisito | Dónde | Evidencia |
|---|---|---|
| Navegar por todas las páginas del sitio | `crawl/discover.ts`: el portal no pagina (30 filas por consulta), así que se particiona el rango de `dataAutuacao` hasta que cada tramo cabe; `state.json` guarda los rangos completados | En vivo: 2.493 procesos sin duplicados. Probado: `listParser.test.ts` (tope de 30, banner de desborde), `dates.test.ts` (`splitRange`) |
| Extraer toda la información de cada documento | `pje/detailParser.ts`: dados do processo, partes, movimentações (paginadas por slider), documentos | En vivo: 4 fichas, 520/520 movimentações. Probado: `detailParser.test.ts` sobre fixtures reales |
| Descargar los PDF asociados | `pje/documents.ts`: ruta binaria (`download.seam`) y ruta del visor (`downloadPDF`); validación de content-type, `%PDF-` y tamaño; escritura `.part` + rename | En vivo: 7 PDF, muestra versionada en `output/pdfs/` |
| Nombre descriptivo y carpeta organizada | `output/pdfs/<idProceso>/<idProceso>_<idDoc>_<fecha>_<título>.pdf` (`safeFileName`) | En vivo. Probado: `text.test.ts` |
| Detectar el `429` | `http/client.ts` (`classify`): 429 / 5xx / 408 → `HttpRetryableError` con `Retry-After`; otros 4xx → `HttpFatalError` | Probado: `retry.test.ts` |
| Reintentos con retroceso exponencial | `util/retry.ts` (`backoffMs`, `withRetry`): 2 s · 2ⁿ con jitter, tope 120 s, `Retry-After` manda | Probado: `retry.test.ts` (schedule, `Retry-After`, tope, agotamiento). En vivo: 5 intentos con esperas 2 s → 3 s → 8 s → 14 s sobre `errorUnexpected.seam` |
| Continuar con el siguiente si el fallo persiste | `crawl/enrich.ts`: `try/catch` por ficha y por documento; el bucle no se rompe | En vivo: la ficha `0006051-07.1991.4.05.8200` falló 5 veces y la corrida siguió con las demás |
| Registrar qué documentos fallaron para reintentarlos | `storage/store.ts` (`recordFailure`) → `output/failed.json` con fase, motivo, intentos y marca de tiempo; `npm run retry-failed` los reprocesa | En vivo: 1 entrada en `failed.json`. Probado: `merge.test.ts` (un reintento exitoso limpia el error previo) |
| TypeScript, sin Puppeteer / Playwright / Selenium | `tsconfig.json` en modo `strict`; dependencias de ejecución: `axios`, `cheerio` | `package.json` |
| Código estructurado y documentado | Capas `http/`, `pje/`, `crawl/`, `storage/`, `util/`; cada fichero abre con el porqué; `docs/protocolo.md` | — |
| Repositorio con fuente, `package.json`, `README.md` y `.gitignore` | Raíz | — |
| Delays entre peticiones | `MIN_DELAY_MS` 700 + `JITTER_MS` 300 en cada petición; sesión reciclada cada `SESSION_MAX_REQUESTS` | En vivo |
| Datos en formato estructurado | `output/processes/*.json`, `index.json`, `processes.csv`, `documents.csv` | En vivo |
| Probar con un subconjunto | `DATE_FROM` / `DATE_TO`, `MAX_PROCESSES`, `MAX_DOCUMENTS`, `MAX_SEARCHES` | En vivo |
| Logging del progreso | `util/logger.ts`: una línea por búsqueda, ficha, descarga y reintento; `output/scraper.log` | En vivo |

## Limitaciones conocidas

- **Días saturados:** si un mismo día + clase judicial supera las 30 filas, ese
  resto es inalcanzable por la interfaz pública; queda anotado en
  `state.json.saturatedDays` (ninguno en las ventanas muestreadas).
- **Documentos sin ruta pública** (enlace `about:blank` sin binario ni visor) se
  registran con `status: "unavailable"`.
- **Partes:** las tres tablas de partes (polo ativo, polo passivo, outros
  interessados) llevan un `rich:dataScroller` propio; el scraper lee la página
  que la ficha renderiza. Un proceso con más partes que una página del scroller
  queda con la lista de partes truncada (no se ha observado en la muestra; las
  movimentações sí se paginan completas).
- `reportPDF.seam` (expediente completo, botón «Imprimir») devuelve 302 fuera
  del flujo del navegador; no se usa. Los PDFs se obtienen documento a documento.

## Nota de alcance

La Consulta Pública es de acceso libre y sin autenticación; el organizador del
desafío declara que ya posee esta información y que el scraper es únicamente una
prueba técnica. Delays conservadores por defecto. `output/` está en
`.gitignore`; solo se versiona la muestra de 7 PDF de `output/pdfs/` como
evidencia de la descarga de punta a punta (resoluciones publicadas por el propio
tribunal para consulta pública). El resto de los datos recogidos no se sube.
