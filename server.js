const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const twilio = require("twilio");

const app = express();
app.use(express.json());
app.use(cors());

const FIREBASE_DB_URL =
  process.env.FIREBASE_URL || "https://crowdshield-b0947-default-rtdb.firebaseio.com/";

// ── Twilio credentials ──────────────────────────────────────────────────────
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;
// ────────────────────────────────────────────────────────────────────────────

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: FIREBASE_DB_URL
});

const db = admin.database();

app.get("/", (req, res) => {
  res.send("CrowdShield backend running 🚀");
});

app.post("/alert", async (req, res) => {
  try {
    const { streetlight_id, type, message, gps_lat, gps_lng } = req.body;

    console.log("Incoming /alert body:", req.body);

    if (!streetlight_id || !type) {
      return res.status(400).json({
        success: false,
        error: "streetlight_id and type are required"
      });
    }

    // ── Fetch streetlight data ──────────────────────────────────────────────
    const streetlightSnap = await db.ref(`streetlights/${streetlight_id}`).once("value");
    const streetlightData = streetlightSnap.val();

    if (!streetlightData) {
      return res.status(404).json({
        success: false,
        error: "Streetlight not found"
      });
    }

    // ── Store event in Firebase ─────────────────────────────────────────────
    const eventData = {
      streetlight_id,
      type,
      message: message || "Emergency detected",
      gps_lat: typeof gps_lat === "number" ? gps_lat : null,
      gps_lng: typeof gps_lng === "number" ? gps_lng : null,
      created_at: new Date().toISOString(),
      streetlight_area: streetlightData.area || "",
      streetlight_lat: streetlightData.lat || null,
      streetlight_lng: streetlightData.lng || null
    };

    const eventRef = await db.ref("events").push(eventData);
    console.log("Event stored:", eventRef.key);

    // ── Fetch phone numbers from Firebase ───────────────────────────────────
    const usersSnap = await db.ref("users").once("value");
    const users = usersSnap.val() || {};

    const phoneList = Object.values(users)
      .map((u) => (u && u.phone ? String(u.phone).trim() : ""))
      .filter((p) => p.length > 0)
      .map((p) => {
        // Ensure E.164 format — add + if missing
        return p.startsWith("+") ? p : `+${p}`;
      });

    console.log("Phones to notify:", phoneList);

    if (phoneList.length === 0) {
      return res.json({
        success: true,
        message: "Alert stored, but no phone numbers found",
        event_id: eventRef.key,
        sms_sent: false,
        reason: "no_phones"
      });
    }

    // ── Build SMS message ───────────────────────────────────────────────────
    let mapsLink = "";
    if (typeof gps_lat === "number" && typeof gps_lng === "number") {
      mapsLink = ` https://maps.google.com/?q=${gps_lat},${gps_lng}`;
    }

    const smsBody =
      `CrowdShield Alert! ${eventData.message}. ` +
      `Area: ${eventData.streetlight_area}.` +
      (mapsLink ? ` Location:${mapsLink}` : "");

    console.log("SMS message:", smsBody);

    // ── Send SMS to each number via Twilio ──────────────────────────────────
    const results = await Promise.allSettled(
      phoneList.map((to) =>
        twilioClient.messages.create({
          body: smsBody,
          from: TWILIO_FROM_NUMBER,
          to
        })
      )
    );

    const sent   = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");

    console.log(`SMS sent: ${sent.length}, failed: ${failed.length}`);
    failed.forEach((f, i) => console.error(`SMS failed for index ${i}:`, f.reason?.message));

    return res.json({
      success: true,
      message: `Alert stored. SMS sent to ${sent.length}/${phoneList.length} recipients.`,
      event_id: eventRef.key,
      sms_sent: sent.length > 0,
      sent_count: sent.length,
      failed_count: failed.length
    });

  } catch (error) {
    console.error("Error handling /alert:", error);
    return res.status(500).json({
      success: false,
      error: "Internal server error"
    });
  }
});

app.listen(3000, "0.0.0.0", () => {
  console.log("CrowdShield backend running on port 3000 🚀");
});