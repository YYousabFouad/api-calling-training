"use strict";

const btn =
  typeof document !== "undefined"
    ? document.querySelector(".btn-country")
    : null;
const countriesContainer =
  typeof document !== "undefined"
    ? document.querySelector(".countries")
    : null;

// NEW REVERSE GEOCODING API URL (use instead of the URL shown in videos):
// https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}

///////////////////////////////////////

const DEFAULT_COUNTRIES_API_URL = "http://127.0.0.1:3000/api/countries";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_ERROR_BODY_LENGTH = 300;
const VALID_ALPHA3_CODE = /^[A-Z]{3}$/;
const LOCAL_PROXY_ORIGINS = new Set([
  "http://127.0.0.1:3000",
  "http://localhost:3000",
]);

/**
 * Resolves the API proxy endpoint, preferring same-origin when served by server.js.
 * @returns {string} The `/api/countries` endpoint URL.
 */
function resolveCountriesApiUrl() {
  if (
    typeof window !== "undefined" &&
    LOCAL_PROXY_ORIGINS.has(window.location?.origin)
  ) {
    return `${window.location.origin}/api/countries`;
  }

  return DEFAULT_COUNTRIES_API_URL;
}

const COUNTRIES_API_URL = resolveCountriesApiUrl();
const TARGET_COUNTRIES = ["portugal", "argentina"];
const ONE_MILLION = 1_000_000;
const HTML_ENTITIES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escapes HTML special characters to prevent DOM XSS when inserting API strings.
 * @param {unknown} value The raw value to escape.
 * @returns {string} HTML-escaped string.
 */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => HTML_ENTITIES[char]);
}

/**
 * Formats a raw population integer in millions.
 * @param {unknown} population Raw population count.
 * @returns {string} Formatted population text or "N/A".
 */
function formatPopulation(population) {
  if (population === null || population === undefined || population === "") {
    return "N/A";
  }

  const count = Number(population);
  if (!Number.isFinite(count) || count < 0) {
    return "N/A";
  }

  return `${(count / ONE_MILLION).toFixed(1)}M people`;
}

/**
 * Formats a v5 currency entry into a readable label.
 * @param {{ name?: string, symbol?: string } | undefined} currency First currency item.
 * @returns {string} Formatted currency label or "N/A".
 */
function formatCurrency(currency) {
  if (!currency?.name) {
    return "N/A";
  }

  if (!currency.symbol) {
    return currency.name;
  }

  return `${currency.name} (${currency.symbol})`;
}

/**
 * Maps a REST Countries v5 record into card display fields.
 * @param {Record<string, any>} country Raw country object from the API.
 * @returns {{ name: string, region: string, flagUrl: string, flagAlt: string, population: string, language: string, currency: string }} Card view model.
 */
function toCountryViewModel(country) {
  const name = country?.names?.common || "Unknown Country";
  const rawFlagUrl = country?.flag?.url_svg || country?.flag?.url_png || "";
  let flagUrl = "";

  if (rawFlagUrl) {
    try {
      const parsed = new URL(rawFlagUrl);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        flagUrl = parsed.href;
      }
    } catch {
      flagUrl = "";
    }
  }

  return {
    name,
    region: country?.region || "Unknown Region",
    flagUrl,
    flagAlt: country?.flag?.description || `${name} flag`,
    population: formatPopulation(country?.population),
    language: country?.languages?.[0]?.name || "N/A",
    currency: formatCurrency(country?.currencies?.[0]),
  };
}

/**
 * Builds the `<article class="country">` HTML markup from a view model.
 * @param {{ name: string, region: string, flagUrl: string, flagAlt: string, population: string, language: string, currency: string }} viewModel Escaped-ready card data.
 * @param {string} [className] Optional extra CSS modifier class (e.g., "neighbour").
 * @returns {string} HTML string matching the index.html card template.
 */
function createCountryCardHtml(viewModel, className = "") {
  const cardClass = className ? `country ${escapeHtml(className)}` : "country";

  return `
    <article class="${cardClass}">
      <img class="country__img" src="${escapeHtml(viewModel.flagUrl)}" alt="${escapeHtml(viewModel.flagAlt)}" />
      <div class="country__data">
        <h3 class="country__name">${escapeHtml(viewModel.name)}</h3>
        <h4 class="country__region">${escapeHtml(viewModel.region)}</h4>
        <p class="country__row"><span>👫</span>${escapeHtml(viewModel.population)}</p>
        <p class="country__row"><span>🗣️</span>${escapeHtml(viewModel.language)}</p>
        <p class="country__row"><span>💰</span>${escapeHtml(viewModel.currency)}</p>
      </div>
    </article>
  `;
}

