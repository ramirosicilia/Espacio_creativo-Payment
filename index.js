// index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import morgan from "morgan";
import { MercadoPagoConfig, Preference } from "mercadopago";
import fetch from "node-fetch"; // 🟢 agregado para consultar el pago

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


// 🟢🟢🟢🟢🟢  AGREGADO: LÓGICA DE WEBHOOK Y CONTROL DE ESTADO 🟢🟢🟢🟢🟢

// Variable temporal (sin base de datos)
let pagoExitoso = false;

// ✅ Webhook que Mercado Pago llama automáticamente después del pago
app.post("/webhook", async (req, res) => {
  try {
    const data = req.body;

    // Solo actuamos si el webhook es del tipo "payment"
    if (data.type === "payment" && data.data && data.data.id) {
      const paymentId = data.data.id;

      // Consultar los detalles del pago en la API de MP
      const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: {
          Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}`,
        },
      });

      const pago = await response.json();
      console.log("🧾 Estado del pago recibido:", pago.status);

      // Si está aprobado, activamos la bandera
      if (pago.status === "approved") {
        pagoExitoso = true;
        console.log("✅ Pago aprobado — listo para desbloquear cuentos");
      } else {
        console.log("⚠️ Pago no aprobado:", pago.status);
      }
    }

    // Responder siempre 200 a Mercado Pago
    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Error en webhook:", error);
    res.sendStatus(500);
  }
});

// ✅ Endpoint que consulta el frontend cada pocos segundos
app.get("/webhook_estado", (req, res) => {
  res.json({ pago_exitoso: pagoExitoso });

  // Reiniciar bandera para no dejar desbloqueado eternamente
  if (pagoExitoso) pagoExitoso = false;
});


// 🚀 Iniciar servidor
app.listen(port, () => {
  console.log(`✅ Servidor backend escuchando en http://localhost:${port}`);
});
