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
        categoria: mp[0].categoria,
      },
      external_reference: mp[0].id,
      notification_url: `${process.env.URL_PAYMENTS}/order`,
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

// ===========================================================
// 🧾 WEBHOOK MERCADO PAGO
// ===========================================================
app.post("/order", async (req, res) => {
  try {
    console.log("==================📩 WEBHOOK /order ==================");
    console.log("➡️ BODY COMPLETO:", JSON.stringify(req.body, null, 2));

    const { type, topic, data, resource } = req.body;
    let paymentId = null;
    let externalReference = null;
    let amount = 0;
    let pdf_url = null;

    // 🟢 1️⃣ Procesar si el webhook viene por "payment"
    if (topic === "payment" || type === "payment") {
      paymentId = data?.id || (typeof resource === "string" ? resource.split("/").pop() : null);

      if (!paymentId) {
        console.warn("⚠️ No hay paymentId en el webhook (se ignora).");
        return res.sendStatus(200);
      }

      console.log("🔍 Consultando pago con ID:", paymentId);
      const pagoResponse = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: { Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}` },
      });

      if (!pagoResponse.ok) {
        console.error("❌ Error al consultar pago:", await pagoResponse.text());
        return res.sendStatus(500);
      }

      const pago = await pagoResponse.json();

      if (pago.status !== "approved") {
        console.log("⛔ Pago no aprobado → se ignora.");
        return res.sendStatus(200);
      }

      console.log("✅ Pago aprobado");
      externalReference = pago.external_reference || pago.metadata?.libroId;

      // 🧮 Monto seguro
      amount =
        Number(pago.transaction_amount) ||
        Number(pago.transaction_details?.total_paid_amount) ||
        0;

      // 🔁 Si no hay monto, intentar obtenerlo desde la merchant_order
      if (amount === 0 && pago.order?.id) {
        try {
          const orderResp = await fetch(
            `https://api.mercadopago.com/merchant_orders/${pago.order.id}`,
            { headers: { Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}` } }
          );
          if (orderResp.ok) {
            const orderData = await orderResp.json();
            const approved = orderData.payments?.filter(p => p.status === "approved") || [];
            amount = approved.reduce((s, p) => s + (p.transaction_amount || 0), 0);
            console.log("💵 Monto recuperado desde merchant_order:", amount);
          }
        } catch (err) {
          console.error("❌ Error recuperando merchant_order:", err);
        }
      }
    }

    // 🟢 2️⃣ Procesar si el webhook viene por "merchant_order"
    if (topic === "merchant_order") {
      console.log("🔹 Webhook merchant_order directo");
      try {
        const orderResponse = await fetch(resource, {
          headers: { Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}` },
        });

        if (orderResponse.ok) {
          const orderData = await orderResponse.json();
          externalReference = orderData.external_reference;
          const approved = orderData.payments?.filter(p => p.status === "approved") || [];
          amount = approved.reduce((sum, p) => sum + (p.transaction_amount || 0), 0);

          const firstApproved = approved[0];
          if (firstApproved?.id) {
            paymentId = firstApproved.id.toString();
            console.log("🆔 payment_id recuperado desde merchant_order:", paymentId);
          }
        }
      } catch (err) {
        console.error("❌ Error consultando merchant_order:", err);
      }
    }

    if (!externalReference) {
      console.warn("❌ No se pudo obtener externalReference");
      return res.sendStatus(200);
    }

    console.log("📗 Libro (externalReference):", externalReference);
    console.log("💰 Monto:", amount);
    console.log("💳 payment_id final:", paymentId);

    // 🧾 Buscar URL pública
    const { data: libroEncontrado } = await supabase
      .from("libros_urls")
      .select("url_publica")
      .eq("libro_id", String(externalReference))
      .maybeSingle();

    pdf_url = libroEncontrado?.url_publica || null;

    // 🧩 3️⃣ Control anti-duplicado mejorado
    const { data: pagosExistentes } = await supabase
      .from("pagos")
      .select("*")
      .eq("libro_id", String(externalReference))
      .eq("status", "approved")
      .order("created_at", { ascending: false });

    if (pagosExistentes?.length > 0) {
      const ultimoPago = pagosExistentes[0];

      const mismoPayment =
        paymentId && ultimoPago.payment_id && String(ultimoPago.payment_id) === String(paymentId);
      const mismoAmount = Number(ultimoPago.amount) === Number(amount);

      // ⚙️ Ignorar si es exactamente el mismo pago repetido
      if (mismoPayment || (mismoAmount && !paymentId)) {
        console.log("⚠️ Webhook duplicado detectado (mismo payment o mismo monto). Ignorado.");
        return res.sendStatus(200);
      }

      // 🔄 Si el registro previo tenía amount=0, actualizarlo
      if (ultimoPago.amount === 0 && amount > 0) {
        console.log("🔄 Actualizando pago existente con monto válido...");
        const { error: updateError } = await supabase
          .from("pagos")
          .update({
            amount,
            payment_id: paymentId ?? ultimoPago.payment_id,
            pdf_url,
          })
          .eq("id", ultimoPago.id);

        if (updateError) console.error("❌ Error actualizando monto:", updateError);
        else console.log("✅ Pago actualizado correctamente.");
        return res.sendStatus(200);
      }
    }

    // 🆕 4️⃣ Insertar nuevo pago (nuevo pago real)
    const { error: insertError } = await supabase.from("pagos").insert([
      {
        payment_id: paymentId ?? `${externalReference}-${Date.now()}`,
        libro_id: String(externalReference),
        status: "approved",
        amount,
        currency: "ARS",
        pdf_url,
      },
    ]);

    if (insertError) console.error("❌ Error insertando pago:", insertError);
    else console.log("✅ Pago insertado correctamente.");

    console.log("✅ Proceso finalizado Webhook /order");
    console.log("===============================================================");
    return res.sendStatus(200);
  } catch (error) {
    console.error("🔥 ERROR en webhook /order:", error);
    res.sendStatus(500);
  }
});




// ===========================================================
// ✅ CONSULTA DESDE EL FRONT: /webhook_estado
// ===========================================================
app.get("/webhook_estado", async (req, res) => {
  try {
    const { libroId, paymentId } = req.query;
    if (!libroId) return res.status(400).json({ error: "Falta libroId" });

    console.log("📘 Consultando estado del libro:", libroId, "payment:", paymentId);

    let query = supabase
      .from("pagos")
      .select("*")
      .eq("libro_id", String(libroId))
      .eq("status", "approved");

    // Si se envía paymentId, filtramos por ese ID exacto
    if (paymentId) query = query.eq("payment_id", paymentId);

    const { data, error } = await query.order("created_at", { ascending: false });

    if (error) throw error;

    if (!data || data.length === 0) {
      console.log("⚠️ No se encontró pago aprobado para libroId:", libroId);
      return res.json({ pago_exitoso: false, data: [] });
    }

    const pago = data[0];
    console.log("✅ Pago encontrado:", pago);

    const { data: libroData } = await supabase
      .from("libros_urls")
      .select("url_publica")
      .eq("libro_id", String(libroId))
      .maybeSingle();

    const pagoConUrl = {
      ...pago,
      url_publica: libroData?.url_publica || pago.pdf_url || null,
    };

    return res.json({
      pago_exitoso: true,
      data: [{ ...pagoConUrl, payment_id: pago.payment_id }],
    });

  } catch (err) {
    console.error("❌ Error en /webhook_estado:", err);
    res.status(500).json({ error: "Error al consultar el pago" });
  }
});
