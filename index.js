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

    // 🟢 1️⃣ Si el webhook viene por "payment"
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
      console.log("🧾 Datos del pago:", JSON.stringify(pago, null, 2));

      if (pago.status !== "approved") {
        console.log("⛔ Pago no aprobado → se ignora.");
        return res.sendStatus(200);
      }

      console.log("✅ Pago aprobado");
      externalReference = pago.external_reference || pago.metadata?.libroId;

      // 🟢 Monto robusto
      amount =
        Number(pago.transaction_amount) ||
        Number(pago.transaction_details?.total_paid_amount) ||
        Number(pago.transaction_details?.net_received_amount) ||
        Number(pago.transaction_details?.installment_amount) ||
        Number(pago.order?.total_amount) ||
        0;

      // 🧩 Si sigue en 0, intentar recuperar desde merchant_order
      if (amount === 0 && pago.order?.id) {
        try {
          const orderResponse = await fetch(
            `https://api.mercadopago.com/merchant_orders/${pago.order.id}`,
            { headers: { Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}` } }
          );
          if (orderResponse.ok) {
            const orderData = await orderResponse.json();
            const approvedPayments =
              orderData.payments?.filter((p) => p.status === "approved") || [];
            amount = approvedPayments.reduce(
              (sum, p) => sum + (Number(p.transaction_amount) || 0),
              0
            );
            console.log("💵 Monto recuperado desde merchant_order:", amount);
          }
        } catch (err) {
          console.error("❌ Error recuperando monto desde merchant_order:", err);
        }
      }

      if (amount === 0) {
        const possibleAmount =
          pago.additional_info?.items?.[0]?.unit_price ||
          pago.metadata?.amount ||
          pago.order?.amount ||
          0;
        amount = Number(possibleAmount) || 0;
        console.log("💵 Monto ajustado (fallback):", amount);
      }

      // Recuperar external_reference desde la orden si no viene en pago
      if (!externalReference && pago.order?.id) {
        try {
          const orderResponse = await fetch(
            `https://api.mercadopago.com/merchant_orders/${pago.order.id}`,
            { headers: { Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}` } }
          );
          if (orderResponse.ok) {
            const orderData = await orderResponse.json();
            externalReference = orderData.external_reference;
          }
        } catch (err) {
          console.error("❌ Error obteniendo order para externalReference:", err);
        }
      }
    }

    // 🟢 2️⃣ Si el webhook viene por "merchant_order"
    if (topic === "merchant_order") {
      console.log("🔹 Webhook merchant_order directo");
      try {
        const orderResponse = await fetch(resource, {
          headers: { Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}` },
        });

        if (orderResponse.ok) {
          const orderData = await orderResponse.json();
          externalReference = orderData.external_reference;
          amount =
            orderData.payments
              ?.filter((p) => p.status === "approved")
              .reduce((sum, p) => sum + (p.transaction_amount || 0), 0) || 0;

          if (!paymentId && Array.isArray(orderData.payments) && orderData.payments.length > 0) {
            const firstApproved = orderData.payments.find((p) => p.status === "approved");
            paymentId = firstApproved?.id?.toString() || null;
            if (paymentId) console.log("🆔 payment_id recuperado desde merchant_order:", paymentId);
          }
        }
      } catch (err) {
        console.error("❌ Error consultando merchant_order:", err);
      }
    }

    // 🆕 🔄 Fallback para recuperar paymentId si aún no lo tenemos
    if (!paymentId && externalReference) {
      try {
        console.log("🔁 Intentando obtener payment_id desde merchant_order (fallback)...");
        const orderSearch = await fetch(
          `https://api.mercadopago.com/merchant_orders/search?external_reference=${externalReference}`,
          {
            headers: { Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}` },
          }
        );

        if (orderSearch.ok) {
          const { elements } = await orderSearch.json();
          const firstOrder = elements?.[0];
          const approved = firstOrder?.payments?.find((p) => p.status === "approved");
          if (approved?.id) {
            paymentId = approved.id.toString();
            console.log("✅ payment_id recuperado desde búsqueda de merchant_order:", paymentId);
          }
        }
      } catch (err) {
        console.error("❌ Error en fallback para obtener payment_id:", err);
      }
    }

    if (!externalReference) {
      console.warn("❌ No se pudo obtener externalReference");
      return res.sendStatus(200);
    }

    console.log("📗 Libro (externalReference):", externalReference);
    console.log("💰 Monto:", amount);
    console.log("💳 payment_id final:", paymentId);

    // 🟢 3️⃣ Buscar URL pública del libro
    const { data: libroEncontrado } = await supabase
      .from("libros_urls")
      .select("url_publica")
      .eq("libro_id", String(externalReference))
      .maybeSingle();

    pdf_url = libroEncontrado?.url_publica || null;

    // ✅ 4️⃣ Validar si ya existe un pago aprobado para ese libro
    const { data: pagoExistente } = await supabase
      .from("pagos")
      .select("*")
      .eq("libro_id", String(externalReference))
      .eq("status", "approved");

    if (pagoExistente?.length > 0) {
      const pagoExistenteRow = pagoExistente[0];

      if (pagoExistenteRow.amount === 0 && amount > 0) {
        console.log("🔄 Actualizando pago existente (amount era 0, ahora es válido)");
        const { error: updateError } = await supabase
          .from("pagos")
          .update({
            amount,
            payment_id: paymentId ? String(paymentId) : pagoExistenteRow.payment_id,
            pdf_url,
          })
          .eq("id", pagoExistenteRow.id);

        if (updateError) console.error("❌ Error actualizando monto:", updateError);
        else console.log("✅ Monto actualizado correctamente en Supabase");
      } else {
        console.log("⚠️ Ya hay un pago aprobado para este libro, se ignora duplicado");
        return res.sendStatus(200);
      }
    }

    // 🟢 5️⃣ Insertar o actualizar en Supabase
    const { error: insertError } = await supabase.from("pagos").upsert(
      [
        {
          payment_id: paymentId ? String(paymentId) : null,
          libro_id: String(externalReference),
          status: "approved",
          amount,
          currency: "ARS",
          pdf_url,
        },
      ],
      { onConflict: "id" } // evita duplicados
    );

    if (insertError) console.error("❌ Error insertando/actualizando Supabase:", insertError);
    else console.log("✅ Pago guardado correctamente en Supabase");

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
    const { libroId } = req.query;
    if (!libroId) return res.status(400).json({ error: "Falta libroId" });

    console.log("📘 Consultando estado del libro:", libroId);

    const { data, error } = await supabase
      .from("pagos")
      .select("*")
      .eq("libro_id", String(libroId))
      .eq("status", "approved")
      .order("created_at", { ascending: false });

    if (error) throw error;

    if (data && data.length > 0) {
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

      return res.json({ pago_exitoso: true, data: [pagoConUrl] });
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