// Helpers de UI e formatação: DOM, dinheiro em centavos, datas/meses, toasts e clipboard.
// Tudo aqui é puro (exceto toast/clipboard/DOM), então os testes importam direto.

/** Cria um elemento DOM. attrs aceita: class, text, html, dataset, on{Event}, e atributos. */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else node.setAttribute(k, v);
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const c of kids) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** Formata centavos como moeda BRL: 123456 -> "R$ 1.234,56". */
export function fmtBRL(cents) {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/** Igual a fmtBRL, mas sem centavos quando o valor é redondo — para títulos grandes. */
export function fmtBRLCurto(cents) {
  const reais = cents / 100;
  return reais.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: Number.isInteger(reais) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Converte texto digitado em centavos (inteiro), tratando separadores pt-BR e en-US.
 *  - "1.234,56" (vírgula decimal) e "1,234.56" (ponto decimal): o ÚLTIMO separador é o decimal.
 *  - só vírgula -> decimal: "12,50" => 1250
 *  - só ponto   -> decimal apenas se for 1 ponto seguido de 1-2 dígitos ("12.5", "12.50");
 *                  caso contrário é separador de milhar ("1.500" => 150000 centavos)
 * Retorna null se inválido (vazio, NaN ou negativo).
 */
export function parseAmountToCents(str) {
  if (str == null) return null;
  let s = String(str).trim().replace(/[^\d.,-]/g, "");
  if (!s || s === "-") return null;
  if (s.includes("-")) return null;

  const hasComma = s.includes(",");
  const hasDot = s.includes(".");

  if (hasComma && hasDot) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (hasComma) {
    s = s.replace(",", ".");
  } else if (hasDot) {
    const parts = s.split(".");
    const dec = parts[parts.length - 1];
    if (!(parts.length === 2 && dec.length <= 2)) s = s.replace(/\./g, "");
  }

  const num = Number(s);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num * 100);
}

// ---------------------------------------------------------------- datas e meses
// Convenção: mês é sempre a string "YYYY-MM" e data é "YYYY-MM-DD" (sem fuso).
// Tudo é manipulado como texto/UTC para o dia nunca "andar" por causa de timezone.

const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const DIAS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

/** "YYYY-MM-DD" de hoje no fuso LOCAL do aparelho. */
export function hojeISO(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "YYYY-MM" de uma data "YYYY-MM-DD". */
export function mesDe(dataISO) {
  return String(dataISO || "").slice(0, 7);
}

/** Soma (ou subtrai) meses a "YYYY-MM". mesAdd("2026-01", -1) => "2025-12". */
export function mesAdd(mes, delta) {
  const [y, m] = String(mes).split("-").map(Number);
  if (!y || !m) return mes;
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  return `${ny}-${String(nm + 1).padStart(2, "0")}`;
}

/** "2026-09" -> "setembro de 2026". */
export function mesExtenso(mes) {
  const [y, m] = String(mes).split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return String(mes || "");
  return `${MESES[m - 1]} de ${y}`;
}

/** "2026-09" -> "set/26" (para eixos e comparações compactas). */
export function mesCurto(mes) {
  const [y, m] = String(mes).split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return String(mes || "");
  return `${MESES[m - 1].slice(0, 3)}/${String(y).slice(2)}`;
}

/** "2026-09-19" -> "sexta, 19/09". Útil no agrupamento por dia. */
export function dataExtenso(dataISO) {
  const [y, m, d] = String(dataISO).split("-").map(Number);
  if (!y || !m || !d) return String(dataISO || "");
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${DIAS[dt.getUTCDay()]}, ${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}`;
}

/** "2026-09-19" -> "19/09". */
export function dataCurta(dataISO) {
  const [, m, d] = String(dataISO).split("-");
  return d && m ? `${d}/${m}` : String(dataISO || "");
}

/** Quantidade de dias do mês "YYYY-MM". */
export function diasNoMes(mes) {
  const [y, m] = String(mes).split("-").map(Number);
  if (!y || !m) return 30;
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Variação percentual de `de` para `para`. Null quando não faz sentido comparar. */
export function variacaoPct(para, de) {
  if (!de || de <= 0) return null;
  return ((para - de) / de) * 100;
}

// ---------------------------------------------------------------- feedback visual

let toastTimer = null;
/** Mostra um toast temporário. type: "info" | "success" | "error". */
export function toast(msg, type = "info") {
  const root = document.getElementById("toast-root");
  if (!root) return;
  root.innerHTML = "";
  const t = el("div", { class: `toast toast--${type}`, role: "status", text: msg });
  root.append(t);
  clearTimeout(toastTimer);
  void t.offsetWidth; // força reflow para a transição entrar
  t.classList.add("toast--show");
  toastTimer = setTimeout(() => {
    t.classList.remove("toast--show");
    setTimeout(() => t.remove(), 250);
  }, type === "error" ? 4500 : 2600);
}

/** Confirmação simples (nativa, confiável no mobile). */
export function confirmAction(message) {
  return window.confirm(message);
}

/** Copia texto para a área de transferência, com fallback. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el("textarea", { value: text });
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

/** Esvazia um container. */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Baixa um arquivo texto gerado no cliente (usado na exportação CSV). */
export function downloadText(filename, text, mime = "text/csv;charset=utf-8") {
  const blob = new Blob(["﻿" + text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
