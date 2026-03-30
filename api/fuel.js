export default async function handler(req, res) {
  try {
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

    const pricesJson = await pricesResponse.json();
    const stationsJson = await stationsResponse.json();

    return res.status(200).json({
      pricesSample: getSample(pricesJson),
      stationsSample: getSample(stationsJson)
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
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

  const tokenJson = await tokenResponse.json();
  return tokenJson?.data?.access_token || tokenJson?.access_token;
}

function getSample(payload) {
  if (Array.isArray(payload)) return payload.slice(0, 1);

  for (const key of ["data", "items", "results", "stations", "forecourts", "records"]) {
    if (Array.isArray(payload?.[key])) return payload[key].slice(0, 1);
    if (Array.isArray(payload?.data?.[key])) return payload.data[key].slice(0, 1);
  }

  return payload;
}
