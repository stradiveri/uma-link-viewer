const POLY_BASE = "https://gamma-api.polymarket.com/events";
const CHAIN_ENDPOINTS = {
  polygon: "https://api.goldsky.com/api/public/project_clus2fndawbcc01w31192938i/subgraphs/polygon-managed-optimistic-oracle-v2/1.0.4/gn",
  amoy: "https://api.goldsky.com/api/public/project_clus2fndawbcc01w31192938i/subgraphs/amoy-managed-optimistic-oracle-v2/1.1.0/gn",
};
const DEFAULT_CHAIN = "polygon";
const PER_MARKET_LIMIT = 5;
const DEFAULT_BATCH_SIZE = 8;

const inputEl = document.querySelector("#input-value");
const includeClosedEl = document.querySelector("#include-closed");
const includeProposedEl = document.querySelector("#include-proposed");
const batchSizeEl = document.querySelector("#batch-size");
const fetchBtn = document.querySelector("#fetch-btn");
const statusEl = document.querySelector("#status-text");
const resultsEl = document.querySelector("#results");

const textEncoder = new TextEncoder();

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
      const response = await fetch(endpoint);
      if (!response.ok) {
        throw new Error(`Polymarket request failed (${response.status}).`);
      }
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
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`UMA request failed (${response.status}): ${message}`);
    }
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
  if (normalized === "proposed" || normalized === "settled") {
    return "state-positive";
  }
  if (normalized === "closed") {
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

function renderEventShell(event, marketRows) {
  resultsEl.innerHTML = "";
  if (!marketRows.length) {
    resultsEl.innerHTML = "<p>No markets match the selected filters.</p>";
    return new Map();
  }
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
  const rowMap = new Map();
  marketRows.forEach((market) => {
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
    const includeClosed = includeClosedEl.checked;
    const includeProposed = includeProposedEl.checked;
    const batchSizeValue = parseInt(batchSizeEl.value, 10);
    const effectiveBatchSize = Number.isFinite(batchSizeValue) && batchSizeValue > 0 ? batchSizeValue : DEFAULT_BATCH_SIZE;
    const markets = collectMarkets(event, includeClosed, includeProposed);
    if (!markets.length) {
      resultsEl.innerHTML = "<p>No markets match the selected filters.</p>";
      setStatus("No markets match the selected filters.");
      return;
    }
    const rowMap = renderEventShell(event, markets);
    setStatus("Fetching UMA proposals…");
    const marketIds = markets.map((market) => market.id);
    let resolved = 0;
    await fetchUmaMap(marketIds, DEFAULT_CHAIN, effectiveBatchSize, (chunk) => {
      Object.entries(chunk).forEach(([marketId, proposals]) => {
        updateMarketRow(rowMap.get(marketId), proposals);
      });
      resolved += Object.keys(chunk).length;
      setStatus(`Fetched UMA for ${resolved}/${markets.length} market(s)…`);
    });
    setStatus(`Found ${markets.length} market(s).`);
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

setStatus("Enter a slug to begin.");
