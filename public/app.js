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
  // Adicione abaixo endpoints de auditoria/search para localizacoes_ruins quando implementar
};

// Expor como window.electronAPI para compatibilidade com o index.html atual
if (typeof window !== 'undefined') {
  window.electronAPI = api;

  // ===== PADRONIZAÇÃO DE IDs ===== 
  // Mapeamento dos botões da nova UI minimalista conforme index.html

  // Novo
  const fabNewAccount = document.getElementById('fabNewAccount');
  if (fabNewAccount) {
    fabNewAccount.title = 'Nova conta';
    fabNewAccount.setAttribute('aria-label', 'Nova conta');
    fabNewAccount.onclick = () => api.criarPerfil({});
  }

  const citiesCountBtn = document.getElementById('citiesCountBtn');
  if (citiesCountBtn) {
    citiesCountBtn.title = 'Ver cidades cadastradas';
    citiesCountBtn.setAttribute('aria-label', 'Ver cidades cadastradas');
    citiesCountBtn.onclick = () => api.listarCidadesPerfisCount();
  }

  const startAllBtn = document.getElementById('startAllBtn');
  if (startAllBtn) {
    startAllBtn.title = 'Ativar todos';
    startAllBtn.setAttribute('aria-label', 'Ativar todos');
    // Função a definir conforme backend para ativar todos
  }

  const stopAllBtn = document.getElementById('stopAllBtn');
  if (stopAllBtn) {
    stopAllBtn.title = 'Desativar todos';
    stopAllBtn.setAttribute('aria-label', 'Desativar todos');
    // Função a definir conforme backend para desativar todos
  }

  const robe24AllBtn = document.getElementById('robe24AllBtn');
  if (robe24AllBtn) {
    robe24AllBtn.title = 'Pausar Robe 24h de todos';
    robe24AllBtn.setAttribute('aria-label', 'Pausar Robe 24h de todos');
    robe24AllBtn.onclick = () => api.robesPause24hAll();
  }

  const robeReleaseAllBtn = document.getElementById('robeReleaseAllBtn');
  if (robeReleaseAllBtn) {
    robeReleaseAllBtn.title = 'Liberar Robe de todos';
    robeReleaseAllBtn.setAttribute('aria-label', 'Liberar Robe de todos');
    robeReleaseAllBtn.onclick = () => api.robesReleaseAll();
  }

  const unfreezeAllBtn = document.getElementById('unfreezeAllBtn');
  if (unfreezeAllBtn) {
    unfreezeAllBtn.title = 'Descongelar todos';
    unfreezeAllBtn.setAttribute('aria-label', 'Descongelar todos');
    // Função a definir conforme backend para descongelar todos
  }

  // Filtros
  const filterAll = document.getElementById('filterAll');
  if (filterAll) {
    filterAll.title = 'Todos';
    filterAll.setAttribute('aria-label', 'Todos');
    // Função a ser implementada para aplicar o filtro 'Todos'
  }
  const filterActive = document.getElementById('filterActive');
  if (filterActive) {
    filterActive.title = 'Ativos';
    filterActive.setAttribute('aria-label', 'Ativos');
    // Função a ser implementada para aplicar o filtro 'Ativos'
  }
  const filterInactive = document.getElementById('filterInactive');
  if (filterInactive) {
    filterInactive.title = 'Inativos';
    filterInactive.setAttribute('aria-label', 'Inativos');
    // Função a ser implementada para aplicar o filtro 'Inativos'
  }
  const filterIssues = document.getElementById('filterIssues');
  if (filterIssues) {
    filterIssues.title = 'Com problemas';
    filterIssues.setAttribute('aria-label', 'Com problemas');
    // Função a ser implementada para aplicar o filtro 'Com problemas'
  }

  // Remove ou padroniza eventuais antigos binds duplicados para IDs deprecated/ambíguos
  // Garantia: zero id 'btn' duplicado/ambíguo aqui
  // Garantia: todos binds por ID são consistentes com o index.html minimalista
}