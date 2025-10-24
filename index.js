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
    origin: [process.env.URL_FRONT || "http://localhost:5173"],
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
let pagoExitoso = false;

// ✅ Mercado Pago llama a esta ruta automáticamente
app.post("/orden", async (req, res) => {
  try {
    const data = req.body;

    // 🧾 Solo actuamos si es de tipo "payment"
    if (data.type === "payment" && data.data && data.data.id) {
      const paymentId = data.data.id;
      console.log("📩 Webhook /orden recibido con paymentId:", paymentId);

      // Consultar a Mercado Pago
      const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: {
          Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}`,
        },
      });

      const pago = await response.json();
      console.log("🧾 Estado del pago:", pago.status);

      if (pago.status === "approved") {
        pagoExitoso = true;
        console.log("✅ Pago aprobado — listo para desbloquear cuentos");
      } else {
        console.log("⚠️ Pago no aprobado:", pago.status);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Error en webhook /orden:", error);
    res.sendStatus(500);
  }
});

// ✅ El front consulta este endpoint para saber si liberar los cuentos
app.get("/webhook_estado", (req, res) => {
  res.json({ pago_exitoso: pagoExitoso });

  // Reiniciamos la bandera después de informar al front
  if (pagoExitoso) pagoExitoso = false;
});

// 🚀 Iniciar servidor
app.listen(port, () => {
  console.log(`✅ Servidor backend escuchando en http://localhost:${port}`);
});
