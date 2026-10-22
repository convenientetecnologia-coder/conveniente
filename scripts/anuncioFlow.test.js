"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  textHasUnavailable,
  judgeListing,
  nomeEhNosso,
  pickMoreOptions,
  pickMenuItem,
  pickClassificado,
  pickConcluir,
  listingProbe,
  moreOptionsProbe
} = require("./anuncioSignals");
const { runAnuncio } = require("./anuncioFlow");

test("indisponível só com as duas frases", () => {
  assert.equal(textHasUnavailable("Este classificado não está mais disponível."), false);
  assert.equal(textHasUnavailable(
    "Este classificado não está mais disponível. O item pode ter sido vendido ou ter expirado. Dê uma olhada nesses outros itens abaixo."
  ), true);
  assert.equal(judgeListing({
    text: "Este classificado não está mais disponível. O item pode ter sido vendido ou ter expirado. Dê uma olhada nesses outros itens abaixo. Seleções de hoje"
  }).kind, "unavailable");
});

test("nome do vendedor só entra se aria e texto visível forem iguais", () => {
  assert.deepEqual(judgeListing({
    hasHeading: true,
    sellerAria: "Andressa Oliveira",
    sellerVisible: "Andressa Oliveira"
  }), { kind: "seller", name: "Andressa Oliveira" });
  assert.equal(judgeListing({
    hasHeading: true,
    sellerAria: "Andressa Oliveira",
    sellerVisible: "Andressa"
  }).kind, "conflict");
  assert.equal(nomeEhNosso("Andressa Oliveira", ["Andressa Oliveira"]), true);
  assert.equal(nomeEhNosso("Andressa oliveira", ["Andressa Oliveira"]), true);
  assert.equal(nomeEhNosso("Andressa", ["Andressa Oliveira"]), false);
  assert.equal(nomeEhNosso("Andressa Oliveira", []), false);
});

test("nosso exige as mesmas palavras e ignora acento e maiúscula", () => {
  assert.equal(nomeEhNosso("jose aldo", ["José Aldo"]), true);
  assert.equal(nomeEhNosso("JOSÉ ALDO", ["jose aldo"]), true);
  assert.equal(nomeEhNosso("José  dos Santos Aldo", ["jose dos santos aldo"]), true);
  assert.equal(nomeEhNosso("Conceicao", ["Conceição"]), true);
  assert.equal(nomeEhNosso("Jose Aldo", ["Jose dos Santos Aldo"]), false);
  assert.equal(nomeEhNosso("Jose dos Santos Aldo", ["Jose Aldo"]), false);
  assert.equal(nomeEhNosso("Jose Santos Aldo", ["Jose Aldo"]), false);
  assert.equal(nomeEhNosso("Jose Aldo", ["Jose Aldo dos Santos"]), false);
  assert.equal(nomeEhNosso("Jose Silva", ["Jose da Silva"]), false);
  assert.equal(nomeEhNosso("Maria Luisa", ["Maria Jose Luisa"]), false);
  assert.equal(nomeEhNosso("Aldo Jose", ["Jose Aldo"]), false);
});

test("mais opções e o item do menu só clicam com um alvo", () => {
  assert.equal(pickMoreOptions([{ aria: "Mais opções de item", nearSend: false }]), 0);
  assert.equal(pickMoreOptions([
    { aria: "Mais opções de item", nearSend: false },
    { aria: "Mais opções de item", nearSend: true }
  ]), 1);
  assert.equal(pickMoreOptions([
    { aria: "Mais opções de item", nearSend: true },
    { aria: "Mais opções de item", nearSend: true }
  ]), 0);
  assert.equal(pickMoreOptions([
    { aria: "Mais opções de item", nearSend: false },
    { aria: "Mais opções de item", nearSend: false }
  ]), null);
  assert.equal(pickMenuItem(["Enviar mensagem", "classificado\num classificado ao Facebook para"]), 1);
  assert.equal(pickMenuItem([
    "classificado\num classificado ao Facebook para",
    "Denunciar classificado\num classificado ao Facebook para"
  ]), null);
  assert.equal(pickMenuItem(["Salvar"]), null);
  assert.equal(pickClassificado(["Classificado"]), 0);
  assert.equal(pickClassificado(["classificado"]), null);
  assert.equal(pickClassificado(["um classificado ao Facebook para"]), null);
  assert.deepEqual(pickClassificado(["Classificado", "Classificado"]), { ambiguous: true });
  assert.equal(pickConcluir([{ aria: "Concluir", text: "Concluir" }]), 0);
  assert.equal(pickConcluir([{ aria: "Concluir", text: "" }]), null);
  assert.equal(pickConcluir([{ aria: "Concluir", text: "concluir" }]), null);
  assert.equal(pickConcluir([{ aria: "Salvar", text: "Concluir" }]), null);
  assert.deepEqual(pickConcluir([
    { aria: "Concluir", text: "Concluir" },
    { aria: "Concluir", text: "Concluir" }
  ]), { ambiguous: true });
});

