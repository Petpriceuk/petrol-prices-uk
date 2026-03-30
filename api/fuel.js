export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
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
        error: "Missing environment variables",
        missingEnv
      });
    }

    const accessToken = await getAccessToken();

    const [pricesResponse, stationsResponse] = await Promise.all([
      fetch(process.env.FUEL_FINDER_PRICES_URL, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json"
        }
      }),
      fetch(process.env.FUEL_FINDER_STATIONS_URL, {
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
        error: "Prices request failed",
        details: pricesText.slice(0, 800)
      });
    }

    if (!stationsResponse.ok) {
      return res.status(stationsResponse.status).json({
        ok: false,
        error: "Stations request failed",
        details: stationsText.slice(0, 800)
      });
    }

    const pricesJson = JSON.parse(pricesText);
    const stationsJson = JSON.parse(stationsText);

    const stations = mergeFuelFinderData(stationsJson, pricesJson);

    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");

    return res.status(200).json({
      ok: true,
      count: stations.length,
      stations
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
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
  const tokenJson = JSON.parse(tokenText);

  const accessToken =
    tokenJson?.access_token ||
    tokenJson?.data?.access_token ||
    tokenJson?.token?.access_token ||
    null;

  if (!accessToken) {
    throw new Error(`No access token returned: ${tokenText.slice(0, 500)}`);
  }

  return accessToken;
}

function mergeFuelFinderData(stationsRaw, pricesRaw) {
  const stationItems = extractItems(stationsRaw);
  const priceItems = extractItems(pricesRaw);

  const pricesById = new Map();

  for (const item of priceItems) {
    const ids = getPossibleIds(item);
    const priceEntries = extractPriceEntries(item);

    for (const id of ids) {
      if (!pricesById.has(id)) pricesById.set(id, []);
      pricesById.get(id).push(...priceEntries);
    }
  }

  const stations = stationItems
    .map((site, index) => {
      const ids = getPossibleIds(site);
      const matchedPrices = firstMatchedPrices(ids, pricesById);

      const e10 = findFuelPrice(matchedPrices, ["E10", "Regular Unleaded", "Unleaded"]);
      const e5 = findFuelPrice(matchedPrices, ["E5", "Super Unleaded", "Premium Unleaded"]);
      const b7s = findFuelPrice(matchedPrices, ["B7", "Diesel", "Regular Diesel"]);
      const b7p = findFuelPrice(matchedPrices, ["SDV", "B7P", "Premium Diesel"]);

      const latitude = firstNumber([
        site.latitude,
        site.lat,
        site.location?.latitude,
        site.location?.lat,
        site.coordinates?.latitude,
        site.coordinates?.lat,
        site.siteLocation?.latitude,
        site.siteLocation?.lat,
        site.geo?.latitude,
        site.geo?.lat
      ]);

      const longitude = firstNumber([
        site.longitude,
        site.lng,
        site.lon,
        site.location?.longitude,
        site.location?.lng,
        site.location?.lon,
        site.coordinates?.longitude,
        site.coordinates?.lng,
        site.coordinates?.lon,
        site.siteLocation?.longitude,
        site.siteLocation?.lng,
        site.geo?.longitude,
        site.geo?.lng,
        site.geo?.lon
      ]);

      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return null;
      }

      const brand = firstString([
        site.brand,
        site.brandName,
        site.operator,
        site.operatorName,
        site.companyName,
        site.forecourtBrand
      ]) || "Unknown";

      const tradingName = firstString([
        site.tradingName,
        site.name,
        site.siteName,
        site.forecourtName,
        site.displayName,
        brand
      ]) || "Fuel Station";

      const address1 = firstString([
        site.address?.line1,
        site.addressLine1,
        site.address1,
        site.line1,
        site.street,
        site.address?.addressLine1
      ]);

      const address2 = firstString([
        site.address?.line2,
        site.addressLine2,
        site.address2,
        site.line2,
        site.address?.addressLine2
      ]);

      const city = firstString([
        site.address?.town,
        site.address?.city,
        site.city,
        site.town,
        site.locality
      ]);

      const county = firstString([
        site.address?.county,
        site.county,
        site.region
      ]);

      const postcode = firstString([
        site.address?.postcode,
        site.postcode,
        site.zip,
        site.zipCode
      ]);

      const address = [address1, address2, city, county, postcode]
        .filter(Boolean)
        .join(", ");

      return {
        id: ids[0] || `station-${index + 1}`,
        latitude,
        longitude,
        brandRaw: brand,
        brandDisplay: brand,
        tradingName,
        address,
        city: city || "",
        county: county || "",
        postcode: postcode || "",
        priceE10: e10?.price ?? null,
        priceE5: e5?.price ?? null,
        priceB7S: b7s?.price ?? null,
        priceB7P: b7p?.price ?? null,
        timestampE10: e10?.updatedAt ?? null,
        timestampE5: e5?.updatedAt ?? null,
        timestampB7S: b7s?.updatedAt ?? null,
        timestampB7P: b7p?.updatedAt ?? null,
        forecourtUpdatedAt: firstString([
          site.updatedAt,
          site.lastUpdated,
          site.forecourtUpdatedAt,
          site.updated_at,
          site.last_updated
        ]),
        openingHours: site.openingHours || site.hours || site.opening_hours || null,
        amenities: normalizeAmenities(site.amenities || site.facilities || site.services),
        isMotorway: Boolean(site.isMotorway || site.motorway),
        isSupermarket: Boolean(site.isSupermarket || site.supermarket)
      };
    })
    .filter(Boolean);

  return stations;
}

