export const config = {
  runtime: "nodejs",
  regions: ["lhr1"],
};

let tokenCache = {
  accessToken: null,
  expiresAt: 0,
};

function cleanEnv(name) {
  const value = process.env[name];
  if (!value) return "";
  return String(value).trim().replace(/^['"]|['"]$/g, "");
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function toBool(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return ["true", "1", "yes", "y"].includes(normalized);
  }
  return false;
}

function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function getApiArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const candidates = [
    payload.data,
    payload.results,
    payload.forecourts,
    payload.pfs,
    payload.items,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function getNodeId(record, fallback = "") {
  return String(
    firstDefined(
      record?.node_id,
      record?.forecourt_id,
      record?.pfs_id,
      record?.id,
      fallback
    ) || ""
  );
}

function getFuelPriceValue(record, ...codes) {
  const direct = record?.fuel_prices || record?.prices || record || {};
  for (const code of codes) {
    const lower = typeof code === "string" ? code.toLowerCase() : code;
    const value = firstDefined(
      direct?.[code],
      direct?.[lower],
      record?.[code],
      record?.[lower]
    );
    const numeric = asNumber(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function getFuelTimestampValue(record, ...codes) {
  const direct =
    record?.price_submission_timestamps ||
    record?.price_submission_timestamp ||
    record?.timestamps ||
    {};

  for (const code of codes) {
    const lower = typeof code === "string" ? code.toLowerCase() : code;
    const value = firstDefined(
      direct?.[code],
      direct?.[lower],
      record?.[`timestamp_${code}`],
      record?.[`price_submission_timestamp_${code}`]
    );
    const parsed = safeDate(value);
    if (parsed) return parsed;
  }

  return safeDate(
    firstDefined(record?.updated_at, record?.last_updated, record?.updatedAt)
  );
}

function normalizeOpeningTimes(record) {
  const days = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
  ];

  const usualDays =
    record?.opening_times?.usual_days ||
    record?.usual_days ||
    record?.openingTimes ||
    {};

  return Object.fromEntries(
    days.map((day) => {
      const value = usualDays?.[day] || record?.[day] || {};
      return [
        day,
        {
          open: firstDefined(value?.open_time, value?.open, ""),
          close: firstDefined(value?.close_time, value?.close, ""),
          is24Hours: toBool(
            firstDefined(value?.is_24_hours, value?.is24Hours, false)
          ),
        },
      ];
    })
  );
}

function normalizeAmenities(record) {
  const fuelServices = record?.amenities?.fuel_and_energy_services || {};
  const vehicleServices = record?.amenities?.vehicle_services || {};

  return {
    hasAdbluePumps: toBool(
      firstDefined(fuelServices?.adblue_pumps, record?.hasAdbluePumps, false)
    ),
    hasAdbluePackaged: toBool(
      firstDefined(fuelServices?.adblue_packaged, record?.hasAdbluePackaged, false)
    ),
    hasLpg: toBool(
      firstDefined(fuelServices?.lpg_pumps, record?.hasLpg, false)
    ),
    hasCarWash: toBool(
      firstDefined(vehicleServices?.car_wash, record?.hasCarWash, false)
    ),
    hasWater: toBool(
      firstDefined(record?.amenities?.water_filling, record?.hasWater, false)
    ),
    is24HoursAmenity: toBool(
      firstDefined(record?.amenities?.twenty_four_hour_fuel, record?.is24HoursAmenity, false)
    ),
    hasToilets: toBool(
      firstDefined(record?.amenities?.customer_toilets, record?.hasToilets, false)
    ),
  };
}

function normalizeStationRecord(record, index, priceRecord) {
  const latitude = asNumber(firstDefined(record?.location?.latitude, record?.latitude));
  const longitude = asNumber(firstDefined(record?.location?.longitude, record?.longitude));

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const temporarilyClosed = toBool(
    firstDefined(record?.temporary_closure, record?.status?.temporary_closure, false)
  );
  const permanentlyClosed = toBool(
    firstDefined(record?.permanent_closure, record?.status?.permanent_closure, false)
  );

  if (temporarilyClosed || permanentlyClosed) return null;

  const postcode = String(
    firstDefined(record?.location?.postcode, record?.postcode, "") || ""
  ).toUpperCase();

  const addressLine1 = firstDefined(
    record?.location?.address_line_1,
    record?.address_line_1,
    ""
  ) || "";

  const addressLine2 = firstDefined(
    record?.location?.address_line_2,
    record?.address_line_2,
    ""
  ) || "";

  const city = firstDefined(record?.location?.city, record?.city, record?.town, "") || "";
  const county = firstDefined(record?.location?.county, record?.county, "") || "";
  const country = firstDefined(record?.location?.country, record?.country, "UK") || "UK";
  const brandRaw = firstDefined(record?.brand_name, record?.brand, "") || "";

  return {
    id: getNodeId(record, `station-${index + 1}`),
    brandRaw,
    brandDisplay: brandRaw,
    tradingName: firstDefined(record?.trading_name, record?.name, "Fuel Station"),
    postcode,
    city,
    county,
    country,
    addressLine1,
    addressLine2,
    address: [addressLine1, addressLine2, city, county, postcode].filter(Boolean).join(", "),
    latitude,
    longitude,
    phone: firstDefined(record?.public_phone_number, record?.phone, "") || "",
    isMotorway: toBool(
      firstDefined(record?.is_motorway_service_station, record?.isMotorway, false)
    ),
    isSupermarket: toBool(
      firstDefined(record?.is_supermarket_service_station, record?.isSupermarket, false)
    ),
    forecourtUpdatedAt: safeDate(
      firstDefined(record?.forecourt_update_timestamp, record?.updated_at, record?.last_updated)
    ),
    priceE5: getFuelPriceValue(priceRecord, "E5"),
    priceE10: getFuelPriceValue(priceRecord, "E10"),
    priceB7S: getFuelPriceValue(priceRecord, "B7S", "B7"),
    priceB7P: getFuelPriceValue(priceRecord, "B7P", "SD", "SDV"),
    priceB10: getFuelPriceValue(priceRecord, "B10"),
    priceHVO: getFuelPriceValue(priceRecord, "HVO"),
    timestampE5: getFuelTimestampValue(priceRecord, "E5"),
    timestampE10: getFuelTimestampValue(priceRecord, "E10"),
    timestampB7S: getFuelTimestampValue(priceRecord, "B7S", "B7"),
    timestampB7P: getFuelTimestampValue(priceRecord, "B7P", "SD", "SDV"),
    timestampB10: getFuelTimestampValue(priceRecord, "B10"),
    timestampHVO: getFuelTimestampValue(priceRecord, "HVO"),
    openingTimes: normalizeOpeningTimes(record),
    ...normalizeAmenities(record),
  };
}

async function getAccessToken() {
  const now = Date.now();

  if (tokenCache.accessToken && now < tokenCache.expiresAt - 60_000) {
    return tokenCache.accessToken;
  }

  const tokenUrl = cleanEnv("FUEL_FINDER_TOKEN_URL");
  const clientId = cleanEnv("FUEL_FINDER_CLIENT_ID");
  const clientSecret = cleanEnv("FUEL_FINDER_CLIENT_SECRET");

  if (!tokenUrl || !clientId || !clientSecret) {
    throw new Error(
      "Missing environment variables: FUEL_FINDER_TOKEN_URL, FUEL_FINDER_CLIENT_ID, FUEL_FINDER_CLIENT_SECRET"
    );
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "fuelfinder.read",
  });

  const tokenResponse = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
    cache: "no-store",
  });

  const tokenText = await tokenResponse.text();

  if (!tokenResponse.ok) {
    throw new Error(`Token request failed: ${tokenResponse.status} ${tokenText}`);
  }

  const tokenData = JSON.parse(tokenText);

  const accessToken =
    tokenData?.access_token ||
    tokenData?.data?.access_token;

  const expiresIn =
    tokenData?.expires_in ||
    tokenData?.data?.expires_in ||
    3600;

  if (!accessToken) {
    throw new Error(`Token response missing access_token: ${tokenText}`);
  }

  tokenCache = {
    accessToken,
    expiresAt: Date.now() + Number(expiresIn) * 1000,
  };

  return tokenCache.accessToken;
}

async function fetchFuelFinderJson(url, token) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    cache: "no-store",
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Fuel Finder request failed: ${response.status} ${text}`);
  }

  return JSON.parse(text);
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const stationsUrl = cleanEnv("FUEL_FINDER_STATIONS_URL");
    const pricesUrl = cleanEnv("FUEL_FINDER_PRICES_URL");

    if (!stationsUrl || !pricesUrl) {
      throw new Error(
        "Missing environment variables: FUEL_FINDER_STATIONS_URL and/or FUEL_FINDER_PRICES_URL"
      );
    }

    const token = await getAccessToken();

    const [stationsPayload, pricesPayload] = await Promise.all([
      fetchFuelFinderJson(stationsUrl, token),
      fetchFuelFinderJson(pricesUrl, token),
    ]);

    const stationRecords = getApiArray(stationsPayload);
    const priceRecords = getApiArray(pricesPayload);

    const priceMap = new Map(
      priceRecords.map((record, index) => [
        getNodeId(record, `price-${index + 1}`),
        record,
      ])
    );

    const normalized = stationRecords
      .map((record, index) =>
        normalizeStationRecord(record, index, priceMap.get(getNodeId(record)))
      )
      .filter(Boolean);

    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=60");
    return res.status(200).json(normalized);
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Internal server error",
      region: process.env.VERCEL_REGION || "unknown",
    });
  }
}
