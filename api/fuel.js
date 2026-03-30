export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      ok: false,
      step: "request",
      error: "Method not allowed"
    });
  }

  try {
    const requiredEnv = [
      "FUEL_FINDER_TOKEN_URL",
      "FUEL_FINDER_CLIENT_ID",
      "FUEL_FINDER_CLIENT_SECRET",
      "FUEL_FINDER_PRICES_URL",
      "FUEL_FINDER_STATIONS_URL"
    ];

    const missingEnv = requiredEnv.filter((key) => !process.env[key]);

    if (missingEnv.length > 0) {
      return res.status(500).json({
        ok: false,
        step: "env",
        error: "Missing required environment variables",
        missingEnv
      });
    }

    const accessToken = await getAccessToken();

    const [pricesResponse, stationsResponse] = await Promise.all([
      fetch(process.env.FUEL_FINDER_PRICES_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json"
        }
      }),
      fetch(process.env.FUEL_FINDER_STATIONS_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json"
        }
      })
    ]);

    const pricesText = await pricesResponse.text();
    const stationsText = await stationsResponse.text();

    if (!pricesResponse.ok) {
      return res.status(pricesResponse.status).json({
        ok: false,
        step: "prices-api",
        error: "Fuel Finder prices request failed",
        status: pricesResponse.status,
        details: safeSnippet(pricesText)
      });
    }

    if (!stationsResponse.ok) {
      return res.status(stationsResponse.status).json({
        ok: false,
        step: "stations-api",
        error: "Fuel Finder stations request failed",
        status: stationsResponse.status,
        details: safeSnippet(stationsText)
      });
    }

    let pricesJson;
    let stationsJson;

    try {
      pricesJson = JSON.parse(pricesText);
    } catch {
      return res.status(500).json({
        ok: false,
        step: "prices-parse",
        error: "Prices endpoint did not return valid JSON",
        details: safeSnippet(pricesText)
      });
    }

    try {
      stationsJson = JSON.parse(stationsText);
    } catch {
      return res.status(500).json({
        ok: false,
        step: "stations-parse",
        error: "Stations endpoint did not return valid JSON",
        details: safeSnippet(stationsText)
      });
    }

    const stations = mergeFuelFinderData(stationsJson, pricesJson);

    return res.status(200).json({
      ok: true,
      count: stations.length,
      stations
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      step: "server",
      error: error?.message || "Unknown server error"
    });
  }
}

async function getAccessToken() {
  const tokenResponse = await fetch(process.env.FUEL_FINDER_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.FUEL_FINDER_CLIENT_ID,
      client_secret: process.env.FUEL_FINDER_CLIENT_SECRET
    }).toString()
  });

  const tokenText = await tokenResponse.text();

  if (!tokenResponse.ok) {
    throw new Error(
      `Token request failed (${tokenResponse.status}): ${safeSnippet(tokenText)}`
    );
  }

  let tokenJson;
  try {
    tokenJson = JSON.parse(tokenText);
  } catch {
    throw new Error(`Token endpoint did not return valid JSON: ${safeSnippet(tokenText)}`);
  }

  if (!tokenJson.access_token) {
    throw new Error(`No access_token in token response: ${safeSnippet(tokenText)}`);
  }

  return tokenJson.access_token;
}

