// public/app.js

// Wrapper api (troca window.electronAPI por api)
const api = {
  getStatus:       () => fetch('/api/status').then(r => r.json()),
  activate:        (nome) => fetch(`/api/perfis/${encodeURIComponent(nome)}/activate`, { method: 'POST' }).then(r => r.json()),
  deactivate:      (nome) => fetch(`/api/perfis/${encodeURIComponent(nome)}/deactivate`, { method: 'POST' }).then(r => r.json()),
  configure:       (nome) => fetch(`/api/perfis/${encodeURIComponent(nome)}/configure`, { method: 'POST' }).then(r => r.json()),
  startWork:       (nome) => fetch(`/api/perfis/${encodeURIComponent(nome)}/start-work`, { method: 'POST' }).then(r => r.json()),
  invokeHuman:     (nome) => fetch(`/api/perfis/${encodeURIComponent(nome)}/invoke-human`, { method: 'POST' }).then(r => r.json()),
  robePlay:        (nome) => fetch(`/api/perfis/${encodeURIComponent(nome)}/robe-play`, { method: 'POST' }).then(r => r.json()),
  robePause24h:    (nome) => fetch(`/api/perfis/${encodeURIComponent(nome)}/robe-24h`,   { method: 'POST' }).then(r => r.json()),
  criarPerfil:     (dados) => fetch('/api/perfis', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dados) }).then(r => r.json()),
  listarCidades:   () => fetch('/api/cidades').then(r=>r.json()).then(d => (d && Array.isArray(d.cidades) ? d.cidades : [])),
  listarCidadesPerfisCount: () => fetch('/api/cidades/contagem').then(r => r.json()),
  deletePerfil:    (nome) => fetch(`/api/perfis/${encodeURIComponent(nome)}`, { method:'DELETE' }).then(r => r.json()),
  renamePerfil:    ({nome,novoLabel,renameSlug}) => renameSlug
                       ? fetch(`/api/perfis/${encodeURIComponent(nome)}/rename`, { method:'POST', headers: { 'Content-Type':'application/json' }, body:JSON.stringify({novoLabel}) }).then(r => r.json())
                       : fetch(`/api/perfis/${encodeURIComponent(nome)}/label`, { method:'PATCH', headers: { 'Content-Type':'application/json' }, body:JSON.stringify({novoLabel}) }).then(r => r.json()),
  getSysMetrics:   () => fetch('/api/sys').then(r => r.json()),
  getFotosCount:   () => fetch('/api/fotos/count').then(r => r.json()),
  getIssues:       (nome) => fetch(`/api/perfis/${encodeURIComponent(nome)}/issues`).then(r => r.json()),
  clearIssues:     (nome) => fetch(`/api/perfis/${encodeURIComponent(nome)}/issues`, { method:'DELETE' }).then(r => r.json()),
  robesPause24hAll: async () => {
    const res = await fetch('/api/robes/pause-24h-all', { method:'POST' });
    const data = await res.json();
    if (!data || data.ok === false) {
      alert(data && data.error ? data.error : "Falha ao pausar Robe 24h (todos).");
    }
    return data;
  },
  robesReleaseAll: async () => {
    const res = await fetch('/api/robes/release-all', { method:'POST' });
    const data = await res.json();
    if (!data || data.ok === false) {
      alert(data && data.error ? data.error : "Falha ao liberar Robe (todos).");
    }
    return data;
  },
  robePause24h: async (nome) => {
    const res = await fetch(`/api/perfis/${encodeURIComponent(nome)}/robe-24h`, { method: 'POST' });
    const data = await res.json();
    if (!data || data.ok === false) {
      alert(data && data.error ? data.error : "Falha ao pausar Robe 24h" + (nome ? " (" + nome + ")" : "") + ".");
    }
    return data;
  },
  resumeHuman:     (nome) => fetch(`/api/perfis/${encodeURIComponent(nome)}/human-resume`, { method: 'POST' }).then(r => r.json()),

  // === INÍCIO PATCH ===
  invokeHumanAllActive: () => fetch('/api/perfis/invoke-human-all-active', { method: 'POST' }).then(r => r.json()),
  // === FIM PATCH ===

  // Adicione abaixo endpoints de auditoria/search para localizacoes_ruins quando implementar
};

// Expor como window.electronAPI para compatibilidade com o index.html atual
if (typeof window !== 'undefined') {
  window.electronAPI = api;
}

// ================= INÍCIO PATCH - EXIBIÇÃO RAM E SOMA DOS CHROMES ==================

// ** INSERIR ESTE PADRÃO no seu script, se não já tiver: **
// Em reloadPerfis(), após ler status, guarde global:
async function reloadPerfis() {
  const [st, perfisResp] = await Promise.all([
    window.electronAPI.getStatus().catch(() => null),
    window.electronAPI.listPerfis().catch(() => null)
  ]);
  window.__lastStatus = st; // Armazena o status para cálculo suma Chrome
  // ... restante da função do seu projeto (listagem, etc)
}

// Em updateSysMetrics, após pegar m.mem:
async function updateSysMetrics() {
  try {
    const m = await window.electronAPI.getSysMetrics().catch(()=>null);
    if (m && m.mem) {
      // Update badge RAM normalmente
      const r = document.getElementById('mRam');
      if (r) r.textContent = (typeof m.mem.freeGB === 'number')
        ? `${Number(m.mem.freeGB).toFixed(2)} GB`
        : '--';

      // Exibir soma dos Chromes no tooltip do badge RAM
      let somaChromes = 0;
      if (window.__lastStatus && Array.isArray(window.__lastStatus.perfis)) {
        somaChromes = window.__lastStatus.perfis.reduce(
          (a, p) => a + (typeof p.ramMB === "number" ? p.ramMB : 0), 0
        );
      }
      if (r && r.parentElement) {
        r.parentElement.title =
          `RAM disponível no sistema (SO): ${ (m.mem.freeMB != null ? m.mem.freeMB : '--') } MB\n` +
          `Soma RAM usada pelos bots (Chromes): ${somaChromes} MB\n` +
          `Ao abrir/fechar bots, este número oscila.`;
      }
      // ... continue updateSysMetrics normalmente (CPU, addPerfilBtn, etc)
    }

    // Fotos (contagem, manter como no seu original)
    const f = await window.electronAPI.getFotosCount().catch(()=>null);
    if (f && f.ok) {
      const el = document.getElementById('mFotos');
      if (el) el.textContent = String(f.count || 0);
    }
  } catch (e) {
    // silencioso
  }
}

// ================= FIM PATCH - EXIBIÇÃO RAM E SOMA DOS CHROMES ==================

// OBS: Se sua função reloadPerfis e updateSysMetrics estão mais complexas,
// faça os patches exatamente nestes pontos no seu JS principal —
// garanta window.__lastStatus atualizado sempre, e tooltip do ramo RAM.