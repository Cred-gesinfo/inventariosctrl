import {initializeApp} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {getAuth,onAuthStateChanged,signInWithEmailAndPassword,signOut,createUserWithEmailAndPassword,sendPasswordResetEmail} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {getFirestore,collection,doc,onSnapshot,setDoc,updateDoc,deleteDoc,runTransaction,serverTimestamp,query,orderBy,limit} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Configuración del proyecto invcontrol-62d5b
const firebaseConfig = {
  apiKey: "AIzaSyByUXNZFFOOY5kf3ajqXyMJmowa505RL3c",
  authDomain: "invcontrol-62d5b.firebaseapp.com",
  projectId: "invcontrol-62d5b",
  storageBucket: "invcontrol-62d5b.firebasestorage.app",
  messagingSenderId: "423401865811",
  appId: "1:423401865811:web:779a3e15ccd2aaf51cfca6"
};
// Cloudinary (plan gratuito): pega tu "Cloud name" y el nombre de tu upload preset sin firma
const CLOUD_NAME = "yiol9iuf";
const UPLOAD_PRESET = "invctrl";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app), db = getFirestore(app);
// Segunda instancia solo para crear cuentas sin cerrar la sesión del administrador
const authAlt = getAuth(initializeApp(firebaseConfig, "alt"));

/* ---------- Roles y permisos (las reglas de Firestore aplican los mismos) ---------- */
const ROLES = {
  admin:   {label:"Administrador", p:["users","settings","catalog","moves"], info:"todo, incluida la administración de usuarios"},
  editor:  {label:"Editor",        p:["settings","catalog","moves"],         info:"catálogo, ajustes y movimientos"},
  almacen: {label:"Almacén",       p:["moves"],                               info:"solo registra entradas, salidas y traslados"},
  consulta:{label:"Solo consulta", p:[],                                      info:"solo ve el catálogo y los movimientos"}
};
let me = null;
const can = p => !!me && me.active === true && (ROLES[me.role]?.p || []).includes(p);

const BASE = [
  {key:"partNumber", label:"Número de parte"},
  {key:"description", label:"Descripción"},
  {key:"color", label:"Color"},
  {key:"features", label:"Características", area:true}
];
const K = {
  fields:     {doc:"schema",    prop:"fields", title:"Propiedades extra", hint:"Ej. Material, Medidas, Proveedor"},
  categories: {doc:"categories",prop:"items",  title:"Categorías",        hint:"Ej. Salas, Recámaras, Comedores"},
  locations:  {doc:"locations", prop:"items",  title:"Ubicaciones",       hint:"Ej. Bodega, Showroom, Sucursal 2"}
};
const S = {fields:[], categories:[], locations:[]};
let products = [], movs = [], users = [], editing = null, imgs = [], pending = [], stream = null;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const slug = s => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"_").replace(/^_|_$/g,"");
const label = (k, key) => S[k].find(x => x.key === key)?.label || key || "";
const thumb = (u, w = 400) => u.replace("/upload/", `/upload/c_fill,w_${w},h_${Math.round(w*.75)},q_auto,f_auto/`);

