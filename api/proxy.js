const ALLOWED_HOSTS = new Set([
  "gamma-api.polymarket.com",
  "api.studio.thegraph.com",
  "api.goldsky.com",
]);

function getAllowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw) {
    return ["https://stradiveri.github.io"];
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function setCorsHeaders(response, origin) {
  response.setHeader("Access-Control-Allow-Origin", origin || "");
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  response.setHeader("Access-Control-Max-Age", "86400");
}

module.exports = async function handler(request, response) {
  const origin = request.headers.origin || "";
  const allowedOrigins = getAllowedOrigins();
  const originAllowed = !origin || allowedOrigins.includes(origin);

  if (request.method === "OPTIONS") {
    setCorsHeaders(response, originAllowed ? origin : "");
    response.status(204).end();
    return;
  }

  if (!originAllowed) {
    setCorsHeaders(response, "");
    response.status(403).json({ error: "Origin not allowed" });
    return;
  }

  const target = request.query?.url;
  if (!target) {
    setCorsHeaders(response, originAllowed ? origin : "");
    response.status(400).json({ error: "Missing url query param" });
    return;
  }

  let targetUrl;
  try {
    targetUrl = new URL(String(target));
  } catch (error) {
    setCorsHeaders(response, originAllowed ? origin : "");
    response.status(400).json({ error: "Invalid url" });
    return;
  }

  if (!ALLOWED_HOSTS.has(targetUrl.host)) {
    setCorsHeaders(response, originAllowed ? origin : "");
    response.status(403).json({ error: "Host not allowed" });
    return;
  }

  const method = request.method || "GET";
  const headers = {};
  const contentType = request.headers["content-type"];
  if (contentType) {
    headers["content-type"] = contentType;
  }

  let body;
  if (method !== "GET" && method !== "HEAD") {
    if (request.body === undefined || request.body === null) {
      body = undefined;
    } else if (Buffer.isBuffer(request.body) || typeof request.body === "string") {
      body = request.body;
    } else {
      body = JSON.stringify(request.body);
    }
  }

  try {
    const upstream = await fetch(targetUrl.toString(), { method, headers, body });
    const buffer = Buffer.from(await upstream.arrayBuffer());

    setCorsHeaders(response, originAllowed ? origin : "");
    const upstreamContentType = upstream.headers.get("content-type");
    if (upstreamContentType) {
      response.setHeader("Content-Type", upstreamContentType);
    }

    response.status(upstream.status).send(buffer);
  } catch (error) {
    setCorsHeaders(response, originAllowed ? origin : "");
    response.status(502).json({ error: "Upstream request failed" });
  }
};
