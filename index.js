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
aapp.post("/order", async (req, res) => {
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

      // obtener pago
      const pagoResponse = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: { Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}` },
      });
      const pago = await pagoResponse.json();

      externalReference = pago.external_reference || pago.metadata?.libroId;

      // 🟢 Intentar obtener el monto real del pago aprobado
      if (pago.order?.id) {
        const orderResponse = await fetch(
          `https://api.mercadopago.com/merchant_orders/${pago.order.id}`,
          { headers: { Authorization: `Bearer ${process.env.MERCADO_PAGO_ACCESS_TOKEN}` } }
        );
        const orderData = await orderResponse.json();

        console.log("🧾 Datos merchant_order:", JSON.stringify(orderData, null, 2));

        const pagosAprobados = orderData.payments?.filter(p => p.status === "approved") || [];

        if (pagosAprobados.length > 0) {
          amount = pagosAprobados.reduce(
            (sum, p) => sum + Number(p.transaction_amount || p.total_paid_amount || 0),
            0
          );
        }

        // 🔄 Fallback si sigue en 0: usar el monto directo del pago
        if (!amount || amount === 0) {
          amount = Number(pago.transaction_amount || pago.total_paid_amount || 0);
        }
      } else {
        // 🔄 Si no hay order.id, usar directamente del pago
        amount = Number(pago.transaction_amount || pago.total_paid_amount || 0);
      }

      console.log("💰 Monto calculado (payment):", amount);
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
          const pagosAprobados = orderData.payments?.filter(p => p.status === "approved") || [];
          amount = pagosAprobados.reduce(
            (sum, p) => sum + Number(p.transaction_amount || p.total_paid_amount || 0),
            0
          ) || 0;

          // Si no hay paymentId, tomarlo del primer pago aprobado
          if (!paymentId && pagosAprobados.length > 0) {
            paymentId = pagosAprobados[0]?.id?.toString() || null;
            if (paymentId) console.log("🆔 payment_id recuperado desde merchant_order:", paymentId);
          }

          console.log("💰 Monto calculado (merchant_order):", amount);
        }
      } catch (err) {
        console.error("❌ Error consultando merchant_order:", err);
      }
    }

    // 🆕 🔄 EXTRA: intentar recuperar paymentId si falta
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
          const approved = firstOrder?.payments?.find(p => p.status === "approved");
          if (approved?.id) {
            paymentId = approved.id.toString();
            console.log("✅ payment_id recuperado desde búsqueda de merchant_order:", paymentId);
          }

          // También calculamos el monto si sigue vacío
          if ((!amount || amount === 0) && approved) {
            amount = Number(approved.transaction_amount || approved.total_paid_amount || 0);
            console.log("💰 Monto obtenido desde búsqueda fallback:", amount);
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
    console.log("💰 Monto final:", amount);
    console.log("💳 payment_id final:", paymentId);

    // 🟢 3️⃣ Buscar URL pública del libro
    const { data: libroEncontrado } = await supabase
      .from("libros_urls")
      .select("url_publica")
      .eq("libro_id", String(externalReference))
      .maybeSingle();

    pdf_url = libroEncontrado?.url_publica || null;

    // ✅ 4️⃣ Validar si ya existe un pago aprobado
    const { data: pagoExistente } = await supabase
      .from("pagos")
      .select("id")
      .eq("libro_id", String(externalReference))
      .eq("status", "approved")
      .limit(1);

    if (pagoExistente?.length > 0) {
      console.log("⚠️ Ya hay un pago aprobado para este libro, se ignora duplicado");
      return res.sendStatus(200);
    }

    // 🟢 5️⃣ Insertar / actualizar en Supabase
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
      { onConflict: paymentId ? "payment_id" : "libro_id" }
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