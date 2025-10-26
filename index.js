// index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import morgan from "morgan";
import { MercadoPagoConfig, Preference } from "mercadopago";



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
       "*"
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

    console.log("📥 Webhook recibido:", JSON.stringify(req.body, null, 2));
  try {
    const { mp } = req.body;

    if (!mp || !Array.isArray(mp) || mp.length === 0) {
      return res.status(400).json({ error: "No se recibieron productos válidos." });
    }

    const preferenceBody = {
  items: mp.map((item) => ({
    id: item.id,                  // Mantengo tu id original
    title: item.name,
    quantity: Number(item.quantity) || 1,
    unit_price: Number(item.unit_price),
    currency_id: "ARS",           // Mantengo explícitamente ARS
  })),
  metadata: {
  libroId: mp[0].id.toString(),
},

  external_reference: mp[0].id.toString(), // Identificador único
  back_urls: {
    success: process.env.URL_FRONT,
    failure: process.env.URL_FRONT,
    pending: process.env.URL_FRONT,
  },
  auto_return: "approved",        // Redirige automáticamente si se aprueba
  notification_url: process.env.URL_PAYMENTS, // Para el webhook
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
app.post("/orden", async (req, res) => {
  try {
    const { type, data } = req.body;
    if (type !== "payment" || !data?.id) {
      console.warn(`⚠️ Webhook ignorado: type=${type}`);
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
      const libroId = pago.metadata?.libroId ?? pago.additional_info?.items?.[0]?.id;

        console.log("✅ Libro pagado registrado:", pago.metadata);
      if (libroId) {
        pagosExitosos.add(libroId.toString());
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

  console.log(libroId)
  if (!libroId) return res.status(400).json({ error: "Falta libroId" }); 

  console.log(libroId,"libro")

  const pagoConfirmado = pagosExitosos.has(libroId.toString());
  console.log("Consulta estado pago:", libroId, "->", pagoConfirmado);

  res.json({ pago_exitoso: pagoConfirmado });
});

// 🚀 Iniciar servidor
app.listen(port, () => {
  console.log(`✅ Servidor backend escuchando en http://localhost:${port}`);
});
