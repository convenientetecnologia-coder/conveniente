### `conveniente/scripts/provisionLock.js` — timeline por dia/commit — 2026-01-09 → 2026-01-29

Como usar:
- Abrir diff do commit: `git show <hash>`
- Este arquivo define regras de lock global (evitar deadlocks/conflitos em provision/login_remediate).

Cobertura real:
- commits: 6
- min: 2026-01-22 21:56:38 -0300
- max: 2026-01-26 17:07:14 -0300

---

## 2026-01-22 (2)
- 2026-01-22 22:27:26 -0300 | 46186dd | Fix provision lock: allow owner operator + use stock_provision:<batchId>
- 2026-01-22 21:56:38 -0300 | 6ab1622 | Hardening stock_provision: backpressure, provision lock, retries

## 2026-01-25 (1)
- 2026-01-25 15:20:08 -0300 | 0b510c8 | fix: provision_lock + quiesce + appeal monitor + cooldown self-heal

## 2026-01-26 (3)
- 2026-01-26 17:07:14 -0300 | d77b7ea | Unify stock_provision via login_remediate + reentrant provisionLock + graceful-first ban close
- 2026-01-26 13:18:22 -0300 | f1adccf | fix: provisionLock compat (nao invalidar lock sem pid); auto-recover so quando pid existir
- 2026-01-26 12:56:54 -0300 | 8c595ab | fix: maintenance_provision auto-recover (provisionLock pid) + endpoint release

