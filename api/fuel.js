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

    const pricesText = await pricesResponse.text();
    const stationsText = await stationsResponse.text();

    if (!pricesResponse.ok) {
      return res.status(pricesResponse.status).json({
        ok: false,
        error: "Fuel Finder prices request failed",
        details: pricesText.slice(0, 1000)
      });
    }

    if (!stationsResponse.ok) {
      return res.status(stationsResponse.status).json({
        ok: false,
        error: "Fuel Finder stations request failed",
        details: stationsText.slice(0, 1000)
      });
    }

    let pricesJson;
    let stationsJson;

    try {
      pricesJson = JSON.parse(pricesText);
    } catch {
      return res.status(500).json({
        ok: false,
        error: "Prices endpoint did not return valid JSON",
        details: pricesText.slice(0, 1000)
      });
    }

    try {
      stationsJson = JSON.parse(stationsText);
    } catch {
      return res.status(500).json({
        ok: false,
        error: "Stations endpoint did not return valid JSON",
        details: stationsText.slice(0, 1000)
      });
    }

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

  if (!tokenResponse.ok) {
    throw new Error(`Token request failed: ${tokenResponse.status} ${tokenText.slice(0, 500)}`);
  }

  let tokenJson;
  try {
    tokenJson = JSON.parse(tokenText);
  } catch {
    throw new Error(`Token endpoint did not return valid JSON: ${tokenText.slice(0, 500)}`);
  }

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

    const fuelPrices =
      Array.isArray(item?.fuel_prices) ? item.fuel_prices :
      Array.isArray(item?.prices) ? item.prices :
      [];

    pricesByNodeId.set(nodeId, fuelPrices);
  }

  return stationItems
    .map((site, index) => {
      const nodeId = String(site?.node_id || `station-${index + 1}`);

      const fuelPrices = pricesByNodeId.get(nodeId) || [];
      const location = site?.location || {};
      const amenities = site?.amenities || {};
      const usualDays = site?.opening_times?.usual_days || {};

      const e10 = findFuelPrice(fuelPrices, ["E10"]);
      const e5 = findFuelPrice(fuelPrices, ["E5"]);
      const b7s = findFuelPrice(fuelPrices, ["B7_STANDARD", "B7", "B7S"]);
      const b7p = findFuelPrice(fuelPrices, ["B7_SUPER", "B7_PREMIUM", "PREMIUM_DIESEL", "B7P"]);
      const b10 = findFuelPrice(fuelPrices, ["B10"]);
      const hvo = findFuelPrice(fuelPrices, ["HVO"]);

      const brandRaw = site?.brand_name || "Unknown";
      const tradingName = site?.trading_name || brandRaw || "Fuel Station";

      const addressLine1 = location?.address_line_1 || "";
      const addressLine2 = location?.address_line_2 || "";
      const city = location?.city || "";
      const county = location?.county || "";
      const country = location?.country || "";
      const postcode = location?.postcode || "";

      const address = [
        addressLine1,
        addressLine2,
        city,
        county,
        postcode
      ].filter(Boolean).join(", ");

      return {
        id: nodeId,
        latitude: toNumber(location?.latitude),
        longitude: toNumber(location?.longitude),

        brandRaw,
        brandDisplay: brandRaw,
        tradingName,

        addressLine1,
        addressLine2,
        address,
        city,
        county,
        country,
        postcode,

        phone: site?.public_phone_number || "",

        priceE10: e10?.price ?? null,
        priceE5: e5?.price ?? null,
        priceB7S: b7s?.price ?? null,
        priceB7P: b7p?.price ?? null,
        priceB10: b10?.price ?? null,
        priceHVO: hvo?.price ?? null,

        timestampE10: e10?.updatedAt ?? null,
        timestampE5: e5?.updatedAt ?? null,
        timestampB7S: b7s?.updatedAt ?? null,
        timestampB7P: b7p?.updatedAt ?? null,
        timestampB10: b10?.updatedAt ?? null,
        timestampHVO: hvo?.updatedAt ?? null,

        forecourtUpdatedAt:
          site?.forecourt_update_timestamp ||
          site?.update_timestamp ||
          e10?.updatedAt ||
          e5?.updatedAt ||
          b7s?.updatedAt ||
          b7p?.updatedAt ||
          b10?.updatedAt ||
          hvo?.updatedAt ||
          null,

        openingTimes: {
          monday: mapUsualDay(usualDays?.monday),
          tuesday: mapUsualDay(usualDays?.tuesday),
          wednesday: mapUsualDay(usualDays?.wednesday),
          thursday: mapUsualDay(usualDays?.thursday),
          friday: mapUsualDay(usualDays?.friday),
          saturday: mapUsualDay(usualDays?.saturday),
          sunday: mapUsualDay(usualDays?.sunday)
        },

        hasAdbluePumps: Boolean(amenities?.fuel_and_energy_services?.adblue_pumps),
        hasAdbluePackaged: Boolean(amenities?.fuel_and_energy_services?.adblue_packaged),
        hasLpg: Boolean(amenities?.fuel_and_energy_services?.lpg_pumps),
        hasCarWash: Boolean(amenities?.vehicle_services?.car_wash),
        hasWater: Boolean(amenities?.water_filling),
        is24HoursAmenity: Boolean(amenities?.twenty_four_hour_fuel),
        hasToilets: Boolean(amenities?.customer_toilets),

        isMotorway: Boolean(site?.is_motorway_service_station),
        isSupermarket: Boolean(site?.is_supermarket_service_station),

        temporaryClosure: Boolean(site?.temporary_closure),
        permanentClosure: Boolean(site?.permanent_closure)
      };
    })
    .filter((station) =>
      Number.isFinite(station.latitude) &&
      Number.isFinite(station.longitude) &&
      !station.temporaryClosure &&
      !station.permanentClosure
    );
}

function mapUsualDay(day) {
  return {
    open: day?.open_time || "",
    close: day?.close_time || "",
    is24Hours: Boolean(day?.is_24_hours)
  };
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
    const type =
      item?.fuel_type ||
      item?.fuelType ||
      item?.product_code ||
      item?.productCode;

    return accepted.includes(normalizeFuelType(type));
  });

  if (!entry) return null;

  return {
    price: toNumber(entry?.price),
    updatedAt:
      entry?.price_last_updated ||
      entry?.price_change_effective_timestamp ||
      entry?.updated_at ||
      null
  };
}

function normalizeFuelType(value) {
  return String(value || "").trim().toUpperCase();
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}