test("vendedor que não é nosso conclui uma vez e encerra", async () => {
  const calls = [];
  const client = {
    base: "http://ct",
    async pedir() {
      return { ok: true, url: "https://www.facebook.com/marketplace/item/1/", itemId: "1", nomes: ["Andressa Oliveira"] };
    },
    async informar(body) {
      calls.push(body.resultado);
      return { ok: true, fim: true, motivo: "concluido" };
    }
  };
  const out = await runAnuncio({
    page: {},
    nome: "conta-1",
    mode: "auto",
    context: { enabled: true, country: "br", servidor: "mae1", base: "http://ct" },
    client,
    actions: {
      async open() { return { ok: true }; },
      async judge() { return { kind: "seller", name: "Outra Pessoa" }; },
      async denounce() { return { ok: true }; }
    }
  });
  assert.equal(out.reason, "concluido");
  assert.equal(out.skipped, false);
  assert.deepEqual(calls, ["concluido"]);
});

test("indisponível pede outro e o nosso também, até três", async () => {
  const resultados = [];
  let step = 0;
  const client = {
    base: "http://ct",
    async pedir() {
      return { ok: true, url: "https://www.facebook.com/marketplace/item/1/", itemId: "1", nomes: ["Andressa Oliveira"] };
    },
    async informar(body) {
      resultados.push(body.resultado);
      step += 1;
      if (step === 1) return { ok: true, url: "https://www.facebook.com/marketplace/item/2/", itemId: "2", nomes: ["Andressa Oliveira"] };
      if (step === 2) return { ok: true, url: "https://www.facebook.com/marketplace/item/3/", itemId: "3", nomes: ["Andressa Oliveira"] };
      return { ok: true, fim: true, motivo: "tentativas" };
    }
  };
  const kinds = ["unavailable", "seller", "unavailable"];
  const out = await runAnuncio({
    page: {},
    nome: "conta-1",
    mode: "human",
    context: { enabled: false, country: "br", servidor: "mae1", base: "http://ct" },
    client,
    actions: {
      async open() { return { ok: true }; },
      async judge() { return kinds.shift() === "unavailable" ? { kind: "unavailable" } : { kind: "seller", name: "Andressa Oliveira" }; },
      async denounce() { throw new Error("nao era para clicar"); }
    }
  });
  assert.equal(out.reason, "tentativas");
  assert.deepEqual(resultados, ["indisponivel", "nosso", "indisponivel"]);
});

test("config não não roda no automático e o humano roda", async () => {
  const auto = await runAnuncio({
    page: {},
    nome: "conta-1",
    mode: "auto",
    context: { enabled: false, country: "br", servidor: "mae1", base: "http://ct" },
    client: { base: "http://ct", async pedir() { throw new Error("nao"); }, async informar() { throw new Error("nao"); } },
    actions: { async open() { return { ok: true }; }, async judge() { return null; }, async denounce() { return { ok: false }; } }
  });
  assert.equal(auto.reason, "disabled");
  const quebrado = await runAnuncio({
    page: {},
    nome: "conta-1",
    mode: "human",
    context: { enabled: false, country: "br", servidor: "mae1", base: "http://ct" },
    client: {
      base: "http://ct",
      async pedir() {
        return { ok: true, url: "https://www.facebook.com/marketplace/item/9/", itemId: "9", nomes: ["Andressa Oliveira"] };
      },
      async informar(body) {
        assert.equal(body.resultado, "erro");
        return { ok: true, liberado: true };
      }
    },
    actions: {
      async open() { return { ok: true }; },
      async judge() { return { kind: "seller", name: "Outra Pessoa" }; },
      async denounce() { return { ok: false, reason: "concluir_ausente" }; }
    }
  });
  assert.equal(quebrado.reason, "click_failed");
});

function textNode(value) {
  return { nodeType: 3, textContent: value, childNodes: [] };
}

function matchEl(el, sel) {
  const attrs = el.attrs || {};
  if (sel === "span") return el.tag === "span";
  if (sel === 'a[href*="/marketplace/profile/"]') {
    return el.tag === "a" && String(attrs.href || "").includes("/marketplace/profile/");
  }
  if (sel === '[role="button"][aria-label="Enviar mensagem"]') {
    return attrs.role === "button" && attrs["aria-label"] === "Enviar mensagem";
  }
  if (sel === '[role="button"][aria-label="Mais opções de item"]') {
    return attrs.role === "button" && attrs["aria-label"] === "Mais opções de item";
  }
  return false;
}

