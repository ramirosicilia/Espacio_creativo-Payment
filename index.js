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
  notification_url:`${process.env.URL_PAYMENTS}/order`, // 🟢 tu webhook /orden
  back_urls: {
    success: `${process.env.URL_FRONT}/capitulo/${mp[0].categoria}/${mp[0].id}`,
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
  const accessToken = process.env.MERCADO_PAGO_ACCESS_TOKEN;
  const timestamp = new Date().toISOString();

  try {
    console.log(`\n📩 [${timestamp}] --- Webhook recibido ---`);
    console.log(JSON.stringify(req.body, null, 2));

    const { type, action, data } = req.body;

    if (!type || !data?.id) {
      console.warn(`[${timestamp}] ⚠️ Webhook sin datos válidos`);
      return res.sendStatus(200);
    }

    console.log(`[${timestamp}] 📌 Tipo: ${type} | Acción: ${action}`);

    let pago = null;
    let externalReference = null;

    // ==========================
    // 🟢 1. INTENTO CON PAYMENT
    // ==========================
    if (type === "payment" && data.id) {
      const paymentRes = await fetch(
        `https://api.mercadopago.com/v1/payments/${data.id}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );

      if (paymentRes.ok) {
        pago = await paymentRes.json();
        externalReference = pago.external_reference;
        console.log(
          `[${timestamp}] 💳 Pago consultado [${pago.id}] -> ${pago.status}`
        );
      } else {
        console.error(
          `[${timestamp}] ❌ Error al consultar pago:`,
          await paymentRes.text()
        );
      }
    }

    // ====================================
    // 🟡 2. SI NO ESTÁ APROBADO, CONSULTA ORDEN
    // ====================================
    if (!pago || pago.status !== "approved") {
      console.log(`[${timestamp}] 🔎 Consultando merchant_order...`);

      const orderRes = await fetch(
        `https://api.mercadopago.com/merchant_orders/${data.id}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );

      if (orderRes.ok) {
        const orden = await orderRes.json();
        console.log(
          `[${timestamp}] 📦 Orden encontrada [${orden.id}] con ${orden.payments?.length || 0} pagos`
        );

        externalReference = orden.external_reference || externalReference;

        const pagoAprobado = orden.payments?.find(
          (p) => p.status === "approved"
        );

        if (pagoAprobado) {
          console.log(
            `[${timestamp}] 💚 Pago aprobado detectado en orden: ${pagoAprobado.id}`
          );

          const pagoFinalRes = await fetch(
            `https://api.mercadopago.com/v1/payments/${pagoAprobado.id}`,
            {
              headers: { Authorization: `Bearer ${accessToken}` },
            }
          );

          if (pagoFinalRes.ok) {
            pago = await pagoFinalRes.json();
          } else {
            console.error(
              `[${timestamp}] ❌ No se pudo obtener detalles del pago aprobado`
            );
          }
        }
      } else {
        console.error(
          `[${timestamp}] ❌ Error al consultar merchant_order:`,
          await orderRes.text()
        );
      }
    }

    // ==========================
    // 🔴 3. SI NO HAY APROBADO, SALIMOS
    // ==========================
    if (!pago || pago.status !== "approved") {
      console.warn(`[${timestamp}] ⛔️ Aún no hay pago aprobado`);
      return res.sendStatus(200);
    }

    // ==========================
    // 🧾 4. EXTRAER DATOS
    // ==========================
    const paymentId = pago.id?.toString();
    const libroId =
      pago.metadata?.libroId?.toString() ||
      pago.external_reference?.toString() ||
      externalReference?.toString() ||
      pago.additional_info?.items?.[0]?.id?.toString() ||
      null;

    const amount = pago.transaction_amount || 0;
    const currency = pago.currency_id || "ARS";
    const status = pago.status || "unknown";

    console.log(`[${timestamp}] 💾 Datos para guardar:`, {
      payment_id: paymentId,
      libro_id: libroId,
      status,
      amount,
      currency,
    });

    if (!libroId) {
      console.warn(`[${timestamp}] ⚠️ No se encontró libro_id, se omite guardado`);
      return res.sendStatus(200);
    }

    // ==========================
    // 💽 5. GUARDAR EN SUPABASE
    // ==========================
    const { error: insertError } = await supabase.from("pagos").insert([
      {
        payment_id: paymentId,
        libro_id: libroId,
        status,
        amount,
        currency,
      },
    ]);

    if (insertError) {
      console.error(`[${timestamp}] ❌ Error al insertar en Supabase:`, insertError.message);
      return res.sendStatus(500);
    }

    console.log(`[${timestamp}] ✅ Pago guardado correctamente en Supabase`);
    return res.sendStatus(200);
  } catch (error) {
    console.error(`[${timestamp}] 💥 Error general en webhook:`, error);
    return res.sendStatus(500);
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

app.post("/registrar_pago_manual", async (req, res) => {
  try {
    const { libro_id, status, payment_id, amount, currency } = req.body;

    if (!libro_id || !status) {
      return res.status(400).json({ error: "Datos incompletos" });
    }

    const { error } = await supabase.from("pagos").insert([
      {
        libro_id,
        status,
        payment_id,
        amount,
        currency,
      },
    ]);

    if (error) throw error;

    console.log("💾 Pago registrado manualmente desde frontend:", libro_id);
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Error en /registrar_pago_manual:", err);
    res.status(500).json({ error: "Error al registrar pago manualmente" });
  }
});




app.listen(port, () =>
  console.log(`✅ Servidor backend escuchando en http://localhost:${port}`)
);