/**
 * Extracts the first country record from a REST Countries v5 payload.
 * @param {Record<string, any>} responsePayload Parsed REST Countries v5 payload.
 * @returns {Record<string, any> | null} First country object or null when absent.
 */
function extractFirstCountry(responsePayload) {
  const objects = responsePayload?.data?.objects;
  return Array.isArray(objects) && objects.length > 0 ? objects[0] : null;
}

/**
 * Selects the matching country by common name, falling back to the first record.
 * @param {Record<string, any>} responsePayload Parsed REST Countries v5 payload.
 * @param {string} countryName Target country name to match.
 * @returns {Record<string, any> | null} Selected country object or null when absent.
 */
function selectCountry(responsePayload, countryName) {
  const objects = responsePayload?.data?.objects;
  if (!Array.isArray(objects) || objects.length === 0) {
    return null;
  }

  const normalizedTarget =
    typeof countryName === "string" ? countryName.trim().toLowerCase() : "";
  if (!normalizedTarget) {
    return objects[0];
  }

  return (
    objects.find(
      (item) => item?.names?.common?.toLowerCase() === normalizedTarget,
    ) ?? objects[0]
  );
}

/**
 * Returns the first bordering ISO alpha-3 code for a country, if present.
 * @param {Record<string, any> | null} country Raw country object from the API.
 * @returns {string | null} First border code or null when none exist.
 */
function getFirstNeighbourCode(country) {
  const borders = country?.borders;
  if (!Array.isArray(borders) || borders.length === 0) {
    return null;
  }

  const firstBorder = borders[0];
  if (typeof firstBorder !== "string") {
    return null;
  }

  const normalizedCode = firstBorder.trim().toUpperCase();
  return normalizedCode || null;
}

/**
 * Renders a country card into the target DOM container.
 * @param {Record<string, any> | null} country Country record to render.
 * @param {{ className?: string, container?: Element | null }} [options] Rendering options.
 * @returns {void} Nothing.
 */
function renderCountryCard(
  country,
  { className = "", container = countriesContainer } = {},
) {
  if (!container || !country) {
    return;
  }

  const html = createCountryCardHtml(toCountryViewModel(country), className);
  container.insertAdjacentHTML("beforeend", html);
  container.style.opacity = "1";
}

/**
 * Represents a non-2xx HTTP response returned by an upstream fetch call.
 */
class HttpError extends Error {
  /**
   * @param {string} message Human-readable error summary.
   * @param {{ status: number, statusText?: string, url?: string, body?: string }} details HTTP failure metadata.
   */
  constructor(message, { status, statusText = "", url = "", body = "" }) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.statusText = statusText;
    this.url = url;
    this.body = body;
  }
}

/**
 * Builds a countries proxy endpoint URL with validated query parameters.
 * @param {Record<string, string>} params Query parameters to attach.
 * @param {string} [baseUrl] Base `/api/countries` endpoint URL.
 * @returns {string} Serialized request URL.
 */
function buildCountriesApiUrl(params, baseUrl = COUNTRIES_API_URL) {
  const url = new URL(baseUrl);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
}

/**
 * Creates a TimeoutError matching standard AbortSignal.timeout() semantics.
 * @param {number} timeoutMs Timeout threshold in milliseconds.
 * @returns {Error} Error instance with `name === "TimeoutError"`.
 */
function createTimeoutError(timeoutMs) {
  const error = new Error(`Request timed out after ${timeoutMs}ms.`);
  error.name = "TimeoutError";
  return error;
}

/**
 * Creates an AbortSignal combining an optional caller signal with a request timeout.
 * @param {number} [timeoutMs] Timeout in milliseconds; non-positive or non-finite disables timeout.
 * @param {AbortSignal} [externalSignal] Optional caller-provided abort signal.
 * @returns {{ signal: AbortSignal, cleanup: () => void }} Combined signal and timer/listener cleanup callback.
 */