function mergeFuelFinderData(stationsRaw, pricesRaw) {
  const stationsList = getArrayFromPayload(stationsRaw);
  const pricesList = getArrayFromPayload(pricesRaw);

  const pricesById = new Map();

  for (const item of pricesList) {
    const siteId = String(
      item.forecourtId ??
      item.stationId ??
      item.siteId ??
      item.id ??
      ""
    ).trim();

    if (!siteId) continue;

    const prices = Array.isArray(item.prices) ? item.prices : [];
    const existing = pricesById.get(siteId) || [];
    pricesById.set(siteId, existing.concat(prices));
  }

  return stationsList
    .map((site, index) => {
      const siteId = String(
        site.forecourtId ??
        site.stationId ??
        site.siteId ??
        site.id ??
        `${index + 1}`
      ).trim();

      const prices = pricesById.get(siteId) || [];

      const e10 = findFuelPrice(prices, ["E10", "Unleaded"]);
      const e5 = findFuelPrice(prices, ["E5", "Super Unleaded", "Premium Unleaded"]);
      const b7s = findFuelPrice(prices, ["B7", "B7S", "Diesel"]);
      const b7p = findFuelPrice(prices, ["SDV", "B7P", "Premium Diesel"]);

      const latitude = toNumber(
        site.latitude ??
        site.location?.latitude ??
        site.coordinates?.latitude ??
        site.lat
      );

      const longitude = toNumber(
        site.longitude ??
        site.location?.longitude ??
        site.coordinates?.longitude ??
        site.lng
      );

      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return null;
      }

      const brand = site.brand || site.operator || site.companyName || "Unknown";
      const tradingName =
        site.name || site.tradingName || site.siteName || brand || "Fuel Station";

      const addressLine1 =
        site.address?.line1 ||
        site.addressLine1 ||
        site.address1 ||
        "";
      const addressLine2 =
        site.address?.line2 ||
        site.addressLine2 ||
        site.address2 ||
        "";
      const city =
        site.address?.town ||
        site.city ||
        site.town ||
        "";
      const county =
        site.address?.county ||
        site.county ||
        "";
      const postcode =
        site.address?.postcode ||
        site.postcode ||
        "";

      return {
        id: siteId,
        latitude,
        longitude,

        brandRaw: brand,
        brandDisplay: brand,
        tradingName,

        address: [addressLine1, addressLine2, city, county, postcode]
          .filter(Boolean)
          .join(", "),
        city,
        county,
        postcode,

        priceE10: e10?.price ?? null,
        priceE5: e5?.price ?? null,
        priceB7S: b7s?.price ?? null,
        priceB7P: b7p?.price ?? null,

        timestampE10: e10?.updatedAt ?? null,
        timestampE5: e5?.updatedAt ?? null,
        timestampB7S: b7s?.updatedAt ?? null,
        timestampB7P: b7p?.updatedAt ?? null,

        forecourtUpdatedAt:
          site.updatedAt ||
          site.lastUpdated ||
          site.forecourtUpdatedAt ||
          null,

        openingHours: site.openingHours || site.hours || null,
        amenities: normalizeAmenities(site.amenities),

        isMotorway: Boolean(site.isMotorway),
        isSupermarket: Boolean(site.isSupermarket)
      };
    })
    .filter(Boolean);
}

function getArrayFromPayload(payload) {
  if (Array.isArray(payload)) return payload;

  const possibleKeys = [
    "forecourts",
    "stations",
    "items",
    "data",
    "results"
  ];

  for (const key of possibleKeys) {
    if (Array.isArray(payload?.[key])) {
      return payload[key];
    }
  }

  return [];
}

function findFuelPrice(prices, acceptedNames) {
  const accepted = acceptedNames.map(normalizeFuelCode);

  const entry = prices.find((item) => {
    const code = normalizeFuelCode(
      item.fuelType ||
      item.fuelCode ||
      item.product ||
      item.grade ||
      item.name
    );
    return accepted.includes(code);
  });

  if (!entry) return null;

  return {
    price: toNumber(itemPrice(entry)),
    updatedAt: entry.updatedAt || entry.lastUpdated || entry.timestamp || null
  };
}

function itemPrice(entry) {
  return entry.price ?? entry.amount ?? entry.pencePerLitre ?? null;
}

function normalizeFuelCode(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function normalizeAmenities(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => {
      if (typeof item === "string") return item;
      return item?.name || item?.label || item?.type || "";
    })
    .filter(Boolean);
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function safeSnippet(value) {
  return String(value || "").slice(0, 800);
}
