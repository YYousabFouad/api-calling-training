"use strict";

const btn = document.querySelector(".btn-country");
const countriesContainer = document.querySelector(".countries");

// NEW REVERSE GEOCODING API URL (use instead of the URL shown in videos):
// https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}

///////////////////////////////////////

const COUNTRIES_API_URL = "http://127.0.0.1:3000/api/countries";
const TARGET_COUNTRIES = ["egypt", "portugal", "argentina"];
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
 * @returns {string} HTML string matching the index.html card template.
 */
function createCountryCardHtml(viewModel) {
  return `
    <article class="country">
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

  const normalizedTarget = countryName.toLowerCase();
  return (
    objects.find(
      (item) => item?.names?.common?.toLowerCase() === normalizedTarget,
    ) ?? objects[0]
  );
}

/**
 * Checks whether an HTTP status code indicates a successful 2xx response.
 * @param {number} status HTTP response status code.
 * @returns {boolean} True when status is in the 200-299 range.
 */
function isSuccessStatus(status) {
  return status >= 200 && status < 300;
}

/**
 * Renders a country card into the target DOM container.
 * @param {Record<string, any> | null} country Country record to render.
 * @param {Element | null} [container] Target DOM container.
 * @returns {void} Nothing.
 */
function renderCountryCard(country, container = countriesContainer) {
  if (!container || !country) {
    return;
  }

  const html = createCountryCardHtml(toCountryViewModel(country));
  container.insertAdjacentHTML("beforeend", html);
  container.style.opacity = "1";
}

/**
 * Fetches JSON over XMLHttpRequest and resolves with the parsed payload.
 * @param {string} url Request endpoint URL.
 * @returns {Promise<any>} Resolves with parsed JSON or rejects on HTTP/network/parse errors.
 */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("GET", url);

    request.addEventListener("load", function () {
      if (!isSuccessStatus(this.status)) {
        reject(
          new Error(`Request failed with status ${this.status}: ${this.responseText}`),
        );
        return;
      }

      try {
        resolve(JSON.parse(this.responseText));
      } catch (error) {
        reject(new Error("Failed to parse JSON response.", { cause: error }));
      }
    });

    request.addEventListener("error", () => {
      reject(new Error("Network error occurred while making the request."));
    });

    request.send();
  });
}

/**
 * Fetches and renders cards for the configured list of countries in order.
 * @param {string[]} countryNames Country names to fetch and display.
 * @param {Element | null} [container] Target DOM container.
 * @returns {Promise<void>} Resolves after all country cards are processed.
 */
async function renderCountries(countryNames, container = countriesContainer) {
  if (!container) {
    return;
  }

  container.replaceChildren();

  const requests = countryNames.map(async (countryName) => {
    const url = `${COUNTRIES_API_URL}?q=${encodeURIComponent(countryName)}`;
    const payload = await fetchJson(url);
    return selectCountry(payload, countryName);
  });

  const results = await Promise.allSettled(requests);
  results.forEach((result) => {
    if (result.status === "fulfilled") {
      renderCountryCard(result.value, container);
    } else {
      console.error(result.reason);
    }
  });
}

renderCountries(TARGET_COUNTRIES);
