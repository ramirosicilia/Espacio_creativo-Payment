// index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import morgan from "morgan";
import { MercadoPagoConfig, Preference } from "mercadopago";
import fetch from "node-fetch";
import fs from "fs";

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

// 🔐 Inicializar SDK Mercado Pago
const client = new MercadoPagoConfig({
  accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN,
  options: { timeout: 40000 },
});

const preference = new Preference(client);

// 🧰 Middlewares
app.use(morgan("dev"));
app.use(express.json());
app.use(
  cors({
    origin: [
      process.env.URL_FRONT,
      process.env.URL_PAYMENTS,
      "http://localhost:5173",
    ],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// 🏠 Ruta base
app.get("/", (req, res) => {
  res.send("✅ Servidor de pagos Mercado Pago funcionando");
});

// 💰 Crear preferencia
app.post("/create_preference", async (req, res) => {
  try {
    const { mp } = req.body;

    if (!mp || !Array.isArray(mp) || mp.length === 0) {
      return res.status(400).json({ error: "No se recibieron productos válidos." });
    }

    const preferenceBody = {
      items: mp.map((item) => ({
        id: item.id,
        title: item.name,
        quantity: Number(item.quantity) || 1,
        unit_price: Number(item.unit_price),
        currency_id: "ARS",
        })),
        metadata: {
    libroId: String(mp[0].id),
  },

      back_urls: {
        success: process.env.URL_FRONT,
        failure: process.env.URL_FRONT,
        pending: process.env.URL_FRONT,
      },
      auto_return: "approved",
     notification_url: `${process.env.URL_PAYMENTS || ''}/orden`,

    };

    const result = await preference.create({ body: preferenceBody });
    console.log("🟢 Preferencia creada:", result.id);

    res.json({ id: result.id });
  } catch (error) {
    console.error("❌ Error al crear preferencia:", error.message);
    res.status(500).json({ error: "Error al crear la preferencia", detalle: error.message });
  }
});

// 🟢 Pagos exitosos
const pagosExitosos = new Set();

// ✅ Webhook Mercado Pago
let pagosExitosos = new Set();
const archivoPagos = "./pagos.json";

if (fs.existsSync(archivoPagos)) {
  try {
    const data = JSON.parse(fs.readFileSync(archivoPagos, "utf8"));
    pagosExitosos = new Set(data);
    console.log("📂 Pagos cargados desde archivo:", [...pagosExitosos]);
  } catch (err) {
    console.error("⚠️ Error leyendo pagos.json:", err);
  }
}

// 🟢 Guardar pagos en archivo
function guardarPagos() {
  try {
    fs.writeFileSync(archivoPagos, JSON.stringify([...pagosExitosos], null, 2));
    console.log("💾 Pagos guardados en archivo");
  } catch (err) {
    console.error("❌ Error guardando pagos:", err);
  }
}


// 🔽 🔽 🔽  A partir de acá va tu código exactamente igual 🔽 🔽 🔽

app.post("/orden", async (req, res) => {
  try {
    const { type, action, data } = req.body;

    // ✅ Nuevo chequeo: se ejecuta solo cuando el webhook corresponde a un pago y la acción es creación o actualización
    if (type !== "payment" || !["payment.created", "payment.updated"].includes(action) || !data?.id) {
      console.warn(`⚠️ Webhook ignorado: type=${type}, action=${action}`);
      return res.sendStatus(200);
    }

    const paymentId = data.id;
    console.log("📩 Pago ID recibido:", paymentId);

    // 1️⃣ Obtener el pago completo
    const pagoResponse = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}` },
    });

    if (!pagoResponse.ok) {
      const errorText = await pagoResponse.text();
      console.error("❌ Error consultando pago:", errorText);
      return res.sendStatus(500);
    }

    const pago = await pagoResponse.json();
    console.log("🧾 Estado del pago:", pago.status);

    // 2️⃣ Obtener external_reference si hace falta
    let externalReference = pago.external_reference;
    if (!externalReference && pago.order?.id) {
      const orderResponse = await fetch(`https://api.mercadopago.com/merchant_orders/${pago.order.id}`, {
        headers: { Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}` },
      });

      if (orderResponse.ok) {
        const ordenData = await orderResponse.json();
        externalReference = ordenData.external_reference;
      }
    }

    if (!externalReference) {
      console.error("❌ No se pudo obtener external_reference");
      return res.status(400).json({ error: "Falta external_reference" });
    }

    // 3️⃣ Registrar pago aprobado
    if (pago.status === "approved") {
      const libroId = pago.metadata?.libroId;
      if (libroId) {
        pagosExitosos.add(libroId.toString());
        guardarPagos(); // 🟢 guardamos en archivo persistente
        console.log("✅ Libro pagado registrado:", libroId);
      } else {
        console.warn("⚠️ El pago fue aprobado pero no llegó metadata.libroId");
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Error en webhook /orden:", error);
    res.sendStatus(500);
  }
});

// ✅ Consulta rápida de pagos
app.get("/webhook_estado", (req, res) => {
  const { libroId } = req.query;
  if (!libroId) return res.status(400).json({ error: "Falta libroId" });

  const pagoConfirmado = pagosExitosos.has(libroId.toString());
  console.log("Consulta estado pago:", libroId, "->", pagoConfirmado);

  res.json({ pago_exitoso: pagoConfirmado });
});

// 🚀 Iniciar servidor
app.listen(port, () => {
  console.log(`✅ Servidor backend escuchando en http://localhost:${port}`);
});
