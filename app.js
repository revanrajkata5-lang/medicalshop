/* ═══════════════════════════════════════════════════
   FIREBASE — MODULAR SDK (v10, ES modules)
   Medicine inventory, bills, and users/logins all sync
   online via Firestore in real time.
═══════════════════════════════════════════════════ */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, doc, onSnapshot, setDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBO5bPVNoLbAb0XHonawg3uRqwAZMzL5Pk",
  authDomain: "medico-ce520.firebaseapp.com",
  projectId: "medico-ce520",
  storageBucket: "medico-ce520.firebasestorage.app",
  messagingSenderId: "1057947361751",
  appId: "1:1057947361751:web:c68b5495114899ef8cab92"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const medsDocRef  = doc(db, 'pharmacy_data', 'medicines');
const billsDocRef = doc(db, 'pharmacy_data', 'bills');
const usersDocRef = doc(db, 'pharmacy_data', 'users');
const settingsDocRef = doc(db, 'pharmacy_data', 'settings');

let medsCache  = [];
let billsCache = [];
let usersCache = {};   // { username: password }
let rolesCache = {};   // { username: 'admin'|'staff' }
let settingsCache = { dlNumber: '' };  // shop-wide settings (DL number etc.)

let medsReady=false, billsReady=false, usersReady=false, settingsReady=false;

// Live sync: whenever the "medicines" document changes — from THIS device
// or from any other device/browser open on this same Firebase project —
// this fires and every open view refreshes automatically.
onSnapshot(medsDocRef, snap=>{
  medsCache = (snap.exists() && Array.isArray(snap.data().list)) ? snap.data().list : [];
  medsReady = true;
  if(document.getElementById('page-inventory')?.classList.contains('active')) renderInventory();
  if(document.getElementById('page-shortage')?.classList.contains('active')) renderShortage();
  renderShortageBadge();
}, err=>{
  console.error('Firestore sync error (medicines):', err);
  showToast('⚠️ Could not connect to online medicine storage','error');
});

// Bills / billing history — synced the same way as medicines.
onSnapshot(billsDocRef, snap=>{
  billsCache = (snap.exists() && Array.isArray(snap.data().list)) ? snap.data().list : [];
  billsReady = true;
  if(document.getElementById('page-history')?.classList.contains('active')) renderHistory();
  if(document.getElementById('page-admin')?.classList.contains('active')) renderStaffActivity();
}, err=>{
  console.error('Firestore sync error (bills):', err);
  showToast('⚠️ Could not connect to online bill history','error');
});

// Users & roles / logins — synced the same way as medicines.
onSnapshot(usersDocRef, snap=>{
  if(snap.exists()){
    usersCache = snap.data().users || {};
    rolesCache = snap.data().roles || {};
  } else {
    usersCache = {}; rolesCache = {};
  }
  const firstLoad = !usersReady;
  usersReady = true;
  if(firstLoad) ensureDefaultAdmin();
  updateLoginReadyUI();
  if(document.getElementById('page-admin')?.classList.contains('active')) renderAdminPanel();
}, err=>{
  console.error('Firestore sync error (users):', err);
  showToast('⚠️ Could not connect to online user accounts','error');
});

// Shop settings (DL Number etc.) — synced the same way as everything else.
onSnapshot(settingsDocRef, snap=>{
  settingsCache = snap.exists() ? { dlNumber: snap.data().dlNumber || '' } : { dlNumber: '' };
  settingsReady = true;
  if(document.getElementById('page-admin')?.classList.contains('active')) renderDlNumberField();
}, err=>{
  console.error('Firestore sync error (settings):', err);
  showToast('⚠️ Could not connect to online settings','error');
});

/* Ensure a default admin account always exists online, mirroring the
   previous local-only bootstrap logic. Runs once, after first sync. */
function ensureDefaultAdmin(){
  let users = {...usersCache};
  let roles = {...rolesCache};
  let changed = false;
  if(users['admin']==='admin123'){ delete users['admin']; delete roles['admin']; changed=true; }
  if(users['Revanraj']){ delete users['Revanraj']; delete roles['Revanraj']; changed=true; }
  if(!users['KataSudhakar']){ users['KataSudhakar']='9985277365@s'; changed=true; }
  if(!roles['KataSudhakar']){ roles['KataSudhakar']='admin'; changed=true; }
  if(changed) saveUsers(users, roles);
}

function updateLoginReadyUI(){
  const btn=document.getElementById('loginBtn'); const hint=document.getElementById('loginHint');
  if(!btn||!hint) return;
  if(usersReady){ btn.disabled=false; btn.textContent='Sign In'; hint.textContent='Contact your admin to get account access'; }
  else{ btn.disabled=true; btn.textContent='Loading...'; hint.textContent='Connecting to online account storage...'; }
}

/* ═══════════════════════════════════════════════════
   STORAGE (local — kept only for "remember me" autofill,
   a per-device convenience, not source of truth for data)
═══════════════════════════════════════════════════ */
const STORE = {
  get(k){ try{ return JSON.parse(localStorage.getItem(k)); }catch(e){ return null; } },
  set(k,v){ localStorage.setItem(k,JSON.stringify(v)); }
};

let currentUser = null;
let cart = [];
let selectedBillMed = null;
let acIndex = -1;

const SHOP_ADDRESS = 'Near Bus Stand, Gogulamallaiah Bazar, Mahabubabad, 506101, Telangana';

/* ═══════════════════════════════════════════════════
   STOCK THRESHOLDS
═══════════════════════════════════════════════════ */
function getStockThresholds(type){
  switch(type){
    case 'tablet':      return {good:100, ok:30};
    case 'capsule':     return {good:100, ok:30};
    case 'syrup':       return {good:10,  ok:5};
    case 'suspension':  return {good:10,  ok:5};
    case 'injection':   return {good:10,  ok:5};
    case 'topical':     return {good:20,  ok:10};
    case 'drops':       return {good:20,  ok:10};
    case 'inhaler':     return {good:10,  ok:5};
    case 'suppository': return {good:20,  ok:10};
    case 'patch':       return {good:20,  ok:10};
    case 'drink':       return {good:10,  ok:5};
    case 'powder':      return {good:20,  ok:10};
    default:            return {good:20,  ok:10};
  }
}

function getStockLevel(type, qty){
  const t = getStockThresholds(type);
  if(qty === null || qty === undefined || qty === '') return {key:'none', label:'Not Set', cls:'qty-none', icon:'—'};
  const q = parseInt(qty);
  if(q === 0) return {key:'danger', label:'Out of Stock', cls:'qty-danger', icon:'❌'};
  if(q < t.ok)   return {key:'danger', label:'Danger ('+q+')', cls:'qty-danger', icon:'🔴'};
  if(q < t.good) return {key:'ok',     label:'Low ('+q+')',    cls:'qty-ok',     icon:'🟡'};
  return              {key:'good',   label:'Good ('+q+')',  cls:'qty-good',   icon:'🟢'};
}

function typeLabel(type){
  const map={
    tablet:'💊 Tablet', capsule:'💊 Capsule', syrup:'🍶 Syrup', suspension:'🧴 Suspension',
    injection:'💉 Injection', topical:'🧴 Topical', drops:'💧 Drops', inhaler:'🌬️ Inhaler/Nebulizer',
    suppository:'🔘 Suppository', patch:'🩹 Patch', drink:'🥤 Drink', powder:'🧂 Powder', other:'📦 Other'
  };
  return map[type]||'📦 Other';
}
function typeCls(type){
  const map={
    tablet:'type-tablet', capsule:'type-capsule', syrup:'type-syrup', suspension:'type-suspension',
    injection:'type-injection', topical:'type-topical', drops:'type-drops', inhaler:'type-inhaler',
    suppository:'type-suppository', patch:'type-patch', drink:'type-drink', powder:'type-powder', other:'type-other'
  };
  return map[type]||'type-other';
}
function scheduleLabel(s){
  const map={H:'Schedule H',H1:'Schedule H1',H2:'Schedule H2',X:'Schedule X',T:'Schedule T',A:'Schedule A',B:'Schedule B',C:'Schedule C',D:'Schedule D',F:'Schedule F',G:'Schedule G',M:'Schedule M',N:'Schedule N',O:'Schedule O',P:'Schedule P',Q:'Schedule Q',R:'Schedule R',S:'Schedule S',U:'Schedule U',V:'Schedule V',Y:'Schedule Y'};
  return map[s]||'—';
}
function scheduleCls(s){
  const map={H:'schedule-h',H1:'schedule-h1',H2:'schedule-h2',X:'schedule-x',T:'schedule-t'};
  if(map[s])return map[s];
  return (s&&s!=='none')?'schedule-other':'schedule-none';
}

