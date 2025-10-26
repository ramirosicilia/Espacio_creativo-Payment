// index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import morgan from "morgan";
import fetch from "node-fetch"; // ⚡ necesario si usas Node 18 o menor
import { MercadoPagoConfig, Preference } from "mercadopago";

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

// 🟢 Inicializa Mercado Pago
console.log("🔹 Inicializando Mercado Pago...");
const client = new MercadoPagoConfig({
  accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN,
  options: { timeout: 40000 },
});
const preference = new Preference(client);

// 🧩 Middlewares
app.use(morgan("dev"));
app.use(express.json());
app.use(
  cors({
    origin: [
      process.env.URL_FRONT,
      process.env.URL_PAYMENTS,
      "*",
    ],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// 🏠 Ruta base
app.get("/", (req, res) => res.send("✅ Servidor de pagos Mercado Pago funcionando correctamente"));

// 💳 Crear preferencia
app.post("/create_preference", async (req, res) => {
  try {
    const { mp } = req.body;

    if (!mp || !Array.isArray(mp) || mp.length === 0)
      return res.status(400).json({ error: "No se recibieron productos válidos." });

    const preferenceBody = {
      items: mp.map((item) => ({
        id: item.id,
        title: item.name,
        quantity: Number(item.quantity),
        unit_price: Number(item.unit_price),
        currency_id: "ARS",
      })),
      metadata: { libroId: mp[0].id },
      external_reference: mp[0].id,
      notification_url: process.env.URL_PAYMENTS,
      back_urls: {
        success: process.env.URL_FRONT,
        failure: process.env.URL_FRONT,
        pending: process.env.URL_FRONT,
      },
      auto_return: "approved",
    };

    const result = await preference.create({ body: preferenceBody });
    console.log("🟢 Preferencia creada:", result.id);
    res.json({ id: result.id });
  } catch (error) {
    console.error("❌ Error al crear preferencia:", error);
    res.status(500).json({ error: "Error al crear preferencia" });
  }
});

// 🧾 Webhook: recibe pagos aprobados
const pagosExitosos = new Set();

app.post("/orden", async (req, res) => {
  try {
    console.log("📥 POST /orden recibido:", JSON.stringify(req.body, null, 2));
    const { type, data } = req.body;

    if (type !== "payment" || !data?.id) return res.sendStatus(200);

    const paymentId = data.id;
    const pagoResponse = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}` },
    });

    if (!pagoResponse.ok) {
      console.error("❌ Error al consultar pago:", await pagoResponse.text());
      return res.sendStatus(500);
    }

    const pago = await pagoResponse.json();
    console.log("🧾 Estado del pago:", pago.status);

    if (pago.status === "approved") {
      const libroId =
        pago.metadata?.libroId ||
        pago.external_reference ||
        pago.additional_info?.items?.[0]?.id;

      if (libroId) {
        pagosExitosos.add(libroId.toString());
        console.log("✅ Libro pagado registrado:", libroId);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Error procesando webhook:", error);
    res.sendStatus(500);
  }
});

// 🔍 Consulta desde el frontend
app.get("/webhook_estado", (req, res) => {
  const { libroId } = req.query;
  const pagoConfirmado = pagosExitosos.has(libroId?.toString());
  res.json({ pago_exitoso: pagoConfirmado });
});

// 🔓 Endpoint manual para probar desbloqueo
app.get("/force_unlock/:libroId", (req, res) => {
  const { libroId } = req.params;
  pagosExitosos.add(libroId.toString());
  res.json({ ok: true, libroId });
});

// 🧩 Endpoint para verificación directa (opcional)
app.get("/verificar_pago", async (req, res) => {
  const { libroId } = req.query;
  const response = await fetch(
    `https://api.mercadopago.com/v1/payments/search?external_reference=${libroId}`,
    { headers: { Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}` } }
  );
  const data = await response.json();
  const pagoAprobado = data.results.some((p) => p.status === "approved");
  res.json({ pago_exitoso: pagoAprobado });
});

app.listen(port, () =>
  console.log(`✅ Servidor backend escuchando en http://localhost:${port}`)
);
