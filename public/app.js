// public/app.js

// Wrapper api (troca window.electronAPI por api)
const api = {
  getStatus:       () => fetch('/api/status').then(r=>r.json()),
  activate:        (nome) => fetch(`/api/perfis/${encodeURIComponent(nome)}/activate`, { method: 'POST' }).then(r=>r.json()),
  deactivate:      (nome) => fetch(`/api/perfis/${encodeURIComponent(nome)}/deactivate`, { method: 'POST' }).then(r=>r.json()),
  configure:       (nome) => fetch(`/api/perfis/${encodeURIComponent(nome)}/configure`, { method: 'POST' }).then(r=>r.json()),
  startWork:       (nome) => fetch(`/api/perfis/${encodeURIComponent(nome)}/start-work`, { method: 'POST' }).then(r=>r.json()),
  invokeHuman:     (nome) => fetch(`/api/perfis/${encodeURIComponent(nome)}/invoke-human`, { method: 'POST' }).then(r=>r.json()),
  robePlay:        (nome) => fetch(`/api/perfis/${encodeURIComponent(nome)}/robe-play`, { method: 'POST' }).then(r=>r.json()),
  robePause24h:    (nome) => fetch(`/api/perfis/${encodeURIComponent(nome)}/robe-24h`,   { method: 'POST' }).then(r=>r.json()),
  criarPerfil:     (dados) => fetch('/api/perfis', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dados) }).then(r=>r.json()),
  listarCidades:   () => fetch('/api/cidades').then(r=>r.json()).then(d => (d && Array.isArray(d.cidades) ? d.cidades : [])),
  listarCidadesPerfisCount: () => fetch('/api/cidades/contagem').then(r=>r.json()),
  deletePerfil:    (nome) => fetch(`/api/perfis/${encodeURIComponent(nome)}`, { method:'DELETE' }).then(r=>r.json()),
  renamePerfil:    ({nome,novoLabel,renameSlug}) => renameSlug
                       ? fetch(`/api/perfis/${encodeURIComponent(nome)}/rename`, { method:'POST', headers: {'Content-Type':'application/json'}, body:JSON.stringify({novoLabel}) }).then(r=>r.json())
                       : fetch(`/api/perfis/${encodeURIComponent(nome)}/label`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({novoLabel}) }).then(r=>r.json()),
  getSysMetrics:   () => fetch('/api/sys').then(r=>r.json()),
  getFotosCount:   () => fetch('/api/fotos/count').then(r=>r.json()),
  getIssues:       (nome) => fetch(`/api/perfis/${encodeURIComponent(nome)}/issues`).then(r=>r.json()),
  clearIssues:     (nome) => fetch(`/api/perfis/${encodeURIComponent(nome)}/issues`, { method:'DELETE' }).then(r=>r.json()),
  robesPause24hAll: () => fetch('/api/robes/pause-24h-all', { method:'POST' }).then(r=>r.json()),
  robesReleaseAll: () => fetch('/api/robes/release-all', { method:'POST' }).then(r=>r.json()),
  resumeHuman:     (nome) => fetch(`/api/perfis/${encodeURIComponent(nome)}/human-resume`, { method: 'POST' }).then(r=>r.json()),
};

// (Opcional) Endpoints para ajuste manual do cap se implementou no backend
api.capUp = () => fetch('/api/sys/cap/up', {method:'POST'}).then(r=>r.json());
api.capDown = () => fetch('/api/sys/cap/down', {method:'POST'}).then(r=>r.json());

// Expor como window.electronAPI para compatibilidade com o index.html atual
if (typeof window !== 'undefined') {
  window.electronAPI = api;
}