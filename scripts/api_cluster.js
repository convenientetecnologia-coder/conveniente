// scripts/api_cluster.js

module.exports = (app, clusterClient, fileStore) => {
  app.get('/api/cluster', (req, res) => {
    try {
      const plan = clusterClient && clusterClient.plan ? clusterClient.plan : null;
      const children = clusterClient && Array.isArray(clusterClient.children) ? clusterClient.children : [];
      const nodes = children.length;
      const shards = children.map((c, i) => ({
        node: i+1,
        size: Array.from(c.shard || []).length,
        names: Array.from(c.shard || [])
      }));
      res.json({
        ok: true,
        nodes,
        perNodeMax: plan && plan.perNode && plan.perNode.maxChromes || null,
        shards
      });
    } catch (e) {
      res.json({ ok: false, error: e && e.message || String(e) });
    }
  });
};