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
    null;

  if (!accessToken) {
    throw new Error(`No access token returned: ${tokenText.slice(0, 500)}`);
  }

  return accessToken;
}

function mergeFuelFinderData(stationsRaw, pricesRaw) {
  const stationItems = extractItems(stationsRaw);
  const priceItems = extractItems(pricesRaw);

  const pricesByNodeId = new Map();

  for (const item of priceItems) {
    const nodeId = String(item?.node_id || "").trim();
    if (!nodeId) continue;

    const fuelPrices = Array.isArray(item.fuel_prices) ? item.fuel_prices : [];
    pricesByNodeId.set(nodeId, fuelPrices);
  }

  return stationItems
    .map((site, index) => {
      const nodeId = String(site?.node_id || `station-${index + 1}`);

      const fuelPrices = pricesByNodeId.get(nodeId) || [];

      const e10 = findFuelPrice(fuelPrices, ["E10"]);
      const e5 = findFuelPrice(fuelPrices, ["E5"]);
      const b7s = findFuelPrice(fuelPrices, ["B7_STANDARD", "B7"]);
      const b7p = findFuelPrice(fuelPrices, ["B7_SUPER", "B7_PREMIUM", "PREMIUM_DIESEL"]);

      const location = site.location || {};
      const brand = site.brand_name || "Unknown";
      const tradingName = site.trading_name || brand || "Fuel Station";

      const address = [
        location.address_line_1,
        location.address_line_2,
        location.city,
        location.county,
        location.postcode
      ].filter(Boolean).join(", ");

      return {
        id: nodeId,
        latitude: toNumber(location.latitude),
        longitude: toNumber(location.longitude),

        brandRaw: brand,
        brandDisplay: brand,
        tradingName,

        address,
        city: location.city || "",
        county: location.county || "",
        postcode: location.postcode || "",

        priceE10: e10?.price ?? null,
        priceE5: e5?.price ?? null,
        priceB7S: b7s?.price ?? null,
        priceB7P: b7p?.price ?? null,

        timestampE10: e10?.updatedAt ?? null,
        timestampE5: e5?.updatedAt ?? null,
        timestampB7S: b7s?.updatedAt ?? null,
        timestampB7P: b7p?.updatedAt ?? null,

        forecourtUpdatedAt:
          e10?.updatedAt ||
          e5?.updatedAt ||
          b7s?.updatedAt ||
          b7p?.updatedAt ||
          null,

        openingHours: site.opening_times || null,
        amenities: Array.isArray(site.amenities) ? site.amenities : [],

        isMotorway: Boolean(site.is_motorway_service_station),
        isSupermarket: Boolean(site.is_supermarket_service_station),

        publicPhoneNumber: site.public_phone_number || "",
        temporaryClosure: Boolean(site.temporary_closure),
        permanentClosure: Boolean(site.permanent_closure),
        fuelTypes: Array.isArray(site.fuel_types) ? site.fuel_types : []
      };
    })
    .filter((station) =>
      Number.isFinite(station.latitude) &&
      Number.isFinite(station.longitude)
    );
}

function extractItems(payload) {
  if (Array.isArray(payload)) return payload;

  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.stations)) return payload.stations;
  if (Array.isArray(payload?.forecourts)) return payload.forecourts;
  if (Array.isArray(payload?.records)) return payload.records;

  return [];
}

function findFuelPrice(fuelPrices, acceptedTypes) {
  const accepted = acceptedTypes.map(normalizeFuelType);

  const entry = (fuelPrices || []).find((item) => {
    return accepted.includes(normalizeFuelType(item?.fuel_type));
  });

  if (!entry) return null;

  return {
    price: toNumber(entry.price),
    updatedAt: entry.price_last_updated || entry.price_change_effective_timestamp || null
  };
}

function normalizeFuelType(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}
