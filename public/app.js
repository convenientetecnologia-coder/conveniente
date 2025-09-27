// public/app.js

// Função auxiliar para obter os headers de autenticação
function getAuthHeaders() {
   const token = typeof window !== 'undefined'
     ? (window._adminToken || window.sessionStorage?.getItem('_adminToken') || window.localStorage?.getItem('_adminToken'))
     : null;
   return token ? { 'Authorization': `Bearer ${token}` } : {};
}

// Wrapper api (troca window.electronAPI por api)
const api = {
  getStatus:       () => fetch('/api/status', { headers: { ...getAuthHeaders() } }).then(r => {
                        if (r.status === 401) { /* Dispare aviso/login */ }
                        return r.json();
                      }),
  activate:        (nome) => fetch(`/api/perfis/${encodeURIComponent(nome)}/activate`, { method: 'POST', headers: { ...getAuthHeaders() } }).then(r => {
                        if (r.status === 401) { /* Dispare aviso/login */ }
                        return r.json();
                      }),
  deactivate:      (nome) => fetch(`/api/perfis/${encodeURIComponent(nome)}/deactivate`, { method: 'POST', headers: { ...getAuthHeaders() } }).then(r => {
                        if (r.status === 401) { /* Dispare aviso/login */ }
                        return r.json();
                      }),
  configure:       (nome) => fetch(`/api/perfis/${encodeURIComponent(nome)}/configure`, { method: 'POST', headers: { ...getAuthHeaders() } }).then(r => {
                        if (r.status === 401) { /* Dispare aviso/login */ }
                        return r.json();
                      }),
  startWork:       (nome) => fetch(`/api/perfis/${encodeURIComponent(nome)}/start-work`, { method: 'POST', headers: { ...getAuthHeaders() } }).then(r => {
                        if (r.status === 401) { /* Dispare aviso/login */ }
                        return r.json();
                      }),
  invokeHuman:     (nome) => fetch(`/api/perfis/${encodeURIComponent(nome)}/invoke-human`, { method: 'POST', headers: { ...getAuthHeaders() } }).then(r => {
                        if (r.status === 401) { /* Dispare aviso/login */ }
                        return r.json();
                      }),
  robePlay:        (nome) => fetch(`/api/perfis/${encodeURIComponent(nome)}/robe-play`, { method: 'POST', headers: { ...getAuthHeaders() } }).then(r => {
                        if (r.status === 401) { /* Dispare aviso/login */ }
                        return r.json();
                      }),
  robePause24h:    (nome) => fetch(`/api/perfis/${encodeURIComponent(nome)}/robe-24h`,   { method: 'POST', headers: { ...getAuthHeaders() } }).then(r => {
                        if (r.status === 401) { /* Dispare aviso/login */ }
                        return r.json();
                      }),
  criarPerfil:     (dados) => fetch('/api/perfis', { method: 'POST', headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(dados) }).then(r => {
                        if (r.status === 401) { /* Dispare aviso/login */ }
                        return r.json();
                      }),
  listarCidades:   () => fetch('/api/cidades').then(r=>r.json()).then(d => (d && Array.isArray(d.cidades) ? d.cidades : [])),
  listarCidadesPerfisCount: () => fetch('/api/cidades/contagem', { headers: { ...getAuthHeaders() } }).then(r => {
                        if (r.status === 401) { /* Dispare aviso/login */ }
                        return r.json();
                      }),
  deletePerfil:    (nome) => fetch(`/api/perfis/${encodeURIComponent(nome)}`, { method:'DELETE', headers: { ...getAuthHeaders() } }).then(r => {
                        if (r.status === 401) { /* Dispare aviso/login */ }
                        return r.json();
                      }),
  renamePerfil:    ({nome,novoLabel,renameSlug}) => renameSlug
                       ? fetch(`/api/perfis/${encodeURIComponent(nome)}/rename`, { method:'POST', headers: { ...getAuthHeaders(), 'Content-Type':'application/json' }, body:JSON.stringify({novoLabel}) }).then(r => {
                            if (r.status === 401) { /* Dispare aviso/login */ }
                            return r.json();
                         })
                       : fetch(`/api/perfis/${encodeURIComponent(nome)}/label`, { method:'PATCH', headers: { ...getAuthHeaders(), 'Content-Type':'application/json' }, body:JSON.stringify({novoLabel}) }).then(r => {
                            if (r.status === 401) { /* Dispare aviso/login */ }
                            return r.json();
                         }),
  getSysMetrics:   () => fetch('/api/sys', { headers: { ...getAuthHeaders() } }).then(r => {
                        if (r.status === 401) { /* Dispare aviso/login */ }
                        return r.json();
                      }),
  getFotosCount:   () => fetch('/api/fotos/count', { headers: { ...getAuthHeaders() } }).then(r => {
                        if (r.status === 401) { /* Dispare aviso/login */ }
                        return r.json();
                      }),
  getIssues:       (nome) => fetch(`/api/perfis/${encodeURIComponent(nome)}/issues`, { headers: { ...getAuthHeaders() } }).then(r => {
                        if (r.status === 401) { /* Dispare aviso/login */ }
                        return r.json();
                      }),
  clearIssues:     (nome) => fetch(`/api/perfis/${encodeURIComponent(nome)}/issues`, { method:'DELETE', headers: { ...getAuthHeaders() } }).then(r => {
                        if (r.status === 401) { /* Dispare aviso/login */ }
                        return r.json();
                      }),
  robesPause24hAll: () => fetch('/api/robes/pause-24h-all', { method:'POST', headers: { ...getAuthHeaders() } }).then(r => {
                        if (r.status === 401) { /* Dispare aviso/login */ }
                        return r.json();
                      }),
  robesReleaseAll: () => fetch('/api/robes/release-all', { method:'POST', headers: { ...getAuthHeaders() } }).then(r => {
                        if (r.status === 401) { /* Dispare aviso/login */ }
                        return r.json();
                      }),
  resumeHuman:     (nome) => fetch(`/api/perfis/${encodeURIComponent(nome)}/human-resume`, { method: 'POST', headers: { ...getAuthHeaders() } }).then(r => {
                        if (r.status === 401) { /* Dispare aviso/login */ }
                        return r.json();
                      }),
};

// Função para setar o token em tempo de execução
api.setToken = function(token) {
  if (typeof window !== 'undefined') {
    window._adminToken = token;
    window.sessionStorage && window.sessionStorage.setItem('_adminToken', token);
  }
}

// Expor como window.electronAPI para compatibilidade com o index.html atual
if (typeof window !== 'undefined') {
  window.electronAPI = api;
}