const http = require('http');
const fs = require('fs');
const path = require('path');

const CCU_IP = process.env.CCU_IP || "192.168.178.37";
const PORT = process.env.PORT || 3001;

function executeRega(script) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: CCU_IP,
      port: 80,
      path: '/tclrega.exe',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=iso-8859-1',
        'Content-Length': Buffer.byteLength(script)
      }
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('latin1');
        resolve(body);
      });
    });

    req.on('error', err => reject(err));
    req.write(script);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Servir el archivo index.html
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Error al cargar index.html');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // Endpoint unificado para lectura y escritura (/api/devices)
  if (req.url === '/api/devices') {
    // GET: Obtener termostatos y sus temperaturas
    if (req.method === 'GET') {
      try {
        const listScript = `
          string devId;
          boolean first = true;
          Write("###START###[");
          foreach(devId, root.Devices().EnumIDs()) {
            object dev = dom.GetObject(devId);
            if (dev) {
              if (dev.TypeName() == "DEVICE") {
                string devType = dev.HssType();
                if ((devType == "HM-CC-RT-DN") || (devType == "HM-TC-IT-WM-W-EU")) {
                  string devAddress = dev.Address();
                  string name = dev.Name();
                  if (!first) { Write(","); }
                  Write("{\\"id\\":\\"" # devId # "\\",\\"name\\":\\"" # name # "\\",\\"type\\":\\"" # devType # "\\",\\"address\\":\\"" # devAddress # "\\"}");
                  first = false;
                }
              }
            }
          }
          Write("]###END###");
        `;

        const responseBody = await executeRega(listScript);
        const startMarker = "###START###";
        const endMarker = "###END###";
        
        const startIndex = responseBody.indexOf(startMarker);
        const endIndex = responseBody.indexOf(endMarker);

        if (startIndex === -1 || endIndex === -1) {
          throw new Error("No se pudo obtener la lista base de dispositivos.");
        }

        let cleanJson = responseBody.substring(startIndex + startMarker.length, endIndex);
        cleanJson = cleanJson
          .replace(/Ö/g, 'Ö').replace(/ö/g, 'ö')
          .replace(/Ü/g, 'Ü').replace(/ü/g, 'ü')
          .replace(/Ä/g, 'Ä').replace(/ä/g, 'ä')
          .replace(/ß/g, 'ß');

        const devices = JSON.parse(cleanJson);

        for (let dev of devices) {
          const tempScript = `
            string act = "--";
            string set = "--";
            object devObj = dom.GetObject("${dev.id}");
            if (devObj) {
              string chId;
              foreach(chId, devObj.Channels().EnumIDs()) {
                object ch = dom.GetObject(chId);
                if (ch) {
                  object dpAct = ch.DPByHssDP("ACTUAL_TEMPERATURE");
                  if (dpAct) { act = dpAct.Value().ToString(1); }
                  object dpSet = ch.DPByHssDP("SET_TEMPERATURE");
                  if (dpSet) { set = dpSet.Value().ToString(1); }
                }
              }
            }
            Write("###TEMP###" # act # "|" # set # "###ENDTEMP###");
          `;

          try {
            const tempRes = await executeRega(tempScript);
            const tStart = tempRes.indexOf("###TEMP###");
            const tEnd = tempRes.indexOf("###ENDTEMP###");

            if (tStart !== -1 && tEnd !== -1) {
              const rawTemps = tempRes.substring(tStart + 10, tEnd).split("|");
              dev.actualTemp = (rawTemps[0] && rawTemps[0] !== "null") ? rawTemps[0] : "--";
              dev.setTemp = (rawTemps[1] && rawTemps[1] !== "null") ? rawTemps[1] : "--";
            } else {
              dev.actualTemp = "--";
              dev.setTemp = "--";
            }
          } catch (e) {
            dev.actualTemp = "--";
            dev.setTemp = "--";
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ result: devices }));

      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `Error procesando dispositivos: ${e.message}` }));
      }
      return;
    }

    // POST: Ajustar temperatura de consigna
    if (req.method === 'POST') {
      let bodyData = '';
      req.on('data', chunk => { bodyData += chunk.toString(); });
      req.on('end', async () => {
        try {
          const { devId, temp } = JSON.parse(bodyData);

          const setScript = `
            object devObj = dom.GetObject("${devId}");
            if (devObj) {
              string chId;
              foreach(chId, devObj.Channels().EnumIDs()) {
                object ch = dom.GetObject(chId);
                if (ch) {
                  object dpSet = ch.DPByHssDP("SET_TEMPERATURE");
                  if (dpSet) { dpSet.State(${temp}); }
                }
              }
            }
            Write("###OK###");
          `;

          const setRes = await executeRega(setScript);
          if (setRes.includes("###OK###")) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: true }));
          } else {
            throw new Error("La CCU2 no confirmó el cambio de temperatura.");
          }
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`Servidor local corriendo en http://localhost:${PORT}`);
});
