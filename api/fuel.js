export default async function handler(req, res) {
  try {
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
