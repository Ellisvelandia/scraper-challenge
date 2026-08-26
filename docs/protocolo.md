# Protocolo del portal — PJe TRF5 «treinamento» (pjett.trf5.jus.br)

Capturado en vivo el 2026-08-25/26 con HTTP puro (sin navegador). Todo lo que
está en este documento fue verificado contra el portal real; lo no verificado
se marca como tal.

**Tecnología:** JBoss Seam 2 + JSF 1.2 + RichFaces / Ajax4jsf 3.3.3.Final.
**Charset:** HTML en `ISO-8859-1`; respuestas AJAX en `text/xml; charset=UTF-8`.
**WAF:** F5. Sirve una página de bloqueo con **HTTP 200** titulada
«Requisição - Rejeitada» (~22 KB). Disparadores observados: enviar una cabecera
`Cookie:` vacía; egress desde rangos de VPN/datacenter. Es intermitente: la
misma petición sin esos rasgos pasa. Reacción correcta: pausa larga y sesión
nueva, nunca reintentos rápidos.

## 1. Sesión

```
GET /pjeconsulta/ConsultaPublica/listView.seam
→ 200, ~48 KB, ISO-8859-1
→ cookies: JSESSIONID (path /pjeconsulta), ROUTER_ID, trf50…, trf50… (WAF)
→ javax.faces.ViewState = j_id1
→ formulario fPP completo
```

No hay CAPTCHA operativo: la página carga el script de reCAPTCHA pero el botón
compila a `function executarReCaptcha(){ if (false) { grecaptcha.execute(); … }
executarPesquisa(); }` — la rama nunca se ejecuta y ningún token viaja en el POST.

## 2. Búsqueda — la trampa del botón

El onclick del botón visible es:

```
return executarReCaptcha();;A4J.AJAX.Submit('fPP',…,{'parameters':{'fPP:searchProcessos':…}});return false;
```

`executarReCaptcha()` devuelve `undefined`, así que el `return` corta ANTES del
`A4J.AJAX.Submit` visible. Enviar `fPP:searchProcessos` solo re-renderiza el
panel de mensajes (`fPP:j_id248`). El submit real es el `a4j:jsFunction`:

```
executarPesquisa=function(){A4J.AJAX.Submit('fPP',null,{…,'parameters':{'fPP:j_id244':'fPP:j_id244'}})};
```

El id `fPP:j_id244` cambia entre despliegues: se lee de la página en cada
apertura de sesión.

Cuerpo del POST (verificado):

```
POST /pjeconsulta/ConsultaPublica/listView.seam
Content-Type: application/x-www-form-urlencoded; charset=UTF-8

AJAXREQUEST=_viewRoot
<TODOS los campos del formulario fPP, en orden de documento>
fPP:j_id244=fPP:j_id244
AJAX:EVENTS_COUNT=1
```

Respuesta: XML A4J con `<meta name="Ajax-Update-Ids" content="fPP:processosGridPanel"/>`
y el `ViewState` nuevo en `#ajax-view-state`. Se parchea el documento vigente
con esos fragmentos, como hace el navegador.

Validaciones del servidor (mensajes en `dl.rich-messages`):
- Sin ningún criterio → «Pelo menos um dos critérios de pesquisa deve ser informado.»
- `nomeParte` con una sola palabra → «É necessário informar ao menos dois nomes…»

## 3. El volumen y la «paginación» que no existe

- Toda consulta filtrada devuelve **como máximo 30 filas** y su pie dice
  `min(total, 30) resultados encontrados`. El hueco del paginador
  (`<div title="Paginação">`) se renderiza **vacío siempre**.
- Un día concreto devuelve su número real (0–12 en el mes muestreado).
- **Truco de medición:** una fecha inexistente (`31/02/2000`) pasa la validación
  «al menos un criterio», el conversor la descarta y la consulta corre SIN
  filtro: el pie anuncia el total real del corpus. Medido: **106.763 procesos**
  (2026-08-26). Filas útiles de esa respuesta: las 30 primeras del orden por año/número.
- Consecuencia: «navegar todas las páginas» = particionar el espacio de búsqueda
  por `dataAutuacao` (rango binario: años → mitades → … → día). Si un día
  concreto sigue devolviendo 30, partición secundaria por `classeJudicial`
  (campo LIKE) con las clases vistas; si aún así satura, el día queda anotado en
  `state.json.saturatedDays` — hueco explícito, nunca silencioso.
- Distribución observada: 1986–2004 caben por año (147 procesos en total);
  2005–2026 saturan el año y bajan a mes/semana/día.

## 4. Ficha del proceso