function extractItems(payload) {
  if (Array.isArray(payload)) return payload;

  const directKeys = [
    "data",
    "items",
    "results",
    "stations",
    "forecourts",
    "records"
  ];

  for (const key of directKeys) {
    if (Array.isArray(payload?.[key])) return payload[key];
    if (Array.isArray(payload?.data?.[key])) return payload.data[key];
  }

  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.content)) return payload.data.content;

  return [];
}

function getPossibleIds(obj) {
  const ids = [
    obj?.id,
    obj?.siteId,
    obj?.stationId,
    obj?.forecourtId,
    obj?.station_id,
    obj?.site_id,
    obj?.forecourt_id,
    obj?.pfsId,
    obj?.pfs_id,
    obj?.locationId,
    obj?.location_id
  ]
    .map((v) => String(v || "").trim())
    .filter(Boolean);

  return [...new Set(ids)];
}

function firstMatchedPrices(ids, pricesById) {
  for (const id of ids) {
    if (pricesById.has(id)) return pricesById.get(id);
  }
  return [];
}

function extractPriceEntries(item) {
  const possibleArrays = [
    item?.prices,
    item?.fuelPrices,
    item?.fuel_prices,
    item?.products,
    item?.grades,
    item?.currentPrices,
    item?.current_prices,
    item?.retailPrices,
    item?.retail_prices
  ];

  for (const arr of possibleArrays) {
    if (Array.isArray(arr)) return arr;
  }

  return extractPricesFromObject(item);
}

function extractPricesFromObject(obj) {
  const out = [];

  for (const [key, value] of Object.entries(obj || {})) {
    if (!value || typeof value !== "object") continue;

    const keyNorm = normalizeFuelCode(key);

    if (["e10", "e5", "b7", "b7s", "b7p", "sdv", "diesel", "unleaded", "premiumdiesel", "superunleaded"].includes(keyNorm)) {
      out.push({
        fuelCode: key,
        ...value
      });
    }
  }

  return out;
}

function findFuelPrice(prices, acceptedNames) {
  const accepted = acceptedNames.map(normalizeFuelCode);

  for (const item of prices || []) {
    const code = normalizeFuelCode(
      item.fuelType ||
      item.fuelCode ||
      item.product ||
      item.grade ||
      item.name ||
      item.code ||
      item.productCode
    );

    if (accepted.includes(code)) {
      return {
        price: firstNumber([
          item.price,
          item.amount,
          item.pencePerLitre,
          item.pence_per_litre,
          item.retailPrice,
          item.retail_price,
          item.currentPrice,
          item.current_price
        ]),
        updatedAt: firstString([
          item.updatedAt,
          item.lastUpdated,
          item.timestamp,
          item.updated_at,
          item.last_updated
        ])
      };
    }
  }

  return null;
}

function normalizeAmenities(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => {
      if (typeof item === "string") return item;
      return item?.name || item?.label || item?.type || item?.code || "";
    })
    .filter(Boolean);
}

function firstString(values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function firstNumber(values) {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function normalizeFuelCode(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}
