import {initializeApp} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {getAuth,onAuthStateChanged,signInWithEmailAndPassword,signOut,createUserWithEmailAndPassword,sendPasswordResetEmail} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {getFirestore,collection,doc,onSnapshot,setDoc,updateDoc,deleteDoc,runTransaction,serverTimestamp,query,orderBy,limit,getDocs,where,startAfter} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

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
  admin:   {label:"Administrador", p:["users","settings","catalog","moves","backdate"], info:"todo, incluida la administración de usuarios y registrar con fecha anterior"},
  editor:  {label:"Editor",        p:["settings","catalog","moves","backdate"],         info:"catálogo, ajustes y movimientos (puede registrar con fecha anterior)"},
  almacen: {label:"Almacén",       p:["moves"],                               info:"solo registra entradas, salidas y traslados con fecha de hoy"},
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
    onSnapshot(collection(db,"products"), s => { products = s.docs.map(d => ({id:d.id, ...d.data()})).sort((a,b)=>(a.partNumber||"").localeCompare(b.partNumber||"")); renderAll(); if (asOfOn()) setAsOf(); }),
    onSnapshot(query(collection(db,"movements"), orderBy("date","desc"), limit(15)), s => { movs = s.docs.map(d => d.data()); renderMovs(); })
  );
  if (can("users")) dataSubs.push(onSnapshot(collection(db,"users"), s => {
    users = s.docs.map(d => ({id:d.id, ...d.data()})).sort((a,b)=>(a.name||a.email||"").localeCompare(b.name||b.email||"")); renderUsers();
  }));
}
function applyPerms() {
  $("#who").textContent = `${me.name || me.email} · ${ROLES[me.role].label}`;
  const vis = {cat:true, inv:true, mov:true, cam:can("settings"), usr:can("users")};
  document.querySelectorAll("nav button").forEach(b => b.hidden = !vis[b.dataset.t]);
  $("#new").hidden = !can("catalog"); $("#mform").hidden = !can("moves");
  $("#mdt").max = $("#iasof").max = today(); if (!$("#mdt").value || !can("backdate")) $("#mdt").value = today(); $("#mdt").disabled = !can("backdate");
  $("#msub").hidden = !can("moves"); if (!can("moves")) { $("#mreg").hidden = true; $("#mhis").hidden = false; }
  const on = document.querySelector("nav button.on");
  if (!on || on.hidden) showTab("cat");
  renderAll();
}
function showTab(t) {
  scrollTo(0, 0);
  if (t === "mov" && !$("#mhis").hidden) setTimeout(loadHis);
  if (t === "mov" && !can("backdate")) $("#mdt").value = today();
  document.querySelectorAll("nav button").forEach(x => x.classList.toggle("on", x.dataset.t === t));
  ["cat","inv","mov","cam","usr"].forEach(id => $("#"+id).hidden = id !== t);
}
document.querySelectorAll("nav button").forEach(b => b.onclick = () => showTab(b.dataset.t));
$("#go").onclick = async () => {
  try { await signInWithEmailAndPassword(auth, $("#em").value, $("#pw").value); $("#lerr").textContent = ""; }
  catch { $("#lerr").textContent = "Correo o contraseña incorrectos."; }
};
$("#out").onclick = $("#out2").onclick = () => signOut(auth);
function renderAll() { renderInvControls(); renderInv(); renderCfg(); renderFields(); renderFilter(); renderList(); renderSelect(); renderMovs(); renderUsers(); }

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
    goMove(e.target.dataset.m); return;
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
  const dv = $("#mdt").value || today();
  if (dv > today()) return err("La fecha del movimiento no puede ser futura.");
  if (!can("backdate") && dv !== today()) return err("Solo un administrador o editor puede registrar con fecha anterior.");
  const [yy, mm, dd] = dv.split("-").map(Number), when = dv === today() ? new Date() : new Date(yy, mm - 1, dd, 12, 0, 0);
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
      tx.set(doc(collection(db,"movements")), {productId:id, partNumber:p.partNumber, description:p.description, type, qty, loc:from, toLoc:type==="transfer"?to:null, stockAfter:total, note, date:when, createdAt:serverTimestamp(), by:auth.currentUser.email});
    });
    $("#mq").value = 1; $("#mn").value = ""; $("#mps").value = ""; renderSelect();
    toast({in:"Entrada registrada", out:"Salida registrada", transfer:"Traslado registrado"}[type] + (dv !== today() ? ` (${dv.split("-").reverse().join("/")})` : "")); navigator.vibrate?.(40);
  } catch (e) { err(e.message); }
};
const TIPO = {in:"Entrada", out:"Salida", transfer:"Traslado"};
const regNote = m => (m.createdAt && m.date && m.createdAt.toDate().toDateString() !== m.date.toDate().toDateString()) ? ` · registrado el ${m.createdAt.toDate().toLocaleDateString("es-MX",{dateStyle:"short"})}` : "";
const movCard = m => `<div class="mv">
    <div class="mvh"><span class="tag ${m.type}">${TIPO[m.type]}</span><b>${m.qty}</b><span>${esc(m.partNumber)}</span></div>
    <div class="mute">${esc(m.description)}</div>
    <div class="mute">${esc(label("locations", m.loc))}${m.toLoc ? " → " + esc(label("locations", m.toLoc)) : ""} · ${m.date ? m.date.toDate().toLocaleString("es-MX",{dateStyle:"short",timeStyle:"short"}) : "…"} · ${esc((m.by || "").split("@")[0])}${regNote(m)}${m.note ? " · " + esc(m.note) : ""}</div>
  </div>`;
