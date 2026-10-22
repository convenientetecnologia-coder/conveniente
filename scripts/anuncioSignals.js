"use strict";

const UNAVAILABLE_A = "Este classificado não está mais disponível.";
const UNAVAILABLE_B = "O item pode ter sido vendido ou ter expirado. Dê uma olhada nesses outros itens abaixo.";
const MENU_A = "classificado";
const MENU_B = "um classificado ao Facebook para";
const MORE_LABEL = "Mais opções de item";
const SELLER_HEADING = "Informações do vendedor";
const CLASSIFICADO_LABEL = "Classificado incorreto";
const CONCLUIR_LABEL = "Concluir";

function textHasUnavailable(text) {
  const body = String(text || "");
  return body.includes(UNAVAILABLE_A) && body.includes(UNAVAILABLE_B);
}

function judgeListing({ text, sellerAria, sellerVisible, hasHeading } = {}) {
  if (textHasUnavailable(text)) return { kind: "unavailable" };
  const aria = String(sellerAria || "").trim();
  const visible = String(sellerVisible || "").trim();
  if (aria && visible && aria !== visible) return { kind: "conflict" };
  if (aria && visible && aria === visible) return { kind: "seller", name: aria };
  if (hasHeading) return { kind: "waiting_name" };
  return { kind: "waiting" };
}

function nameTokens(value) {
  return String(value || "").trim().split(/\s+/).filter(Boolean).map((token) => {
    return token.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  });
}

function nomeEhNosso(sellerName, nomes) {
  const seller = nameTokens(sellerName);
  if (!seller.length || !Array.isArray(nomes) || !nomes.length) return false;
  return nomes.some((item) => {
    const listed = nameTokens(item);
    if (listed.length !== seller.length) return false;
    return seller.every((token, index) => token === listed[index]);
  });
}

function pickMoreOptions(buttons) {
  const list = Array.isArray(buttons) ? buttons : [];
  const exact = list
    .map((button, index) => ({ button, index }))
    .filter((row) => String(row.button && row.button.aria || "") === MORE_LABEL);
  if (exact.length === 1) return exact[0].index;
  const near = exact.filter((row) => row.button && row.button.nearSend === true);
  if (near.length >= 1) return near[0].index;
  return null;
}

function pickMenuItem(texts) {
  const hits = [];
  (Array.isArray(texts) ? texts : []).forEach((text, index) => {
    const body = String(text || "");
    if (body.includes(MENU_A) && body.includes(MENU_B)) hits.push(index);
  });
  return hits.length === 1 ? hits[0] : null;
}

function pickClassificado(labels) {
  const hits = [];
  (Array.isArray(labels) ? labels : []).forEach((text, index) => {
    if (String(text || "").trim() === CLASSIFICADO_LABEL) hits.push(index);
  });
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return { ambiguous: true };
  return null;
}

function pickConcluir(buttons) {
  const hits = [];
  (Array.isArray(buttons) ? buttons : []).forEach((button, index) => {
    const aria = String(button && button.aria || "").trim();
    const text = String(button && button.text || "").trim();
    if (aria === CONCLUIR_LABEL && text === CONCLUIR_LABEL) hits.push(index);
  });
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return { ambiguous: true };
  return null;
}

