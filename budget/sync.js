/* Sincronizzazione online di Budget e Giornate (Supabase, stesso progetto di Garage).
   I dati restano sempre anche sul dispositivo: funziona offline e invia le modifiche quando torna la rete.
   Ogni utente vede solo le proprie righe (tabella public.app_dati con RLS, vedi supabase/sync.sql). */
(function () {
  const CFG = {
    url: 'https://jbfuaxwusglfgikjtdqa.supabase.co',
    key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpiZnVheHd1c2dsZmdpa2p0ZHFhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUxNzc5NzYsImV4cCI6MjExMDc1Mzk3Nn0.qIAs1D2IoM6K_f1z_hY6WxZZpyU9-XusZNMC3jpedKE',
    lib: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js',
  };
  const APPS = { 'budget-v1': 'budget', 'giornate-v1': 'giornate' };
  const META = 'sync-meta';
  const SESSION_KEY = 'sb-jbfuaxwusglfgikjtdqa-auth-token';
  const ls = window.localStorage;
  const hasSession = () => !!ls.getItem('sb-jbfuaxwusglfgikjtdqa-auth-token');
  if (!hasSession()) document.documentElement.classList.add('needs-login');
  const css = document.createElement('style');
  css.textContent = `html.needs-login body>*:not(#sync-gate){visibility:hidden}
#sync-gate{position:fixed;inset:0;z-index:2000;display:flex;align-items:center;justify-content:center;padding:24px 20px calc(env(safe-area-inset-bottom) + 24px);
 background:#f2f2f7;color:#000;font-family:-apple-system,BlinkMacSystemFont,system-ui,"SF Pro Text","Helvetica Neue",sans-serif;-webkit-font-smoothing:antialiased;overflow:auto}
#sync-gate .box{width:100%;max-width:380px;text-align:center}
#sync-gate .logo{width:84px;height:84px;border-radius:20px;margin:0 auto 18px;display:grid;place-items:center;font-size:44px;background:linear-gradient(160deg,#34c759,#30b0c7);box-shadow:0 8px 24px rgba(52,199,89,.3);color:#fff;font-weight:700}
#sync-gate h1{font-size:30px;font-weight:700;margin:0 0 6px;letter-spacing:.3px}
#sync-gate p{color:rgba(60,60,67,.6);font-size:15px;line-height:1.4;margin:0 0 22px}
#sync-gate .card{background:#fff;border-radius:12px;overflow:hidden;text-align:left}
#sync-gate input{display:block;width:100%;border:0;background:none;outline:none;height:50px;padding:0 16px;font:inherit;font-size:17px;color:inherit;-webkit-user-select:text;user-select:text}
#sync-gate input+input{border-top:.5px solid rgba(60,60,67,.29)}
#sync-gate .err{color:#ff3b30;font-size:14px;margin:10px 4px 0;min-height:18px;text-align:left}
#sync-gate .go{display:block;width:100%;height:50px;border:0;border-radius:14px;background:#007aff;color:#fff;font:inherit;font-size:17px;font-weight:600;margin-top:8px;cursor:pointer}
#sync-gate .go:disabled{opacity:.5}
#sync-gate .sw{background:none;border:0;color:#007aff;font:inherit;font-size:15px;margin-top:18px;cursor:pointer}
#sync-gate .note{font-size:13px;margin-top:22px;margin-bottom:0}
@media (prefers-color-scheme: dark){#sync-gate{background:#000;color:#fff}#sync-gate .card{background:#1c1c1e}#sync-gate p{color:rgba(235,235,245,.6)}#sync-gate input+input{border-top-color:rgba(84,84,88,.65)}#sync-gate .go{background:#0a84ff}#sync-gate .sw{color:#0a84ff}#sync-gate .err{color:#ff453a}}`;
  document.head.appendChild(css);
  const origSet = Storage.prototype.setItem;
  let meta = {}; try { meta = JSON.parse(ls.getItem(META)) || {}; } catch (e) {}
  const saveMeta = () => origSet.call(ls, META, JSON.stringify(meta));

  let quiet = false, sb = null, user = null, applying = false, running = false, again = false, pushT = null;
  const listeners = [];
  const Sync = {
    status: 'off', error: null, email: null, lastSync: meta.lastSync || null,
    onChange(f) { listeners.push(f); },
    signIn, signUp, signOut, syncNow: () => syncNow(),
    get active() { return !!user; },
  };
  window.Sync = Sync;
  const emit = () => listeners.forEach(f => { try { f(Sync); } catch (e) {} });
  const set = (status, error) => { Sync.status = status; Sync.error = error || null; emit(); };

  // ogni salvataggio delle app segna i dati come "da inviare"
  Storage.prototype.setItem = function (k, v) {
    origSet.call(this, k, v);
    if (this === ls && APPS[k] && !applying) {
      const a = APPS[k]; meta[a] = meta[a] || {}; meta[a].dirty = true; saveMeta();
      if (user) { clearTimeout(pushT); pushT = setTimeout(syncNow, 1500); }
    }
  };

  function loadLib() {
    if (window.supabase) return Promise.resolve();
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = CFG.lib; s.onload = () => window.supabase ? res() : rej(new Error('rete')); s.onerror = () => rej(new Error('rete')); document.head.appendChild(s); });
  }
  async function client() {
    if (sb) return sb;
    await loadLib();
    sb = window.supabase.createClient(CFG.url, CFG.key, { auth: { persistSession: true, autoRefreshToken: true } });
    sb.auth.onAuthStateChange((ev, s) => { user = s ? s.user : null; Sync.email = user ? user.email : null; if (!user) set('off'); });
    return sb;
  }

  const hasData = (a, d) => !!d && (a === 'giornate' ? Object.keys(d.days || {}).length > 0 : !!(d.setup && ((d.tx || []).length || (d.piggies || []).length || (d.wishes || []).length || (d.credits || []).length)));
  function applyRemote(k, a, r) { applying = true; try { origSet.call(ls, k, JSON.stringify(r.data)); } finally { applying = false; } meta[a].remoteAt = r.updated_at; }

  async function syncNow() {
    if (!user) return;
    if (running) { again = true; return; }
    if (!navigator.onLine) { set('offline'); return; }
    running = true; set('syncing');
    try {
      const { data, error } = await sb.from('app_dati').select('app,data,updated_at');
      if (error) throw error;
      const remote = {}; for (const r of data) remote[r.app] = r;
      let changed = false;
      for (const [k, a] of Object.entries(APPS)) {
        const m = meta[a] = meta[a] || {};
        const r = remote[a];
        let local = null; try { local = JSON.parse(ls.getItem(k)); } catch (e) {}
        if (m.user !== user.id) {
          // primo collegamento di questo dispositivo all'account
          if (r && hasData(a, r.data)) {
            if (local && hasData(a, local)) origSet.call(ls, k + '-prima-della-sync', JSON.stringify(local));
            if (a === 'giornate' && local && local.days) r.data.days = Object.assign({}, local.days, r.data.days || {});
            if (a === 'giornate' && local && local.days && Object.keys(local.days).some(d => !(r.data.days || {})[d])) m.dirty = true;
            applyRemote(k, a, r); changed = true; m.dirty = !!m.dirty && a === 'giornate';
          } else if (local) m.dirty = true;
          m.user = user.id;
        } else if (r && r.updated_at !== m.remoteAt && !m.dirty) {
          applyRemote(k, a, r); changed = true;
        }
        if (m.dirty) {
          const cur = ls.getItem(k);
          if (cur) {
            const { data: up, error: e2 } = await sb.from('app_dati')
              .upsert({ user_id: user.id, app: a, data: JSON.parse(cur), updated_at: new Date().toISOString() })
              .select('updated_at').single();
            if (e2) throw e2;
            m.remoteAt = up.updated_at;
          }
          m.dirty = false;
        }
      }
      meta.lastSync = Sync.lastSync = new Date().toISOString(); saveMeta();
      set('ok');
      if (changed && !quiet) { if (typeof window.onSyncRemote === 'function') window.onSyncRemote(); else location.reload(); }
    } catch (e) {
      saveMeta(); set(navigator.onLine ? 'error' : 'offline', e && e.message);
    } finally {
      running = false;
      if (again) { again = false; setTimeout(syncNow, 300); }
    }
  }

  function itErr(e) {
    const m = (e && e.message || '').toLowerCase();
    if (m.includes('invalid login')) return 'Email o password non corrette.';
    if (m.includes('already registered')) return 'Esiste già un account con questa email: usa Accedi.';
    if (m.includes('password should be')) return 'La password deve avere almeno 6 caratteri.';
    if (m.includes('email') && m.includes('invalid')) return 'Email non valida.';
    if (m.includes('rete') || m.includes('fetch')) return 'Nessuna connessione. Riprova quando sei online.';
    if (m.includes('not confirmed')) return 'Conferma prima l\'email dal link che ti è arrivato.';
    return 'Qualcosa non ha funzionato: ' + (e && e.message || 'errore');
  }
  async function signIn(email, password, fromGate) {
    try { await client(); const { data, error } = await sb.auth.signInWithPassword({ email, password }); if (error) throw error;
      user = data.user; Sync.email = user.email; claimDevice(user.id); quiet = !!fromGate; await syncNow(); quiet = false; return { ok: true }; }
    catch (e) { return { ok: false, error: itErr(e) }; }
  }
  async function signUp(email, password, fromGate) {
    try { await client(); const { data, error } = await sb.auth.signUp({ email, password }); if (error) throw error;
      if (!data.session) return { ok: false, error: 'Ti abbiamo mandato un\'email: apri il link per confermare, poi accedi.' };
      user = data.user; Sync.email = user.email; claimDevice(user.id); quiet = !!fromGate; await syncNow(); quiet = false; return { ok: true }; }
    catch (e) { return { ok: false, error: itErr(e) }; }
  }
  // uscita: invio le ultime modifiche, poi tolgo i dati da questo dispositivo (restano sul tuo account)
  async function signOut() {
    if (user) { await syncNow(); }
    const pending = Object.values(APPS).some(a => meta[a] && meta[a].dirty);
    if (pending && !confirm('Alcune modifiche non sono ancora state salvate online (sei offline?). Uscendo andranno perse. Uscire lo stesso?')) return false;
    try { await client(); await sb.auth.signOut({ scope: 'local' }); } catch (e) {}
    ls.removeItem(SESSION_KEY);
    for (const k of Object.keys(APPS)) { ls.removeItem(k); ls.removeItem(k + '-prima-della-sync'); }
    ls.removeItem(META); ls.removeItem('budget-tab');
    location.reload(); return true;
  }

  function showGate() {
    if (document.getElementById('sync-gate')) return;
    let mode = 'in';
    const g = document.createElement('div'); g.id = 'sync-gate';
    g.innerHTML = `<form class="box" autocomplete="on"><div class="logo">€</div><h1>Accedi</h1>
      <p>Entra con il tuo account per usare Giornate e Budget. I tuoi dati restano salvati online e li ritrovi su ogni dispositivo.</p>
      <div class="card"><input type="email" name="email" placeholder="Email" autocomplete="username" autocapitalize="off" required>
      <input type="password" name="password" placeholder="Password" autocomplete="current-password" required></div>
      <div class="err"></div><button class="go" type="submit">Accedi</button>
      <button class="sw" type="button">Non hai un account? <b>Crea account</b></button>
      <p class="note">Ogni persona usa le proprie credenziali e vede solo i propri dati.</p></form>`;
    document.body.appendChild(g);
    const f = g.querySelector('form'), err = g.querySelector('.err'), go = g.querySelector('.go'), sw = g.querySelector('.sw'), h = g.querySelector('h1'), pw = f.password;
    sw.onclick = () => { mode = mode === 'in' ? 'up' : 'in'; err.textContent = '';
      h.textContent = mode === 'in' ? 'Accedi' : 'Crea account'; go.textContent = mode === 'in' ? 'Accedi' : 'Crea account';
      pw.placeholder = mode === 'in' ? 'Password' : 'Password (almeno 6 caratteri)'; pw.autocomplete = mode === 'in' ? 'current-password' : 'new-password';
      sw.innerHTML = mode === 'in' ? 'Non hai un account? <b>Crea account</b>' : 'Hai già un account? <b>Accedi</b>'; };
    f.onsubmit = async e => { e.preventDefault(); err.textContent = ''; go.disabled = true; go.textContent = 'Un momento…';
      const r = await (mode === 'in' ? signIn(f.email.value.trim(), pw.value, true) : signUp(f.email.value.trim(), pw.value, true));
      if (r.ok) { location.reload(); return; }
      go.disabled = false; go.textContent = mode === 'in' ? 'Accedi' : 'Crea account'; err.textContent = r.error; };
  }
  // dati locali di un altro account su questo dispositivo: li tolgo prima di caricare quelli del nuovo
  function claimDevice(uid) {
    if (meta.owner && meta.owner !== uid) { for (const k of Object.keys(APPS)) { ls.removeItem(k); ls.removeItem(k + '-prima-della-sync'); } meta = {}; }
    meta.owner = uid; saveMeta();
  }

  async function start() {
    if (!hasSession()) { set('off'); showGate(); return; }
    try {
      await client();
      const { data } = await sb.auth.getSession();
      user = data.session ? data.session.user : null; Sync.email = user ? user.email : null;
      if (user) { claimDevice(user.id); await syncNow(); } else if (navigator.onLine) { ls.removeItem(SESSION_KEY); document.documentElement.classList.add('needs-login'); showGate(); } else set('offline');
    } catch (e) { set(navigator.onLine ? 'error' : 'offline', e && e.message); }
  }
  window.addEventListener('online', () => syncNow());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNow(); });
  setInterval(() => { if (!document.hidden) syncNow(); }, 30000);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