function renderMovs() { $("#mlist").innerHTML = movs.map(movCard).join("") || `<p class="mute">Aún no hay movimientos.</p>`; }

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
const instBtns = () => [$("#inst"), $("#inst2")];
addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEv = e; instBtns().forEach(b => b.hidden = false); $("#insttip").hidden = true; });
instBtns().forEach(b => b.onclick = async () => { if (!installEv) return; installEv.prompt(); await installEv.userChoice; installEv = null; instBtns().forEach(x => x.hidden = true); });
addEventListener("appinstalled", () => instBtns().forEach(b => b.hidden = true));
// Guía para cuando el navegador no ofrece el botón (iPhone o navegadores dentro de otras apps)
(() => {
  if (matchMedia("(display-mode: standalone)").matches || navigator.standalone) return;
  const ua = navigator.userAgent, tip = $("#insttip");
  if (/FBAN|FBAV|Instagram|WhatsApp|Line\/|MicroMessenger|; wv\)/i.test(ua)) tip.textContent = "Estás dentro de otra app. Abre esta dirección en Chrome (menú ⋮, “Abrir en el navegador”) para poder instalarla.";
  else if (/iphone|ipad|ipod/i.test(ua)) tip.textContent = "En iPhone: abre esta página en Safari, toca Compartir y elige “Agregar a pantalla de inicio”.";
  else return void setTimeout(() => { if (!installEv) { tip.textContent = "Si no aparece el botón Instalar, abre el menú ⋮ del navegador y elige “Instalar aplicación” o “Agregar a pantalla de inicio”."; tip.hidden = false; } }, 4000);
  tip.hidden = false;
})();

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

/* ---------- Utilidades ---------- */
const kpi = (n, t) => `<div class="kpi"><b>${n}</b><span>${t}</span></div>`;
function fillSel(sel, html) { const cur = $(sel).value; $(sel).innerHTML = html; if ([...$(sel).options].some(o => o.value === cur)) $(sel).value = cur; }
function downloadCSV(name, rows) {
  const csv = "\ufeff" + rows.map(r => r.map(c => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], {type:"text/csv;charset=utf-8"})); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const today = () => { const t = new Date(); return `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,"0")}-${String(t.getDate()).padStart(2,"0")}`; };
function goMove(id) {
  if (!can("moves")) return;
  showTab("mov"); setSub("reg"); $("#mps").value = ""; renderSelect(); $("#mp").value = id; updInfo();
}
function renderInvControls() {
  fillSel("#ig", [{v:"",t:"Sin agrupar"},{v:"category",t:"Categoría"},{v:"loc",t:"Ubicación"},{v:"color",t:"Color"},...S.fields.map(f => ({v:"x:"+f.key, t:f.label}))].map(o => `<option value="${o.v}">${esc(o.t)}</option>`).join(""));
  const lo = S.locations.map(l => `<option value="${l.key}">${esc(l.label)}</option>`).join("");
  fillSel("#il", `<option value="">Todas</option>` + lo);
  fillSel("#hl", `<option value="">Todas</option>` + lo);
  fillSel("#ic", `<option value="">Todas</option>` + S.categories.map(c => `<option value="${c.key}">${esc(c.label)}</option>`).join("") + `<option value="_none">Sin categoría</option>`);
}

