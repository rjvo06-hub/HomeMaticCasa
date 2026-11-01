export default async function handler(req, res) {
  const CCU_IP = "192.168.178.37";
  const url = `http://${CCU_IP}/api/homematic.cgi`;

  const payload = {
    method: "Device.listAllDetail",
    params: {}
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ 
      error: "No se pudo conectar con la CCU2. Asegúrate de estar en la misma red Wi-Fi.",
      details: error.message 
    });
  }
}
