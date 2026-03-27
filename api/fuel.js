// File: api/fuel.js

let tokenCache = {
  accessToken: null,
  expiresAt: 0,
};

async function getAccessToken() {
  const now = Date.now();

  if (tokenCache.accessToken && now < tokenCache.expiresAt - 60_000) {
    return tokenCache.accessToken;
  }

  const tokenUrl = process.env.FUEL_FINDER_TOKEN_URL;
  const clientId = process.env.FUEL_FINDER_CLIENT_ID;
  const clientSecret = process.env.FUEL_FINDER_CLIENT_SECRET;

  if (!tokenUrl || !clientId || !clientSecret) {
    throw new Error(
      "Missing one or more environment variables: FUEL_FINDER_TOKEN_URL, FUEL_FINDER_CLIENT_ID, FUEL_FINDER_CLIENT_SECRET"
    );
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "fuelfinder.read",
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Token request failed: ${response.status} ${text}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Token response was not valid JSON: ${text}`);
  }

  if (!data.access_token) {
    throw new Error(`Token response missing access_token: ${text}`);
  }

  tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in || 3600) * 1000),
  };

  return tokenCache.accessToken;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const apiBaseUrl = process.env.FUEL_FINDER_API_BASE_URL;

    if (!apiBaseUrl) {
      throw new Error("Missing environment variable: FUEL_FINDER_API_BASE_URL");
    }

    const token = await getAccessToken();

    const cleanBaseUrl = apiBaseUrl.replace(/\/+$/, "");
    const upstreamUrl = new URL(`${cleanBaseUrl}/v1/prices`);

    // Pass through all query params from your frontend to Fuel Finder
    // Example: /api/fuel?fuel_type=unleaded
    const query = req.query || {};
    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) {
        value.forEach((v) => upstreamUrl.searchParams.append(key, v));
      } else if (value !== undefined && value !== null && value !== "") {
        upstreamUrl.searchParams.set(key, String(value));
      }
    }

    // Optional default so the endpoint works even with no query string
    if (!upstreamUrl.searchParams.has("fuel_type")) {
      upstreamUrl.searchParams.set("fuel_type", "unleaded");
    }

    const response = await fetch(upstreamUrl.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    const text = await response.text();

    if (!response.ok) {
      return res.status(response.status).json({
        error: `Fuel API request failed: ${response.status}`,
        details: text,
      });
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(502).json({
        error: "Fuel API returned non-JSON data",
        details: text,
      });
    }

    // Fuel Finder recommends caching price data for 15 minutes
    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=60");

    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Internal server error",
    });
  }
}
