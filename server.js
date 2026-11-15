"use strict";

const { readFile } = require("node:fs/promises");
const { createServer } = require("node:http");
const { resolve } = require("node:path");

const HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
const MAX_QUERY_LENGTH = 100;
const MAX_UPSTREAM_BYTES = 10_485_760;
const REQUEST_TIMEOUT_MS = 20_000;
const SERVER_REQUEST_TIMEOUT_MS = 15_000;
const SERVER_HEADERS_TIMEOUT_MS = 10_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 30;
const MAX_RATE_LIMIT_ENTRIES = 1000;
const PROJECT_ROOT = __dirname;
const API_URL = "https://api.restcountries.com/countries/v5";
const BASE_SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};
const ALLOWED_ORIGINS = new Set([
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "http://127.0.0.1:3000",
  "http://localhost:3000",
]);
const HTML_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; connect-src 'self' http://127.0.0.1:3000 http://localhost:3000; frame-ancestors 'none'; object-src 'none'; base-uri 'self'";
const STATIC_FILES = new Map([
  [
    "/",
    {
      file: "index.html",
      contentType: "text/html; charset=utf-8",
      isHtml: true,
    },
  ],
  [
    "/index.html",
    {
      file: "index.html",
      contentType: "text/html; charset=utf-8",
      isHtml: true,
    },
  ],
  [
    "/js/main.js",
    {
      file: "js/main.js",
      contentType: "text/javascript; charset=utf-8",
      isHtml: false,
    },
  ],
  [
    "/style/main.css",
    {
      file: "style/main.css",
      contentType: "text/css; charset=utf-8",
      isHtml: false,
    },
  ],
  [
    "/img/img-1.jpg",
    { file: "img/img-1.jpg", contentType: "image/jpeg", isHtml: false },
  ],
  [
    "/img/img-2.jpg",
    { file: "img/img-2.jpg", contentType: "image/jpeg", isHtml: false },
  ],
]);
const rateLimitStore = new Map();

const port = Number(process.env.PORT || DEFAULT_PORT);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

if (!process.env.RESTCOUNTRIES_API_KEY) {
  console.warn(
    "Warning: RESTCOUNTRIES_API_KEY is not set; /api/countries will return 500.",
  );
}

/**
 * Sends a JSON response with security and no-store cache headers.
 * @param {import("node:http").ServerResponse} response The HTTP response.
 * @param {number} statusCode The response status code.
 * @param {unknown} body The JSON-serializable response body.
 * @param {Record<string, string>} [extraHeaders] Optional additional response headers.
 * @returns {void} Nothing.
 * @throws {Error} If writing the response fails.
 */