/* ---------- Inventario: revisar existencias (actual o a una fecha) ---------- */
let asOfMap = null;
const st = p => asOfMap ? (asOfMap.get(p.id) || {t:0, l:{}}) : {t:p.stock || 0, l:p.stockByLoc || {}};
const asOfOn = () => !!$("#iasof").value && $("#iasof").value !== today();
function invRows() {
  const q = $("#iq").value.trim().toLowerCase(), loc = $("#il").value, cat = $("#ic").value, s = $("#is").value;
  return products.filter(p => {
    if (q && !JSON.stringify([p.partNumber, p.description, p.color, p.features, p.extra]).toLowerCase().includes(q)) return false;
    if (cat === "_none" && p.category) return false;
    if (cat && cat !== "_none" && p.category !== cat) return false;
    const qty = loc ? (st(p).l[loc] || 0) : st(p).t;
    if (s === "con" && qty <= 0) return false;
    if (s === "agotado" && qty > 0) return false;
    return true;
  }).map(p => ({p, qty: loc ? (st(p).l[loc] || 0) : st(p).t}));
}
function invGroups(rows) {
  const g = $("#ig").value, loc = $("#il").value, map = new Map();
  const add = (k, t, r) => { if (!map.has(k)) map.set(k, {t, items:[]}); map.get(k).items.push(r); };
  rows.forEach(r => {
    const p = r.p;
    if (!g) add("", "", r);
    else if (g === "category") add(p.category || "_", label("categories", p.category) || "Sin categoría", r);
    else if (g === "color") { const c = (p.color || "").trim(); add(c.toLowerCase(), c || "Sin color", r); }
    else if (g.startsWith("x:")) { const v = (p.extra?.[g.slice(2)] || "").trim(); add(v.toLowerCase(), v || "Sin dato", r); }
    else if (g === "loc") {
      const ls = S.locations.filter(l => (st(p).l[l.key] || 0) > 0 && (!loc || l.key === loc));
      if (ls.length) ls.forEach(l => add(l.key, l.label, {p, qty:st(p).l[l.key]}));
      else if (!loc) add("_", "Sin existencia", {p, qty:0});
    }
  });
  const out = [...map.values()]; if (g) out.sort((a, b) => a.t.localeCompare(b.t)); return out;
}
function invRow(r) {
  const p = r.p, im = p.images?.[0], loc = $("#il").value, g = $("#ig").value;
  const where = (loc || g === "loc") ? "" : S.locations.filter(l => (st(p).l[l.key] || 0) > 0).map(l => `${esc(l.label)}: ${st(p).l[l.key]}`).join(" · ");
  return `<div class="ir">${im ? `<img src="${esc(thumb(im.url,150))}" alt="" loading="lazy">` : `<div class="ph"></div>`}
    <div class="t"><b>${esc(p.partNumber)}</b> ${esc(p.description)}
      <div class="mute">${esc([label("categories", p.category), p.color].filter(Boolean).join(" · "))}</div>${where ? `<div class="mute">${where}</div>` : ""}</div>
    <div class="q ${r.qty <= 0 ? "low" : ""}">${r.qty}</div>${can("moves") && !asOfMap ? `<button class="sec" data-m="${p.id}">Mover</button>` : ""}</div>`;
}
function renderInv() {
  const rows = invRows(), groups = invGroups(rows);
  $("#ikpi").innerHTML = kpi(rows.reduce((s, r) => s + r.qty, 0), "Piezas") + kpi(rows.length, "Productos") + kpi(rows.filter(r => r.qty <= 0).length, "Agotados");
  $("#ilist").innerHTML = groups.map(g => (g.t ? `<h3 class="gh"><span>${esc(g.t)}</span><span>${g.items.reduce((s, r) => s + r.qty, 0)} pzas · ${g.items.length}</span></h3>` : "") + g.items.map(invRow).join("")).join("") || `<p class="mute">Sin resultados.</p>`;
}
// Existencia a una fecha: parte de la existencia actual y deshace los movimientos posteriores al corte
async function setAsOf() {
  const v = $("#iasof").value, note = $("#iasnote");
  if (!v || v >= today()) { $("#iasof").value = ""; asOfMap = null; note.textContent = ""; return renderInv(); }
  const [y, m, d] = v.split("-").map(Number), cut = new Date(y, m - 1, d, 23, 59, 59, 999);
  note.textContent = "Calculando…";
  const later = []; let last = null, capped = false;
  try {
    for (let i = 0; i < 10; i++) {
      const s = await getDocs(query(collection(db,"movements"), where("date", ">", cut), orderBy("date"), ...(last ? [startAfter(last)] : []), limit(500)));
      later.push(...s.docs.map(x => x.data()));
      if (s.size < 500) break;
      last = s.docs[s.size - 1]; if (i === 9) capped = true;
    }
  } catch (e) { note.textContent = "No se pudo calcular: " + e.message; return; }
  if (capped) { asOfMap = null; note.textContent = "Hay demasiados movimientos posteriores a esa fecha para calcular el corte. Elige una fecha más reciente."; return renderInv(); }
  const map = new Map(products.map(p => [p.id, {t:p.stock || 0, l:{...(p.stockByLoc || {})}}]));
  later.forEach(x => {
    const r = map.get(x.productId); if (!r) return;
    const add = (k, n) => { r.l[k] = (r.l[k] || 0) + n; };
    if (x.type === "in") { add(x.loc, -x.qty); r.t -= x.qty; }
    else if (x.type === "out") { add(x.loc, x.qty); r.t += x.qty; }
    else { add(x.loc, x.qty); add(x.toLoc, -x.qty); }
  });
  asOfMap = map; note.textContent = `Existencia calculada al ${v.split("-").reverse().join("/")} con el historial de movimientos.`;
  renderInv();
}
$("#iasof").onchange = setAsOf;
$("#iq").oninput = renderInv; ["#ig","#il","#ic","#is"].forEach(s => $(s).onchange = renderInv);
$("#ilist").onclick = e => { if (e.target.dataset.m) goMove(e.target.dataset.m); };
$("#icsv").onclick = () => downloadCSV(`inventario_${$("#iasof").value || today()}.csv`, [
  ["Número de parte","Descripción","Color","Categoría",...S.fields.map(f => f.label),"Existencia total",...S.locations.map(l => l.label)],
  ...invRows().map(({p}) => [p.partNumber, p.description, p.color, label("categories", p.category), ...S.fields.map(f => p.extra?.[f.key]), st(p).t, ...S.locations.map(l => st(p).l[l.key] || 0)])
]);

