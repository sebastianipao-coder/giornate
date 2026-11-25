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
  const origSet = Storage.prototype.setItem;
  let meta = {}; try { meta = JSON.parse(ls.getItem(META)) || {}; } catch (e) {}
  const saveMeta = () => origSet.call(ls, META, JSON.stringify(meta));

  let sb = null, user = null, applying = false, running = false, again = false, pushT = null;
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
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = CFG.lib; s.onload = res; s.onerror = () => rej(new Error('rete')); document.head.appendChild(s); });
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
      if (changed) { if (typeof window.onSyncRemote === 'function') window.onSyncRemote(); else location.reload(); }
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
  async function signIn(email, password) {
    try { await client(); const { data, error } = await sb.auth.signInWithPassword({ email, password }); if (error) throw error;
      user = data.user; Sync.email = user.email; await syncNow(); return { ok: true }; }
    catch (e) { return { ok: false, error: itErr(e) }; }
  }
  async function signUp(email, password) {
    try { await client(); const { data, error } = await sb.auth.signUp({ email, password }); if (error) throw error;
      if (!data.session) return { ok: false, error: 'Ti abbiamo mandato un\'email: apri il link per confermare, poi accedi.' };
      user = data.user; Sync.email = user.email; await syncNow(); return { ok: true }; }
    catch (e) { return { ok: false, error: itErr(e) }; }
  }
  async function signOut() { try { await client(); await sb.auth.signOut(); } catch (e) {} user = null; Sync.email = null; set('off'); }

  async function start() {
    if (!ls.getItem(SESSION_KEY)) { set('off'); return; }
    try {
      await client();
      const { data } = await sb.auth.getSession();
      user = data.session ? data.session.user : null; Sync.email = user ? user.email : null;
      if (user) await syncNow(); else set('off');
    } catch (e) { set(navigator.onLine ? 'error' : 'offline', e && e.message); }
  }
  window.addEventListener('online', () => syncNow());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNow(); });
  setInterval(() => { if (!document.hidden) syncNow(); }, 30000);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
