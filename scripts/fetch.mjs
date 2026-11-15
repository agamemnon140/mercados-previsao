#!/usr/bin/env node
// Coleta diária dos maiores mercados da Kalshi e da Polymarket.
//
// Lê só endpoints públicos (sem chave), monta rankings por volume em quatro
// janelas (dia, semana, mês, ano), no geral e por categoria, e grava
// data/latest.json, que a página lê, mais um resumo em data/history/.
// Node 20 ou mais novo, sem dependências:  node scripts/fetch.mjs

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const KALSHI_BASE = trimSlash(process.env.KALSHI_BASE ?? 'https://external-api.kalshi.com/trade-api/v2');
const GAMMA_BASE = trimSlash(process.env.GAMMA_BASE ?? 'https://gamma-api.polymarket.com');
const OUT_DIR = process.env.OUT_DIR ?? 'data';
const TOP_N = intEnv('TOP_N', 500); // tamanho do ranking geral de cada janela
const TOP_PER_CATEGORY = intEnv('TOP_PER_CATEGORY', 100); // tamanho do ranking de cada categoria
const POLY_DEPTH = intEnv('POLY_DEPTH', 2000); // eventos lidos por janela na Polymarket
const KALSHI_MAX_PAGES = intEnv('KALSHI_MAX_PAGES', 600); // 200 eventos por página
const KALSHI_CANDLE_EVENTS = intEnv('KALSHI_CANDLE_EVENTS', 3000); // eventos com histórico consultado
const HISTORY_TOP = intEnv('HISTORY_TOP', 100); // por janela, quantos entram no resumo diário
const POLY_SCAN_MAX_PAGES = intEnv('POLY_SCAN_MAX_PAGES', 600); // 100 eventos por página
const PAUSE_MS = intEnv('PAUSE_MS', 120); // pausa entre requisições
const RETRY_BASE_MS = intEnv('RETRY_BASE_MS', 1000);
const TIMEOUT_MS = intEnv('TIMEOUT_MS', 30000);
const OUTCOMES_KEPT = 4; // resultados mostrados de início em cada evento
const OUTCOMES_STORED = intEnv('OUTCOMES_STORED', 50); // resultados guardados por evento, contando os de início
const TIGHT_SPREAD = 0.1; // até 10 centavos de spread, vale o ponto médio
const USER_AGENT = 'mercados-previsao/1.0 (coleta diaria, somente leitura)';
const DAY_SECONDS = 86400;

export const WINDOWS = ['day', 'week', 'month', 'year'];
const WINDOW_DAYS = { week: 7, month: 30, year: 365 };
export const CATEGORIES = ['esportes', 'politica', 'economia', 'cripto', 'cultura', 'ciencia', 'clima', 'mundo', 'outros'];

// ---------------------------------------------------------------- utilidades

function trimSlash(s) {
  return s.replace(/\/+$/, '');
}

