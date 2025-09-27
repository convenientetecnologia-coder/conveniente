// scripts/auth.js
/*
 * Middleware de autenticação para APIs REST (Bearer Token).
 * - TOKEN é definido via env ADMIN_TOKEN.
 * - Inclui helper para uso programático e como Express middleware.
 */

'use strict';

const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || '').trim();

function mustGetTokenOrExit() {
  if (!ADMIN_TOKEN) {
    console.error('[FATAL] ADMIN_TOKEN não definido. Defina via variável de ambiente ou .env e reinicie.');
    process.exit(1);
  }
}

/**
 * Express middleware para proteger rotas *. Use como: app.use(auth.required);
 * Permite exceção para rotas/paths por array ou função.
 * Exemplo: app.use(auth.required({ except: ["/api/health", "/health"] }))
 */
function required(opts = {}) {
  // Opcional: lista de exceções
  const except = opts.except || [];

  return (req, res, next) => {
    // Exceções
    if (
      (typeof except === "function" && except(req)) ||
      (Array.isArray(except) && except.some((r) => req.path.startsWith(r)))
    ) return next();

    const auth = req.headers.authorization || '';
    const token = auth.split(' ')[1];
    if (auth.startsWith('Bearer ') && token === ADMIN_TOKEN) {
      return next();
    }
    return res.status(401).json({ error: 'Unauthorized: token inválido ou ausente' });
  };
}

/** Middleware pronto padrão, para .use() com exceções mais comuns */
const standard = required({
  except: [
    '/api/health', '/health',
    '/public/', '/static/', '/favicon.ico'
  ]
});

/** Checagem direta programática (ex: para rotas individuais/função) */
function checkToken(authHeader) {
  if (!authHeader || typeof authHeader !== 'string') return false;
  const token = authHeader.split(' ')[1];
  return authHeader.startsWith('Bearer ') && token === ADMIN_TOKEN;
}

/** Helper que retorna o token atualmente configurado (NUNCA expor via API!) */
function adminToken() {
  return ADMIN_TOKEN;
}

module.exports = {
  mustGetTokenOrExit,
  required,
  standard,
  checkToken,
  adminToken
};