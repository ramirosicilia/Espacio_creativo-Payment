// index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import morgan from "morgan";
import { MercadoPagoConfig, Preference } from "mercadopago";
import fetch from "node-fetch";

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
      "https://espacio-creativo-front.onrender.com", // ✅ frontend en producción
      "http://localhost:5173",                       // ✅ para desarrollo local
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
      back_urls: {
        success: process.env.URL_FRONT,
        failure: process.env.URL_FRONT,
        pending: process.env.URL_FRONT,
      },
      auto_return: "approved",
      notification_url: `${process.env.URL_PAYMENTS || "https://tu-servidor.com"}/orden`, // 👈 webhook oficial
    };

    const result = await preference.create({ body: preferenceBody });
    console.log("🟢 Preferencia creada:", result.id);

    res.json({ id: result.id });
  } catch (error) {
    console.error("❌ Error al crear preferencia:", error.message);
    res.status(500).json({ error: "Error al crear la preferencia", detalle: error.message });
  }
});


// 🟢 Estado temporal



// ✅ Mercado Pago llama a esta ruta automáticamente
const pagosExitosos = new Set();

app.post("/orden", async (req, res) => {
  try {
    console.log("🔔 Webhook recibido:", req.body);

    const data = req.body;

    if (data.type === "payment" && data.data?.id) {
      const paymentId = data.data.id;
      console.log("📩 Pago ID recibido:", paymentId);

      const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: {
          Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}`,
        },
      });

      const pago = await response.json();
      console.log("🧾 Estado del pago:", pago.status);

      if (pago.status === "approved") {
        const items = pago.additional_info?.items || [];
        items.forEach((item) => pagosExitosos.add(item.id.toString()));

        console.log("✅ Pagos exitosos:", [...pagosExitosos]);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Error en webhook /orden:", error);
    res.sendStatus(500);
  }
});

// ✅ Consulta real
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