/* ═══════════════════════════════════════════════════
   BLUETOOTH PRINTER
═══════════════════════════════════════════════════ */
let btDevice=null, btCharacteristic=null;
const PRINTER_SERVICE_UUIDS=['000018f0-0000-1000-8000-00805f9b34fb','0000ff00-0000-1000-8000-00805f9b34fb','0000ffe0-0000-1000-8000-00805f9b34fb','49535343-fe7d-4ae5-8fa9-9fafd205e455','e7810a71-73ae-499d-8c15-faa9aef0c3f2','0000ff12-0000-1000-8000-00805f9b34fb'];
const PRINTER_CHAR_UUIDS=['0000ff02-0000-1000-8000-00805f9b34fb','00002af1-0000-1000-8000-00805f9b34fb','49535343-8841-43f4-a8d4-ecbe34729bb3','0000ffe1-0000-1000-8000-00805f9b34fb','bef8d6c9-9c21-4c9e-b632-bd58c1009f9f','0000ff01-0000-1000-8000-00805f9b34fb'];

function btLog(msg){ const log=document.getElementById('btDebugLog'); if(!log)return; log.style.display='block'; const l=document.createElement('div'); l.textContent='['+new Date().toLocaleTimeString()+'] '+msg; log.appendChild(l); log.scrollTop=log.scrollHeight; }

async function connectBTPrinter(){
  if(!navigator.bluetooth){ showToast('Web Bluetooth not supported. Use Chrome/Edge.','warn'); return; }
  const btn=document.getElementById('btBtn'); btn.textContent='🔄 Scanning...'; btn.disabled=true;
  try{ btDevice=await navigator.bluetooth.requestDevice({acceptAllDevices:true,optionalServices:PRINTER_SERVICE_UUIDS}); }
  catch(e){ resetPrinterBtn(); return; }
  btn.textContent='🔄 Connecting...';
  let server=null;
  for(let i=1;i<=3;i++){ try{ if(i>1)await new Promise(r=>setTimeout(r,1200)); server=await btDevice.gatt.connect(); btLog('GATT connected attempt '+i); break; }catch(e){ btLog('GATT attempt '+i+' failed: '+e.message); if(i===3){ showToast('Cannot connect. Turn printer OFF/ON and retry.','warn'); resetPrinterBtn(); return; } } }
  let allServices=[];
  try{ allServices=await server.getPrimaryServices(); btLog('Found '+allServices.length+' services'); }catch(e){}
  let service=null;
  for(const uuid of PRINTER_SERVICE_UUIDS){ try{ service=await server.getPrimaryService(uuid); btLog('Service: '+uuid); break; }catch(e){} }
  if(!service&&allServices.length>0){ service=allServices[0]; btLog('Using first service: '+service.uuid); }
  if(!service){ showToast('No printer service found.','warn'); resetPrinterBtn(); return; }
  let chars=[];
  try{ chars=await service.getCharacteristics(); }catch(e){ for(const uuid of PRINTER_CHAR_UUIDS){ try{ const c=await service.getCharacteristic(uuid); chars.push(c); break; }catch(e2){} } }
  btCharacteristic=null;
  for(const tx of PRINTER_CHAR_UUIDS){ const f=chars.find(c=>c.uuid===tx); if(f&&(f.properties.write||f.properties.writeWithoutResponse)){ btCharacteristic=f; break; } }
  if(!btCharacteristic) btCharacteristic=chars.find(c=>c.properties.write||c.properties.writeWithoutResponse);
  if(!btCharacteristic){ showToast('No writable channel on printer.','warn'); resetPrinterBtn(); return; }
  const name=btDevice.name||'Thermal Printer';
  btn.textContent='✅ '+name; btn.classList.add('connected'); btn.disabled=false;
  document.getElementById('printerStatusBar').style.display='block';
  updateBtPrintHint(); showToast('✅ '+name+' connected!','success');
  btDevice.addEventListener('gattserverdisconnected',()=>{ btCharacteristic=null; btDevice=null; resetPrinterBtn(); document.getElementById('printerStatusBar').style.display='none'; updateBtPrintHint(); showToast('Printer disconnected','warn'); });
}

function resetPrinterBtn(){ const btn=document.getElementById('btBtn'); btn.textContent='🖨️ Connect Printer'; btn.classList.remove('connected'); btn.disabled=false; }

function buildEscPos(bill){
  const enc=new TextEncoder(); const chunks=[]; const ESC=0x1B,GS=0x1D,LF=0x0A;
  const raw=(...b)=>chunks.push(new Uint8Array(b)); const text=s=>chunks.push(enc.encode(s)); const nl=()=>chunks.push(new Uint8Array([LF])); const line=s=>{text(s);nl();};
  const W=32; const pad=(s,n)=>String(s).substring(0,n).padEnd(n); const rpad=(s,n)=>String(s).substring(0,n).padStart(n); const divider=()=>line('-'.repeat(W));
  raw(ESC,0x40); raw(ESC,0x74,0x00); raw(GS,0x61,0x00);
  raw(ESC,0x61,0x01); raw(ESC,0x21,0x10); line('Rajeshwari Medical'); raw(ESC,0x21,0x00); line('& General Store');
  const shopAddr=bill.shopAddress||SHOP_ADDRESS; for(let i=0;i<shopAddr.length;i+=W) line(shopAddr.substring(i,i+W));
  if(bill.dlNumber) line('D.L. No: '+bill.dlNumber);
  nl();
  raw(ESC,0x61,0x00); divider(); line('Bill  : '+bill.billId); line('Date  : '+bill.date); line('Pt    : '+(bill.patient||'Walk-in').substring(0,22)); if(bill.patientPhone) line('Ph.   : '+bill.patientPhone.substring(0,23)); if(bill.patientAddress) line('Addr  : '+bill.patientAddress.substring(0,23)); if(bill.doctor&&bill.doctor!=='—') line('Dr.   : '+bill.doctor.substring(0,23)); divider();
  line(pad('Item',16)+pad('Qty',5)+rpad('Amt',11)); divider();
  bill.items.forEach(item=>{ const name=item.name.substring(0,16); const qty=String(item.qty).padStart(4)+' '; const amount=('Rs'+(item.price*item.qty).toFixed(2)).padStart(11); if(item.name.length>16){ line(name); line(' '.repeat(16)+qty+amount); line('  '+item.name.substring(16,30)); }else{ line(name+qty+amount); } if(item.batch){ line('  Batch: '+item.batch); } });
  divider();
  const sub=bill.sub.toFixed(2); const discount=(bill.discount!=null?bill.discount:bill.sub*0.03).toFixed(2); const total=bill.total.toFixed(2);
  line(pad('Subtotal:',W-12)+('Rs'+sub).padStart(12)); line(pad('Discount(3%):',W-12)+('-Rs'+discount).padStart(12)); divider();
  raw(ESC,0x21,0x30); line(pad('TOTAL:',W-14)+('Rs'+total).padStart(14)); raw(ESC,0x21,0x00);
  divider(); raw(ESC,0x61,0x01); line('By: '+(bill.generatedBy||'')); line('Thank you! Come again.'); nl(); nl(); nl(); raw(GS,0x56,0x00);
  const tlen=chunks.reduce((a,b)=>a+b.length,0); const merged=new Uint8Array(tlen); let off=0; chunks.forEach(c=>{merged.set(c,off);off+=c.length;}); return merged;
}

async function sendToPrinter(data){
  const CS=100,DL=80; btLog('Sending '+data.length+' bytes...');
  for(let i=0;i<data.length;i+=CS){ const sl=data.slice(i,i+CS); try{ if(btCharacteristic.properties.writeWithoutResponse) await btCharacteristic.writeValueWithoutResponse(sl); else await btCharacteristic.writeValue(sl); }catch(e){ btLog('Write error: '+e.message); throw e; } await new Promise(r=>setTimeout(r,DL)); }
  btLog('All sent!');
}

function updateBtPrintHint(){
  const btn=document.getElementById('btPrintBtn'); const hint=document.getElementById('btPrintHint'); if(!btn||!hint)return;
  if(btCharacteristic){ btn.disabled=false; btn.classList.add('connected'); hint.innerHTML='<span style="color:var(--green);font-weight:500">✅ '+(btDevice&&btDevice.name?btDevice.name:'Printer')+' ready</span>'; }
  else{ btn.disabled=true; btn.classList.remove('connected'); hint.innerHTML='Not connected — <a href="#" onclick="event.preventDefault();connectBTPrinter();" style="color:var(--blue);font-weight:500">Connect Printer</a>'; }
}