/* ---------- Sesión ---------- */
let sessionSubs = [], dataSubs = [];
const stopData = () => { dataSubs.forEach(f => f()); dataSubs = []; };
onAuthStateChanged(auth, u => {
  $("#boot")?.remove();
  sessionSubs.forEach(f => f()); sessionSubs = []; stopData(); me = null;
  $("#login").hidden = !!u; $("#app").hidden = true; $("#noacc").hidden = true;
  if (!u) return;
  sessionSubs.push(onSnapshot(doc(db,"users",u.uid), d => {
    me = d.exists() ? d.data() : null;
    const ok = !!me && me.active === true && !!ROLES[me.role];
    $("#noacc").hidden = ok; $("#app").hidden = !ok;
    stopData();
    if (ok) { startData(); applyPerms(); }
  }, () => { $("#noacc").hidden = false; }));
});
function startData() {
  Object.entries(K).forEach(([k, c]) => dataSubs.push(onSnapshot(doc(db,"config",c.doc), d => {
    S[k] = d.exists() ? d.data()[c.prop] || [] : []; renderAll();
  })));
  dataSubs.push(
    onSnapshot(collection(db,"products"), s => { products = s.docs.map(d => ({id:d.id, ...d.data()})).sort((a,b)=>(a.partNumber||"").localeCompare(b.partNumber||"")); renderAll(); }),
    onSnapshot(query(collection(db,"movements"), orderBy("date","desc"), limit(100)), s => { movs = s.docs.map(d => d.data()); renderMovs(); })
  );
  if (can("users")) dataSubs.push(onSnapshot(collection(db,"users"), s => {
    users = s.docs.map(d => ({id:d.id, ...d.data()})).sort((a,b)=>(a.name||a.email||"").localeCompare(b.name||b.email||"")); renderUsers();
  }));
}
function applyPerms() {
  $("#who").textContent = `${me.name || me.email} · ${ROLES[me.role].label}`;
  const vis = {cat:true, mov:true, cam:can("settings"), usr:can("users")};
  document.querySelectorAll("nav button").forEach(b => b.hidden = !vis[b.dataset.t]);
  $("#new").hidden = !can("catalog"); $("#mform").hidden = !can("moves");
  const on = document.querySelector("nav button.on");
  if (!on || on.hidden) showTab("cat");
  renderAll();
}
function showTab(t) {
  scrollTo(0, 0);
  document.querySelectorAll("nav button").forEach(x => x.classList.toggle("on", x.dataset.t === t));
  ["cat","mov","cam","usr"].forEach(id => $("#"+id).hidden = id !== t);
}
document.querySelectorAll("nav button").forEach(b => b.onclick = () => showTab(b.dataset.t));
$("#go").onclick = async () => {
  try { await signInWithEmailAndPassword(auth, $("#em").value, $("#pw").value); $("#lerr").textContent = ""; }
  catch { $("#lerr").textContent = "Correo o contraseña incorrectos."; }
};
$("#out").onclick = $("#out2").onclick = () => signOut(auth);
function renderAll() { renderCfg(); renderFields(); renderFilter(); renderList(); renderSelect(); renderMovs(); renderUsers(); }

