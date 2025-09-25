// public/app.js

function getOperator() {
  let op = localStorage.getItem('operatorName');
  if (!op) {
    op = prompt('Identificação do operador (para auditoria):') || 'unknown';
    localStorage.setItem('operatorName', op);
  }
  return op;
}

// Wrapper api (troca window.electronAPI por api)
const api = {
  getStatus:           ()      => fetch('/api/status', {
    headers: { 'X-Operator': getOperator() }
  }).then(r=>r.json()),

  activate:            (nome)  => fetch(`/api/perfis/${encodeURIComponent(nome)}/activate`,  { 
    method: 'POST',
    headers: { 'X-Operator': getOperator() }
  }).then(r=>r.json()),

  deactivate:          (nome)  => fetch(`/api/perfis/${encodeURIComponent(nome)}/deactivate`,{ 
    method: 'POST',
    headers: { 'X-Operator': getOperator() }
  }).then(r=>r.json()),

  configure:           (nome)  => fetch(`/api/perfis/${encodeURIComponent(nome)}/configure`, { 
    method: 'POST',
    headers: { 'X-Operator': getOperator() }
  }).then(r=>r.json()),

  startWork:           (nome)  => fetch(`/api/perfis/${encodeURIComponent(nome)}/start-work`,{ 
    method: 'POST',
    headers: { 'X-Operator': getOperator() }
  }).then(r=>r.json()),

  invokeHuman:         (nome)  => fetch(`/api/perfis/${encodeURIComponent(nome)}/invoke-human`,{ 
    method: 'POST',
    headers: { 'X-Operator': getOperator() }
  }).then(r=>r.json()),

  robePlay:            (nome)  => fetch(`/api/perfis/${encodeURIComponent(nome)}/robe-play`, { 
    method: 'POST',
    headers: { 'X-Operator': getOperator() }
  }).then(r=>r.json()),

  robePause24h:        (nome)  => fetch(`/api/perfis/${encodeURIComponent(nome)}/robe-24h`,   { 
    method: 'POST',
    headers: { 'X-Operator': getOperator() }
  }).then(r=>r.json()),

  criarPerfil:         (dados) => fetch('/api/perfis',       { 
    method: 'POST', 
    headers: { 'Content-Type': 'application/json', 'X-Operator': getOperator() }, 
    body: JSON.stringify(dados) 
  }).then(r=>r.json()),

  // Ajustado: retorna diretamente array de cidades
  listarCidades:       ()      => fetch('/api/cidades', {
    headers: { 'X-Operator': getOperator() }
  }).then(r=>r.json()).then(d => (d && Array.isArray(d.cidades) ? d.cidades : [])),

  listarCidadesPerfisCount:() => fetch('/api/cidades/contagem', {
    headers: { 'X-Operator': getOperator() }
  }).then(r=>r.json()),

  deletePerfil:        (nome)  => fetch(`/api/perfis/${encodeURIComponent(nome)}`,{ 
    method:'DELETE',
    headers: { 'X-Operator': getOperator() }
  }).then(r=>r.json()),

  renamePerfil:        ({nome,novoLabel,renameSlug}) => renameSlug
                         ? fetch(`/api/perfis/${encodeURIComponent(nome)}/rename`, {
                              method:'POST',
                              headers:{'Content-Type':'application/json', 'X-Operator': getOperator()},
                              body:JSON.stringify({novoLabel})
                            }).then(r=>r.json())
                         : fetch(`/api/perfis/${encodeURIComponent(nome)}/label`,  {
                              method:'PATCH',
                              headers:{'Content-Type':'application/json', 'X-Operator': getOperator()},
                              body:JSON.stringify({novoLabel})
                            }).then(r=>r.json()),

  getSysMetrics:       ()      => fetch('/api/sys', {
    headers: { 'X-Operator': getOperator() }
  }).then(r=>r.json()),

  getFotosCount:       ()      => fetch('/api/fotos/count', {
    headers: { 'X-Operator': getOperator() }
  }).then(r=>r.json()),

  getIssues:           (nome)  => fetch(`/api/perfis/${encodeURIComponent(nome)}/issues`, {
    headers: { 'X-Operator': getOperator() }
  }).then(r=>r.json()),

  clearIssues:         (nome)  => fetch(`/api/perfis/${encodeURIComponent(nome)}/issues`,{
    method:'DELETE',
    headers: { 'X-Operator': getOperator() }
  }).then(r=>r.json()),

  robesPause24hAll:    ()      => fetch('/api/robes/pause-24h-all', {
    method:'POST',
    headers: { 'X-Operator': getOperator() }
  }).then(r=>r.json()),

  robesReleaseAll:     ()      => fetch('/api/robes/release-all', {
    method:'POST',
    headers: { 'X-Operator': getOperator() }
  }).then(r=>r.json()),

  resumeHuman:         (nome)  => fetch(`/api/perfis/${encodeURIComponent(nome)}/human-resume`, { 
    method: 'POST',
    headers: { 'X-Operator': getOperator() }
  }).then(r=>r.json()),
};

// Expor como window.electronAPI para compatibilidade com o index.html atual
if (typeof window !== 'undefined') {
  window.electronAPI = api;
}