function intEnv(name, fallback) {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Número finito ou null. As duas APIs misturam números e strings decimais. */
export function num(x) {
  if (x === null || x === undefined || x === '') return null;
  const n = typeof x === 'number' ? x : Number.parseFloat(x);
  return Number.isFinite(n) ? n : null;
}

function round(x, digits) {
  if (x === null || x === undefined) return null;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

function sum(values) {
  let total = 0;
  for (const v of values) total += v ?? 0;
  return total;
}

/** Aceita um array ou um array codificado em texto JSON (formato da Gamma). */
export function parseList(x) {
  if (Array.isArray(x)) return x;
  if (typeof x !== 'string' || !x.trim()) return [];
  try {
    const parsed = JSON.parse(x);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function cleanText(x) {
  return typeof x === 'string' ? x.replace(/\s+/g, ' ').trim() : '';
}

async function fetchJson(url, { retries = 4 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let waitMs = RETRY_BASE_MS * 2 ** attempt;
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return await res.json();

      const body = cleanText(await res.text().catch(() => '')).slice(0, 160);
      lastError = new Error(`HTTP ${res.status} em ${new URL(url).pathname}${body ? `: ${body}` : ''}`);
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable) throw Object.assign(lastError, { fatal: true });

      const retryAfter = num(res.headers.get('retry-after'));
      if (retryAfter !== null) waitMs = Math.min(Math.max(waitMs, retryAfter * 1000), 60000);
    } catch (err) {
      if (err?.fatal) throw err;
      lastError = err;
    }
    if (attempt < retries) await sleep(waitMs);
  }
  throw lastError;
}

// ---------------------------------------------------------------- categorias

// Cada rótulo (tag, categoria ou título) que casa com a expressão vale um ponto
// para a categoria; vence a de mais pontos e, no empate, a que vem antes aqui.
const CATEGORY_RULES = [
  ['esportes', /\b(sports?|esports|soccer|football|basketball|baseball|hockey|tennis|golf|nfl|nba|wnba|mlb|nhl|mls|epl|ucl|ufc|mma|boxing|f1|formula 1|cricket|olympics?|ncaa|rugby|nascar|pga|atp|wta|champions league|premier league|la liga|counter strike|dota|league of legends|valorant)\b/],
  ['cripto', /\b(crypto|cryptocurrency|bitcoin|btc|ethereum|solana|xrp|defi|stablecoins?|memecoins?|nfts?)\b/],
  ['clima', /\b(climate|weather|hurricanes?|temperature)\b/],
  ['cultura', /\b(culture|entertainment|movies?|music|tv|television|netflix|awards?|celebrit(y|ies)|oscars?|grammys?|mentions?|social|gaming)\b/],
  ['ciencia', /\b(tech|technology|science|ai|space|health|medicine)\b/],
  ['mundo', /\b(world|geopolitics|foreign policy|military|ceasefire|war|global|international|middle east|ukraine|russia|china|taiwan|israel|iran|gaza|venezuela|cuba|north korea|nato)\b/],
  ['economia', /\b(econom(y|ics|ic)|financ(e|ials?)|fed|fomc|inflation|cpi|gdp|macro|recession|tariffs?|business|compan(y|ies)|earnings|stocks?|commodit(y|ies)|oil|gold|ipos?|acquisitions?|rates?)\b/],
  ['politica', /\b(politics?|elections?|midterms?|primar(y|ies)|congress|senate|governor|mayor|parliament|president(ial)?|prime ministers?|nominee|trump|government|white house|supreme court)\b/],
];

/** Reduz as categorias e tags de cada plataforma a um conjunto comum. */
export function unifiedCategory(labels) {
  const lowered = labels.map((label) => cleanText(label).toLowerCase()).filter(Boolean);
  let best = 'outros';
  let bestScore = 0;
  for (const [category, pattern] of CATEGORY_RULES) {
    const score = lowered.filter((label) => pattern.test(label)).length;
    if (score > bestScore) {
      best = category;
      bestScore = score;
    }
  }
  return best;
}

// -------------------------------------------------------------------- Kalshi

/**
 * Probabilidade implícita do "sim": ponto médio quando o spread é estreito,
 * senão o último negócio. É a mesma regra que a Polymarket usa no preço que
 * publica, o que deixa as duas colunas comparáveis.
 */
export function kalshiProbability(market) {
  const bid = num(market.yes_bid_dollars);
  const ask = num(market.yes_ask_dollars);
  const last = num(market.last_price_dollars);
  const twoSided = bid !== null && ask !== null && bid > 0 && ask > 0 && ask <= 1 && ask >= bid;
  if (twoSided && ask - bid <= TIGHT_SPREAD) return (bid + ask) / 2;
  if (last !== null && last > 0) return last;
  if (twoSided) return (bid + ask) / 2;
  return null;
}

function ageInDays(iso, nowMs) {
  const opened = Date.parse(iso ?? '');
  return Number.isFinite(opened) ? Math.max(0, (nowMs - opened) / (DAY_SECONDS * 1000)) : null;
}

export function normalizeKalshiEvent(event, nowMs = Date.now()) {
  const markets = Array.isArray(event.markets) ? event.markets : [];
  // Só os mercados ainda abertos viram resultados exibidos.
  const live = markets.filter((m) => !m.status || m.status === 'active');

  const outcomes = live.map((m) => {
    const last = num(m.last_price_dollars);
    const previous = num(m.previous_price_dollars);
    const change = last !== null && previous !== null && last > 0 && previous > 0 ? last - previous : null;
    return {
      label: cleanText(m.yes_sub_title) || cleanText(m.title) || 'Yes',
      prob: round(kalshiProbability(m), 4),
      change_24h: round(change, 4),
      volume_24h: round(num(m.volume_24h_fp) ?? 0, 0),
    };
  });

  const closeTimes = live.map((m) => m.close_time).filter(Boolean).sort();
  const series = cleanText(event.series_ticker);
  const sourceCategory = cleanText(event.category);

  return {
    id: cleanText(event.event_ticker),
    title: cleanText(event.title),
    subtitle: cleanText(event.sub_title),
    category: unifiedCategory([sourceCategory]),
    source_category: sourceCategory,
    tags: [],
    url: series ? `https://kalshi.com/markets/${encodeURIComponent(series.toLowerCase())}` : null,
    open_interest: round(sum(markets.map((m) => num(m.open_interest_fp))), 0),
    liquidity: null,
    closes_at: closeTimes.at(-1) ?? null,
    n_outcomes: outcomes.length,
    ...storedOutcomes(outcomes, event.mutually_exclusive !== false),
    // Uso interno, para calcular o volume de cada janela; não vai para o arquivo.
    _series: series,
    _markets: markets
      .map((m) => ({
        ticker: cleanText(m.ticker),
        total: num(m.volume_fp) ?? 0,
        day: num(m.volume_24h_fp) ?? 0,
        age: ageInDays(m.open_time ?? m.created_time, nowMs),
      }))
      .filter((m) => m.total > 0 || m.day > 0),
  };
}

/** Soma os candles diários que caem na janela; o mais antigo entra na proporção em que se sobrepõe. */
export function sumCandles(candles, windowStartSec) {
  let total = 0;
  for (const candle of candles) {
    if (candle.end <= windowStartSec) continue;
    const overlap = Math.min(1, (candle.end - windowStartSec) / DAY_SECONDS);
    total += candle.volume * overlap;
  }
  return total;
}

/**
 * A API da Kalshi só publica o volume de 24 horas e o total desde a abertura.
 * Para as outras janelas:
 *  - mercado aberto há menos tempo que a janela: o volume da janela é o total (exato);
 *  - mercado mais antigo com candles diários consultados: soma dos candles (exato);
 *  - mercado mais antigo sem candles: semana e mês ficam no piso conhecido (limite
 *    'min', o valor real é maior ou igual) e ano fica no total (limite 'max').
 * `candles` é um Map ticker -> [{ end, volume }], ou null se o evento não foi consultado.
 */
export function resolveKalshiVolumes(record, candles, candleRangeDays, nowSec) {
  const volume = { day: 0, week: 0, month: 0, year: 0, total: 0 };
  const bounds = {};

  for (const market of record._markets) {
    volume.day += market.day;
    volume.total += market.total;
    let floor = market.day;
    for (const [window, days] of Object.entries(WINDOW_DAYS)) {
      let value;
      if (market.age !== null && market.age <= days) {
        value = market.total;
      } else if (candles && candleRangeDays >= days) {
        const fromCandles = sumCandles(candles.get(market.ticker) ?? [], nowSec - days * DAY_SECONDS);
        value = Math.min(market.total, Math.max(floor, fromCandles));
      } else if (window === 'year') {
        value = market.total;
        bounds.year = 'max';
      } else {
        value = floor;
        bounds[window] = 'min';
      }
      volume[window] += value;
      floor = value; // semana <= mês <= ano
    }
  }

  for (const key of Object.keys(volume)) volume[key] = round(volume[key], 0);
  return { volume, bounds };
}

async function fetchEventCandles(record, rangeDays, nowSec) {
  const byTicker = new Map();
  const endSec = nowSec;
  let fromSec = nowSec - rangeDays * DAY_SECONDS;
  // A API encurta o intervalo quando há candles demais; continua de onde ela parou.
  for (let step = 0; step < 8; step++) {
    const url = new URL(
      `${KALSHI_BASE}/series/${encodeURIComponent(record._series)}/events/${encodeURIComponent(record.id)}/candlesticks`,
    );
    url.searchParams.set('start_ts', String(fromSec));
    url.searchParams.set('end_ts', String(endSec));
    url.searchParams.set('period_interval', '1440');
    const page = await fetchJson(url, { retries: 2 });

    const tickers = Array.isArray(page.market_tickers) ? page.market_tickers : [];
    const lists = Array.isArray(page.market_candlesticks) ? page.market_candlesticks : [];
    tickers.forEach((ticker, i) => {
      const known = byTicker.get(ticker) ?? new Map();
      for (const candle of Array.isArray(lists[i]) ? lists[i] : []) {
        const end = num(candle.end_period_ts);
        if (end !== null) known.set(end, num(candle.volume_fp) ?? num(candle.volume) ?? 0);
      }
      byTicker.set(ticker, known);
    });

    const adjusted = num(page.adjusted_end_ts);
    if (adjusted === null || adjusted >= endSec || adjusted <= fromSec) break;
    fromSec = adjusted;
  }
  return new Map([...byTicker].map(([ticker, known]) => [ticker, [...known].map(([end, volume]) => ({ end, volume }))]));
}

function topIds(records, valueOf, overall, perCategory) {
  const sorted = records.slice().sort((a, b) => valueOf(b) - valueOf(a));
  const ids = new Set(sorted.slice(0, overall).map((r) => r.id));
  const seen = {};
  for (const record of sorted) {
    seen[record.category] = (seen[record.category] ?? 0) + 1;
    if (seen[record.category] <= perCategory) ids.add(record.id);
  }
  return ids;
}

async function collectKalshi() {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const records = [];
  let cursor = '';
  let pages = 0;
  let scanned = 0;

  do {
    const url = new URL(`${KALSHI_BASE}/events`);
    url.searchParams.set('status', 'open');
    url.searchParams.set('with_nested_markets', 'true');
    url.searchParams.set('limit', '200');
    if (cursor) url.searchParams.set('cursor', cursor);

    const page = await fetchJson(url);
    const events = Array.isArray(page.events) ? page.events : [];
    scanned += events.length;
    for (const event of events) {
      const record = normalizeKalshiEvent(event, nowMs);
      if (record.id && record._markets.length) records.push(record);
    }

    cursor = typeof page.cursor === 'string' ? page.cursor : '';
    pages += 1;
    if (!events.length) break;
    if (cursor) await sleep(PAUSE_MS);
  } while (cursor && pages < KALSHI_MAX_PAGES);

  // Primeiro passo sem candles: já resolve tudo que abriu há pouco tempo.
  for (const record of records) Object.assign(record, resolveKalshiVolumes(record, null, 0, nowSec));

  // Candles só para quem pode aparecer em algum ranking e ainda tem janela em aberto.
  const pool = new Set([
    ...topIds(records, (r) => r.volume.total, TOP_N * 2, TOP_PER_CATEGORY * 2),
    ...topIds(records, (r) => r.volume.day, TOP_N, TOP_PER_CATEGORY),
  ]);
  const candidates = records
    .filter((r) => pool.has(r.id) && r._series && Object.keys(r.bounds).length)
    .sort((a, b) => b.volume.total - a.volume.total)
    .slice(0, KALSHI_CANDLE_EVENTS);

  const candleStats = { requested: candidates.length, ok: 0, failed: 0, error: null };
  let streak = 0;
  for (const record of candidates) {
    const rangeDays = record._markets.some((m) => m.age !== null && m.age > WINDOW_DAYS.year) ? WINDOW_DAYS.year : WINDOW_DAYS.month;
    try {
      const candles = await fetchEventCandles(record, rangeDays, nowSec);
      Object.assign(record, resolveKalshiVolumes(record, candles, rangeDays, nowSec));
      candleStats.ok += 1;
      streak = 0;
    } catch (err) {
      candleStats.failed += 1;
      candleStats.error = String(err?.message ?? err).slice(0, 200);
      streak += 1;
      if (streak >= 3) {
        console.log(`  Kalshi: candles indisponíveis (${candleStats.error}); semana e mês ficam como piso nos mercados antigos.`);
        break;
      }
    }
    await sleep(PAUSE_MS);
  }

  return {
    volume_unit: 'contracts',
    source: `${KALSHI_BASE}/events`,
    scanned_events: scanned,
    truncated: Boolean(cursor), // true se o limite de páginas cortou a varredura
    candles: candleStats,
    ...buildRankings(records),
  };
}

// ---------------------------------------------------------------- Polymarket

const POLY_VOLUME_FIELD = { day: 'volume24hr', week: 'volume1wk', month: 'volume1mo', year: 'volume1yr' };

export function normalizePolymarketEvent(event) {
  const active = (Array.isArray(event.markets) ? event.markets : []).filter(
    (m) => m.active !== false && m.closed !== true && m.archived !== true,
  );
  // Num jogo, o evento traz dezenas de linhas (handicap, total de pontos). Vale o vencedor.
  const moneyline = active.filter((m) => cleanText(m.sportsMarketType).toLowerCase() === 'moneyline');
  const markets = moneyline.length ? moneyline : active;
  const exclusive = moneyline.length > 0 || event.negRisk === true || markets.length === 1;

  let outcomes = [];
  if (markets.length === 1) {
    // Um mercado só: Sim/Não vira uma linha; outros pares (Time A x Time B) viram uma linha por lado.
    const market = markets[0];
    const labels = parseList(market.outcomes).map(cleanText);
    const prices = parseList(market.outcomePrices).map(num);
    const change = num(market.oneDayPriceChange);
    const volume = round(num(market.volume24hr) ?? num(event.volume24hr) ?? 0, 0);
    const isYesNo = labels.length === 2 && labels[0].toLowerCase() === 'yes' && labels[1].toLowerCase() === 'no';
    if (isYesNo || labels.length === 0) {
      outcomes = [{ label: 'Yes', prob: round(prices[0] ?? null, 4), change_24h: round(change, 4), volume_24h: volume }];
    } else {
      outcomes = labels.map((label, i) => ({
        label: label || `Resultado ${i + 1}`,
        prob: round(prices[i] ?? null, 4),
        // A variação publicada vale para o primeiro lado; num par, o outro é o espelho.
        change_24h: round(i === 0 ? change : labels.length === 2 && change !== null ? -change : null, 4),
        volume_24h: volume,
      }));
    }
  } else {
    // Vários mercados: cada um é um resultado do evento, e o preço é o do "sim".
    outcomes = markets.map((market) => ({
      label: cleanText(market.groupItemTitle) || cleanText(market.question) || 'Yes',
      prob: round(num(parseList(market.outcomePrices)[0]), 4),
      change_24h: round(num(market.oneDayPriceChange), 4),
      volume_24h: round(num(market.volume24hr) ?? 0, 0),
    }));
  }

  const tags = (Array.isArray(event.tags) ? event.tags : []).map((tag) => cleanText(tag?.label)).filter(Boolean);
  const slug = cleanText(event.slug);

  // Valores como a API publica, usados para conferir a ordenação.
  const raw = Object.fromEntries(WINDOWS.map((w) => [w, num(event[POLY_VOLUME_FIELD[w]]) ?? 0]));
  const total = num(event.volume) ?? 0;
  const week = Math.max(raw.week, raw.day);
  const month = Math.max(raw.month, week);
  const year = Math.max(raw.year, month);

  return {
    id: String(event.id ?? slug),
    title: cleanText(event.title),
    subtitle: '',
    category: unifiedCategory([...tags, cleanText(event.category), cleanText(event.title)]),
    source_category: tags[0] ?? '',
    tags: tags.slice(0, 4),
    url: slug ? `https://polymarket.com/event/${encodeURIComponent(slug)}` : null,
    volume: {
      day: round(raw.day, 0),
      week: round(week, 0),
      month: round(month, 0),
      year: round(year, 0),
      total: round(Math.max(total, year), 0),
    },
    bounds: {},
    open_interest: round(num(event.openInterest), 0),
    liquidity: round(num(event.liquidity), 0),
    closes_at: event.endDate ?? null,
    n_outcomes: outcomes.length,
    ...storedOutcomes(outcomes, exclusive),
    _raw: raw,
  };
}

function polymarketUrl(pathname, { order, limit }) {
  const url = new URL(`${GAMMA_BASE}${pathname}`);
  url.searchParams.set('active', 'true');
  url.searchParams.set('closed', 'false');
  url.searchParams.set('archived', 'false');
  url.searchParams.set('limit', String(limit));
  if (order) {
    url.searchParams.set('order', order);
    url.searchParams.set('ascending', 'false');
  }
  return url;
}

/**
 * Percorre a listagem de eventos ativos, página a página, chamando `onPage`
 * (que devolve false para parar). Usa a paginação por cursor; se ela não
 * responder logo na primeira página, usa a antiga, por offset, que a API
 * limita a poucos milhares de eventos. `complete` diz se a listagem chegou ao fim.
 */
async function eachPolymarketPage({ order, maxPages }, onPage) {
  const limit = 100;
  let paging = 'cursor';
  let cursor = '';
  for (let page = 0; page < maxPages; page++) {
    let events;
    let hasMore;
    if (paging === 'cursor') {
      try {
        const url = polymarketUrl('/events/keyset', { order, limit });
        if (cursor) url.searchParams.set('after_cursor', cursor);
        const body = await fetchJson(url);
        if (!Array.isArray(body?.events)) throw new Error('formato inesperado em /events/keyset');
        events = body.events;
        cursor = typeof body.next_cursor === 'string' ? body.next_cursor : '';
        hasMore = Boolean(cursor);
      } catch (err) {
        if (page > 0) throw err; // no meio da listagem não dá para trocar de método
        paging = 'offset';
      }
    }
    if (paging === 'offset') {
      const url = polymarketUrl('/events', { order, limit });
      url.searchParams.set('offset', String(page * limit));
      try {
        const body = await fetchJson(url);
        if (!Array.isArray(body)) throw new Error('formato inesperado em /events');
        events = body;
        hasMore = body.length === limit;
      } catch (err) {
        // Limite de profundidade da API: fica com o que já veio.
        if (page > 0 && /offset too large/i.test(err.message)) return { paging, complete: false };
        throw err;
      }
    }
    const wantsMore = onPage(events) !== false;
    if (!hasMore) return { paging, complete: true };
    if (!wantsMore) return { paging, complete: false };
    await sleep(PAUSE_MS);
  }
  return { paging, complete: false };
}

/**
 * Confere se a API realmente ordenou pelo volume da janela (ela ignora campos
 * que não conhece). Os volumes mudam enquanto as páginas são lidas, então
 * alguma troca entre vizinhos é normal; uma lista que ignorou a ordenação tem
 * perto de metade dos pares invertidos.
 */
export function isSortedByVolume(records, window) {
  if (!records.length || !(records[0]._raw[window] > 0)) return false;
  let inversions = 0;
  for (let i = 1; i < records.length; i++) {
    if (records[i]._raw[window] > records[i - 1]._raw[window] * 1.001 + 1) inversions += 1;
  }
  const allowed = records.length < 20 ? 0 : Math.floor(records.length * 0.1);
  return inversions <= allowed;
}

/** Caminho rápido: a API devolve os eventos já ordenados e bastam poucas páginas por janela. */
async function polymarketSorted(order, window) {
  const seen = new Set();
  const kept = [];
  const maxPages = Math.ceil(POLY_DEPTH / 100) + 5;
  const { paging } = await eachPolymarketPage({ order, maxPages }, (events) => {
    let added = 0;
    for (const event of events) {
      const record = normalizePolymarketEvent(event);
      if (!record.id || seen.has(record.id)) continue;
      seen.add(record.id);
      if (record._raw[window] > 0) {
        kept.push(record); // nulos podem vir na frente
        added += 1;
      }
    }
    // Para ao atingir a profundidade pedida ou ao entrar na cauda sem volume.
    return kept.length < POLY_DEPTH && !(added === 0 && kept.length > 0);
  });
  return { kept, paging };
}

/** Caminho lento: varre todos os eventos ativos e ordena aqui. */
async function polymarketScan() {
  const seen = new Set();
  const kept = [];
  let scanned = 0;
  const { paging, complete } = await eachPolymarketPage({ order: null, maxPages: POLY_SCAN_MAX_PAGES }, (events) => {
    scanned += events.length;
    for (const event of events) {
      const record = normalizePolymarketEvent(event);
      if (!record.id || seen.has(record.id)) continue;
      seen.add(record.id);
      if (record.volume.total > 0) kept.push(record);
    }
    return true;
  });
  return { kept, scanned, truncated: !complete, paging };
}

async function collectPolymarket() {
  const base = { volume_unit: 'usd', source: `${GAMMA_BASE}/events` };
  const byId = new Map();
  const sortMode = {};
  const notes = [];
  let paging = null;

  for (const window of WINDOWS) {
    const field = POLY_VOLUME_FIELD[window];
    // A documentação oficial e os clientes divergem na grafia do campo; tenta as duas.
    const spellings = [field, field.replace(/^volume/, 'volume_')];
    for (const order of spellings) {
      try {
        const sorted = await polymarketSorted(order, window);
        if (isSortedByVolume(sorted.kept, window)) {
          for (const record of sorted.kept) byId.set(record.id, record);
          sortMode[window] = `api:${order}`;
          paging = sorted.paging;
          break;
        }
        notes.push(`order=${order} veio fora de ordem`);
      } catch (err) {
        notes.push(`order=${order} falhou (${err.message})`);
      }
    }
    if (!sortMode[window]) break;
  }

  if (WINDOWS.every((window) => sortMode[window])) {
    return { ...base, sort_mode: sortMode, paging, truncated: false, ...buildRankings([...byId.values()]) };
  }

  console.log(`  Polymarket: ordenação pela API indisponível (${notes.join('; ')}); varrendo tudo.`);
  const scan = await polymarketScan();
  return { ...base, sort_mode: 'varredura', paging: scan.paging, scanned_events: scan.scanned, truncated: scan.truncated, ...buildRankings(scan.kept) };
}

// ------------------------------------------------------------------- saída

/**
 * Resultados mostrados por evento. Quando só um pode acontecer, valem os mais
 * prováveis. Quando são independentes (faixas de preço, datas, linhas de aposta),
 * os mais prováveis são quase certos e dizem pouco: valem os mais próximos de 50%.
 */
export function pickOutcomes(outcomes, exclusive) {
  const byProb = (a, b) => (b.prob ?? -1) - (a.prob ?? -1) || b.volume_24h - a.volume_24h;
  if (exclusive || outcomes.length <= OUTCOMES_KEPT) return outcomes.slice().sort(byProb).slice(0, OUTCOMES_KEPT);
  const distance = (o) => (o.prob === null ? Infinity : Math.abs(o.prob - 0.5));
  return outcomes
    .slice()
    .sort((a, b) => distance(a) - distance(b) || b.volume_24h - a.volume_24h)
    .slice(0, OUTCOMES_KEPT)
    .sort(byProb);
}

/**
 * O que vai para o arquivo: `outcomes` são os mostrados de início e `more` são
 * os demais, até o teto, em forma compacta: [rótulo, probabilidade, variação em 24h].
 */
export function storedOutcomes(outcomes, exclusive) {
  const picked = pickOutcomes(outcomes, exclusive);
  const shown = new Set(picked);
  const room = Math.max(0, OUTCOMES_STORED - picked.length);
  const byProb = (a, b) => (b.prob ?? -1) - (a.prob ?? -1) || b.volume_24h - a.volume_24h;
  const distance = (o) => (o.prob === null ? Infinity : Math.abs(o.prob - 0.5));
  let rest = outcomes.filter((o) => !shown.has(o));
  rest = exclusive
    ? rest.sort(byProb).slice(0, room)
    : rest.sort((a, b) => distance(a) - distance(b) || b.volume_24h - a.volume_24h).slice(0, room).sort(byProb);
  return { outcomes: picked, more: rest.map((o) => [o.label, o.prob, o.change_24h]) };
}

/**
 * Para cada janela, o ranking geral e um por categoria, como listas de ids.
 * Os eventos citados em algum ranking são guardados uma vez só, em `events`.
 */
export function buildRankings(records) {
  const rankings = {};
  const used = new Set();
  for (const window of WINDOWS) {
    const sorted = records.filter((r) => r.volume[window] > 0).sort((a, b) => b.volume[window] - a.volume[window]);
    const lists = { all: sorted.slice(0, TOP_N).map((r) => r.id) };
    for (const category of CATEGORIES) {
      lists[category] = sorted
        .filter((r) => r.category === category)
        .slice(0, TOP_PER_CATEGORY)
        .map((r) => r.id);
    }
    rankings[window] = lists;
    for (const ids of Object.values(lists)) for (const id of ids) used.add(id);
  }

  const events = {};
  for (const record of records) {
    if (!used.has(record.id)) continue;
    events[record.id] = Object.fromEntries(Object.entries(record).filter(([key]) => !key.startsWith('_')));
  }
  return { events, rankings };
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Resumo do dia: os maiores de cada janela, sem repetir, com volume e probabilidades. */
function historyEntry(venue) {
  const ids = new Set();
  for (const window of WINDOWS) {
    for (const id of (venue.rankings?.[window]?.all ?? []).slice(0, HISTORY_TOP)) ids.add(id);
  }
  return [...ids].map((id) => {
    const e = venue.events[id];
    return { id, title: e.title, volume: e.volume, outcomes: e.outcomes.map((o) => [o.label, o.prob]) };
  });
}

export async function main() {
  const latestFile = path.join(OUT_DIR, 'latest.json');
  const previous = await readJson(latestFile);
  const venues = {};
  const failed = [];

  for (const [key, name, collect] of [
    ['kalshi', 'Kalshi', collectKalshi],
    ['polymarket', 'Polymarket', collectPolymarket],
  ]) {
    console.log(`${name}: coletando…`);
    try {
      const result = await collect();
      const topDay = result.rankings.day.all;
      if (!topDay.length) throw new Error('a API respondeu, mas nenhum evento com volume em 24h apareceu');
      venues[key] = { ok: true, error: null, fetched_at: new Date().toISOString(), ...result };
      const top = result.events[topDay[0]];
      console.log(`  ${Object.keys(result.events).length} eventos guardados; maior do dia: "${top.title}" (${top.volume.day.toLocaleString('pt-BR')})`);
      if (result.candles) {
        const { ok, requested, failed: missed, error } = result.candles;
        console.log(`  candles: ${ok} de ${requested} eventos consultados${missed ? `; ${missed} falharam (último erro: ${error})` : ''}`);
      }
      if (result.truncated) console.log('  Aviso: a varredura bateu no limite de páginas e pode estar incompleta.');
    } catch (err) {
      failed.push(key);
      const message = String(err?.message ?? err).slice(0, 300);
      console.error(`  FALHOU: ${message}`);
      // Mantém o último dado bom dessa plataforma em vez de apagar a coluna.
      const old = previous?.schema === 2 ? previous.venues?.[key] : null;
      venues[key] = { ...(old ?? { fetched_at: null, events: {}, rankings: {} }), ok: false, error: message };
    }
  }

  const generatedAt = new Date().toISOString();
  const output = {
    schema: 2,
    generated_at: generatedAt,
    windows: WINDOWS,
    categories: CATEGORIES,
    top_n: TOP_N,
    top_per_category: TOP_PER_CATEGORY,
    venues,
  };

  await mkdir(path.join(OUT_DIR, 'history'), { recursive: true });
  await writeFile(latestFile, `${JSON.stringify(output)}\n`);

  // Resumo do dia, só com as plataformas que responderam nesta coleta.
  const fresh = Object.fromEntries(
    Object.entries(venues)
      .filter(([, venue]) => venue.ok)
      .map(([key, venue]) => [key, historyEntry(venue)]),
  );
  if (Object.keys(fresh).length) {
    const day = generatedAt.slice(0, 10);
    await writeFile(
      path.join(OUT_DIR, 'history', `${day}.json`),
      `${JSON.stringify({ schema: 2, generated_at: generatedAt, venues: fresh })}\n`,
    );
  }

  console.log(`Gravado em ${latestFile}.`);
  if (failed.length) {
    console.error(`Coleta incompleta: ${failed.join(', ')}.`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
