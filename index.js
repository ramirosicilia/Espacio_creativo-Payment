// index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import morgan from "morgan";
import { MercadoPagoConfig, Preference } from "mercadopago";

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

// 🔐 Inicializar SDK de Mercado Pago
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
    origin: [process.env.URL_FRONT || "http://localhost:5173"], // Ajustá al dominio real del front
  })
);

// 🏠 Ruta base
app.get("/", (req, res) => {
  res.send("✅ Servidor de pagos Mercado Pago funcionando");
});

// 💰 Crear preferencia de pago
app.post("/create_preference", async (req, res) => {
  try {
    const { mp } = req.body;

    if (!mp || !Array.isArray(mp) || mp.length === 0) {
      return res.status(400).json({ error: "No se recibieron productos válidos." });
    }

    // Armar la preferencia
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
    };

    const result = await preference.create({ body: preferenceBody });
    console.log("🟢 Preferencia creada:", result.id);

    res.json({ id: result.id });
  } catch (error) {
    console.error("❌ Error al crear preferencia:", error.message);
    res.status(500).json({ error: "Error al crear la preferencia", detalle: error.message });
  }
});

// 🚀 Iniciar servidor
app.listen(port, () => {
  console.log(`✅ Servidor backend escuchando en http://localhost:${port}`);
});