async function doBTPrint(){
  if(!btCharacteristic){ showToast('Connect a Bluetooth printer first','warn'); return; }
  const bills=billsCache; if(!bills.length){ showToast('No bill to print','warn'); return; }
  const bill=bills[0]; const btn=document.getElementById('btPrintBtn'); btn.textContent='⏳ Printing...'; btn.disabled=true;
  const log=document.getElementById('btDebugLog'); if(log){log.innerHTML='';log.style.display='block';}
  try{ const data=buildEscPos(bill); await sendToPrinter(data); showToast('✅ Receipt sent to printer!','success'); btn.textContent='✅ Printed!'; setTimeout(()=>updateBtPrintHint(),3000); }
  catch(e){ btLog('PRINT FAILED: '+e.message); showToast('Print failed: '+(e.message||'unknown error'),'error'); btCharacteristic=null; btDevice=null; resetPrinterBtn(); document.getElementById('printerStatusBar').style.display='none'; updateBtPrintHint(); }
}

function doBrowserPrint(){ setTimeout(()=>window.print(),150); }

let _toastTimer=null;
function showToast(msg,type){
  const colors={success:'#1a7a4a',error:'#c0392b',warn:'#e67e22'}; const bg=colors[type]||colors.success;
  let t=document.getElementById('toastMsg');
  if(!t){ t=document.createElement('div'); t.id='toastMsg'; t.style.cssText='position:fixed;bottom:28px;left:50%;transform:translateX(-50%);color:white;padding:12px 24px;border-radius:10px;font-size:14px;font-weight:500;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,0.2);transition:opacity 0.4s;opacity:0'; document.body.appendChild(t); }
  if(_toastTimer)clearTimeout(_toastTimer);
  t.style.background=bg; t.textContent=msg; t.style.opacity='1';
  _toastTimer=setTimeout(()=>{ t.style.opacity='0'; },3500);
}

/* ═══════════════════════════════════════════════════
   AUTH — users & roles now come from Firestore (usersCache/rolesCache)
═══════════════════════════════════════════════════ */
function doLogin(){
  if(!usersReady){ showToast('Still connecting to online account storage — try again in a moment','warn'); return; }
  const u=document.getElementById('loginUser').value.trim(); const p=document.getElementById('loginPass').value;
  const users=usersCache; const roles=rolesCache;
  if(users[u]&&users[u]===p){
    currentUser=u;
    document.getElementById('currentUserLabel').textContent=u+' ('+(roles[u]||'staff')+')';
    const isAdmin=(roles[u]||'staff')==='admin';
    document.getElementById('adminTab').style.display=isAdmin?'block':'none';
    document.getElementById('downloadAllBillsBtn').style.display=isAdmin?'inline-flex':'none';
    document.getElementById('loginScreen').style.display='none';
    document.getElementById('appScreen').style.display='block';
    renderInventory(); renderHistory(); renderShortageBadge();
    // Save or clear remembered credentials (local device convenience only)
    if(document.getElementById('rememberMe').checked){
      localStorage.setItem('ms_remember_user', u);
      localStorage.setItem('ms_remember_pass', p);
    } else {
      localStorage.removeItem('ms_remember_user');
      localStorage.removeItem('ms_remember_pass');
    }
    document.getElementById('loginUser').value=''; document.getElementById('loginPass').value=''; document.getElementById('loginError').style.display='none';
  }else{ document.getElementById('loginError').style.display='block'; }
}

function doLogout(){
  currentUser=null; cart=[]; selectedBillMed=null;
  btDevice=null; btCharacteristic=null; resetPrinterBtn();
  document.getElementById('downloadAllBillsBtn').style.display='none';
  document.getElementById('printerStatusBar').style.display='none';
  document.getElementById('appScreen').style.display='none';
  document.getElementById('loginScreen').style.display='flex';
  document.querySelectorAll('.nav-tab').forEach((t,i)=>t.classList.toggle('active',i===0));
  document.querySelectorAll('.page').forEach((p,i)=>p.classList.toggle('active',i===0));
}

/* ═══════════════════════════════════════════════════
   TABS
═══════════════════════════════════════════════════ */
function switchTab(tab,el){
  document.querySelectorAll('.nav-tab').forEach(t=>t.classList.remove('active'));
  el.classList.add('active');
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.getElementById('page-'+tab).classList.add('active');
  if(tab==='history') renderHistory();
  if(tab==='shortage') renderShortage();
  if(tab==='admin') renderAdminPanel();
  if(tab==='billing'){ document.getElementById('billSearch').value=''; selectedBillMed=null; document.getElementById('selectedMedInfo').style.display='none'; }
}

/* ═══════════════════════════════════════════════════
   ADMIN — users/roles read from and written to Firestore
═══════════════════════════════════════════════════ */
function saveUsers(users, roles){
  usersCache = users; rolesCache = roles; // update immediately so UI feels instant
  setDoc(usersDocRef, {users, roles}).catch(err=>{
    console.error('Failed to save users online:', err);
    showToast('⚠️ Failed to save — check your internet connection','error');
  });
}

function renderAdminPanel(){
  renderDlNumberField();
  const users=usersCache; const roles=rolesCache;
  const names=Object.keys(users); const admins=names.filter(u=>(roles[u]||'staff')==='admin'); const staff=names.filter(u=>(roles[u]||'staff')==='staff');
  document.getElementById('aStatUsers').textContent=names.length; document.getElementById('aStatAdmins').textContent=admins.length; document.getElementById('aStatStaff').textContent=staff.length;
  const tbody=document.getElementById('userList'); tbody.innerHTML='';
  names.forEach((u,i)=>{
    const role=roles[u]||'staff'; const isSelf=u===currentUser; const isOnlyAdmin=role==='admin'&&admins.length===1;
    const tr=document.createElement('tr');
    tr.innerHTML=`<td style="color:var(--muted);font-size:12px">${i+1}</td><td style="font-weight:500">${u} ${isSelf?'<span style="background:var(--green-light);color:var(--green);font-size:11px;padding:2px 7px;border-radius:20px">you</span>':''}</td>
      <td><span class="status-pill ${role==='admin'?'status-safe':'status-warning'}">${role}</span></td>
      <td><div style="display:flex;gap:6px;align-items:center"><input type="password" placeholder="New password" id="pw_${u}" style="padding:6px 10px;border:1.5px solid var(--border);border-radius:6px;font-size:13px;width:150px;outline:none;font-family:inherit"/><button class="btn-sm btn-blue" onclick="changePassword('${u}')">Save</button></div></td>
      <td><select id="role_${u}" style="padding:6px 10px;border:1.5px solid var(--border);border-radius:6px;font-size:13px;font-family:inherit;outline:none" onchange="changeRole('${u}',this.value)" ${isOnlyAdmin?'disabled':''}>
        <option value="staff" ${role==='staff'?'selected':''}>Staff</option><option value="admin" ${role==='admin'?'selected':''}>Admin</option></select></td>
      <td><button class="btn-sm btn-danger" onclick="deleteUser('${u}')" ${isSelf||isOnlyAdmin?'disabled style="opacity:0.4;cursor:not-allowed"':''}>Delete</button></td>`;
    tbody.appendChild(tr);
  });
  renderStaffActivity();
}

function adminCreateUser(){
  const u=document.getElementById('newUserName').value.trim(); const p=document.getElementById('newUserPass').value; const role=document.getElementById('newUserRole').value;
  const msg=document.getElementById('adminCreateMsg');
  if(!u||!p){ msg.style.cssText='display:block;color:var(--red);background:var(--red-light);padding:8px 12px;border-radius:6px'; msg.textContent='Please fill username and password'; return; }
  let users={...usersCache};
  if(users[u]){ msg.style.cssText='display:block;color:var(--red);background:var(--red-light);padding:8px 12px;border-radius:6px'; msg.textContent='Username already exists'; return; }
  users[u]=p;
  let roles={...rolesCache}; roles[u]=role;
  saveUsers(users, roles);
  document.getElementById('newUserName').value=''; document.getElementById('newUserPass').value='';
  msg.style.cssText='display:block;color:var(--green);background:var(--green-light);padding:8px 12px;border-radius:6px'; msg.textContent=`User "${u}" created as ${role}`;
  setTimeout(()=>msg.style.display='none',3000); renderAdminPanel();
}

