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
console.log("🔹 Inicializando Mercado Pago...");
const client = new MercadoPagoConfig({
  accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN,
  options: { timeout: 40000 },
});
const preference = new Preference(client);

// 🧰 Middlewares
console.log("🔹 Configurando middlewares...");
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
  console.log("🔹 GET / recibido");
  res.send("✅ Servidor de pagos Mercado Pago funcionando");
});

// 💰 Crear preferencia
app.post("/create_preference", async (req, res) => {
  console.log("📥 POST /create_preference recibido:", JSON.stringify(req.body, null, 2));
  try {
    const { mp } = req.body;
    console.log("🔹 Productos recibidos:", mp);

    if (!mp || !Array.isArray(mp) || mp.length === 0) {
      console.warn("⚠️ No se recibieron productos válidos.");
      return res.status(400).json({ error: "No se recibieron productos válidos." });
    }

    const preferenceBody = {
      items: mp.map((item) => {
        console.log("🔹 Procesando item:", item);
        return {
          id: item.id,
          title: item.name,
          quantity: Number(item.quantity) || 1,
          unit_price: Number(item.unit_price),
          currency_id: "ARS",
        };
      }),
      metadata: {
        libroId: mp[0].id.toString(),
      },
      external_reference: mp[0].id.toString(),
      notification_url: process.env.URL_PAYMENTS,
      back_urls: {
        success: process.env.URL_FRONT,
        failure: process.env.URL_FRONT,
        pending: process.env.URL_FRONT,
      },
      auto_return: "approved",
    };

    console.log("🔹 Preference body creado:", JSON.stringify(preferenceBody, null, 2));

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
console.log("🔹 Set de pagos exitosos inicializado");

// ✅ Webhook Mercado Pago
app.post("/orden", async (req, res) => {
  console.log("📥 POST /orden recibido:", JSON.stringify(req.body, null, 2));
  try {
    const { type, data } = req.body;
    console.log("🔹 Tipo de webhook:", type);
    if (type !== "payment" || !data?.id) {
      console.warn(`⚠️ Webhook ignorado: type=${type}, data.id=${data?.id}`);
      return res.sendStatus(200);
    }

    const paymentId = data.id;
    console.log("📩 Pago ID recibido:", paymentId);

    // 1️⃣ Obtener el pago completo
    console.log("🔹 Consultando pago completo...");
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
    console.log("🔹 Datos completos del pago:", JSON.stringify(pago, null, 2));

    // 2️⃣ Obtener external_reference si hace falta
    let externalReference = pago.external_reference;
    console.log("🔹 External reference inicial:", externalReference);
    if (!externalReference && pago.order?.id) {
      console.log("🔹 Obteniendo external_reference desde merchant_orders...");
      const orderResponse = await fetch(`https://api.mercadopago.com/merchant_orders/${pago.order.id}`, {
        headers: { Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}` },
      });

      if (orderResponse.ok) {
        const ordenData = await orderResponse.json();
        externalReference = ordenData.external_reference;
        console.log("🔹 External reference obtenido desde merchant_orders:", externalReference);
      }
    }

    if (!externalReference) {
      console.error("❌ No se pudo obtener external_reference");
      return res.status(400).json({ error: "Falta external_reference" });
    }

    // 3️⃣ Registrar pago aprobado
    if (pago.status === "approved") {
     let libroId = pago.metadata?.libroId 
  ?? pago.metadata?.libro_id 
  ?? pago.external_reference 
  ?? pago.additional_info?.items?.[0]?.id;

if (!libroId && pago.order?.id) {
  // Si aún no lo tenemos, buscamos desde merchant_orders
  const orderResponse = await fetch(
    `https://api.mercadopago.com/merchant_orders/${pago.order.id}`,
    { headers: { Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}` } }
  );
  if (orderResponse.ok) {
    const ordenData = await orderResponse.json();
    libroId = ordenData.external_reference;
  }
}

if (pago.status === "approved" && libroId) {
  pagosExitosos.add(libroId.toString());
  console.log("✅ Pago confirmado para libroId:", libroId);
} else {
  console.warn("⚠️ No se pudo obtener libroId o el pago no está aprobado:", libroId, pago.status);
}

      console.log("🔹 Metadata del pago:", pago.metadata);

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
  console.log("📥 GET /webhook_estado recibido:", JSON.stringify(req.query, null, 2));
  const { libroId } = req.query;

  console.log("🔹 libroId recibido:", libroId);
  if (!libroId) return res.status(400).json({ error: "Falta libroId" });

  const pagoConfirmado = pagosExitosos.has(libroId.toString());
  console.log("🔹 Consulta estado pago:", libroId, "->", pagoConfirmado);

  res.json({ pago_exitoso: pagoConfirmado });
});

// 🟢 agregado: endpoint de prueba manual (para frontend)
app.get("/force_unlock/:libroId", (req, res) => {
  const { libroId } = req.params;
  pagosExitosos.add(libroId.toString());
  console.log("🟢 Pago forzado manualmente como exitoso:", libroId);
  res.json({ ok: true, libroId });
});

// 🚀 Iniciar servidor
app.listen(port, () => {
  console.log(`✅ Servidor backend escuchando en http://localhost:${port}`);
});
