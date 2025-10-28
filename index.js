// index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import morgan from "morgan";
import fetch from "node-fetch"; // ⚡ necesario si usas Node 18 o menor
import { MercadoPagoConfig, Preference } from "mercadopago";
import { supabase } from "./DB.js"; 


dotenv.config();

const app = express();
const port = process.env.PORT || 5000;


const client = new MercadoPagoConfig({
  accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN,
  options: { timeout: 40000 },
});
const preference = new Preference(client);

// Middlewares
app.use(morgan("dev"));
app.use(express.json());
app.use(
  cors({
    origin: process.env.URL_FRONT,
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
   allowedHeaders: ["Content-Type", "Authorization"]
  })
);


// 🏠 Test
app.get("/", (req, res) => res.send("✅ Backend MercadoPago + Supabase funcionando correctamente"));

// 💳 Crear preferencia de pago
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
  metadata: {
    libroId: mp[0].id,
    categoria: mp[0].categoria, // 👈 agregamos categoría para redirigir correctamente
  },
  external_reference: mp[0].id,
  notification_url:process.env.URL_PAYMENTS, // 🟢 tu webhook /orden
  back_urls: {
    success: `${process.env.URL_FRONT}/comprar/${mp[0].categoria}/${mp[0].id}`,
    failure: `${process.env.URL_FRONT}/comprar/${mp[0].categoria}/${mp[0].id}`,
    pending: `${process.env.URL_FRONT}/comprar/${mp[0].categoria}/${mp[0].id}`,
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

// 🧾 Webhook MercadoPago
app.post("/order", async (req, res) => {
  try {
    console.log("📩 Webhook recibido:", JSON.stringify(req.body, null, 2));
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

      const amount = pago.transaction_amount || 0;

      // 🟢 Guardar en Supabase
      const { error: insertError } = await supabase.from("pagos").insert([
        {
          payment_id: paymentId,
          libro_id: libroId,
          status: pago.status,
          amount: amount,
          currency: pago.currency_id || "ARS",
        },
      ]);

      if (insertError) {
        console.error("❌ Error insertando en Supabase:", insertError.message);
      } else {
        console.log("✅ Pago guardado en Supabase correctamente.");
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Error procesando webhook:", error);
    res.sendStatus(500);
  }
});

// 🔍 Consulta desde el front para desbloquear
app.get("/webhook_estado", async (req, res) => {
  const libroId = req.query.libroId;
  console.log("📘 Consultando libroId:", libroId, typeof libroId);

  let intentos = 0;
  const maxIntentos = 20; // espera máx. 10 veces (~15s)

  try {
    while (intentos < maxIntentos) {
      const { data, error } = await supabase
        .from("pagos")
        .select("*")
        .eq("libro_id", +libroId)
        .eq("status", "approved");

      if (error) throw error;

      if (data && data.length > 0) {
        console.log("✅ Pago encontrado:", data);
        return res.json({ pago_exitoso: true, data });
      }

      intentos++;
      console.log(`⏳ Intento ${intentos}: no se encontró pago aún...`);
      await new Promise((r) => setTimeout(r, 1500)); // espera 1.5 segundos
    }

    console.warn("⚠️ No se detectó pago después de varios intentos.");
    res.json({ pago_exitoso: false, data: [] });
  } catch (err) {
    console.error("❌ Error en /webhook_estado:", err);
    res.status(500).json({ error: "Error al consultar el pago" });
  }
});



app.listen(port, () =>
  console.log(`✅ Servidor backend escuchando en http://localhost:${port}`)
);