export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      ok: false,
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

    if (!pricesResponse.ok) {
      const text = await safeReadText(pricesResponse);
      return res.status(pricesResponse.status).json({
        ok: false,
        error: "Failed to fetch prices",
        details: text
      });
    }

    if (!stationsResponse.ok) {
      const text = await safeReadText(stationsResponse);
      return res.status(stationsResponse.status).json({
        ok: false,
        error: "Failed to fetch stations",
        details: text
      });
    }

    const pricesJson = await pricesResponse.json();
    const stationsJson = await stationsResponse.json();

    const prices = extractArray(pricesJson);
    const stations = extractArray(stationsJson);

    const mergedStations = mergeStationsAndPrices(stations, prices)
      .map(normalizeStation)
      .filter(Boolean);

    return res.status(200).json({
      ok: true,
      count: mergedStations.length,
      stations: mergedStations
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "Unexpected server error",
      details: error instanceof Error ? error.message : String(error)
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

  if (!tokenResponse.ok) {
    const text = await safeReadText(tokenResponse);
    throw new Error(`Failed to get access token: ${tokenResponse.status} ${text}`);
  }

  const tokenJson = await tokenResponse.json();
  const accessToken =
    tokenJson.access_token ||
    tokenJson.accessToken ||
    tokenJson.token;

  if (!accessToken) {
    throw new Error("Token response did not contain an access token");
  }

  return accessToken;
}

function extractArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.stations)) return payload.stations;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function mergeStationsAndPrices(stations, prices) {
  if (!stations.length && !prices.length) return [];

  const stationMap = new Map();

  for (const station of stations) {
    const key = getMergeKey(station);
    const base = { ...station };
    if (key) {
      stationMap.set(key, base);
    } else {
      stationMap.set(`station-${stationMap.size + 1}`, base);
    }
  }

  for (const price of prices) {
    const key = getMergeKey(price);

    if (key && stationMap.has(key)) {
      const existing = stationMap.get(key);
      stationMap.set(key, { ...existing, ...price });
      continue;
    }

    stationMap.set(key || `price-${stationMap.size + 1}`, { ...price });
  }

  return Array.from(stationMap.values());
}

function getMergeKey(item) {
  return (
    item?.id ||
    item?.stationId ||
    item?.station_id ||
    item?.forecourtId ||
    item?.forecourt_id ||
    item?.siteId ||
    item?.site_id ||
    item?.locationId ||
    item?.location_id ||
    null
  );
}

function normalizeStation(raw) {
  const latitude = toNumber(raw.latitude ?? raw.lat);
  const longitude = toNumber(raw.longitude ?? raw.lng ?? raw.lon);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  if (raw.temporaryClosure === true || raw.permanentClosure === true) {
    return null;
  }

  const addressLine1 = stringOrEmpty(raw.addressLine1 || raw.address1);
  const addressLine2 = stringOrEmpty(raw.addressLine2 || raw.address2);
  const city = stringOrEmpty(raw.city || raw.town);
  const county = stringOrEmpty(raw.county || raw.region);
  const country = stringOrEmpty(raw.country);
  const postcode = stringOrEmpty(raw.postcode || raw.postCode);

  const address =
    stringOrEmpty(raw.address) ||
    [addressLine1, addressLine2, city, county, postcode].filter(Boolean).join(", ");

  return {
    id:
      raw.id ||
      raw.stationId ||
      raw.station_id ||
      raw.forecourtId ||
      raw.forecourt_id ||
      createFallbackId(raw, latitude, longitude),

    latitude,
    longitude,

    brandRaw: stringOrEmpty(raw.brandRaw || raw.brand || raw.brandName),
    brandDisplay: stringOrEmpty(raw.brandDisplay || raw.brandRaw || raw.brand || raw.brandName),
    tradingName: stringOrEmpty(raw.tradingName || raw.name || raw.siteName),

    addressLine1,
    addressLine2,
    address,
    city,
    county,
    country,
    postcode,

    phone: stringOrEmpty(raw.phone || raw.telephone),

    priceE10: toNullableNumber(raw.priceE10 ?? raw.e10),
    priceE5: toNullableNumber(raw.priceE5 ?? raw.e5),
    priceB7S: toNullableNumber(raw.priceB7S ?? raw.b7s ?? raw.priceDiesel ?? raw.diesel),
    priceB7P: toNullableNumber(raw.priceB7P ?? raw.b7p ?? raw.premiumDiesel),
    priceB10: toNullableNumber(raw.priceB10 ?? raw.b10),
    priceHVO: toNullableNumber(raw.priceHVO ?? raw.hvo),

    timestampE10: toNullableDate(raw.timestampE10),
    timestampE5: toNullableDate(raw.timestampE5),
    timestampB7S: toNullableDate(raw.timestampB7S),
    timestampB7P: toNullableDate(raw.timestampB7P),
    timestampB10: toNullableDate(raw.timestampB10),
    timestampHVO: toNullableDate(raw.timestampHVO),
    forecourtUpdatedAt: toNullableDate(
      raw.forecourtUpdatedAt || raw.updatedAt || raw.lastUpdated || raw.modifiedAt
    ),

    openingTimes: normalizeOpeningTimes(raw.openingTimes),

    hasAdbluePumps: Boolean(raw.hasAdbluePumps),
    hasAdbluePackaged: Boolean(raw.hasAdbluePackaged),
    hasLpg: Boolean(raw.hasLpg),
    hasCarWash: Boolean(raw.hasCarWash),
    hasWater: Boolean(raw.hasWater),
    is24HoursAmenity: Boolean(raw.is24HoursAmenity),
    hasToilets: Boolean(raw.hasToilets),

    isMotorway: Boolean(raw.isMotorway),
    isSupermarket: Boolean(raw.isSupermarket),
    temporaryClosure: Boolean(raw.temporaryClosure),
    permanentClosure: Boolean(raw.permanentClosure)
  };
}

function normalizeOpeningTimes(openingTimes) {
  const emptyDay = { open: "", close: "", is24Hours: false };

  return {
    monday: normalizeDay(openingTimes?.monday, emptyDay),
    tuesday: normalizeDay(openingTimes?.tuesday, emptyDay),
    wednesday: normalizeDay(openingTimes?.wednesday, emptyDay),
    thursday: normalizeDay(openingTimes?.thursday, emptyDay),
    friday: normalizeDay(openingTimes?.friday, emptyDay),
    saturday: normalizeDay(openingTimes?.saturday, emptyDay),
    sunday: normalizeDay(openingTimes?.sunday, emptyDay)
  };
}

function normalizeDay(day, fallback) {
  if (!day || typeof day !== "object") return { ...fallback };

  return {
    open: stringOrEmpty(day.open),
    close: stringOrEmpty(day.close),
    is24Hours: Boolean(day.is24Hours)
  };
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function toNullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toNullableDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function stringOrEmpty(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function createFallbackId(raw, latitude, longitude) {
  return [
    raw.brandDisplay || raw.brandRaw || raw.brand || "station",
    raw.postcode || raw.postCode || "no-postcode",
    latitude,
    longitude
  ].join("-");
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
