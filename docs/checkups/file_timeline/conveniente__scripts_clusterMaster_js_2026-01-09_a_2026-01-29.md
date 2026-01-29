### `conveniente/scripts/clusterMaster.js` — timeline por dia/commit — 2026-01-09 → 2026-01-29

Como usar:
- Abrir diff do commit: `git show <hash>`
- Este arquivo é o orquestrador do cluster (shards/rebalance/consistência de status).

Cobertura real:
- commits: 6
- min: 2026-01-22 22:27:26 -0300
- max: 2026-01-28 13:21:47 -0300

---

## 2026-01-22 (1)
- 2026-01-22 22:27:26 -0300 | 46186dd | Fix provision lock: allow owner operator + use stock_provision:<batchId>

## 2026-01-23 (2)
- 2026-01-23 22:56:03 -0300 | a292da2 | status: include _debug controllersCount/pid per node to diagnose zero-active dashboard
- 2026-01-23 15:23:09 -0300 | ffc62a2 | fix: sticky shard rebalance (no mass shard_moved) + cap worker shard moves

## 2026-01-25 (1)
- 2026-01-25 20:17:13 -0300 | 739d936 | fix: harden human overlay + ban sweep + appeal guard + buildTag

## 2026-01-28 (2)
- 2026-01-28 13:21:47 -0300 | a96646e | Fix: prevent login_remediate provision_lock freezing server; add watchdog + ban timeout
- 2026-01-28 12:18:19 -0300 | 2ad6f9e | perf: master-only writes for perfis.json (IPC + lock + audit)