```
GET /pjeconsulta/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam?ca=<hash48>
→ 200, ~86–106 KB
```

- El `ca` de 48 hex sale del `onclick="openPopUp('Consulta pública','…?ca=…')"`
  de cada fila y **es estable entre sesiones** (verificado en sesión virgen).
- Secciones: «Dados do Processo» (pares `.propertyView` → `.name`/`.value`),
  Polo ativo / Polo Passivo / Outros interessados (`rich:dataTable` con
  datascroller, oculto con una sola página), Movimentações, Documentos.
- **Movimentações** pagina de 15 en 15 con un `rich:inputNumberSlider` en su
  propio formulario (`<form id="…:j_id561">`), total en un
  `<span>N resultados encontrados</span>`. Página N (verificado en la ejecución
  real, 90/90 y 282/282 movimientos):

```
POST DetalheProcessoConsultaPublica/listView.seam
AJAXREQUEST=_viewRoot            (el containerId del onchange también funciona vía código)
<campos del formulario del slider, con <slider>=N>
<control a4j:support del onchange>=<el mismo>     p.ej. …:j_id563
AJAX:EVENTS_COUNT=1
```

## 5. Documentos y descarga de PDF

Cada fila de «Documentos juntados ao processo» publica una de dos rutas
(ambas verificadas):

**a) binaria** — documentos guardados como binario (Decisão, Inteiro Teor…):

```
GET  <href de la fila>   listView.seam?idBin=N&numeroDocumento=…&nomeArqProcDocBin=…&idProcessoDocumento=N&actionMethod=…setDownloadInstance(row)
→ 302 Location: /pjeconsulta/download.seam?cid=N
GET  /pjeconsulta/download.seam?cid=N
→ 200 application/pdf, Content-Disposition: filename="…", bytes %PDF-1.4
```

**b) visor** — documentos nacidos como HTML (Despacho, Certidão…):

```
GET  documentoSemLoginHTML.seam?ca=<hash96>&idProcessoDoc=N     (visor HTML del documento)
POST documentoSemLoginHTML.seam
     <campos del formulario del visor> + <form>:downloadPDF=<form>:downloadPDF + ca=<hash96> + idProcDocBin=N
→ 200 application/pdf, attachment; filename="<numeroCNJ>_<idDoc>.pdf"
```

**Los `ca` de 96 hex de los documentos están ligados a la sesión** que abrió la
ficha (verificado: reutilizarlos en otra sesión da 302). Por eso la descarga
siempre parte de una ficha recién abierta en la misma sesión, nunca de URLs
guardadas. Algunos documentos llevan además un comprovante
(`/pjeconsulta/Processo/reportReciboPDF.seam?idBin=…&idProcessoDoc=…&idProcessoTrf=…`),
descargable con `INCLUDE_RECEIPTS=1`.

No verificado: `reportPDF.seam?idProcessoTrf=N` (botón «Imprimir», expediente
completo) devolvió 302 en ambas rutas probadas; no se usa.

## 6. Señales de fallo y reacción

| Señal | Significado | Reacción implementada |
|---|---|---|
| `429` | Rate limit (anunciado por el enunciado para PDFs) | Backoff exponencial con jitter, `Retry-After` si viene, tope de intentos, se anota en `failed.json` y se continúa |
| `200` + «Requisição - Rejeitada» | Bloqueo del WAF F5 | `WafBlockedError`: pausa de 90 s y sesión nueva |
| `302` → `errorUnexpected.seam?cid=N` | Pool de conexiones agotado / error interno | Reintento con backoff y sesión nueva; tras agotar, `failed.json` |
| `5xx`, `408`, cortes de red | Transitorio | Backoff exponencial |
| XML A4J con `ViewExpiredException` o respuesta HTML | Vista/sesión caducada | Reabrir sesión y repetir |
| `content-type` HTML donde iba un PDF | Documento no disponible en binario | `InvalidDownloadError`: no se guarda basura con extensión `.pdf`, va a `failed.json` |
| `403`/`404` | No autorizado / no existe | Fatal, sin reintento |

## 7. Coste estimado de una corrida completa

- Descubrimiento: ~4.000–8.000 búsquedas (partición adaptativa de ~14.800 días).
- Enriquecimiento: 1 GET de ficha por proceso (106.763) + páginas de
  movimentações + 2–3 peticiones por documento.
- Con el delay por defecto (0,7–1 s), el descubrimiento completo ronda 2–3 h y
  el corpus entero de fichas+PDF, varios días. Ambas fases son reanudables
  (`state.json` / `processes.json`), como permite el enunciado.