/* ---------- Imágenes (Cloudinary) ---------- */
async function shrink(file, max = 1600) {
  try {
    const bm = await createImageBitmap(file), k = Math.min(1, max / Math.max(bm.width, bm.height));
    const c = document.createElement("canvas"); c.width = Math.round(bm.width * k); c.height = Math.round(bm.height * k);
    c.getContext("2d").drawImage(bm, 0, 0, c.width, c.height);
    return await new Promise(r => c.toBlob(r, "image/jpeg", .85));
  } catch { return file; }
}
async function upload(file) {
  const fd = new FormData(); fd.append("file", await shrink(file)); fd.append("upload_preset", UPLOAD_PRESET);
  const r = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`, {method:"POST", body:fd}), j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || "No se pudo subir la imagen.");
  return {url:j.secure_url, id:j.public_id};
}

/* ---------- Catálogo ---------- */
function renderFilter() {
  const cur = $("#qc").value;
  $("#qc").innerHTML = `<option value="">Todas las categorías</option>` + S.categories.map(c => `<option value="${c.key}">${esc(c.label)}</option>`).join("");
  $("#qc").value = cur;
}
function renderList() {
  const q = $("#q").value.toLowerCase(), c = $("#qc").value, edit = can("catalog");
  const rows = products.filter(p => (!c || p.category === c) && (!q || JSON.stringify([p.partNumber,p.description,p.color,p.features,p.extra]).toLowerCase().includes(q)));
  $("#list").innerHTML = rows.length ? rows.map(p => {
    const im = p.images || [], where = S.locations.filter(l => (p.stockByLoc?.[l.key]||0) > 0).map(l => `${esc(l.label)}: ${p.stockByLoc[l.key]}`).join(" · ");
    return `<article class="p">
      ${im[0] ? `<a href="${esc(im[0].url)}" target="_blank" rel="noopener"><img src="${esc(thumb(im[0].url,500))}" alt="${esc(p.description)}" loading="lazy"></a>` : ""}
      <div>
        <b>${esc(p.partNumber)}</b><span>${esc(p.description)}</span>
        <span class="mute">${esc([label("categories", p.category), p.color].filter(Boolean).join(" · "))}</span>
        <span class="stock ${(p.stock||0)<=0?"low":""}">Existencia: ${p.stock||0}</span>
        ${where ? `<span class="mute">${where}</span>` : ""}
        ${im.length > 1 ? `<div class="cnt">${im.slice(1,4).map(i => `<a href="${esc(i.url)}" target="_blank" rel="noopener"><img src="${esc(thumb(i.url,150))}" alt="" loading="lazy"></a>`).join("")}</div>` : ""}
        ${(can("moves") || edit) ? `<div class="acts">${can("moves") ? `<button data-m="${p.id}">Mover</button>` : ""}${edit ? `<button class="sec" data-e="${p.id}">Editar</button><button class="del" data-d="${p.id}">Eliminar</button>` : ""}</div>` : ""}
      </div>
    </article>`; }).join("") : `<p class="mute">No hay productos.${can("catalog") ? " Agrega el primero con “Nuevo producto”." : ""}</p>`;
}
$("#q").oninput = renderList; $("#qc").onchange = renderList;
$("#list").onclick = async e => {
  if (e.target.dataset.m) {   // "Mover": abre Movimientos con el producto ya elegido
    if (!can("moves")) return;
    showTab("mov"); $("#mps").value = ""; renderSelect(); $("#mp").value = e.target.dataset.m; updInfo(); return;
  }
  const id = e.target.dataset.e || e.target.dataset.d; if (!id || !can("catalog")) return;
  const p = products.find(x => x.id === id);
  if (e.target.dataset.e) return openForm(p);
  if (confirm(`¿Eliminar ${p.partNumber}? No se puede deshacer. Sus fotos dejan de mostrarse en la app, pero siguen en tu cuenta de Cloudinary.`)) await deleteDoc(doc(db,"products",id));
};

function renderFields() {
  const keep = {}; document.querySelectorAll("#fields [id^=f_]").forEach(el => keep[el.id] = el.value);
  $("#fields").innerHTML =
    BASE.map(f => `<label for="f_${f.key}">${f.label}</label>` + (f.area ? `<textarea id="f_${f.key}" rows="3"></textarea>` : `<input id="f_${f.key}">`)).join("") +
    `<label for="f_category">Categoría</label><select id="f_category"><option value="">Sin categoría</option>${S.categories.map(c => `<option value="${c.key}">${esc(c.label)}</option>`).join("")}</select>` +
    S.fields.map(f => `<label for="f_${f.key}">${esc(f.label)}</label><input id="f_${f.key}">`).join("");
  Object.entries(keep).forEach(([id, v]) => { const el = $("#"+id); if (el) el.value = v; });
}
function renderThumbs() {
  const all = [...imgs.map(i => thumb(i.url,150)), ...pending.map(p => p.url)];
  $("#thumbs").innerHTML = all.map((src, n) => `<div class="th"><img src="${esc(src)}" alt="Imagen ${n+1}"><button type="button" data-x="${n}" aria-label="Quitar imagen ${n+1}">×</button></div>`).join("");
}
$("#thumbs").onclick = e => {
  const n = e.target.dataset.x; if (n === undefined) return;
  if (+n < imgs.length) imgs.splice(+n, 1);
  else { const [p] = pending.splice(+n - imgs.length, 1); URL.revokeObjectURL(p.url); }
  renderThumbs();
};
function clearPending() { pending.forEach(p => URL.revokeObjectURL(p.url)); pending = []; }
function addFiles(files) { files.forEach(f => pending.push({file:f, url:URL.createObjectURL(f)})); renderThumbs(); }
function openForm(p) {
  editing = p || {}; $("#dt").textContent = p ? "Editar producto" : "Nuevo producto";
  renderFields();
  BASE.forEach(f => $("#f_"+f.key).value = p?.[f.key] ?? "");
  $("#f_category").value = p?.category ?? "";
  S.fields.forEach(f => $("#f_"+f.key).value = p?.extra?.[f.key] ?? "");
  clearPending(); imgs = p ? [...(p.images || [])] : []; renderThumbs();
  $("#img").value = ""; $("#perr").textContent = ""; $("#dlg").showModal();
}
$("#new").onclick = () => openForm(null);
$("#cancel").onclick = () => { editing = null; clearPending(); $("#dlg").close(); };
$("#save").onclick = async () => {
  const err = m => $("#perr").textContent = m;
  const data = {}; BASE.forEach(f => data[f.key] = $("#f_"+f.key).value.trim());
  if (!data.partNumber || !data.description) return err("Número de parte y descripción son obligatorios.");
  const files = pending.map(p => p.file);
  if (!imgs.length && !files.length) return err("Cada producto necesita al menos una imagen.");
  if (files.length && (CLOUD_NAME.startsWith("TU_") || UPLOAD_PRESET.startsWith("TU_"))) return err("Falta configurar Cloudinary en el archivo (CLOUD_NAME y UPLOAD_PRESET).");
  if (products.some(p => p.partNumber === data.partNumber && p.id !== editing.id)) return err("Ya existe un producto con ese número de parte.");
  $("#save").disabled = true; err("Guardando…");
  try {
    const id = editing.id || doc(collection(db,"products")).id;
    data.category = $("#f_category").value;
    data.extra = {}; S.fields.forEach(f => data.extra[f.key] = $("#f_"+f.key).value.trim());
    const all = [...imgs];
    for (const f of files) all.push(await upload(f));
    data.images = all; data.imageUrl = all[0].url;
    if (!editing.id) { data.stock = 0; data.stockByLoc = {}; }   // la existencia solo cambia con movimientos
    await setDoc(doc(db,"products",id), {...data, updatedAt: serverTimestamp()}, {merge:true});
    editing = null; clearPending(); err(""); $("#dlg").close();
  } catch (e) { err("No se pudo guardar: " + e.message); }
  $("#save").disabled = false;
};

/* ---------- Movimientos ---------- */
function renderSelect() {
  const keep = ["#mp","#ml","#md"].map(s => $(s).value), f = $("#mps").value.trim().toLowerCase();
  const list = products.filter(p => !f || `${p.partNumber} ${p.description} ${p.color || ""}`.toLowerCase().includes(f));
  $("#mp").innerHTML = list.map(p => `<option value="${p.id}">${esc(p.partNumber)} · ${esc(p.description)}</option>`).join("") || `<option value="">Sin resultados</option>`;
  const lo = S.locations.map(l => `<option value="${l.key}">${esc(l.label)}</option>`).join("");
  $("#ml").innerHTML = lo; $("#md").innerHTML = lo;
  ["#mp","#ml","#md"].forEach((s, i) => { if (keep[i]) $(s).value = keep[i]; });
  updInfo();
}
function updInfo() {
  const p = products.find(x => x.id === $("#mp").value), l = $("#ml").value;
  $("#minfo").textContent = p ? `Existencia total: ${p.stock || 0}${l ? ` · en ${label("locations", l)}: ${p.stockByLoc?.[l] || 0}` : ""}` : "";
}
$("#mps").oninput = renderSelect; $("#mp").onchange = $("#ml").onchange = updInfo;
function setType(t) {
  $("#mt").value = t; document.querySelectorAll("#mtseg button").forEach(b => b.classList.toggle("on", b.dataset.v === t));
  $("#mdw").hidden = t !== "transfer"; $("#mll").textContent = t === "transfer" ? "Origen" : "Ubicación";
}
$("#mtseg").onclick = e => { if (e.target.dataset.v) setType(e.target.dataset.v); };
$("#qm").onclick = () => { $("#mq").value = Math.max(1, (parseInt($("#mq").value, 10) || 1) - 1); };
$("#qp").onclick = () => { $("#mq").value = (parseInt($("#mq").value, 10) || 0) + 1; };
function toast(m) { const t = $("#toast"); t.textContent = m; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 2500); }
$("#mgo").onclick = async () => {
  if (!can("moves")) return;
  const id = $("#mp").value, type = $("#mt").value, qty = parseInt($("#mq").value, 10), note = $("#mn").value.trim();
  const from = $("#ml").value, to = $("#md").value;
  const err = m => $("#merr").textContent = m; err("");
  if (!id) return err("Primero agrega un producto al catálogo.");
  if (!from) return err("Primero agrega una ubicación en Ajustes.");
  if (!(qty > 0)) return err("La cantidad debe ser mayor a cero.");
  if (type === "transfer" && from === to) return err("El origen y el destino deben ser distintos.");
  try {
    await runTransaction(db, async tx => {
      const pref = doc(db,"products",id), p = (await tx.get(pref)).data(), sbl = {...(p.stockByLoc || {})};
      const has = sbl[from] || 0; let total = p.stock || 0;
      if (type === "in") { sbl[from] = has + qty; total += qty; }
      else {
        if (has < qty) throw new Error(`En esa ubicación solo hay ${has}.`);
        sbl[from] = has - qty;
        if (type === "out") total -= qty; else sbl[to] = (sbl[to] || 0) + qty;
      }
      tx.update(pref, {stock: total, stockByLoc: sbl});
      tx.set(doc(collection(db,"movements")), {productId:id, partNumber:p.partNumber, description:p.description, type, qty, loc:from, toLoc:type==="transfer"?to:null, stockAfter:total, note, date:serverTimestamp(), by:auth.currentUser.email});
    });
    $("#mq").value = 1; $("#mn").value = ""; $("#mps").value = ""; renderSelect();
    toast({in:"Entrada registrada", out:"Salida registrada", transfer:"Traslado registrado"}[type]); navigator.vibrate?.(40);
  } catch (e) { err(e.message); }
};
const TIPO = {in:"Entrada", out:"Salida", transfer:"Traslado"};
function renderMovs() {
  $("#mlist").innerHTML = movs.map(m => `<div class="mv">
    <div class="mvh"><span class="tag ${m.type}">${TIPO[m.type]}</span><b>${m.qty}</b><span>${esc(m.partNumber)}</span></div>
    <div class="mute">${esc(m.description)}</div>
    <div class="mute">${esc(label("locations", m.loc))}${m.toLoc ? " → " + esc(label("locations", m.toLoc)) : ""} · ${m.date ? m.date.toDate().toLocaleString("es-MX",{dateStyle:"short",timeStyle:"short"}) : "…"} · ${esc((m.by || "").split("@")[0])}${m.note ? " · " + esc(m.note) : ""}</div>
  </div>`).join("") || `<p class="mute">Aún no hay movimientos.</p>`;
}

/* ---------- Ajustes: propiedades, categorías y ubicaciones ---------- */
function renderCfg() {
  if (!can("settings")) { $("#cam").innerHTML = ""; return; }
  const focus = document.activeElement?.id, vals = {}; Object.keys(K).forEach(k => vals[k] = $("#n_"+k)?.value || "");
  $("#cam").innerHTML = Object.entries(K).map(([k, c]) => `
    <div class="panel"><h2 style="margin-top:0;font-size:1.1rem">${c.title}</h2>
      ${k === "fields" ? `<p class="mute">Número de parte, descripción, color y características siempre existen. Aquí agregas las demás.</p>` : ""}
      <div class="row"><div><label for="n_${k}">Nuevo nombre</label><input id="n_${k}" placeholder="${c.hint}"></div><button data-a="${k}" style="flex:0 0 auto">Agregar</button></div>
      <table style="margin-top:.8rem"><tbody>${S[k].map(f => `<tr><td>${esc(f.label)}</td><td style="text-align:right"><button class="del" data-k="${k}" data-r="${f.key}">Quitar</button></td></tr>`).join("") || `<tr><td class="mute">Aún no hay elementos.</td></tr>`}</tbody></table>
    </div>`).join("");
  Object.keys(K).forEach(k => $("#n_"+k).value = vals[k]);
  if (focus && $("#"+focus)) $("#"+focus).focus();
}
$("#cam").onclick = async e => {
  if (!can("settings")) return;
  const a = e.target.dataset.a, r = e.target.dataset.r, k = e.target.dataset.k;
  if (a) {
    const input = $("#n_"+a), name = input.value.trim(), key = slug(name);
    const used = [...S[a], ...(a === "fields" ? BASE : [])].some(f => f.key === key);
    if (!key || used) return alert("Escribe un nombre que no exista todavía.");
    await setDoc(doc(db,"config",K[a].doc), {[K[a].prop]: [...S[a], {key, label:name}]});
  } else if (r) {
    if (k === "locations" && products.some(p => (p.stockByLoc?.[r] || 0) > 0)) return alert("Aún hay existencia en esa ubicación. Traslada o da salida al producto primero.");
    if (confirm("Se quita de las listas. Los datos ya guardados en productos y movimientos se conservan.")) await setDoc(doc(db,"config",K[k].doc), {[K[k].prop]: S[k].filter(f => f.key !== r)});
  }
};

/* ---------- Usuarios (solo administradores) ---------- */
const roleOpts = sel => Object.entries(ROLES).map(([k, r]) => `<option value="${k}" ${k===sel?"selected":""}>${r.label}</option>`).join("");
$("#ur").innerHTML = roleOpts("consulta");
$("#rolehelp").innerHTML = Object.values(ROLES).map(r => `<b>${r.label}:</b> ${r.info}.`).join(" ");
function renderUsers() {
  if (!can("users") || !auth.currentUser) { $("#ulist").innerHTML = ""; return; }
  $("#ulist").innerHTML = users.map(u => { const self = u.id === auth.currentUser.uid; return `<div class="mv">
    <div class="mvh"><b>${esc(u.name)}</b>${self ? `<span class="tag">Tú</span>` : ""}</div>
    <div class="mute">${esc(u.email)}</div>
    <div class="row" style="margin-top:.5rem;align-items:center">
      <select style="flex:1 1 150px" data-ur="${u.id}" ${self?"disabled":""} aria-label="Rol de ${esc(u.email)}">${roleOpts(u.role)}</select>
      <label style="margin:0;display:flex;gap:.5rem;align-items:center;flex:0 0 auto"><input type="checkbox" data-ua="${u.id}" ${u.active?"checked":""} ${self?"disabled":""}> Activo</label>
    </div>
    <div class="acts"><button class="sec" data-up="${esc(u.email)}">Restablecer contraseña</button></div>
  </div>`; }).join("");
}
$("#ulist").onchange = async e => {
  if (!can("users")) return;
  if (e.target.dataset.ur) await updateDoc(doc(db,"users",e.target.dataset.ur), {role:e.target.value});
  if (e.target.dataset.ua) await updateDoc(doc(db,"users",e.target.dataset.ua), {active:e.target.checked});
};
$("#ulist").onclick = async e => {
  const mail = e.target.dataset.up; if (!mail || !can("users")) return;
  try { await sendPasswordResetEmail(auth, mail); alert("Se envió un correo para restablecer la contraseña a " + mail); }
  catch { alert("No se pudo enviar el correo."); }
};
$("#ugo").onclick = async () => {
  if (!can("users")) return;
  const name = $("#un").value.trim(), email = $("#ue").value.trim(), pw = $("#up").value, role = $("#ur").value;
  const err = m => $("#uerr").textContent = m; err("");
  if (!name || !email) return err("Escribe el nombre y el correo.");
  if (pw.length < 6) return err("La contraseña temporal necesita al menos 6 caracteres.");
  $("#ugo").disabled = true;
  try {
    const cred = await createUserWithEmailAndPassword(authAlt, email, pw);
    await setDoc(doc(db,"users",cred.user.uid), {name, email, role, active:true, createdAt:serverTimestamp()});
    await signOut(authAlt);
    $("#un").value = $("#ue").value = $("#up").value = "";
  } catch (e) {
    err(e.code === "auth/email-already-in-use" ? "Ese correo ya tiene cuenta. Si ya lo diste de alta, búscalo en la lista." :
        e.code === "auth/invalid-email" ? "El correo no es válido." :
        e.code === "auth/operation-not-allowed" ? "En Authentication debe estar permitido crear cuentas (User actions)." : "No se pudo crear: " + e.message);
  }
  $("#ugo").disabled = false;
};

/* ---------- App instalable (PWA) ---------- */
if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
let installEv = null;
addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEv = e; $("#inst").hidden = false; });
$("#inst").onclick = async () => { if (!installEv) return; installEv.prompt(); await installEv.userChoice; installEv = null; $("#inst").hidden = true; };
addEventListener("appinstalled", () => { $("#inst").hidden = true; });

/* ---------- Cámara ---------- */
$("#galbtn").onclick = () => $("#img").click();
$("#img").onchange = () => { addFiles([...$("#img").files]); $("#img").value = ""; };
$("#imgcam").onchange = () => { addFiles([...$("#imgcam").files]); $("#imgcam").value = ""; };
$("#cambtn").onclick = async () => {
  // En celular/tableta abre la cámara nativa; en computadora usa la cámara web con vista previa
  if (matchMedia("(pointer: coarse)").matches || !navigator.mediaDevices?.getUserMedia) return $("#imgcam").click();
  try {
    stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:"environment", width:{ideal:1920}}, audio:false});
    $("#cv").srcObject = stream; $("#cmsg").textContent = ""; $("#camdlg").showModal();
  } catch { $("#perr").textContent = "No se pudo abrir la cámara. Revisa el permiso del navegador o sube la foto desde la galería."; }
};
function stopCam() { stream?.getTracks().forEach(t => t.stop()); stream = null; $("#cv").srcObject = null; }
$("#snap").onclick = () => {
  const v = $("#cv"); if (!v.videoWidth) return;
  const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext("2d").drawImage(v, 0, 0);
  c.toBlob(b => { addFiles([new File([b], `foto_${Date.now()}.jpg`, {type:"image/jpeg"})]); $("#cmsg").textContent = `Foto agregada (${pending.length}). Captura otra o toca Listo.`; }, "image/jpeg", .9);
};
$("#camdone").onclick = () => $("#camdlg").close();
$("#camdlg").addEventListener("close", stopCam);