function createRequestSignal(
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  externalSignal,
) {
  const controller = new AbortController();
  let timeoutId = null;
  let onExternalAbort = null;

  const cleanup = () => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (externalSignal && onExternalAbort) {
      externalSignal.removeEventListener("abort", onExternalAbort);
      onExternalAbort = null;
    }
  };

  const abortWithExternalReason = () => {
    cleanup();
    if (
      externalSignal &&
      "reason" in externalSignal &&
      externalSignal.reason !== undefined
    ) {
      controller.abort(externalSignal.reason);
      return;
    }
    controller.abort();
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      abortWithExternalReason();
      return { signal: controller.signal, cleanup };
    }
    onExternalAbort = abortWithExternalReason;
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      cleanup();
      controller.abort(createTimeoutError(timeoutMs));
    }, timeoutMs);
  }

  return { signal: controller.signal, cleanup };
}

/**
 * Rethrows an abort or timeout error instead of wrapping it as a network or parse failure.
 * @param {AbortSignal | undefined} signal Active request abort signal.
 * @param {unknown} [error] Caught error, if any.
 * @returns {void} Nothing.
 */
function rethrowIfAborted(signal, error) {
  if (signal?.aborted && signal.reason instanceof Error) {
    throw signal.reason;
  }
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    throw error;
  }
}

/**
 * Extracts a concise error detail string from an HTTP error response body.
 * @param {Response} response Fetch Response object with non-2xx status.
 * @returns {Promise<string>} Bounded error detail message or statusText fallback.
 */
async function readErrorMessage(response) {
  const fallback = response?.statusText || "";
  if (typeof response?.text !== "function") {
    return fallback;
  }

  try {
    const rawText = await response.text();
    const trimmed = rawText.trim();
    if (!trimmed) {
      return fallback;
    }

    let detail = "";
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed?.error === "string") {
        detail = parsed.error.trim();
      } else if (typeof parsed?.message === "string") {
        detail = parsed.message.trim();
      }
    } catch {
      // Non-JSON error bodies fall through to bounded plain-text truncation.
    }

    const messageText = detail || trimmed;
    return messageText.length > MAX_ERROR_BODY_LENGTH
      ? `${messageText.slice(0, MAX_ERROR_BODY_LENGTH - 3)}...`
      : messageText;
  } catch {
    return fallback;
  }
}

/**
 * Validates HTTP status and parses a Fetch Response body as JSON.
 * @param {Response} response Fetch Response object.
 * @param {{ url?: string, signal?: AbortSignal }} [options] Request context for error reporting.
 * @returns {Promise<any>} Resolves with parsed JSON or rejects with HttpError, abort, or parse error.
 */
async function parseJsonResponse(
  response,
  { url = response?.url || "", signal } = {},
) {
  if (!response?.ok) {
    const detail = await readErrorMessage(response);
    rethrowIfAborted(signal);
    const suffix = detail ? `: ${detail}` : "";
    throw new HttpError(
      `Request failed with status ${response.status}${suffix}`,
      {
        status: response.status,
        statusText: response.statusText || "",
        url,
        body: detail,
      },
    );
  }

  try {
    return await response.json();
  } catch (error) {
    rethrowIfAborted(signal, error);
    throw new Error("Failed to parse JSON response.", { cause: error });
  }
}

/**
 * Fetches JSON from a URL using the Fetch API with async/await, timeout, and abort support.
 * @param {string} url Request endpoint URL.
 * @param {{ signal?: AbortSignal, timeoutMs?: number, headers?: Record<string, string>, fetcher?: typeof fetch }} [options] Request options.
 * @returns {Promise<any>} Resolves with parsed JSON or rejects on HTTP, timeout, abort, network, or parse failure.
 */
async function fetchJson(url, options = {}) {
  const {
    signal: externalSignal,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    headers = {},
    fetcher = globalThis.fetch,
  } = options;

  if (typeof fetcher !== "function") {
    throw new Error("Fetch API is not available in this environment.");
  }

  const { signal, cleanup } = createRequestSignal(timeoutMs, externalSignal);

  try {
    let response;
    try {
      response = await fetcher(url, {
        method: "GET",
        headers: { Accept: "application/json", ...headers },
        signal,
      });
    } catch (error) {
      rethrowIfAborted(signal, error);
      throw new Error(`Network request failed for ${url}.`, { cause: error });
    }

    return await parseJsonResponse(response, { url, signal });
  } finally {
    cleanup();
  }
}

/**
 * Fetches a single country record by common name.
 * @param {string} countryName Country name to search.
 * @param {{ apiUrl?: string, signal?: AbortSignal, timeoutMs?: number, headers?: Record<string, string>, fetcher?: typeof fetch }} [options] Request options.
 * @returns {Promise<Record<string, any>>} Resolves with the matched country object.
 */
