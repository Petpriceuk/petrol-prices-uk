export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const accessToken = await getAccessToken();

    const response = await fetch(process.env.FUEL_FINDER_API_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      const details = await response.text();
      return res.status(response.status).json({
        error: "Fuel Finder API request failed",
        details
      });
    }

    const raw = await response.json();
    const stations = normalizeFuelFinderResponse(raw);

    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");

    return res.status(200).json({ stations });
  } catch (error) {
    console.error("Fuel API route error:", error);
    return res.status(500).json({
      error: "Unable to load fuel data right now"
    });
  }
}

async function getAccessToken() {
  const response = await fetch(process.env.FUEL_FINDER_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.FUEL_FINDER_CLIENT_ID,
      client_secret: process.env.FUEL_FINDER_CLIENT_SECRET,
      ...(process.env.FUEL_FINDER_SCOPE
        ? { scope: process.env.FUEL_FINDER_SCOPE }
        : {})
    }).toString()
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Token request failed: ${response.status} ${details}`);
  }

  const json = await response.json();

  if (!json.access_token) {
    throw new Error("No access token returned");
  }

  return json.access_token;
}

function normalizeFuelFinderResponse(raw) {
  const items =
    raw.forecourts ||
    raw.stations ||
    raw.items ||
    raw.data ||
    [];

  return items
    .map((site, index) => {
      const prices = Array.isArray(site.prices) ? site.prices : [];

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

      const address = [
        addressLine1,
        addressLine2,
        city,
        county,
        postcode
      ].filter(Boolean).join(", ");

      return {
        id: String(site.forecourtId || site.id || site.siteId || `${brand}-${index + 1}`),
        latitude,
        longitude,

        brandRaw: brand,
        brandDisplay: brand,
        tradingName,

        address,
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
    price: toNumber(entry.price ?? entry.amount ?? entry.pencePerLitre),
    updatedAt: entry.updatedAt || entry.lastUpdated || entry.timestamp || null
  };
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
