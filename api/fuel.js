let tokenCache = {
  accessToken: null,
  expiresAt: 0,
};

async function getAccessToken() {
  const now = Date.now();

  // reuse token if still valid
  if (tokenCache.accessToken && now < tokenCache.expiresAt - 60000) {
    return tokenCache.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.FUEL_FINDER_CLIENT_ID,
    client_secret: process.env.FUEL_FINDER_CLIENT_SECRET,
  });

  const response = await fetch(process.env.FUEL_FINDER_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: body.toString()
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error("Token request failed: " + response.status + " " + text);
  }

  const data = await response.json();

  if (!data.access_token) {
    throw new Error("No access token returned");
  }

  tokenCache = {
    accessToken: data.access_token,
    expiresAt: now + (Number(data.expires_in || 300) * 1000),
  };

  return tokenCache.accessToken;
}

async function fetchGovJson(url) {
  if (!url) {
    throw new Error("Missing API URL (check Vercel env variables)");
  }

  const token = await getAccessToken();

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json"
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error("API request failed: " + response.status + " " + text);
  }

  return response.json();
}

export default async function handler(req, res) {
  try {
    const prices = await fetchGovJson(process.env.FUEL_FINDER_PRICES_URL);
    const stations = await fetchGovJson(process.env.FUEL_FINDER_STATIONS_URL);

    return res.status(200).json({
      prices,
      stations
    });

  } catch (error) {
    console.error("ERROR:", error);

    return res.status(500).json({
      error: error.message || "Something went wrong"
    });
  }
}