async function fetchCountryByName(countryName, options = {}) {
  const normalizedName =
    typeof countryName === "string" ? countryName.trim() : "";
  if (!normalizedName) {
    throw new TypeError("Country name must be a non-empty string.");
  }

  const { apiUrl = COUNTRIES_API_URL, ...requestOptions } = options;
  const searchUrl = buildCountriesApiUrl({ q: normalizedName }, apiUrl);

  const payload = await fetchJson(searchUrl, requestOptions);
  const country = selectCountry(payload, normalizedName);
  if (!country) {
    throw new Error(`No country data returned for "${normalizedName}".`);
  }
  return country;
}

/**
 * Fetches a single country record by 3-letter ISO alpha-3 code.
 * @param {string} countryCode Three-letter ISO alpha-3 country code.
 * @param {{ apiUrl?: string, signal?: AbortSignal, timeoutMs?: number, headers?: Record<string, string>, fetcher?: typeof fetch }} [options] Request options.
 * @returns {Promise<Record<string, any> | null>} Resolves with the matched country object or null when absent.
 */
async function fetchCountryByCode(countryCode, options = {}) {
  const normalizedCode =
    typeof countryCode === "string" ? countryCode.trim().toUpperCase() : "";
  if (!VALID_ALPHA3_CODE.test(normalizedCode)) {
    throw new TypeError(
      `Invalid ISO alpha-3 country code "${String(countryCode)}".`,
    );
  }

  const { apiUrl = COUNTRIES_API_URL, ...requestOptions } = options;
  const codeUrl = buildCountriesApiUrl({ code: normalizedCode }, apiUrl);

  const payload = await fetchJson(codeUrl, requestOptions);
  return extractFirstCountry(payload);
}

/**
 * Fetches a country and its first bordering neighbour country using async/await.
 * @param {string} countryName Country name to search.
 * @param {{ apiUrl?: string, signal?: AbortSignal, timeoutMs?: number, headers?: Record<string, string>, fetcher?: typeof fetch }} [options] Request options.
 * @returns {Promise<{ country: Record<string, any>, neighbour: Record<string, any> | null }>} Country pair.
 */
async function fetchCountryWithNeighbour(countryName, options = {}) {
  const country = await fetchCountryByName(countryName, options);
  const neighbourCode = getFirstNeighbourCode(country);
  if (!neighbourCode) {
    return { country, neighbour: null };
  }

  try {
    const neighbour = await fetchCountryByCode(neighbourCode, options);
    return { country, neighbour };
  } catch (error) {
    if (options.signal?.aborted) {
      throw error;
    }
    console.error(`Failed to load neighbour ${neighbourCode}:`, error);
    return { country, neighbour: null };
  }
}

/**
 * Fetches and renders cards for each configured country and its neighbour in order.
 * @param {string[]} countryNames Country names to fetch and display.
 * @param {Element | null} [container] Target DOM container.
 * @param {{ apiUrl?: string, signal?: AbortSignal, timeoutMs?: number, headers?: Record<string, string>, fetcher?: typeof fetch }} [options] Request options.
 * @returns {Promise<void>} Resolves after all country cards are processed.
 */
async function renderCountries(
  countryNames,
  container = countriesContainer,
  options = {},
) {
  if (!container) {
    return;
  }

  container.replaceChildren();

  const results = await Promise.allSettled(
    countryNames.map((countryName) =>
      fetchCountryWithNeighbour(countryName, options),
    ),
  );

  for (const result of results) {
    if (result.status !== "fulfilled") {
      console.error(result.reason);
      continue;
    }

    const { country, neighbour } = result.value;
    renderCountryCard(country, { container });
    if (neighbour) {
      renderCountryCard(neighbour, { className: "neighbour", container });
    }
  }
}

/**
 * Initializes country rendering in the browser with top-level error handling.
 * @returns {Promise<void>} Resolves once initial rendering finishes or logs any failure.
 */
async function init() {
  try {
    await renderCountries(TARGET_COUNTRIES);
  } catch (error) {
    console.error("Failed to render countries:", error);
  }
}

if (typeof document !== "undefined") {
  init();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    HttpError,
    buildCountriesApiUrl,
    createRequestSignal,
    extractFirstCountry,
    fetchJson,
    fetchCountryByName,
    fetchCountryByCode,
    fetchCountryWithNeighbour,
    getFirstNeighbourCode,
    renderCountries,
    selectCountry,
  };
}