/* ---------- Movimientos: registrar / historial ---------- */
function setSub(s) {
  $("#mreg").hidden = s !== "reg"; $("#mhis").hidden = s !== "his";
  document.querySelectorAll("#msub button").forEach(b => b.classList.toggle("on", b.dataset.s === s));
  if (s === "his") loadHis();
}
$("#msub").onclick = e => { if (e.target.dataset.s) setSub(e.target.dataset.s); };
let hisAll = [], hisShown = [];
function hisRange() {
  const mode = document.querySelector("#mrange .on").dataset.d, t = new Date();
  const end = new Date(t.getFullYear(), t.getMonth(), t.getDate(), 23, 59, 59, 999);
  if (mode === "c") { const f = $("#hf").value, u = $("#ht").value; return [f ? new Date(f + "T00:00:00") : new Date(0), u ? new Date(u + "T23:59:59.999") : end]; }
  if (mode === "m") return [new Date(t.getFullYear(), t.getMonth(), 1), end];
  return [new Date(t.getFullYear(), t.getMonth(), t.getDate() - Math.max(0, +mode - 1)), end];
}
async function loadHis() {
  const [from, to] = hisRange();
  $("#hlist").innerHTML = `<p class="mute">Cargando…</p>`;
  try {
    const s = await getDocs(query(collection(db,"movements"), where("date", ">=", from), where("date", "<=", to), orderBy("date","desc"), limit(500)));
    hisAll = s.docs.map(d => d.data());
  } catch (e) { $("#hlist").innerHTML = `<p class="err">No se pudo cargar: ${esc(e.message)}</p>`; return; }
  fillSel("#hu", `<option value="">Todos</option>` + [...new Set(hisAll.map(m => m.by).filter(Boolean))].sort().map(u => `<option value="${esc(u)}">${esc(u.split("@")[0])}</option>`).join(""));
  renderHis();
}
function renderHis() {
  const ty = $("#hty").value, lo = $("#hl").value, q = $("#hq").value.trim().toLowerCase(), u = $("#hu").value;
  hisShown = hisAll.filter(m => (!ty || m.type === ty) && (!lo || m.loc === lo || m.toLoc === lo) && (!u || m.by === u) &&
    (!q || `${m.partNumber} ${m.description} ${m.note || ""}`.toLowerCase().includes(q)));
  const sum = t => hisShown.filter(m => m.type === t).reduce((s, m) => s + m.qty, 0);
  $("#hkpi").innerHTML = kpi(sum("in"), "Piezas que entraron") + kpi(sum("out"), "Piezas que salieron") + kpi(hisShown.length, "Movimientos");
  const cut = hisAll.length >= 500 ? `<p class="mute">Se muestran los 500 más recientes del periodo. Acota las fechas para ver el resto.</p>` : "";
  const sum2 = document.querySelector("#hview .on").dataset.v === "r";
  $("#hlist").innerHTML = (sum2 ? hisSummary().map(x => `<div class="ir"><div class="t"><b>${esc(x.pn)}</b> ${esc(x.d)}<div class="mute">Entradas ${x.in} · Salidas ${x.out}${x.tr ? ` · Traslados ${x.tr}` : ""}</div></div><div class="q ${x.in - x.out < 0 ? "low" : ""}">${x.in - x.out > 0 ? "+" : ""}${x.in - x.out}</div></div>`).join("") : hisShown.map(movCard).join("")) + cut || `<p class="mute">No hay movimientos con estos filtros.</p>`;
}
$("#mrange").onclick = e => {
  if (e.target.dataset.d === undefined) return;
  document.querySelectorAll("#mrange button").forEach(b => b.classList.toggle("on", b === e.target));
  $("#mdates").hidden = e.target.dataset.d !== "c";
  if (e.target.dataset.d === "c" && !$("#hf").value) { $("#hf").value = $("#ht").value = today(); }
  loadHis();
};
["#hf","#ht"].forEach(s => $(s).onchange = loadHis);
["#hty","#hl","#hu"].forEach(s => $(s).onchange = renderHis); $("#hq").oninput = renderHis;
$("#hcsv").onclick = () => {
  if (document.querySelector("#hview .on").dataset.v === "r") return downloadCSV(`resumen_movimientos_${today()}.csv`, [["Número de parte","Descripción","Entradas","Salidas","Traslados","Neto"], ...hisSummary().map(x => [x.pn, x.d, x.in, x.out, x.tr, x.in - x.out])]);
  downloadCSV(`movimientos_${today()}.csv`, [
    ["Fecha del movimiento","Registrado","Tipo","Número de parte","Descripción","Cantidad","Ubicación","Destino","Nota","Usuario"],
    ...hisShown.map(m => [m.date ? m.date.toDate().toLocaleString("es-MX") : "", m.createdAt ? m.createdAt.toDate().toLocaleString("es-MX") : "", TIPO[m.type], m.partNumber, m.description, m.qty, label("locations", m.loc), m.toLoc ? label("locations", m.toLoc) : "", m.note, m.by])
  ]);
};
function hisSummary() {
  const mp = new Map();
  hisShown.forEach(x => { const r = mp.get(x.productId) || {pn:x.partNumber, d:x.description, in:0, out:0, tr:0}; if (x.type === "in") r.in += x.qty; else if (x.type === "out") r.out += x.qty; else r.tr += x.qty; mp.set(x.productId, r); });
  return [...mp.values()].sort((a, b) => a.pn.localeCompare(b.pn));
}
$("#hview").onclick = e => { if (!e.target.dataset.v) return; document.querySelectorAll("#hview button").forEach(b => b.classList.toggle("on", b === e.target)); renderHis(); };
