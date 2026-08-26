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
| `npm test` | Compila y corre la suite offline (fixtures reales, sin red) |
| `npm run build` / `npm run typecheck` | Compilación / solo chequeo de tipos |

### Variables de entorno

| Variable | Por defecto | Efecto |
|---|---|---|
| `DATE_FROM` / `DATE_TO` | `1985-01-01` / hoy | Ventana (ISO) que particiona la Fase 1 |
| `MAX_SEARCHES` | 0 = sin límite | Tope de búsquedas de la Fase 1 por ejecución |
| `MAX_PROCESSES` | 0 = sin límite | Tope de fichas de la Fase 2 por ejecución |
| `MAX_DOCUMENTS` | 0 = sin límite | Tope de PDFs descargados por ejecución |
| `MIN_DELAY_MS` / `JITTER_MS` | 700 / 300 | Pausa mínima + jitter entre peticiones |
| `MAX_ATTEMPTS` | 5 | Intentos por petición antes de anotar el fallo y seguir |
| `RETRY_BASE_MS` / `RETRY_MAX_MS` | 2000 / 120000 | Base y techo del backoff exponencial |
| `WAF_COOLDOWN_MS` | 90000 | Pausa tras la página de bloqueo del WAF |
| `PJE_BASE_URL` | `https://pjett.trf5.jus.br` | Otra instancia del mismo PJe |
| `INCLUDE_RECEIPTS` | off | Descarga también los comprovantes (`reportReciboPDF`) |
| `OUTPUT_DIR` | `output` | Carpeta de salida |
| `SAVE_RAW` | off | Guarda cada respuesta cruda en `output/raw/` |
| `DEBUG` | off | Traza cada petición HTTP |

### Salida

| Ruta | Contenido |
|---|---|
| `output/processes.json` | Procesos indexados por id estable `BR-TRF5-<númeroCNJ>` (o `BR-TRF5-ca-<hash>` si el portal no publica el número). Dedupe O(1) por construcción. |
| `output/processes.csv` / `output/documents.csv` | Exportación tabular (UTF-8 con BOM, apto para Excel) |
| `output/pdfs/<idProceso>/<idProceso>_<idDoc>_<fecha>_<título>.pdf` | Un PDF por documento, nombre descriptivo y estable |
| `output/state.json` | Rangos completados, días saturados, total medido: el estado de reanudación |
| `output/failed.json` | Cada fallo con su fase, motivo, nº de intentos y última marca de tiempo |
| `output/scraper.log` | Log completo de la ejecución |

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
├── storage/store.ts      Persistencia atómica: JSON, CSV, estado, fallos
├── util/                 retry/backoff, fechas, logger, texto e ids
└── __tests__/            Suite offline con fixtures REALES capturados del portal
                          (sesiones redactadas): parsers, A4J, fechas, store
docs/protocolo.md         El protocolo del portal, petición a petición
```

### Identificadores

Cada proceso recibe un id estable `PAIS-FUENTE-<clave única de la fuente>`:
`BR-TRF5-0800041-77.2020.4.05.8302` (número CNJ, único en Brasil) y cada
documento `…-DOC-<idProcessoDocumento>`. Los procesos en segredo de justiça,
que el portal lista sin número, usan el hash con el que el propio portal los
abre: `BR-TRF5-ca-<hash>`.

## Limitaciones conocidas

- **Días saturados:** si un mismo día + clase judicial supera las 30 filas, ese
  resto es inalcanzable por la interfaz pública; queda anotado en
  `state.json.saturatedDays` (ninguno en las ventanas muestreadas).
- **Documentos sin ruta pública** (enlace `about:blank` sin binario ni visor) se
  registran con `status: "unavailable"`.
- `reportPDF.seam` (expediente completo, botón «Imprimir») devuelve 302 fuera
  del flujo del navegador; no se usa. Los PDFs se obtienen documento a documento.

## Nota de alcance

La Consulta Pública es de acceso libre y sin autenticación; el organizador del
desafío declara que ya posee esta información y que el scraper es únicamente una
prueba técnica. Delays conservadores por defecto; `output/` está en
`.gitignore` y no se versiona ningún dato recogido.
