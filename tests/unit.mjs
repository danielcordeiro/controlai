// Testes das funções puras do Controlaí — dinheiro, datas/meses e agregação do mês.
// Sem dependência externa: `node tests/unit.mjs` (sai 0 se passar, 1 se falhar).

import {
  parseAmountToCents, fmtBRL, hojeISO, mesDe, mesAdd, mesExtenso, mesCurto,
  dataCurta, diasNoMes, variacaoPct,
} from "../js/ui.js";

let falhas = 0;
let total = 0;

function ok(cond, nome, extra = "") {
  total++;
  if (cond) return;
  falhas++;
  console.error(`  ✗ ${nome}${extra ? ` — ${extra}` : ""}`);
}
function eq(actual, expected, nome) {
  ok(Object.is(actual, expected), nome, `esperado ${JSON.stringify(expected)}, veio ${JSON.stringify(actual)}`);
}
function grupo(nome, fn) {
  console.log(`\n${nome}`);
  fn();
}

// ---------------------------------------------------------------- dinheiro
grupo("parseAmountToCents", () => {
  eq(parseAmountToCents("12,50"), 1250, "vírgula decimal");
  eq(parseAmountToCents("12.50"), 1250, "ponto decimal com 2 casas");
  eq(parseAmountToCents("12.5"), 1250, "ponto decimal com 1 casa");
  eq(parseAmountToCents("1.500"), 150000, "ponto como milhar (R$ 1.500)");
  eq(parseAmountToCents("1.234.567"), 123456700, "vários pontos = milhar");
  eq(parseAmountToCents("1.234,56"), 123456, "pt-BR completo");
  eq(parseAmountToCents("1,234.56"), 123456, "en-US completo");
  eq(parseAmountToCents("R$ 89,90"), 8990, "com símbolo e espaço");
  eq(parseAmountToCents("  42  "), 4200, "inteiro com espaços");
  eq(parseAmountToCents("0,01"), 1, "um centavo");
  eq(parseAmountToCents(""), null, "vazio é inválido");
  eq(parseAmountToCents("abc"), null, "texto é inválido");
  eq(parseAmountToCents("-10"), null, "negativo é inválido");
  eq(parseAmountToCents(null), null, "null é inválido");
  // arredondamento: nunca pode gerar centavo fracionário
  ok(Number.isInteger(parseAmountToCents("33,333")), "sempre inteiro");
});

grupo("fmtBRL", () => {
  ok(fmtBRL(123456).includes("1.234,56"), "formata milhar e centavos");
  ok(fmtBRL(0).includes("0,00"), "zero");
  // ida e volta: formatar e reinterpretar preserva o valor
  for (const c of [1, 99, 100, 1050, 999999, 123456789]) {
    eq(parseAmountToCents(fmtBRL(c)), c, `ida e volta ${c}`);
  }
});

// ---------------------------------------------------------------- meses
grupo("mesAdd / mesDe / mesExtenso", () => {
  eq(mesDe("2026-09-19"), "2026-09", "mês de uma data");
  eq(mesAdd("2026-09", 1), "2026-10", "próximo mês");
  eq(mesAdd("2026-12", 1), "2027-01", "vira o ano para frente");
  eq(mesAdd("2026-01", -1), "2025-12", "vira o ano para trás");
  eq(mesAdd("2026-09", -12), "2025-09", "um ano atrás");
  eq(mesAdd("2026-09", 0), "2026-09", "delta zero");
  eq(mesExtenso("2026-09"), "setembro de 2026", "mês por extenso");
  eq(mesExtenso("2026-03"), "março de 2026", "acento preservado");
  eq(mesCurto("2026-09"), "set/26", "mês curto");
  // ida e volta em 36 meses seguidos
  let m = "2024-01";
  for (let i = 0; i < 36; i++) {
    eq(mesAdd(mesAdd(m, 1), -1), m, `ida e volta em ${m}`);
    m = mesAdd(m, 1);
  }
});

grupo("diasNoMes", () => {
  eq(diasNoMes("2026-01"), 31, "janeiro");
  eq(diasNoMes("2026-02"), 28, "fevereiro comum");
  eq(diasNoMes("2024-02"), 29, "fevereiro bissexto");
  eq(diasNoMes("2026-04"), 30, "abril");
  eq(diasNoMes("2026-12"), 31, "dezembro");
});

grupo("hojeISO / dataCurta", () => {
  ok(/^\d{4}-\d{2}-\d{2}$/.test(hojeISO()), "formato YYYY-MM-DD");
  eq(hojeISO(new Date(2026, 0, 5)), "2026-01-05", "zero à esquerda");
  eq(hojeISO(new Date(2026, 11, 31)), "2026-12-31", "fim do ano");
  eq(dataCurta("2026-09-19"), "19/09", "data curta");
  // o dia não pode "andar" por fuso: meia-noite local continua o mesmo dia
  eq(hojeISO(new Date(2026, 5, 1, 0, 0, 0)), "2026-06-01", "meia-noite local");
  eq(hojeISO(new Date(2026, 5, 1, 23, 59, 59)), "2026-06-01", "quase meia-noite");
});