function listingProbe() {
  const HEADING = "Informações do vendedor";
  const IGNORE = {
    "Detalhes do vendedor": true,
    "Informações do vendedor": true,
    "Enviar mensagem": true,
    "Enviar": true,
    "Salvar": true,
    "Compartilhar": true,
    "Mais opções de item": true
  };
  const body = document.body;
  const text = body ? String(body.innerText || "") : "";
  const nodes = Array.from(document.querySelectorAll("body *"));
  const heading = nodes.find((el) => {
    if (!el || el.childNodes.length !== 1 || !el.childNodes[0] || el.childNodes[0].nodeType !== 3) return false;
    return String(el.textContent || "").trim() === HEADING;
  });
  let sellerAria = "";
  let sellerVisible = "";
  function personNames(box) {
    const links = Array.from(box.querySelectorAll('a[href*="/marketplace/profile/"]'));
    const ids = [];
    const names = [];
    links.forEach((link) => {
      const href = String(link.getAttribute("href") || "");
      const match = href.match(/\/marketplace\/profile\/(\d+)/);
      if (match && ids.indexOf(match[1]) === -1) ids.push(match[1]);
      const aria = String(link.getAttribute("aria-label") || "").trim();
      if (aria && !IGNORE[aria] && names.indexOf(aria) === -1) names.push(aria);
      Array.from(link.querySelectorAll("span")).forEach((span) => {
        if (!span || span.childNodes.length !== 1 || !span.childNodes[0] || span.childNodes[0].nodeType !== 3) return;
        const value = String(span.textContent || "").trim();
        if (value && !IGNORE[value] && names.indexOf(value) === -1) names.push(value);
      });
    });
    return { ids, names };
  }
  if (heading) {
    let box = heading;
    for (let depth = 0; depth < 25 && box; depth += 1) {
      const read = personNames(box);
      if (read.ids.length > 1 || (read.ids.length === 1 && read.names.length > 1)) {
        sellerAria = read.names[0] || "conflito";
        sellerVisible = read.names[1] || "nomes";
        break;
      }
      if (read.ids.length === 1 && read.names.length === 1) {
        sellerAria = read.names[0];
        sellerVisible = read.names[0];
        break;
      }
      box = box.parentElement;
    }
  }
  return {
    text,
    hasHeading: !!heading,
    sellerAria,
    sellerVisible
  };
}

function moreOptionsProbe() {
  const send = Array.from(document.querySelectorAll('[role="button"][aria-label="Enviar mensagem"]'));
  return Array.from(document.querySelectorAll('[role="button"][aria-label="Mais opções de item"]')).map((button) => {
    let box = button;
    let nearSend = false;
    for (let depth = 0; depth < 12 && box && !nearSend; depth += 1) {
      nearSend = send.some((item) => box.contains(item));
      box = box.parentElement;
    }
    return { aria: "Mais opções de item", nearSend };
  });
}

function menuProbe() {
  return Array.from(document.querySelectorAll('[role="menuitem"]')).map((item) => String(item.innerText || item.textContent || ""));
}

function classificadoProbe() {
  return Array.from(document.querySelectorAll("span")).filter((el) => {
    if (!el || el.childNodes.length !== 1 || !el.childNodes[0] || el.childNodes[0].nodeType !== 3) return false;
    return String(el.textContent || "").trim() === "Classificado incorreto";
  }).map(() => "Classificado incorreto");
}

function clickClassificado() {
  const spans = Array.from(document.querySelectorAll("span")).filter((el) => {
    if (!el || el.childNodes.length !== 1 || !el.childNodes[0] || el.childNodes[0].nodeType !== 3) return false;
    return String(el.textContent || "").trim() === "Classificado incorreto";
  });
  if (spans.length !== 1) return false;
  spans[0].click();
  return true;
}

function concluirProbe() {
  return Array.from(document.querySelectorAll('[role="button"][aria-label="Concluir"]')).map((button) => {
    const span = Array.from(button.querySelectorAll("span")).find((el) => {
      if (!el || el.childNodes.length !== 1 || !el.childNodes[0] || el.childNodes[0].nodeType !== 3) return false;
      return String(el.textContent || "").trim() === "Concluir";
    });
    return { aria: "Concluir", text: span ? "Concluir" : "" };
  });
}

function clickConcluir() {
  const buttons = Array.from(document.querySelectorAll('[role="button"][aria-label="Concluir"]')).filter((button) => {
    return Array.from(button.querySelectorAll("span")).some((el) => {
      if (!el || el.childNodes.length !== 1 || !el.childNodes[0] || el.childNodes[0].nodeType !== 3) return false;
      return String(el.textContent || "").trim() === "Concluir";
    });
  });
  if (buttons.length !== 1) return false;
  buttons[0].click();
  return true;
}

module.exports = {
  UNAVAILABLE_A,
  UNAVAILABLE_B,
  MENU_A,
  MENU_B,
  MORE_LABEL,
  SELLER_HEADING,
  textHasUnavailable,
  judgeListing,
  nomeEhNosso,
  pickMoreOptions,
  pickMenuItem,
  pickClassificado,
  pickConcluir,
  CLASSIFICADO_LABEL,
  CONCLUIR_LABEL,
  listingProbe,
  moreOptionsProbe,
  menuProbe,
  classificadoProbe,
  clickClassificado,
  concluirProbe,
  clickConcluir
};