function changePassword(u){ const pw=document.getElementById('pw_'+u).value; if(!pw){ showToast('Enter a new password','warn'); return; } if(pw.length<4){ showToast('Password must be at least 4 chars','warn'); return; } let users={...usersCache}; users[u]=pw; saveUsers(users, rolesCache); document.getElementById('pw_'+u).value=''; showToast(`Password updated for "${u}"`,'success'); }
function changeRole(u,r){ const roles={...rolesCache}; const admins=Object.keys(roles).filter(k=>roles[k]==='admin'); if(roles[u]==='admin'&&admins.length===1&&r==='staff'){ showToast('Cannot demote the only admin.','warn'); document.getElementById('role_'+u).value='admin'; return; } roles[u]=r; saveUsers(usersCache, roles); renderAdminPanel(); }
function deleteUser(u){ if(!confirm(`Delete user "${u}"?`))return; const roles={...rolesCache}; const admins=Object.keys(roles).filter(k=>roles[k]==='admin'); if(roles[u]==='admin'&&admins.length===1){ showToast('Cannot delete the only admin.','warn'); return; } let users={...usersCache}; delete users[u]; delete roles[u]; saveUsers(users, roles); renderAdminPanel(); }

function renderStaffActivity(){
  const meds=medsCache; const bills=billsCache; const users=usersCache; const roles=rolesCache;
  const userFilter=document.getElementById('activityUserFilter').value; const typeFilter=document.getElementById('activityTypeFilter').value;
  const sel=document.getElementById('activityUserFilter'); const prev=sel.value;
  sel.innerHTML='<option value="all">All Staff</option>';
  Object.keys(users).forEach(u=>{ const opt=document.createElement('option'); opt.value=u; opt.textContent=u+' ('+(roles[u]||'staff')+')'; sel.appendChild(opt); }); sel.value=prev;
  let activities=[];
  if(typeFilter!=='bill') meds.forEach(m=>activities.push({type:'medicine',user:m.addedBy||'Unknown',details:m.name,extra:'₹'+parseFloat(m.price).toFixed(2),date:m.addedOn||'—',ts:m.id||0}));
  if(typeFilter!=='medicine') bills.forEach(b=>activities.push({type:'bill',user:b.generatedBy||'Unknown',details:b.billId+' — '+b.patient+' ('+b.items.length+' item'+(b.items.length>1?'s':'')+')',extra:'₹'+b.total.toFixed(2),date:b.date,ts:parseInt(b.billId.replace('RX-',''))||0}));
  if(userFilter!=='all') activities=activities.filter(a=>a.user===userFilter);
  activities.sort((a,b)=>b.ts-a.ts);
  const summaryMap={};
  meds.forEach(m=>{ const u=m.addedBy||'Unknown'; if(!summaryMap[u]) summaryMap[u]={meds:0,bills:0,revenue:0}; summaryMap[u].meds++; });
  bills.forEach(b=>{ const u=b.generatedBy||'Unknown'; if(!summaryMap[u]) summaryMap[u]={meds:0,bills:0,revenue:0}; summaryMap[u].bills++; summaryMap[u].revenue+=b.total; });
  const sd=document.getElementById('staffSummaryCards'); const fu=userFilter==='all'?Object.keys(summaryMap):[userFilter];
  sd.innerHTML=fu.length===0?'':fu.map(u=>{ const s=summaryMap[u]||{meds:0,bills:0,revenue:0}; const role=roles[u]||'staff'; return `<div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:14px 16px"><div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><div style="width:32px;height:32px;border-radius:50%;background:var(--green-light);display:flex;align-items:center;justify-content:center;font-weight:600;font-size:13px;color:var(--green)">${u[0].toUpperCase()}</div><div><div style="font-weight:600;font-size:14px">${u}</div><div style="font-size:11px;color:var(--muted)">${role}</div></div></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:12px"><div style="background:white;border-radius:6px;padding:6px 8px"><div style="color:var(--muted)">Medicines</div><div style="font-weight:600;color:var(--green)">${s.meds}</div></div><div style="background:white;border-radius:6px;padding:6px 8px"><div style="color:var(--muted)">Bills</div><div style="font-weight:600;color:var(--blue)">${s.bills}</div></div><div style="background:white;border-radius:6px;padding:6px 8px;grid-column:span 2"><div style="color:var(--muted)">Revenue</div><div style="font-weight:600;color:var(--amber)">₹${s.revenue.toFixed(2)}</div></div></div></div>`; }).join('');
  const tbody=document.getElementById('activityList'); tbody.innerHTML='';
  document.getElementById('activityEmpty').style.display=activities.length?'none':'block';
  activities.forEach(a=>{ const isMed=a.type==='medicine'; const tr=document.createElement('tr'); tr.innerHTML=`<td><span class="status-pill ${isMed?'status-safe':'status-warning'}">${isMed?'💊 Medicine':'🧾 Bill'}</span></td><td><div style="display:flex;align-items:center;gap:8px"><div style="width:28px;height:28px;border-radius:50%;background:var(--green-light);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:var(--green)">${(a.user||'?')[0].toUpperCase()}</div><span style="font-weight:500">${a.user}</span></div></td><td>${a.details}</td><td style="font-weight:600;color:${isMed?'var(--muted)':'var(--green)'}">${a.extra}</td><td style="color:var(--muted);font-size:13px">${a.date}</td>`; tbody.appendChild(tr); });
}

/* ═══════════════════════════════════════════════════
   INVENTORY
═══════════════════════════════════════════════════ */
function getMeds(){ return medsCache; }
function saveMeds(m){
  medsCache = m; // update immediately so the UI feels instant
  setDoc(medsDocRef, {list:m}).catch(err=>{
    console.error('Failed to save medicines online:', err);
    showToast('⚠️ Failed to save — check your internet connection','error');
  });
}

function getExpiryStatus(expiry){
  const today=new Date(); today.setHours(0,0,0,0); const exp=new Date(expiry); const days=Math.ceil((exp-today)/(1000*60*60*24));
  if(days<0)    return {text:'Expired',                   cls:'status-expired',key:'expired'};
  if(days<=180) return {text:'Expiring ('+days+'d)',       cls:'status-warning',key:'warning'};
  if(days<=365) return {text:'~'+Math.ceil(days/30)+'mo', cls:'status-year',   key:'year'};
  return             {text:'Good',                        cls:'status-safe',   key:'safe'};
}

function addMedicine(){
  const name=document.getElementById('medName').value.trim();
  const expiry=document.getElementById('expiryDate').value;
  const type=document.getElementById('medType').value;
  const qty=document.getElementById('medQty').value;
  const price=parseFloat(document.getElementById('medPrice').value);
  const schedule=document.getElementById('medSchedule').value;
  const batch=document.getElementById('medBatch').value.trim();
  if(!name||!expiry||isNaN(price)||price<0){ showToast('Please fill all fields correctly','warn'); return; }
  const meds=getMeds();
  meds.push({id:Date.now(),name,expiry,type,qty:qty!==''?parseInt(qty):null,price,schedule:schedule||'none',batch:batch||'',addedBy:currentUser,addedOn:new Date().toLocaleDateString('en-IN')});
  saveMeds(meds);
  document.getElementById('medName').value=''; document.getElementById('expiryDate').value=''; document.getElementById('medQty').value=''; document.getElementById('medPrice').value=''; document.getElementById('medSchedule').value='none'; document.getElementById('medBatch').value='';
  renderInventory(); renderShortageBadge(); showToast('Medicine added!','success');
}

function deleteMedicine(id){
  if(!confirm('Remove this medicine from stock?'))return;
  saveMeds(getMeds().filter(m=>m.id!==id));
  renderInventory(); renderShortageBadge();
}

function openEditModal(id){
  const med=getMeds().find(m=>m.id===id); if(!med)return;
  document.getElementById('editMedId').value=id;
  document.getElementById('editName').value=med.name;
  document.getElementById('editType').value=med.type||'tablet';
  document.getElementById('editSchedule').value=med.schedule||'none';
  document.getElementById('editBatch').value=med.batch||'';
  document.getElementById('editExpiry').value=med.expiry;
  document.getElementById('editQtyCurrent').value=med.qty!==null&&med.qty!==undefined?med.qty:'Not Set';
  document.getElementById('editQtyAdd').value='';
  document.getElementById('editQtySet').value='';
  document.getElementById('editPrice').value=med.price;
  document.getElementById('editModal').classList.add('open');
}