function el(tag, attrs, kids) {
  const node = {
    nodeType: 1,
    tag,
    attrs: attrs || {},
    childNodes: [],
    parentElement: null,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    get textContent() {
      return this.childNodes.map((child) => child.textContent || "").join("");
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = (current) => {
        current.childNodes.forEach((child) => {
          if (child.nodeType !== 1) return;
          if (matchEl(child, sel)) out.push(child);
          walk(child);
        });
      };
      walk(this);
      return out;
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    },
    contains(other) {
      let current = other;
      while (current) {
        if (current === this) return true;
        current = current.parentElement;
      }
      return false;
    }
  };
  (kids || []).forEach((kid) => {
    kid.parentElement = node;
    node.childNodes.push(kid);
  });
  return node;
}

function nest(depth, leaf) {
  let box = leaf;
  for (let i = 0; i < depth; i += 1) box = el("div", {}, [box]);
  return box;
}

function installDocument(body) {
  const previous = global.document;
  global.document = {
    body,
    querySelectorAll(sel) {
      if (sel === "body *") {
        const out = [];
        const walk = (current) => {
          current.childNodes.forEach((child) => {
            if (child.nodeType !== 1) return;
            out.push(child);
            walk(child);
          });
        };
        walk(body);
        return out;
      }
      return body.querySelectorAll(sel);
    }
  };
  return previous;
}

test("janela estreita ainda lê o vendedor e o botão repetido", () => {
  const heading = el("div", {}, [textNode("Informações do vendedor")]);
  const sellerCard = el("section", {}, [
    nest(14, el("div", {}, [
      heading,
      el("a", { href: "/marketplace/profile/100003565261522/?product_id=1473569581566483" }, [
        el("span", {}, [textNode("Detalhes do vendedor")])
      ])
    ])),
    el("a", {
      href: "/marketplace/profile/100003565261522/?product_id=1473569581566483&__tn__=%3C",
      "aria-label": "Marcos Augusto"
    }, [el("svg", {}, [])]),
    el("a", { href: "/marketplace/profile/100003565261522/?product_id=1473569581566483" }, [
      el("span", {}, [el("span", {}, [textNode("Marcos Augusto")])])
    ])
  ]);
  function actionBar() {
    const button = el("div", { role: "button", "aria-label": "Mais opções de item" }, [
      el("i", {}, [])
    ]);
    return el("div", {}, [
      el("div", { role: "button", "aria-label": "Enviar mensagem" }, []),
      nest(8, button)
    ]);
  }
  const body = el("body", {}, [
    sellerCard,
    el("a", { href: "/marketplace/profile/999/?product_id=1", "aria-label": "Outra Pessoa" }, [
      el("span", {}, [textNode("Outra Pessoa")])
    ]),
    el("div", { role: "button", "aria-label": "Abrir o menu" }, []),
    actionBar(),
    actionBar()
  ]);
  body.innerText = "Informações do vendedor Marcos Augusto";
  const previous = installDocument(body);
  try {
    const raw = listingProbe();
    assert.equal(raw.hasHeading, true);
    assert.deepEqual(judgeListing(raw), { kind: "seller", name: "Marcos Augusto" });
    const picked = pickMoreOptions(moreOptionsProbe());
    assert.equal(picked, 0);
  } finally {
    global.document = previous;
  }
});

test("dois perfis no mesmo bloco não viram vendedor", () => {
  const heading = el("div", {}, [textNode("Informações do vendedor")]);
  const body = el("body", {}, [
    el("section", {}, [
      heading,
      el("a", { href: "/marketplace/profile/100003565261522/", "aria-label": "Marcos Augusto" }, []),
      el("a", { href: "/marketplace/profile/222/", "aria-label": "Outra Pessoa" }, [])
    ])
  ]);
  body.innerText = "";
  const previous = installDocument(body);
  try {
    assert.equal(judgeListing(listingProbe()).kind, "conflict");
  } finally {
    global.document = previous;
  }
});

test("ct sem resposta antes do link nao marca o fluxo como começado", async () => {
  const out = await runAnuncio({
    page: {},
    nome: "conta-1",
    mode: "auto",
    context: { enabled: true, country: "br", servidor: "mae1", base: "http://ct" },
    client: {
      base: "http://ct",
      async pedir() { return { ok: false, error: "ct_falhou" }; },
      async informar() { throw new Error("nao era para informar"); }
    },
    actions: {
      async open() { throw new Error("nao era para abrir"); },
      async judge() { return null; },
      async denounce() { return { ok: false }; }
    }
  });
  assert.equal(out.reason, "ct_falhou");
  assert.equal(out.started, undefined);
});
