// Función de servidor (Vercel). Solo el propietario puede usarla.
// Permite cambiar contraseñas y eliminar cuentas sin pasar por el correo.
const admin = require("firebase-admin");

function init() {
  if (admin.apps.length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("Falta la variable FIREBASE_SERVICE_ACCOUNT");
  let sa;
  try { sa = JSON.parse(raw); } catch { sa = JSON.parse(Buffer.from(raw, "base64").toString("utf8")); }
  admin.initializeApp({ credential: admin.credential.cert(sa) });
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });
  try {
    init();
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ error: "Sin sesión" });
    const me = await admin.auth().verifyIdToken(token);

    // 1) Solo el correo del propietario (variable SUPERADMIN_EMAIL en Vercel)
    const owner = (process.env.SUPERADMIN_EMAIL || "").trim().toLowerCase();
    if (!owner || (me.email || "").toLowerCase() !== owner) return res.status(403).json({ error: "No autorizado" });
    // 2) Y además debe seguir siendo administrador activo en la app
    const prof = await admin.firestore().doc(`users/${me.uid}`).get();
    if (!prof.exists || prof.data().active !== true || prof.data().role !== "admin") return res.status(403).json({ error: "No autorizado" });

    const { action, uid, password } = req.body || {};
    if (action === "can") return res.status(200).json({ ok: true });
    if (typeof uid !== "string" || !uid) return res.status(400).json({ error: "Falta el usuario" });

    if (action === "setPassword") {
      if (typeof password !== "string" || password.length < 6 || password.length > 128) return res.status(400).json({ error: "La contraseña debe tener entre 6 y 128 caracteres" });
      await admin.auth().updateUser(uid, { password });
      if (uid !== me.uid) await admin.auth().revokeRefreshTokens(uid);   // cierra sus sesiones abiertas
      return res.status(200).json({ ok: true });
    }
    if (action === "deleteUser") {
      if (uid === me.uid) return res.status(400).json({ error: "No puedes eliminarte a ti mismo" });
      try { await admin.auth().deleteUser(uid); } catch (e) { if (e.code !== "auth/user-not-found") throw e; }
      await admin.firestore().doc(`users/${uid}`).delete();
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: "Acción desconocida" });
  } catch (e) {
    console.error(e);
    if (String(e.code || "").startsWith("auth/id-token") || e.code === "auth/argument-error") return res.status(401).json({ error: "Sesión inválida" });
    if (e.code === "auth/user-not-found") return res.status(404).json({ error: "Ese usuario no existe en Firebase" });
    return res.status(500).json({ error: "Error del servidor" });
  }
};