function closeEditModal(){ document.getElementById('editModal').classList.remove('open'); }

function saveEditMedicine(){
  const id=parseInt(document.getElementById('editMedId').value);
  const meds=getMeds(); const idx=meds.findIndex(m=>m.id===id); if(idx===-1)return;
  const name=document.getElementById('editName').value.trim();
  const type=document.getElementById('editType').value;
  const schedule=document.getElementById('editSchedule').value;
  const batch=document.getElementById('editBatch').value.trim();
  const expiry=document.getElementById('editExpiry').value;
  const qtyAdd=document.getElementById('editQtyAdd').value;
  const qtySet=document.getElementById('editQtySet').value;
  const price=parseFloat(document.getElementById('editPrice').value);
  if(!name||!expiry||isNaN(price)||price<0){ showToast('Please fill all required fields','warn'); return; }
  let newQty=meds[idx].qty;
  if(qtySet!=='') newQty=parseInt(qtySet);
  else if(qtyAdd!=='') newQty=(newQty||0)+parseInt(qtyAdd);
  meds[idx]={...meds[idx],name,type,schedule:schedule||'none',batch:batch||'',expiry,qty:newQty,price};
  saveMeds(meds); closeEditModal(); renderInventory(); renderShortageBadge(); showToast('Medicine updated!','success');
}

function fuzzyMatch(query, target){
  const q=query.toLowerCase().trim(); const t=target.toLowerCase();
  if(!q)return 1;
  if(t.includes(q))return 1;
  const words=t.split(/\s+/);
  for(const w of words){ if(w.startsWith(q))return 0.9; }
  let qi=0;
  for(let i=0;i<t.length&&qi<q.length;i++){ if(t[i]===q[qi])qi++; }
  return qi===q.length?0.5:0;
}

function highlightMatch(text, query){
  if(!query)return text;
  const idx=text.toLowerCase().indexOf(query.toLowerCase());
  if(idx===-1)return text;
  return text.substring(0,idx)+'<span class="ac-highlight">'+text.substring(idx,idx+query.length)+'</span>'+text.substring(idx+query.length);
}

function renderInventory(){
  const meds=getMeds();
  const search=(document.getElementById('searchInput')?.value||'').toLowerCase().trim();
  const filterStatus=document.getElementById('filterStatus')?.value||'all';
  const filterType=document.getElementById('filterType')?.value||'all';
  const filterStock=document.getElementById('filterStock')?.value||'all';
  const filterSchedule=document.getElementById('filterSchedule')?.value||'all';
  const tbody=document.getElementById('medList'); tbody.innerHTML='';
  let expired=0,warning=0,good=0,low=0;
  meds.forEach(m=>{ const s=getExpiryStatus(m.expiry); if(s.key==='expired')expired++; else if(s.key==='warning')warning++; else good++; const sl=getStockLevel(m.type||'tablet',m.qty); if(sl.key==='danger'||sl.key==='ok')low++; });
  document.getElementById('statTotal').textContent=meds.length;
  document.getElementById('statExpired').textContent=expired;
  document.getElementById('statWarning').textContent=warning;
  document.getElementById('statLow').textContent=low;
  document.getElementById('statGood').textContent=good;

  let filtered=meds.filter(m=>{
    const es=getExpiryStatus(m.expiry); const sl=getStockLevel(m.type||'tablet',m.qty);
    if(filterStatus!=='all'&&es.key!==filterStatus)return false;
    if(filterType!=='all'&&(m.type||'tablet')!==filterType)return false;
    if(filterStock!=='all'&&sl.key!==filterStock)return false;
    if(filterSchedule!=='all'&&(m.schedule||'none')!==filterSchedule)return false;
    if(search){ const score=Math.max(fuzzyMatch(search,m.name),fuzzyMatch(search,m.type||''),fuzzyMatch(search,m.expiry||''),fuzzyMatch(search,m.batch||'')); return score>0; }
    return true;
  });

  if(search){ filtered.sort((a,b)=>{ const sa=Math.max(fuzzyMatch(search,a.name),fuzzyMatch(search,a.type||'')); const sb=Math.max(fuzzyMatch(search,b.name),fuzzyMatch(search,b.type||'')); return sb-sa; }); }

  document.getElementById('invEmpty').style.display=filtered.length?'none':'block';
  filtered.forEach((m,i)=>{
    const es=getExpiryStatus(m.expiry); const sl=getStockLevel(m.type||'tablet',m.qty);
    const tr=document.createElement('tr');
    tr.innerHTML=`
      <td style="color:var(--muted);font-size:12px">${i+1}</td>
      <td style="font-weight:500">${search?highlightMatch(m.name,search):m.name}</td>
      <td><span class="status-pill ${typeCls(m.type||'other')}">${typeLabel(m.type||'other')}</span></td>
      <td><span class="schedule-pill ${scheduleCls(m.schedule)}">${scheduleLabel(m.schedule)}</span></td>
      <td style="font-size:13px;color:var(--muted)">${m.batch?(search?highlightMatch(m.batch,search):m.batch):'—'}</td>
      <td>${m.expiry}</td>
      <td style="font-weight:600">${m.qty!==null&&m.qty!==undefined?m.qty:'—'}</td>
      <td><span class="qty-pill ${sl.cls}">${sl.icon} ${sl.label}</span></td>
      <td>₹${parseFloat(m.price).toFixed(2)}</td>
      <td><span class="status-pill ${es.cls}">${es.text}</span></td>
      <td style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn-sm btn-amber" onclick="openEditModal(${m.id})">✏️ Edit/Restock</button>
        <button class="btn-sm btn-danger" onclick="deleteMedicine(${m.id})">Remove</button>
      </td>`;
    tbody.appendChild(tr);
  });
}

/* ═══════════════════════════════════════════════════
   SHORTAGE PAGE
═══════════════════════════════════════════════════ */
function renderShortageBadge(){
  const meds=getMeds();
  const count=meds.filter(m=>{ const sl=getStockLevel(m.type||'tablet',m.qty); return sl.key==='danger'||sl.key==='ok'; }).length;
  const badge=document.getElementById('shortageBadge');
  if(count>0){ badge.textContent=count; badge.style.display='inline-flex'; }
  else{ badge.style.display='none'; }
}