function sendJson(response, statusCode, body, extraHeaders = {}) {
  response.writeHead(statusCode, {
    ...BASE_SECURITY_HEADERS,
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

const LOCAL_ORIGIN_PATTERN = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

/**
 * Returns CORS headers when the request Origin is explicitly allowlisted.
 * @param {import("node:http").IncomingMessage} request The incoming request.
 * @returns {Record<string, string>} CORS response headers or an empty object.
 */
function getCorsHeaders(request) {
  const origin = request.headers.origin;
  if (origin && (ALLOWED_ORIGINS.has(origin) || LOCAL_ORIGIN_PATTERN.test(origin))) {
    return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
  }
  return {};
}

/**
 * Parses an origin-relative request target and rejects malformed or host-overriding URLs.
 * @param {string | undefined} rawUrl The raw request.url value.
 * @returns {URL | null} The parsed URL when valid and same-origin, otherwise null.
 */
function parseRequestUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.startsWith("/")) {
    return null;
  }

  try {
    const parsed = new URL(rawUrl, "http://localhost");
    return parsed.origin === "http://localhost" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Enforces a fixed-window per-IP rate limit with bounded memory usage.
 * @param {string} clientIp The socket remote IP address.
 * @param {number} [now] Current timestamp in milliseconds.
 * @returns {boolean} True when the caller has exceeded the rate limit.
 */
function isRateLimited(clientIp, now = Date.now()) {
  const existing = rateLimitStore.get(clientIp);
  if (existing && now < existing.resetAt) {
    if (existing.count >= RATE_LIMIT_MAX_REQUESTS) {
      return true;
    }
    existing.count += 1;
    return false;
  }

  if (rateLimitStore.size >= MAX_RATE_LIMIT_ENTRIES) {
    for (const [key, entry] of rateLimitStore) {
      if (now >= entry.resetAt) {
        rateLimitStore.delete(key);
      }
    }
    if (rateLimitStore.size >= MAX_RATE_LIMIT_ENTRIES) {
      const oldestKey = rateLimitStore.keys().next().value;
      if (oldestKey !== undefined) {
        rateLimitStore.delete(oldestKey);
      }
    }
  }

  rateLimitStore.set(clientIp, {
    count: 1,
    resetAt: now + RATE_LIMIT_WINDOW_MS,
  });
  return false;
}

/**
 * Reads an upstream fetch response body up to a strict byte limit.
 * @param {Response} upstreamResponse The fetch Response object.
 * @param {number} maxBytes Maximum allowed payload size in bytes.
 * @returns {Promise<string>} Decoded UTF-8 response text.
 * @throws {Error} When the response exceeds maxBytes.
 */
async function readBoundedResponseText(upstreamResponse, maxBytes) {
  if (!upstreamResponse.body) {
    return "";
  }

  const reader = upstreamResponse.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error("Upstream response exceeded maximum allowed size.");
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

/**
 * Proxies the country search without exposing the API key to the browser.
 * @param {import("node:http").IncomingMessage} request The incoming request.
 * @param {import("node:http").ServerResponse} response The outgoing response.
 * @param {URL} requestUrl The parsed request URL.
 * @returns {Promise<void>} Resolves after the response is sent.
 * @throws {Error} If response handling fails.
 */
async function handleCountrySearch(request, response, requestUrl) {
  const corsHeaders = getCorsHeaders(request);

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      ...BASE_SECURITY_HEADERS,
      ...corsHeaders,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    });
    response.end();
    return;
  }

  if (request.method !== "GET") {
    return sendJson(
      response,
      405,
      { error: "Method not allowed" },
      { ...corsHeaders, Allow: "GET, OPTIONS" },
    );
  }

  const clientIp = request.socket.remoteAddress || "unknown";
  if (isRateLimited(clientIp)) {
    return sendJson(
      response,
      429,
      { error: "Too many requests" },
      {
        ...corsHeaders,
        "Retry-After": String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)),
      },
    );
  }

  const hasQuery = requestUrl.searchParams.has("q");
  const query = requestUrl.searchParams.get("q")?.trim();
  if (hasQuery && (!query || query.length > MAX_QUERY_LENGTH)) {
    return sendJson(
      response,
      400,
      { error: "A valid q query parameter is required" },
      corsHeaders,
    );
  }

  const apiKey = process.env.RESTCOUNTRIES_API_KEY;
  if (!apiKey) {
    console.error(
      "Country API request aborted: RESTCOUNTRIES_API_KEY is not configured.",
    );
    return sendJson(
      response,
      500,
      { error: "Server configuration error" },
      corsHeaders,
    );
  }

  const upstreamUrl = new URL(API_URL);
  if (query) {
    upstreamUrl.searchParams.set("q", query);
  }

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const contentType = upstreamResponse.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return sendJson(
        response,
        502,
        { error: "Unexpected response from country service" },
        corsHeaders,
      );
    }

    const rawBody = await readBoundedResponseText(
      upstreamResponse,
      MAX_UPSTREAM_BYTES,
    );
    const parsedBody = JSON.parse(rawBody);
    sendJson(response, upstreamResponse.status, parsedBody, corsHeaders);
  } catch (error) {
    console.error("Country API request failed:", error);
    sendJson(
      response,
      502,
      { error: "Country API request failed" },
      corsHeaders,
    );
  }
}

/**
 * Routes a request to the country proxy or an explicitly allowed project file.
 * @param {import("node:http").IncomingMessage} request The incoming request.
 * @param {import("node:http").ServerResponse} response The outgoing response.
 * @returns {Promise<void>} Resolves after the response is sent.
 * @throws {Error} If file or response handling fails.
 */
async function handleRequest(request, response) {
  const requestUrl = parseRequestUrl(request.url || "/");
  if (!requestUrl) {
    return sendJson(response, 400, { error: "Invalid request URL" });
  }

  if (requestUrl.pathname === "/api/countries") {
    return handleCountrySearch(request, response, requestUrl);
  }

  if (request.method !== "GET") {
    return sendJson(
      response,
      405,
      { error: "Method not allowed" },
      { Allow: "GET" },
    );
  }

  const staticFile = STATIC_FILES.get(requestUrl.pathname);
  if (!staticFile) {
    return sendJson(response, 404, { error: "Not found" });
  }

  const body = await readFile(resolve(PROJECT_ROOT, staticFile.file));
  const headers = {
    ...BASE_SECURITY_HEADERS,
    "Content-Type": staticFile.contentType,
  };
  if (staticFile.isHtml) {
    headers["Content-Security-Policy"] = HTML_CSP;
  }

  response.writeHead(200, headers);
  response.end(body);
}

const server = createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error("Request handling failed:", error);
    if (!response.headersSent) {
      sendJson(response, 500, { error: "Internal server error" });
    } else {
      response.destroy();
    }
  });
});

server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS;
server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;

server.listen(port, HOST, () => {
  console.log(`Server listening at http://${HOST}:${port}`);
});
