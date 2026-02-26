const POLY_BASE = "https://gamma-api.polymarket.com/events";
const CHAIN_ENDPOINTS = {
  polygon: "https://api.studio.thegraph.com/query/1057/polygon-managed-optimistic-oracle-v2/1.2.0",
  amoy: "https://api.goldsky.com/api/public/project_clus2fndawbcc01w31192938i/subgraphs/amoy-managed-optimistic-oracle-v2/1.1.0/gn",
};
const DEFAULT_CHAIN = "polygon";
const PER_MARKET_LIMIT = 5;
const DEFAULT_BATCH_SIZE = 8;

const inputEl = document.querySelector("#input-value");
const includeClosedEl = document.querySelector("#include-closed");
const includeProposedEl = document.querySelector("#include-proposed");
const batchSizeEl = document.querySelector("#batch-size");
const themeToggleEl = document.querySelector("#theme-toggle");
const fetchBtn = document.querySelector("#fetch-btn");
const statusEl = document.querySelector("#status-text");
const resultsEl = document.querySelector("#results");

const textEncoder = new TextEncoder();
const PROXY_BUILDERS = [
  (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
];
const THEME_STORAGE_KEY = "uma-link-viewer-theme";
const THEMES = { LIGHT: "light", DARK: "dark" };
let currentTheme = THEMES.LIGHT;

async function requestWithFallback(url, options = {}, enableProxy = true) {
  const attempts = [url];
  if (enableProxy) {
    PROXY_BUILDERS.forEach((builder) => attempts.push(builder(url)));
  }
  let lastError;
  for (const target of attempts) {
    try {
      const response = await fetch(target, options);
      if (!response.ok) {
        const message = await response.text();
        lastError = new Error(`Request failed (${response.status}): ${message}`);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("All request attempts failed.");
}

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute("data-theme", theme);
  updateThemeToggle(theme);
}

function updateThemeToggle(theme) {
  if (!themeToggleEl) {
    return;
  }
  const nextTheme = theme === THEMES.DARK ? THEMES.LIGHT : THEMES.DARK;
  const icon = nextTheme === THEMES.DARK ? "🌙" : "☀️";
  const label = nextTheme === THEMES.DARK ? "Switch to dark mode" : "Switch to light mode";
  themeToggleEl.textContent = icon;
  themeToggleEl.setAttribute("aria-label", label);
  themeToggleEl.setAttribute("title", label);
}

function resolveInitialTheme() {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored && (stored === THEMES.LIGHT || stored === THEMES.DARK)) {
      return stored;
    }
  } catch (error) {
    // ignore storage errors and fall back to system preference
  }
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  return prefersDark ? THEMES.DARK : THEMES.LIGHT;
}

function initTheme() {
  const initialTheme = resolveInitialTheme();
  applyTheme(initialTheme);
  if (themeToggleEl) {
    themeToggleEl.addEventListener("click", () => {
      const nextTheme = currentTheme === THEMES.DARK ? THEMES.LIGHT : THEMES.DARK;
      applyTheme(nextTheme);
      try {
        localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
      } catch (error) {
        // storage might be unavailable; ignore
      }
    });
  }
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", Boolean(isError));
}

function parseInput(raw) {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  let slug = trimmed;
  let eventId = null;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const segments = url.pathname.split("/").filter(Boolean);
      slug = segments.pop() || "";
    } catch (error) {
      slug = trimmed;
    }
  }
  if (/^\d+$/.test(slug)) {
    eventId = slug;
    slug = null;
  }
  return { slug, eventId };
}