function renderShortage(){
  const meds=getMeds();
  const dangerItems=meds.filter(m=>getStockLevel(m.type||'tablet',m.qty).key==='danger');
  const okItems=meds.filter(m=>getStockLevel(m.type||'tablet',m.qty).key==='ok');
  const total=dangerItems.length+okItems.length;
  document.getElementById('sStatTotal').textContent=total;
  document.getElementById('sStatDanger').textContent=dangerItems.length;
  document.getElementById('sStatOk').textContent=okItems.length;
  let html='';
  if(total===0){
    html=`<div class="card"><div class="empty-state"><div class="icon">✅</div><p style="color:var(--green);font-weight:500">All medicines are well stocked!</p></div></div>`;
  } else {
    const types=['tablet','capsule','syrup','suspension','injection','topical','drops','inhaler','suppository','patch','drink','powder','other'];
    types.forEach(type=>{
      const danger=dangerItems.filter(m=>(m.type||'other')===type);
      const ok=okItems.filter(m=>(m.type||'other')===type);
      if(danger.length===0&&ok.length===0)return;
      const typeIcons={tablet:'💊',capsule:'💊',syrup:'🍶',suspension:'🧴',injection:'💉',topical:'🧴',drops:'💧',inhaler:'🌬️',suppository:'🔘',patch:'🩹',drink:'🥤',powder:'🧂',other:'📦'};
      const typeNames={tablet:'Tablets',capsule:'Capsules',syrup:'Syrups',suspension:'Suspensions',injection:'Injections',topical:'Topicals',drops:'Drops',inhaler:'Inhalers/Nebulizers',suppository:'Suppositories',patch:'Patches',drink:'Drinks',powder:'Powders',other:'Others'};
      const thresholds=getStockThresholds(type);
      html+=`<div class="card shortage-section"><div class="shortage-section-title">${typeIcons[type]} ${typeNames[type]}<span style="font-size:12px;font-weight:400;color:var(--muted)">Good: ≥${thresholds.good} | Low: ${thresholds.ok}–${thresholds.good-1} | Danger: &lt;${thresholds.ok}</span></div>`;
      if(danger.length>0){
        html+=`<div style="margin-bottom:14px"><div style="font-size:13px;font-weight:600;color:var(--red);margin-bottom:8px;display:flex;align-items:center;gap:6px">🔴 Critical / Danger (${danger.length})</div>`;
        danger.forEach(m=>{ html+=`<div class="shortage-card danger"><div class="shortage-icon">${typeIcons[type]}</div><div class="shortage-info"><div class="shortage-name">${m.name} <span class="schedule-pill ${scheduleCls(m.schedule)}" style="margin-left:6px">${scheduleLabel(m.schedule)}</span></div><div class="shortage-meta">Expiry: ${m.expiry} · Batch: ${m.batch||'—'} · Added by: ${m.addedBy||'—'}</div></div><div class="shortage-qty"><div class="shortage-qty-val">${m.qty!==null&&m.qty!==undefined?m.qty:0}</div><div class="shortage-qty-label">units left</div></div><button class="btn-sm btn-amber" style="margin-left:10px" onclick="openEditModal(${m.id});switchTab('inventory',document.querySelector('.nav-tab'))">✏️ Restock</button></div>`; });
        html+='</div>';
      }
      if(ok.length>0){
        html+=`<div><div style="font-size:13px;font-weight:600;color:var(--yellow);margin-bottom:8px;display:flex;align-items:center;gap:6px">🟡 Low Stock (${ok.length})</div>`;
        ok.forEach(m=>{ html+=`<div class="shortage-card ok"><div class="shortage-icon">${typeIcons[type]}</div><div class="shortage-info"><div class="shortage-name">${m.name} <span class="schedule-pill ${scheduleCls(m.schedule)}" style="margin-left:6px">${scheduleLabel(m.schedule)}</span></div><div class="shortage-meta">Expiry: ${m.expiry} · Batch: ${m.batch||'—'} · Added by: ${m.addedBy||'—'}</div></div><div class="shortage-qty"><div class="shortage-qty-val">${m.qty!==null&&m.qty!==undefined?m.qty:0}</div><div class="shortage-qty-label">units left</div></div><button class="btn-sm btn-amber" style="margin-left:10px" onclick="openEditModal(${m.id});switchTab('inventory',document.querySelector('.nav-tab'))">✏️ Restock</button></div>`; });
        html+='</div>';
      }
      html+='</div>';
    });
  }
  document.getElementById('shortageContent').innerHTML=html;
}

/* ═══════════════════════════════════════════════════
   BILLING — SMART SEARCH
═══════════════════════════════════════════════════ */
function getBillableMeds(){
  return getMeds().filter(m=>getExpiryStatus(m.expiry).key!=='expired');
}

function onBillSearch(){
  const q=document.getElementById('billSearch').value.trim();
  const list=document.getElementById('billAutoList');
  selectedBillMed=null;
  document.getElementById('selectedMedInfo').style.display='none';
  acIndex=-1;
  if(!q){ list.style.display='none'; return; }
  const meds=getBillableMeds();
  const scored=meds.map(m=>{
    const score=Math.max(fuzzyMatch(q,m.name)*2,fuzzyMatch(q,typeLabel(m.type||'other')));
    return {m,score};
  }).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,8);
  if(!scored.length){ list.style.display='none'; return; }
  list.innerHTML=scored.map((x,i)=>{
    const sl=getStockLevel(x.m.type||'tablet',x.m.qty);
    return `<div class="autocomplete-item" data-idx="${i}" onmousedown="selectBillMed(${x.m.id})">
      <span class="status-pill ${typeCls(x.m.type||'other')} ac-type">${typeLabel(x.m.type||'other')}</span>
      ${x.m.schedule&&x.m.schedule!=='none'?`<span class="schedule-pill ${scheduleCls(x.m.schedule)}">${scheduleLabel(x.m.schedule)}</span>`:''}
      <span class="ac-name">${highlightMatch(x.m.name,q)}</span>
      <span class="ac-qty ${sl.cls}" style="padding:2px 8px;border-radius:20px">${sl.icon} ${x.m.qty!==null&&x.m.qty!==undefined?x.m.qty:'—'}</span>
      <span class="ac-price">₹${parseFloat(x.m.price).toFixed(2)}</span>
    </div>`;
  }).join('');
  list._items=scored.map(x=>x.m.id);
  list.style.display='block';
}

function onBillSearchKey(e){
  const list=document.getElementById('billAutoList');
  const items=list.querySelectorAll('.autocomplete-item');
  if(!items.length)return;
  if(e.key==='ArrowDown'){ e.preventDefault(); acIndex=Math.min(acIndex+1,items.length-1); items.forEach((el,i)=>el.classList.toggle('selected',i===acIndex)); }
  else if(e.key==='ArrowUp'){ e.preventDefault(); acIndex=Math.max(acIndex-1,0); items.forEach((el,i)=>el.classList.toggle('selected',i===acIndex)); }
  else if(e.key==='Enter'||e.key==='Tab'){ if(acIndex>=0&&list._items&&list._items[acIndex]!==undefined){ e.preventDefault(); selectBillMed(list._items[acIndex]); } }
  else if(e.key==='Escape'){ document.getElementById('billAutoList').style.display='none'; }
}

function selectBillMed(id){
  const med=getBillableMeds().find(m=>m.id===id); if(!med)return;
  selectedBillMed=med;
  document.getElementById('billSearch').value=med.name;
  document.getElementById('billAutoList').style.display='none';
  const sl=getStockLevel(med.type||'tablet',med.qty);
  const info=document.getElementById('selectedMedInfo');
  info.style.display='block';
  const schedTag=med.schedule&&med.schedule!=='none'?` · <span class="schedule-pill ${scheduleCls(med.schedule)}">${scheduleLabel(med.schedule)}</span>`:'';
  info.innerHTML=`✅ Selected: <strong>${med.name}</strong> · ${typeLabel(med.type||'other')}${schedTag} · Batch: ${med.batch||'—'} · ₹${parseFloat(med.price).toFixed(2)} · Stock: <span class="${sl.cls}" style="padding:1px 6px;border-radius:10px">${sl.icon} ${med.qty!==null&&med.qty!==undefined?med.qty:'—'}</span>`;
}

/* ═══════════════════════════════════════════════════
   CART — NO STOCK DEDUCTION HERE
   Stock is only deducted when bill is GENERATED
═══════════════════════════════════════════════════ */
function addToBill(){
  if(!selectedBillMed){ showToast('Search and select a medicine first','warn'); return; }
  const qty=parseInt(document.getElementById('billQty').value)||1;

  // ── Check available stock before adding ──
  if(selectedBillMed.qty !== null && selectedBillMed.qty !== undefined){
    const alreadyInCart = cart.find(c=>c.id===selectedBillMed.id);
    const alreadyQty = alreadyInCart ? alreadyInCart.qty : 0;
    const totalWanted = alreadyQty + qty;
    if(totalWanted > selectedBillMed.qty){
      showToast(`Only ${selectedBillMed.qty} units available in stock`,'warn');
      return;
    }
  }

  const existing=cart.find(c=>c.id===selectedBillMed.id);
  if(existing){ existing.qty+=qty; }
  else{ cart.push({id:selectedBillMed.id,name:selectedBillMed.name,price:selectedBillMed.price,qty,type:selectedBillMed.type,schedule:selectedBillMed.schedule,batch:selectedBillMed.batch}); }

  // NOTE: Stock is NOT deducted here. It will be deducted when bill is generated.

  selectedBillMed=null;
  document.getElementById('billSearch').value=''; document.getElementById('billQty').value='1';
  document.getElementById('selectedMedInfo').style.display='none';
  renderCart();
  showToast(existing?'Quantity updated':'Added to bill','success');
}

