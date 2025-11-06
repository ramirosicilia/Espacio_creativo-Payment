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
        session_id: mp[0].session_id,  // ✅ NUEVO
      },
     external_reference: `${mp[0].id}-${mp[0].session_id}`,

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
    let pago = null;

    // 🟢 1️⃣ Procesar si el webhook viene por "payment"
    if (topic === "payment" || type === "payment") {
      paymentId =
        data?.id || (typeof resource === "string" ? resource.split("/").pop() : null);

      if (!paymentId) {
        console.warn("⚠️ No hay paymentId en el webhook (se ignora).");
        return res.sendStatus(200);
      }

      console.log("🔍 Consultando pago con ID:", paymentId);
      const pagoResponse = await fetch(
        `https://api.mercadopago.com/v1/payments/${paymentId}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}`,
          },
        }
      );

      if (!pagoResponse.ok) {
        console.error("❌ Error al consultar pago:", await pagoResponse.text());
        return res.sendStatus(500);
      }

      pago = await pagoResponse.json();

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

      // 🔁 Si no hay monto, intentar obtenerlo desde merchant_order
      if (amount === 0 && pago.order?.id) {
        try {
          const orderResp = await fetch(
            `https://api.mercadopago.com/merchant_orders/${pago.order.id}`,
            {
              headers: {
                Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}`,
              },
            }
          );
          if (orderResp.ok) {
            const orderData = await orderResp.json();
            const approved =
              orderData.payments?.filter((p) => p.status === "approved") || [];
            amount = approved.reduce(
              (s, p) => s + (p.transaction_amount || 0),
              0
            );
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

      // 🧱 Evitar insertar antes de tener payment_id real
      console.log("🕓 Esperando webhook de pago real (sin payment_id).");
      return res.sendStatus(200);
    }

    if (!externalReference) {
      console.warn("❌ No se pudo obtener externalReference");
      return res.sendStatus(200);
    }

    console.log("📗 Libro (externalReference):", externalReference);
    console.log("💰 Monto:", amount);
    console.log("💳 payment_id final:", paymentId);

    // 🧾 Buscar URL pública ANTES DE INSERTAR EL PAGO
    const libroIdLimpio = String(externalReference).split("-")[0];
    const { data: libroEncontrado, error: errorLibro } = await supabase
      .from("libros_urls")
      .select("url_publica")
      .eq("libro_id", libroIdLimpio)
      .maybeSingle();

    if (errorLibro) console.error("❌ Error consultando libros_urls:", errorLibro);
    pdf_url = libroEncontrado?.url_publica || null;
    console.log("📎 URL pública asociada:", pdf_url);

    // 🆕 Obtener session_id (para control de duplicados)
    let sessionId = null;
    if (typeof pago !== "undefined" && pago?.metadata?.session_id) {
      sessionId = pago.metadata.session_id;
    } else if (externalReference?.includes("-")) {
      sessionId = externalReference.split("-")[1];
    }

    // 🚫 Evitar duplicado real (por payment_id o session_id)
    const { data: existePago } = await supabase
      .from("pagos")
      .select("id")
      .or(`payment_id.eq.${paymentId},session_id.eq.${sessionId}`)
      .eq("libro_id", libroIdLimpio)
      .maybeSingle();

    if (existePago) {
      console.log("⚠️ Pago ya existente (por payment_id o session_id). No se inserta.");
      return res.sendStatus(200);
    }

    // 🔎 Si no hay paymentId válido, buscar uno previo o generar seguro
    if (!paymentId) {
      const { data: previo } = await supabase
        .from("pagos")
        .select("payment_id")
        .eq("libro_id", libroIdLimpio)
        .eq("status", "approved")
        .order("created_at", { ascending: false })
        .limit(1);

      if (previo && previo.length > 0) {
        paymentId = previo[0].payment_id;
        console.log("♻️ Reutilizando payment_id previo:", paymentId);
      } else {
        paymentId = `${externalReference}-${Date.now()}`;
        console.log("🆔 Generado fallback payment_id:", paymentId);
      }
    }

    // 🚀 Insertar nuevo pago (ya con pdf_url correcto)
    await supabase.from("pagos").insert([
      {
        payment_id: paymentId,
        libro_id: libroIdLimpio,
        session_id: sessionId || null,
        status: "approved",
        amount,
        currency: "ARS",
        pdf_url,
      },
    ]);

    console.log("✅ Pago insertado correctamente:", paymentId);
    console.log("===============================================================");
    return res.sendStatus(200);
  } catch (error) {
    console.error("🔥 ERROR en webhook /order:", error);
    res.sendStatus(500);
  }
});


// ✅ CONSULTA DESDE EL FRONT: /webhook_estado
// ===========================================================
app.get("/webhook_estado", async (req, res) => {
  try {
    const { libroId, sessionId } = req.query;
    if (!libroId) return res.status(400).json({ error: "Falta libroId" });

    if (!sessionId) {
     return res.status(400).json({ error: "Falta sessionId" });
  }


    console.log("📘 Consultando estado del libro:", libroId, "sessionId:", sessionId);
          
    // 🧾 Consulta base
    const query = supabase
  .from("pagos")
  .select("*")
  .eq("libro_id", String(libroId))
  .eq("status", "approved")
  .eq("session_id", sessionId)
  .order("created_at", { ascending: false });
    

    const { data, error } = await query;
    if (error) throw error;

    if (data && data.length > 0) {
      const pago = data[0];
      console.log("✅ Pago encontrado:", pago);

      // 🔎 Verificar si ya existía ese payment_id
      const { data: repetido, error: errRepetido } = await supabase
        .from("pagos")
        .select("payment_id")
        .eq("payment_id", pago.payment_id);

      if (errRepetido) throw errRepetido;

      // ⚠️ Si hay más de un registro con el mismo payment_id, no se devuelve
      if (repetido && repetido.length > 1) {
        console.log("⚠️ Pago ya existente, no se envía el cuento:", pago.payment_id);
        return res.json({ pago_exitoso: false, data: [] });
      }

      // 📗 Traer URL del libro
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
    }

    console.log("⚠️ No se encontró pago aprobado para libroId:", libroId);
    res.json({ pago_exitoso: false, data: [] });

  } catch (err) {
    console.error("❌ Error en /webhook_estado:", err);
    res.status(500).json({ error: "Error al consultar el pago" });
  }
});

// ===========================================================
app.listen(port, () =>
  console.log(`✅ Servidor backend escuchando en http://localhost:${port}`)
);
