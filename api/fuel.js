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
    },
    body: JSON.stringify({
      client_id: process.env.FUEL_FINDER_CLIENT_ID,
      client_secret: process.env.FUEL_FINDER_CLIENT_SECRET,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error("Token request failed: " + response.status + " " + text);
  }

  const data = await response.json();

  tokenCache = {
    accessToken: data.access_token,
    expiresAt: now + (Number(data.expires_in || 300) * 1000),
  };

  return tokenCache.accessToken;
}

async function fetchGovJson(url) {
  const token = await getAccessToken();

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error("API request failed: " + response.status + " " + text);
  }

  return response.json();
}

export default async function handler(req, res) {
  try {
    const [prices, stations] = await Promise.all([
      fetchGovJson(process.env.FUEL_FINDER_PRICES_URL),
      fetchGovJson(process.env.FUEL_FINDER_STATIONS_URL),
    ]);

    return res.status(200).json({
      prices,
      stations,
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Something went wrong",
    });
  }
}