function renderCart(){
  const container=document.getElementById('cartItems');
  const notice=document.getElementById('stockDeductNotice');
  if(!cart.length){
    container.innerHTML=`<div class="empty-state" style="padding:24px"><div class="icon">🛒</div><p>No items added yet</p></div>`;
    updateBillTotals(0);
    notice.classList.remove('visible');
    return;
  }
  let html='',sub=0;
  cart.forEach((item,i)=>{
    const lt=item.price*item.qty; sub+=lt;
    const hasSched=item.schedule&&item.schedule!=='none';
    const schedValue=hasSched?`<span class="schedule-pill ${scheduleCls(item.schedule)}">${scheduleLabel(item.schedule)}</span>`:'—';
    html+=`<div class="cart-item">
      <div class="cart-item-top">
        <div class="cart-name">${item.name}</div>
        <div class="cart-price">₹${parseFloat(item.price).toFixed(2)} each</div>
      </div>
      <div class="cart-fields">
        <div class="cart-field"><div class="cart-field-label">Batch No.</div><div class="cart-field-value">${item.batch||'—'}</div></div>
        <div class="cart-field"><div class="cart-field-label">Schedule Drug</div><div class="cart-field-value">${schedValue}</div></div>
        <div class="cart-field"><div class="cart-field-label">Quantity</div><div class="cart-field-value"><div class="cart-qty"><button class="qty-btn" onclick="changeQty(${i},-1)">−</button><span class="qty-val">${item.qty}</span><button class="qty-btn" onclick="changeQty(${i},1)">+</button></div></div></div>
        <div class="cart-field"><div class="cart-field-label">Amount</div><div class="cart-field-value">₹${lt.toFixed(2)} <button class="btn-sm btn-danger" style="margin-left:6px" onclick="removeCartItem(${i})">✕</button></div></div>
      </div>
    </div>`;
  });
  container.innerHTML=html;
  updateBillTotals(sub);
  notice.classList.add('visible');
}

function changeQty(i,delta){
  const newQty=Math.max(1,cart[i].qty+delta);
  // Check stock limit
  const meds=getMeds(); const med=meds.find(m=>m.id===cart[i].id);
  if(med&&med.qty!==null&&med.qty!==undefined&&newQty>med.qty){
    showToast(`Only ${med.qty} units available in stock`,'warn'); return;
  }
  cart[i].qty=newQty; renderCart();
}
function removeCartItem(i){ cart.splice(i,1); renderCart(); }
function clearCart(){ cart=[]; renderCart(); }

function updateBillTotals(sub){ const d=sub*0.03; const t=sub-d; document.getElementById('subtotalAmt').textContent='₹'+sub.toFixed(2); document.getElementById('discountAmt').textContent='-₹'+d.toFixed(2); document.getElementById('totalAmt').textContent='₹'+t.toFixed(2); }

/* ═══════════════════════════════════════════════════
   GENERATE BILL — STOCK IS DEDUCTED HERE ONLY
   Bill is saved to Firestore (billsCache / billsDocRef)
═══════════════════════════════════════════════════ */
function getBills(){ return billsCache; }
function saveBills(list){
  billsCache = list; // update immediately so the UI feels instant
  setDoc(billsDocRef, {list}).catch(err=>{
    console.error('Failed to save bill history online:', err);
    showToast('⚠️ Failed to save bill — check your internet connection','error');
  });
}

/* ── Admin-only: wipe all billing history ── */
/* ── Admin-only: Drug License (DL) Number, printed on every bill ── */
function renderDlNumberField(){
  const input=document.getElementById('dlNumberInput');
  if(!input) return;
  // Don't clobber what the admin is currently typing
  if(document.activeElement!==input){ input.value=settingsCache.dlNumber||''; }
  const label=document.getElementById('dlNumberCurrent');
  if(label) label.textContent=settingsCache.dlNumber ? settingsCache.dlNumber : 'Not set';
}

function saveDlNumber(){
  const role=rolesCache[currentUser]||'staff';
  if(role!=='admin'){ showToast('Only admins can change the DL number','warn'); return; }
  const val=(document.getElementById('dlNumberInput').value||'').trim();
  if(!val){ showToast('Enter a DL number','warn'); return; }
  settingsCache={...settingsCache, dlNumber:val};
  setDoc(settingsDocRef, {dlNumber:val}).then(()=>{
    showToast('DL Number updated','success');
    renderDlNumberField();
  }).catch(err=>{
    console.error('Failed to save DL number online:', err);
    showToast('⚠️ Failed to save — check your internet connection','error');
  });
}

function deleteAllBills(){
  const role=rolesCache[currentUser]||'staff';
  if(role!=='admin'){ showToast('Only admins can delete billing data','warn'); return; }
  const input=document.getElementById('deleteAllBillsConfirm');
  if((input.value||'').trim()!=='DELETE'){ showToast('Type DELETE in the box to confirm','warn'); return; }
  if(!confirm('This will permanently delete ALL billing history for every staff member. This cannot be undone. Continue?')) return;
  saveBills([]);
  input.value='';
  showToast('All billing data deleted','success');
  renderHistory();
  if(document.getElementById('page-admin')?.classList.contains('active')) renderStaffActivity();
}

function generateBill(){
  if(!cart.length){ showToast('Add medicines to the bill first','warn'); return; }

  // ── Validate required patient details before doing anything else ──
  const patient=document.getElementById('patientName').value.trim();
  const patientPhone=document.getElementById('patientPhone').value.trim();
  const patientAddress=document.getElementById('patientAddress').value.trim();
  if(!patient){ showToast('Patient name is required','warn'); return; }
  if(!patientPhone){ showToast('Patient phone number is required','warn'); return; }
  if(!/^[0-9+\-\s]{7,15}$/.test(patientPhone)){ showToast('Enter a valid phone number','warn'); return; }
  if(!patientAddress){ showToast('Patient address is required','warn'); return; }

  // ── Validate stock availability before finalising ──
  const meds=getMeds();
  for(const item of cart){
    const med=meds.find(m=>m.id===item.id);
    if(med&&med.qty!==null&&med.qty!==undefined&&item.qty>med.qty){
      showToast(`Not enough stock for "${item.name}". Available: ${med.qty}, Requested: ${item.qty}`,'error');
      return;
    }
  }

  // ── Deduct stock from inventory ──
  cart.forEach(item=>{
    const idx=meds.findIndex(m=>m.id===item.id);
    if(idx!==-1&&meds[idx].qty!==null&&meds[idx].qty!==undefined){
      meds[idx].qty=Math.max(0,meds[idx].qty-item.qty);
    }
  });
  saveMeds(meds);
  renderShortageBadge();

  // ── Save bill (online, via Firestore) ──
  const doctor=document.getElementById('doctorRef').value.trim()||'—';
  const sub=cart.reduce((a,c)=>a+c.price*c.qty,0); const discount=sub*0.03; const total=sub-discount;
  const billId='RX-'+Date.now().toString().slice(-6); const date=new Date().toLocaleString('en-IN');
  const bill={billId,patient,patientPhone,patientAddress,doctor,date,items:JSON.parse(JSON.stringify(cart)),sub,discount,total,generatedBy:currentUser,shopAddress:SHOP_ADDRESS,dlNumber:settingsCache.dlNumber||''};
  const history=[bill, ...getBills()]; saveBills(history);

  showReceipt(bill);
}

function showReceipt(bill){
  const discount=bill.discount!=null?bill.discount:(bill.sub*0.03);
  let rows=bill.items.map(item=>`<tr><td>${item.name}</td><td style="text-align:center;font-size:12px">${item.batch||'—'}</td><td style="text-align:center">${item.schedule&&item.schedule!=='none'?`<span class="schedule-pill ${scheduleCls(item.schedule)}" style="font-size:10px">${scheduleLabel(item.schedule)}</span>`:'—'}</td><td style="text-align:center">${item.qty}</td><td style="text-align:right">₹${parseFloat(item.price).toFixed(2)}</td><td style="text-align:right">₹${(item.price*item.qty).toFixed(2)}</td></tr>`).join('');
  document.getElementById('receiptContent').innerHTML=`
    <div class="receipt-header"><h2>💊 Rajeshwari Medical</h2><div class="store-sub">& General Store</div><div class="store-sub">${bill.shopAddress||SHOP_ADDRESS}</div>${bill.dlNumber?`<div class="store-sub">D.L. No: ${bill.dlNumber}</div>`:''}<p style="margin-top:8px;font-weight:600">${bill.billId} &nbsp;|&nbsp; ${bill.date}</p></div>
    <div style="font-size:13px;margin-bottom:16px">
      <div><strong>Patient:</strong> ${bill.patient}</div>
      <div><strong>Phone:</strong> ${bill.patientPhone||'—'}</div>
      <div><strong>Address:</strong> ${bill.patientAddress||'—'}</div>
      <div><strong>Dr. Ref:</strong> ${bill.doctor}</div>
    </div>
    <table class="receipt-table"><thead><tr><th>Medicine</th><th style="text-align:center">Batch No.</th><th style="text-align:center">Schedule</th><th style="text-align:center">Qty</th><th style="text-align:right">Rate</th><th style="text-align:right">Amount</th></tr></thead><tbody>${rows}</tbody></table>
    <div style="text-align:right;font-size:13px;color:var(--muted)">Subtotal: ₹${bill.sub.toFixed(2)}</div>
    <div style="text-align:right;font-size:13px;color:var(--green)">Discount (3%): -₹${discount.toFixed(2)}</div>
    <div class="receipt-total">Total: ₹${bill.total.toFixed(2)}</div>
    <div class="receipt-footer">Served by: ${bill.generatedBy} &nbsp;|&nbsp; Thank you for your visit!<br><span style="font-size:10px">Please preserve this receipt for reference</span></div>`;
  const log=document.getElementById('btDebugLog'); if(log){log.innerHTML='';log.style.display='none';}
  document.getElementById('receiptModal').classList.add('open');
  updateBtPrintHint();
}

