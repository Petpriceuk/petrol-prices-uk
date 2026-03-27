let tokenCache = {
  accessToken: null,
  expiresAt: 0,
};

async function getAccessToken() {
  const now = Date.now();

  if (tokenCache.accessToken && now < tokenCache.expiresAt - 60000) {
    return tokenCache.accessToken;
  }

  const response = await fetch(process.env.FUEL_FINDER_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      client_id: process.env.FUEL_FINDER_CLIENT_ID,
      client_secret: process.env.FUEL_FINDER_CLIENT_SECRET,
    }),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error("Token request failed: " + response.status + " " + text);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Token response was not valid JSON: " + text);
  }

  const accessToken = data.access_token || data.token || data.accessToken;

  if (!accessToken) {
    throw new Error("No token returned: " + text);
  }

  tokenCache = {
    accessToken,
    expiresAt: now + Number(data.expires_in || 3600) * 1000,
  };

  return tokenCache.accessToken;
}

async function fetchGovJson(url) {
  if (!url) {
    throw new Error("Missing API URL in environment variables");
  }

  const token = await getAccessToken();

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error("API request failed: " + response.status + " " + text);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("API response was not valid JSON: " + text);
  }
}

export default async function handler(req, res) {
  try {
    const prices = await fetchGovJson(process.env.FUEL_FINDER_PRICES_URL);
    const stations = await fetchGovJson(process.env.FUEL_FINDER_STATIONS_URL);

    return res.status(200).json({
      prices,
      stations,
    });
  } catch (error) {
    console.error("Fuel API error:", error);

    return res.status(500).json({
      error: error.message || "Something went wrong",
    });
  }
}
