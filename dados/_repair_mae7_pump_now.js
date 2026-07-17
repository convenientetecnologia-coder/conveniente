const https = require("https");
const Database = require("C:/sitechatbot/node_modules/better-sqlite3");

const HOST = "29546e77-083e-4c81-b90f-4402499d0fef";

function loadHost() {
  const ct = new Database("C:/sitechatbot/dados/convenientetecnologia.sqlite", {
    readonly: true,
    fileMustExist: true,
  });
  const row = ct
    .prepare("SELECT infra_secret, host_fqdn FROM ct_edge_hosts WHERE server_id=?")
    .get(HOST);
  ct.close();
  return {
    secret: String(row.infra_secret || "").trim(),
    fqdn: String(row.host_fqdn || "")
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, ""),
  };
}

function post(fqdn, secret, body, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const raw = Buffer.from(JSON.stringify(body), "utf8");
    const t0 = Date.now();
    const req = https.request(
      {
        hostname: fqdn,
        port: 443,
        path: "/api/infra/command-bus",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": raw.length,
          "x-infra-secret": secret,
        },
        timeout: timeoutMs,
        rejectUnauthorized: false,
      },
      (res) => {
        const c = [];
        res.on("data", (d) => c.push(d));
        res.on("end", () => {
          const t = Buffer.concat(c).toString("utf8");
          let j = null;
          try {
            j = JSON.parse(t);
          } catch {}
          resolve({ status: res.statusCode, ms: Date.now() - t0, j, t: t.slice(0, 8000) });
        });
      }
    );
    req.on("error", (e) => resolve({ status: 0, ms: Date.now() - t0, j: null, t: "", error: e.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, ms: Date.now() - t0, j: null, t: "", error: "timeout" });
    });
    req.write(raw);
    req.end();
  });
}

function get(fqdn, secret, path) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: fqdn,
        port: 443,
        path,
        method: "GET",
        headers: { "x-infra-secret": secret },
        timeout: 20000,
        rejectUnauthorized: false,
      },
      (res) => {
        const c = [];
        res.on("data", (d) => c.push(d));
        res.on("end", () => {
          const t = Buffer.concat(c).toString("utf8");
          let j = null;
          try {
            j = JSON.parse(t);
          } catch {}
          resolve({ status: res.statusCode, j });
        });
      }
    );
    req.on("error", (e) => resolve({ status: 0, j: null, error: e.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, j: null, error: "timeout" });
    });
    req.end();
  });
}

async function main() {
  const { secret, fqdn } = loadHost();
  const now = Date.now();

  console.log("=== 1) REPAIR truncate (arquiva outbox gordo e zera) ===");
  const repair = await post(fqdn, secret, {
    commands: [
      {
        id: `repair_${now}`,
        type: "delta_reply_outbox_repair",
        truncate: true,
        data: { truncate: true, reason: "operator_mae7_wipe_stale_outbox" },
      },
    ],
  });
  console.log(JSON.stringify({ status: repair.status, ms: repair.ms, error: repair.error || null, body: repair.j }, null, 2));

  console.log("\n=== 2) PROBE delta_reply ponta_grossa #54455 thread ===");
  const probeId = `post_repair_probe_${now}`;
  const probe = await post(fqdn, secret, {
    commands: [
      {
        id: probeId,
        type: "delta_reply",
        nome: "ponta_grossa-1778708734047",
        thread_key: "2233419924155897",
        texto_resposta:
          "Boa noite, sim, conseguimos fazer frete grande, mas me conta melhor o que precisa transportar? Qual o seu WhatsApp com DDD?",
        client_message_id: probeId,
      },
    ],
  });
  console.log(JSON.stringify({ status: probe.status, ms: probe.ms, body: probe.j }, null, 2));

  console.log("\n=== 3) wait 25s then forensic ===");
  await new Promise((r) => setTimeout(r, 25000));
  const f = await get(
    fqdn,
    secret,
    "/api/infra/forensic-logs?account=ponta_grossa-1778708734047"
  );
  const recs =
    (f.j && f.j.files && f.j.files.forensic_edge && f.j.files.forensic_edge.records) || [];
  const hits = recs
    .filter((r) => {
      const s = JSON.stringify(r);
      return (
        s.includes(probeId) ||
        s.includes("54455") ||
        s.includes("ipc_dispatch") ||
        s.includes("pump_") ||
        s.includes("profile_runtime") ||
        s.includes("2233419924155897")
      );
    })
    .slice(-40)
    .map((r) => ({
      flow: r.flow_stage,
      stage: r.details && r.details.stage,
      reason: r.details && r.details.reason,
      error: r.details && r.details.error,
      cmd: r.details && r.details.cmd_id,
      status: r.details && r.details.status,
      tk: r.thread_key,
    }));
  console.log(JSON.stringify({ forensic_status: f.status, hits }, null, 2));

  const att = new Database("C:/sitechatbot/dados/attendance.sqlite", {
    readonly: true,
    fileMustExist: true,
  });
  const ob = att
    .prepare(
      "SELECT id,status,attempts,last_error,facebook_sent_at,updated_at FROM messenger_delta_outbox WHERE ticket_id=54455"
    )
    .get();
  att.close();
  console.log("\n=== CT #54455 ===");
  console.log(JSON.stringify(ob, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