grupo("variacaoPct", () => {
  eq(variacaoPct(150, 100), 50, "+50%");
  eq(variacaoPct(50, 100), -50, "-50%");
  eq(variacaoPct(100, 100), 0, "estável");
  eq(variacaoPct(100, 0), null, "sem base de comparação");
  eq(variacaoPct(100, null), null, "base nula");
});

// ---------------------------------------------------------------- agregação do mês
const { porCategoria, porFormaPagamento, porDia, totalCentavos, maioresDespesas } =
  await import("../js/report.js");

const CATS = [
  { id: "c1", name: "Alimentação", color: "#ef4444", parent_id: null },
  { id: "c1a", name: "Mercado", color: "#ef4444", parent_id: "c1" },
  { id: "c1b", name: "Restaurante", color: "#ef4444", parent_id: "c1" },
  { id: "c2", name: "Transporte", color: "#3b82f6", parent_id: null },
  { id: "c3", name: "Moradia", color: "#8b5cf6", parent_id: null },
];
const FORMAS = [
  { id: "f1", name: "Cartão" },
  { id: "f2", name: "Pix" },
];
const DESP = [
  { id: "e1", spent_on: "2026-09-01", description: "Feira", amount_cents: 20000, category_id: "c1a", payment_method_id: "f1" },
  { id: "e2", spent_on: "2026-09-01", description: "Almoço", amount_cents: 5000, category_id: "c1b", payment_method_id: "f2" },
  { id: "e3", spent_on: "2026-09-03", description: "Uber", amount_cents: 2500, category_id: "c2", payment_method_id: null },
  { id: "e4", spent_on: "2026-09-10", description: "Aluguel", amount_cents: 150000, category_id: "c3", payment_method_id: "f2" },
  { id: "e5", spent_on: "2026-09-10", description: "Padaria", amount_cents: 1500, category_id: "c1", payment_method_id: null },
];
const TOTAL = 20000 + 5000 + 2500 + 150000 + 1500; // 179000

grupo("totalCentavos", () => {
  eq(totalCentavos(DESP), TOTAL, "soma tudo");
  eq(totalCentavos([]), 0, "lista vazia");
});

grupo("porCategoria (rollup pai/filho)", () => {
  const linhas = porCategoria(DESP, CATS);
  eq(linhas.reduce((s, l) => s + l.cents, 0), TOTAL, "soma das categorias = total");
  eq(linhas[0].id, "c3", "ordenado por valor decrescente (Moradia primeiro)");
  const alim = linhas.find((l) => l.id === "c1");
  eq(alim.cents, 26500, "pai soma os filhos + lançamentos diretos");
  eq(alim.subs.length, 3, "três linhas de subcategoria (Mercado, Restaurante, direto)");
  eq(alim.subs.reduce((s, x) => s + x.cents, 0), alim.cents, "subs somam o pai");
  eq(alim.subs[0].cents, 20000, "sub ordenada por valor (Mercado primeiro)");
  const transp = linhas.find((l) => l.id === "c2");
  eq(transp.subs.length, 0, "categoria sem filhos não tem detalhamento");
  // percentuais
  ok(Math.abs(linhas.reduce((s, l) => s + l.pct, 0) - 100) < 0.01, "percentuais somam 100");
  eq(porCategoria([], CATS).length, 0, "mês sem despesa");
  // despesa órfã (categoria apagada) não some do total
  const comOrfa = porCategoria([...DESP, { id: "x", spent_on: "2026-09-11", amount_cents: 1000, category_id: "zzz" }], CATS);
  eq(comOrfa.reduce((s, l) => s + l.cents, 0), TOTAL + 1000, "órfã entra em 'Sem categoria'");
});

grupo("porFormaPagamento", () => {
  const linhas = porFormaPagamento(DESP, FORMAS);
  eq(linhas.reduce((s, l) => s + l.cents, 0), TOTAL, "soma = total");
  const pix = linhas.find((l) => l.id === "f2");
  eq(pix.cents, 155000, "Pix soma aluguel + almoço");
  const semForma = linhas.find((l) => l.id === null);
  eq(semForma.cents, 4000, "sem forma informada é agrupado");
});

grupo("porDia", () => {
  const dias = porDia(DESP);
  eq(dias.length, 3, "três dias com lançamento");
  eq(dias[0].dia, "2026-09-10", "mais recente primeiro");
  eq(dias[0].cents, 151500, "soma do dia");
  eq(dias.reduce((s, d) => s + d.cents, 0), TOTAL, "soma dos dias = total");
  eq(dias[0].itens.length, 2, "itens do dia");
});

grupo("maioresDespesas", () => {
  const top = maioresDespesas(DESP, 3);
  eq(top.length, 3, "respeita o limite");
  eq(top[0].id, "e4", "maior primeiro");
  ok(top[0].amount_cents >= top[1].amount_cents, "ordenado decrescente");
  eq(maioresDespesas([], 3).length, 0, "vazio");
});

// ---------------------------------------------------------------- resultado
console.log(`\n${total - falhas}/${total} verificações passaram.`);
if (falhas) {
  console.error(`${falhas} falha(s).`);
  process.exit(1);
}
console.log("Tudo certo.");
