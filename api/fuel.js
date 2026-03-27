export default async function handler(req, res) {
  try {
    const response = await fetch(process.env.FUEL_FINDER_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        client_id: process.env.FUEL_FINDER_CLIENT_ID,
        client_secret: process.env.FUEL_FINDER_CLIENT_SECRET
      })
    });

    const text = await response.text();

    return res.status(200).json({
      status: response.status,
      response: text
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message
    });
  }
}