function closeReceipt(){ document.getElementById('receiptModal').classList.remove('open'); clearBillForm(); }
function clearBillForm(){ cart=[]; renderCart(); document.getElementById('patientName').value=''; document.getElementById('patientPhone').value=''; document.getElementById('patientAddress').value=''; document.getElementById('doctorRef').value=''; }
function startNewBill(){ closeReceipt(); }

/* ═══════════════════════════════════════════════════
   HISTORY
═══════════════════════════════════════════════════ */
function renderHistory(){
  const bills=getBills(); const container=document.getElementById('billHistoryList');
  const total=bills.reduce((a,b)=>a+b.total,0); const avg=bills.length?total/bills.length:0;
  document.getElementById('hStatBills').textContent=bills.length;
  document.getElementById('hStatRev').textContent='₹'+total.toFixed(0);
  document.getElementById('hStatAvg').textContent='₹'+avg.toFixed(0);
  if(!bills.length){ container.innerHTML=`<div class="empty-state"><div class="icon">📋</div><p>No bills generated yet</p></div>`; return; }

  const q=(document.getElementById('historySearchInput')?.value||'').trim().toLowerCase();
  let filtered=bills;
  if(q){
    filtered=bills.filter(b=>
      (b.patientPhone||'').toLowerCase().includes(q) ||
      (b.patient||'').toLowerCase().includes(q) ||
      (b.billId||'').toLowerCase().includes(q)
    );
  }

  if(!filtered.length){ container.innerHTML=`<div class="empty-state"><div class="icon">🔍</div><p>No bills match "${q}"</p></div>`; return; }

  container.innerHTML=filtered.map(b=>`<div class="bill-record"><div><div style="font-weight:600;font-size:14px">${b.billId}</div><div style="font-size:12px;color:var(--muted)">${b.date} &nbsp;·&nbsp; ${b.patient}${b.patientPhone?' ('+b.patientPhone+')':''} &nbsp;·&nbsp; ${b.items.length} item(s)</div></div><div style="display:flex;align-items:center;gap:8px"><div style="font-weight:600;color:var(--green)">₹${b.total.toFixed(2)}</div><button class="btn-sm btn-blue" onclick='showReceipt(${JSON.stringify(b)})'>View</button><button class="btn-sm btn-success" onclick='downloadBillText(${JSON.stringify(b)})'>⬇️ Download</button></div></div>`).join('');
}

/* ── Download a single bill as a plain-text receipt file ── */
function downloadBillText(bill){
  const discount=bill.discount!=null?bill.discount:(bill.sub*0.03);
  let lines=[];
  lines.push('Rajeshwari Medical & General Store');
  lines.push(bill.shopAddress||SHOP_ADDRESS);
  if(bill.dlNumber) lines.push('D.L. No: '+bill.dlNumber);
  lines.push('');
  lines.push('Bill No : '+bill.billId);
  lines.push('Date    : '+bill.date);
  lines.push('Patient : '+bill.patient);
  lines.push('Phone   : '+(bill.patientPhone||'—'));
  lines.push('Address : '+(bill.patientAddress||'—'));
  lines.push('Dr. Ref : '+bill.doctor);
  lines.push('-'.repeat(40));
  lines.push('Medicine'.padEnd(20)+'Qty'.padStart(6)+'Rate'.padStart(8)+'Amount'.padStart(10));
  bill.items.forEach(item=>{
    lines.push(item.name.substring(0,20).padEnd(20)+String(item.qty).padStart(6)+('₹'+parseFloat(item.price).toFixed(2)).padStart(8)+('₹'+(item.price*item.qty).toFixed(2)).padStart(10));
    if(item.batch) lines.push('  Batch: '+item.batch);
  });
  lines.push('-'.repeat(40));
  lines.push('Subtotal'.padEnd(30)+('₹'+bill.sub.toFixed(2)).padStart(10));
  lines.push('Discount (3%)'.padEnd(30)+('-₹'+discount.toFixed(2)).padStart(10));
  lines.push('TOTAL'.padEnd(30)+('₹'+bill.total.toFixed(2)).padStart(10));
  lines.push('-'.repeat(40));
  lines.push('Served by: '+(bill.generatedBy||''));
  lines.push('Thank you for your visit!');
  const blob=new Blob([lines.join('\n')],{type:'text/plain'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=bill.billId+'.txt'; document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ── Download the full bill history (respecting the current search) as CSV ── */
function downloadAllBillsCSV(){
  const role=rolesCache[currentUser]||'staff';
  if(role!=='admin'){ showToast('Only admins can download all billing data','warn'); return; }
  const bills=getBills();
  if(!bills.length){ showToast('No bills to download','warn'); return; }
  const q=(document.getElementById('historySearchInput')?.value||'').trim().toLowerCase();
  const filtered=q?bills.filter(b=>(b.patientPhone||'').toLowerCase().includes(q)||(b.patient||'').toLowerCase().includes(q)||(b.billId||'').toLowerCase().includes(q)):bills;
  if(!filtered.length){ showToast('No bills match the current search','warn'); return; }
  const esc=v=>'"'+String(v==null?'':v).replace(/"/g,'""')+'"';
  const header=['Bill ID','Date','Patient Name','Phone Number','Address','Doctor Ref','Items','Subtotal','Discount','Total','Generated By'];
  const rows=filtered.map(b=>[
    b.billId, b.date, b.patient, b.patientPhone||'', b.patientAddress||'', b.doctor||'',
    b.items.map(i=>i.name+' x'+i.qty).join('; '),
    b.sub.toFixed(2), (b.discount!=null?b.discount:b.sub*0.03).toFixed(2), b.total.toFixed(2), b.generatedBy||''
  ].map(esc).join(','));
  const csv=[header.map(esc).join(','), ...rows].join('\n');
  const blob=new Blob([csv],{type:'text/csv'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download='bill_history_'+new Date().toISOString().slice(0,10)+'.csv'; document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ═══════════════════════════════════════════════════
   KEYBOARD
═══════════════════════════════════════════════════ */
// ── Auto-fill remembered credentials on page load ──
(function loadRemembered(){
  const ru = localStorage.getItem('ms_remember_user');
  const rp = localStorage.getItem('ms_remember_pass');
  if(ru && rp){
    document.getElementById('loginUser').value = ru;
    document.getElementById('loginPass').value = rp;
    document.getElementById('rememberMe').checked = true;
    document.getElementById('savedUserHint').style.display = 'inline';
  }
  updateLoginReadyUI();
})();

document.addEventListener('keydown',e=>{
  if(e.key==='Enter'){ const ls=document.getElementById('loginScreen'); if(ls&&ls.style.display!=='none')doLogin(); }
});

document.addEventListener('click',e=>{
  const list=document.getElementById('billAutoList');
  if(list&&!list.contains(e.target)&&e.target.id!=='billSearch') list.style.display='none';
});

/* ═══════════════════════════════════════════════════
   EXPOSE FUNCTIONS CALLED FROM INLINE HTML HANDLERS
   (needed because this is now a type="module" script —
   top-level functions no longer attach to window automatically)
═══════════════════════════════════════════════════ */
Object.assign(window, {
  doLogin, doLogout, switchTab, connectBTPrinter,
  addMedicine, deleteMedicine, openEditModal, closeEditModal, saveEditMedicine,
  renderInventory, renderShortage, renderAdminPanel, renderStaffActivity,
  adminCreateUser, changePassword, changeRole, deleteUser,
  onBillSearch, onBillSearchKey, selectBillMed, addToBill,
  changeQty, removeCartItem, clearCart, generateBill,
  showReceipt, closeReceipt, startNewBill,
  doBrowserPrint, doBTPrint, renderHistory, downloadBillText, downloadAllBillsCSV, deleteAllBills,
  saveDlNumber
});