async function fetchEventDetails(target) {
  if (!target) {
    throw new Error("Enter a slug, URL, or event ID.");
  }
  const attempts = [];
  if (target.slug) {
    attempts.push(`${POLY_BASE}/slug/${encodeURIComponent(target.slug)}`);
  }
  if (target.eventId) {
    attempts.push(`${POLY_BASE}/${encodeURIComponent(target.eventId)}`);
  }
  if (!attempts.length) {
    throw new Error("Unable to determine slug or event id from input.");
  }
  for (const endpoint of attempts) {
    try {
      const response = await requestWithFallback(endpoint);
      const payload = await response.json();
      if (!payload || typeof payload !== "object") {
        continue;
      }
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload;
    } catch (error) {
      if (error?.message?.includes("(404)")) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("Polymarket event not found. Double-check the slug or event ID.");
}

async function fetchEventById(eventId) {
  if (eventId === null || eventId === undefined) {
    return null;
  }
  try {
    const response = await requestWithFallback(`${POLY_BASE}/${encodeURIComponent(eventId)}`);
    const payload = await response.json();
    if (payload && !payload.error) {
      return payload;
    }
  } catch (error) {
    console.warn("Failed to fetch event by id", error);
  }
  return null;
}

async function fetchChildEvents(parentEventId, limit = 50) {
  if (parentEventId === null || parentEventId === undefined) {
    return [];
  }
  const url = `${POLY_BASE}?parent_event_id=${encodeURIComponent(parentEventId)}&limit=${limit}`;
  try {
    const response = await requestWithFallback(url);
    const payload = await response.json();
    if (Array.isArray(payload)) {
      return payload.filter((child) => child && typeof child === "object");
    }
  } catch (error) {
    console.warn("Failed to fetch child events", error);
  }
  return [];
}

async function gatherRelatedEvents(primaryEvent) {
  if (!primaryEvent) {
    return [];
  }
  const seen = new Map();
  const addEvent = (event) => {
    if (!event || event.id === undefined || event.id === null) {
      return;
    }
    const key = String(event.id);
    if (!seen.has(key)) {
      seen.set(key, event);
    }
  };

  addEvent(primaryEvent);
  const rootId = primaryEvent.parentEventId ?? primaryEvent.id ?? null;

  if (primaryEvent.parentEventId) {
    const parentEvent = await fetchEventById(primaryEvent.parentEventId);
    if (parentEvent) {
      addEvent(parentEvent);
    }
  }

  if (rootId !== null && rootId !== undefined) {
    const childEvents = await fetchChildEvents(rootId);
    childEvents.forEach(addEvent);
  }

  return Array.from(seen.values());
}

function isProposedMarket(market) {
  return market?.umaResolutionStatus === "proposed";
}

function collectMarkets(event, includeClosed, includeProposed) {
  const markets = Array.isArray(event?.markets) ? event.markets : [];
  const rows = [];
  for (const market of markets) {
    const closed = Boolean(market?.closed);
    if (!includeClosed && closed) {
      continue;
    }
    const proposed = isProposedMarket(market);
    if (!includeProposed && proposed) {
      continue;
    }
    const id = market?.id ?? market?.market_id;
    if (!id && id !== 0) {
      continue;
    }
    const label = market?.question || market?.groupItemTitle || market?.slug || `Market ${id}`;
    rows.push({
      id: String(id),
      label,
      closed,
      proposed,
      stateLabel: proposed ? "Proposed" : closed ? "Closed" : "Open",
      slug: market?.slug || null,
      umaStatus: market?.umaStatus || market?.umaResolutionStatus || null,
    });
  }
  rows.sort((a, b) => {
    const left = Number(a.id);
    const right = Number(b.id);
    if (Number.isFinite(left) && Number.isFinite(right)) {
      return left - right;
    }
    return a.id.localeCompare(b.id);
  });
  return rows;
}

function chunkIds(ids, size = DEFAULT_BATCH_SIZE) {
  const chunks = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}

function encodeNeedle(marketId) {
  const phrase = `market_id: ${marketId}`;
  const bytes = textEncoder.encode(phrase);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function buildGraphqlPayload(batch) {
  const varDefs = batch.map((_, idx) => `$needle${idx}: String!`).join(", ");
  const fields = batch
    .map(
      (_, idx) =>
        `  m${idx}: optimisticPriceRequests(first: ${PER_MARKET_LIMIT}, orderBy: requestTimestamp, orderDirection: desc, where: { ancillaryData_contains: $needle${idx} }) { id state proposer disputer proposedPrice requestTimestamp proposalTimestamp requestHash requestLogIndex }`,
    )
    .join("\n");
  const variables = {};
  batch.forEach((marketId, idx) => {
    variables[`needle${idx}`] = encodeNeedle(marketId);
  });
  const query = `query(${varDefs}) {\n${fields}\n}`;
  return { query, variables };
}

async function fetchUmaMap(marketIds, chainKey, batchSize = DEFAULT_BATCH_SIZE, onChunk) {
  if (!marketIds.length) {
    return {};
  }
  const endpoint = CHAIN_ENDPOINTS[chainKey] || CHAIN_ENDPOINTS[DEFAULT_CHAIN];
  const results = {};
  for (const batch of chunkIds(marketIds, batchSize)) {
    const payload = buildGraphqlPayload(batch);
    const response = await requestWithFallback(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (data.errors) {
      throw new Error(`UMA GraphQL error: ${JSON.stringify(data.errors)}`);
    }
    const payloadData = data.data || {};
    const batchResults = {};
    batch.forEach((marketId, idx) => {
      const proposals = payloadData[`m${idx}`] || [];
      results[marketId] = proposals;
      batchResults[marketId] = proposals;
    });
    if (typeof onChunk === "function") {
      onChunk(batchResults);
    }
  }
  return results;
}

function formatTimestamp(value) {
  if (!value) {
    return "—";
  }
  const num = Number(value);
  if (Number.isFinite(num)) {
    return new Date(num * 1000).toISOString();
  }
  return String(value);
}

function buildPortalUrl(entry) {
  const txHash = (entry?.requestHash || "").trim();
  const logIndex = (entry?.requestLogIndex || "").trim();
  if (!txHash || !logIndex) {
    return null;
  }
  const state = (entry?.state || "").toLowerCase();
  if (state === "requested") {
    return `https://oracle.uma.xyz/propose?project=Polymarket&transactionHash=${txHash}&eventIndex=${logIndex}&chainId=137`;
  }
  return `https://oracle.uma.xyz/?transactionHash=${txHash}&eventIndex=${logIndex}`;
}

function createPlaceholderEntry(text) {
  const node = document.createElement("p");
  node.className = "uma-entry";
  node.textContent = text;
  return node;
}

function getUmaStateClass(state) {
  const normalized = (state || "").toLowerCase();
  if (normalized === "proposed") {
    return "state-positive";
  }
  if (normalized === "closed"  || normalized === "settled") {
    return "state-warning";
  }
  return "";
}

function createUmaEntryElement(entry) {
  const wrapper = document.createElement("div");
  const state = entry.state || "?";
  const stateClass = getUmaStateClass(state);
  wrapper.className = ["uma-entry", stateClass].filter(Boolean).join(" ");
  const ts = formatTimestamp(entry.proposalTimestamp || entry.requestTimestamp);
  const url = buildPortalUrl(entry);
  wrapper.innerHTML = url
    ? `${state} @ ${ts} — <a href="${url}" target="_blank" rel="noopener">Open UMA portal</a>`
    : `${state} @ ${ts} — (missing tx hash/index)`;
  return wrapper;
}

function renderEventSections(eventCollections) {
  resultsEl.innerHTML = "";
  const rowMap = new Map();
  if (!eventCollections.length) {
    resultsEl.innerHTML = "<p>No markets match the selected filters.</p>";
    return rowMap;
  }

  eventCollections.forEach(({ event, markets }) => {
    const eventCard = document.createElement("article");
    eventCard.className = "result-card";
    const title = event?.title || event?.name || "Polymarket event";
    const subtitle = event?.slug || event?.id;
    eventCard.innerHTML = `
      <h2>${title}</h2>
      <p class="market-meta">${subtitle ? `Slug/ID: ${subtitle}` : ""}</p>
    `;

    const list = document.createElement("div");
    list.className = "market-list";
    markets.forEach((market) => {
      const row = document.createElement("div");
      row.className = "market-row";
      row.innerHTML = `
        <div class="market-header">
          <span>${market.label}</span>
          <span class="market-meta">${market.stateLabel}</span>
        </div>
        <div class="market-meta">Market ID: ${market.id}</div>
      `;
      row.appendChild(createPlaceholderEntry("Loading UMA requests…"));
      list.appendChild(row);
      rowMap.set(market.id, row);
    });

    eventCard.appendChild(list);
    resultsEl.appendChild(eventCard);
  });

  return rowMap;
}

function updateMarketRow(row, proposals) {
  if (!row) {
    return;
  }
  row.querySelectorAll(".uma-entry").forEach((node) => node.remove());
  if (!proposals || !proposals.length) {
    row.appendChild(createPlaceholderEntry("No UMA requests yet."));
    return;
  }
  proposals.forEach((entry) => {
    row.appendChild(createUmaEntryElement(entry));
  });
}

async function handleFetch() {
  const target = parseInput(inputEl.value);
  if (!target) {
    setStatus("Enter a slug, full URL, or numeric event id.", true);
    return;
  }
  fetchBtn.disabled = true;
  resultsEl.innerHTML = "";
  setStatus("Loading Polymarket event…");
  try {
    const event = await fetchEventDetails(target);
    const relatedEvents = await gatherRelatedEvents(event);
    const includeClosed = includeClosedEl.checked;
    const includeProposed = includeProposedEl.checked;
    const batchSizeValue = parseInt(batchSizeEl.value, 10);
    const effectiveBatchSize = Number.isFinite(batchSizeValue) && batchSizeValue > 0 ? batchSizeValue : DEFAULT_BATCH_SIZE;
    const eventCollections = relatedEvents
      .map((evt) => ({ event: evt, markets: collectMarkets(evt, includeClosed, includeProposed) }))
      .filter((collection) => collection.markets.length);

    if (!eventCollections.length) {
      resultsEl.innerHTML = "<p>No markets match the selected filters.</p>";
      setStatus("No markets match the selected filters.");
      return;
    }
    const rowMap = renderEventSections(eventCollections);
    setStatus("Fetching UMA proposals…");
    const marketIds = Array.from(
      new Set(eventCollections.flatMap(({ markets }) => markets.map((market) => market.id))),
    );
    let resolved = 0;
    await fetchUmaMap(marketIds, DEFAULT_CHAIN, effectiveBatchSize, (chunk) => {
      Object.entries(chunk).forEach(([marketId, proposals]) => {
        updateMarketRow(rowMap.get(marketId), proposals);
      });
      resolved += Object.keys(chunk).length;
      setStatus(`Fetched UMA for ${resolved}/${marketIds.length} market(s)…`);
    });
    setStatus(`Found ${marketIds.length} market(s) across ${eventCollections.length} event(s).`);
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Unexpected error", true);
  } finally {
    fetchBtn.disabled = false;
  }
}

fetchBtn.addEventListener("click", handleFetch);
inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    handleFetch();
  }
});

initTheme();
setStatus("Enter a slug to begin.");
