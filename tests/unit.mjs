// Testes das funções puras do Controlaí — dinheiro, datas/meses e agregação do mês.
// Sem dependência externa: `node tests/unit.mjs` (sai 0 se passar, 1 se falhar).

import {
  parseAmountToCents, fmtBRL, hojeISO, mesDe, mesAdd, mesExtenso, mesCurto,
  dataCurta, diasNoMes, variacaoPct, MAX_CENTAVOS, acaoUnica,
  divideParcelas, previaParcelas, limiteNavegacao, limitesDataEdicao,
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
const pendentes = [];   // grupos que devolvem promise (testes assíncronos)
function grupo(nome, fn) {
  console.log(`\n${nome}`);
  const r = fn();
  if (r && typeof r.then === "function") pendentes.push(r);
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

// ------------------------------------------------------- guarda de envio duplo
grupo("acaoUnica", () => {
  let chamadas = 0;
  let libera;
  const espera = new Promise((r) => { libera = r; });
  const fn = acaoUnica(async () => { chamadas++; await espera; return chamadas; });
  const primeira = fn();
  fn(); fn();                             // dois disparos com a primeira em voo
  eq(chamadas, 1, "só a primeira chamada roda enquanto está no ar");
  libera();
  // depois que a primeira termina, uma nova chamada volta a passar
  return primeira.then(() => fn()).then(() => {
    eq(chamadas, 2, "volta a aceitar depois que a anterior termina");
  });
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

grupo("divideParcelas / previaParcelas (a mesma divisão do servidor)", () => {
  const d = divideParcelas(100000, 3);
  eq(d.primeira, 33334, "a 1ª leva o centavo que sobra");
  eq(d.parcela, 33333, "as demais com a divisão inteira");
  eq(divideParcelas(300000, 10).primeira, 30000, "divisão exata não tem resto");
  // soma = total e o resto cabe no check do banco (0 .. N-1)
  for (const [t, n] of [[100000, 3], [99999, 7], [1, 1], [12345, 12], [10, 10], [2147483647, 600]]) {
    const { parcela, primeira } = divideParcelas(t, n);
    eq(primeira + parcela * (n - 1), t, `soma das parcelas = total em ${t}/${n}`);
    ok(t - parcela * n >= 0 && t - parcela * n <= n - 1, `resto dentro do check em ${t}/${n}`);
  }
  eq(previaParcelas(30000, 10, false), `10x de ${fmtBRL(30000)} · total ${fmtBRL(300000)}`, "valor da parcela");
  eq(previaParcelas(300000, 10, true), `10x de ${fmtBRL(30000)} · total ${fmtBRL(300000)}`, "total que divide exato");
  eq(previaParcelas(100000, 3, true), `1ª ${fmtBRL(33334)} + 2x ${fmtBRL(33333)} · total ${fmtBRL(100000)}`,
    "total com centavo de sobra");
});

grupo("limiteNavegacao (até onde o › avança)", () => {
  const A = "2026-09";
  eq(limiteNavegacao([], A), A, "sem série o › para no mês atual");
  eq(limiteNavegacao(undefined, A), A, "snapshot sem fixas");
  eq(limiteNavegacao([{ mes_inicio: "2026-08", ultimo_mes: "2027-05" }], A), "2027-05", "parcelado vai até a última parcela");
  eq(limiteNavegacao([{ mes_inicio: "2025-01", ultimo_mes: null }], A), "2026-10", "sem fim: só o mês que vem");
  eq(limiteNavegacao([{ mes_inicio: "2027-02", ultimo_mes: null }], A), "2027-02", "sem fim que começa depois: até o início");
  eq(limiteNavegacao([{ mes_inicio: "2026-01", ultimo_mes: "2026-06" }], A), A, "série acabada não abre o futuro");
  eq(limiteNavegacao([{ mes_inicio: "2025-01", cancelado_em: "2026-10", ultimo_mes: "2026-09" }], A), A,
    "sem fim cancelada não abre o futuro");
  eq(limiteNavegacao([{ mes_inicio: "2026-01", ultimo_mes: "2026-09" }, { mes_inicio: "2026-09", ultimo_mes: "2026-12" }], A),
    "2026-12", "vale a série que vai mais longe");
  eq(limiteNavegacao([{ mes_inicio: "2026-11", ultimo_mes: null }], "2026-12"), "2027-01", "vira o ano");
});

grupo("limitesDataEdicao (a mesma régua do servidor)", () => {
  const ap = (spent_on) => limitesDataEdicao({ spent_on, a_pagar: true }, "2026-09-30");
  eq(ap("2026-08-10").min, "2026-08-01", "a pagar: do 1º dia do mês do vencimento");
  eq(ap("2026-08-10").max, "2026-08-31", "a pagar: até o último dia, sem sair do mês");
  eq(ap("2026-02-10").max, "2026-02-28", "fevereiro comum");
  eq(ap("2024-02-10").max, "2024-02-29", "fevereiro bissexto");
  const paga = (spent_on, hoje) => limitesDataEdicao({ spent_on, a_pagar: false }, hoje);
  eq(paga("2026-09-03", "2026-09-10").min, null, "paga: sem mínimo");
  eq(paga("2026-09-03", "2026-09-10").max, "2026-09-11", "paga: até amanhã");
  eq(paga("2026-09-03", "2026-09-30").max, "2026-10-01", "amanhã vira o mês");
  eq(paga("2026-12-03", "2026-12-31").max, "2027-01-01", "amanhã vira o ano");
  eq(paga("2026-09-20", "2026-09-05").max, "2026-09-20", "série lançada à frente de hoje: até a própria data");
});

grupo("diasNoMes", () => {
  eq(diasNoMes("2026-01"), 31, "janeiro");
  eq(diasNoMes("2026-02"), 28, "fevereiro comum");
  eq(diasNoMes("2024-02"), 29, "fevereiro bissexto");
  eq(diasNoMes("2026-04"), 30, "abril");
  eq(diasNoMes("2026-12"), 31, "dezembro");
});

grupo("hojeISO / dataCurta (fuso da carteira)", () => {
  ok(/^\d{4}-\d{2}-\d{2}$/.test(hojeISO()), "formato YYYY-MM-DD");
  eq(dataCurta("2026-09-19"), "19/09", "data curta");
  // "hoje" é SEMPRE o dia em America/Sao_Paulo, não no fuso do aparelho:
  // o banco valida data futura nesse fuso, as duas pontas têm que concordar.
  eq(hojeISO(new Date("2026-01-05T15:00:00Z")), "2026-01-05", "meio da tarde");
  eq(hojeISO(new Date("2026-01-05T02:00:00Z")), "2026-01-04", "02h UTC ainda é o dia anterior no Brasil");
  eq(hojeISO(new Date("2026-06-02T02:59:00Z")), "2026-06-01", "quase meia-noite no Brasil");
  eq(hojeISO(new Date("2026-06-02T03:01:00Z")), "2026-06-02", "logo após a virada no Brasil");
  eq(hojeISO(new Date("2027-01-01T01:00:00Z")), "2026-12-31", "virada de ano pelo fuso");
});

grupo("MAX_CENTAVOS (teto do integer do Postgres)", () => {
  eq(MAX_CENTAVOS, 2147483647, "teto conhecido");
  ok(parseAmountToCents("21.474.836,47") === MAX_CENTAVOS, "valor exatamente no teto");
  ok(parseAmountToCents("30.000.000,00") > MAX_CENTAVOS, "acima do teto é detectável antes da RPC");
});

grupo("variacaoPct", () => {
  eq(variacaoPct(150, 100), 50, "+50%");
  eq(variacaoPct(50, 100), -50, "-50%");
  eq(variacaoPct(100, 100), 0, "estável");
  eq(variacaoPct(100, 0), null, "sem base de comparação");
  eq(variacaoPct(100, null), null, "base nula");
});

// ---------------------------------------------------------------- agregação do mês
const {
  porCategoria, porFormaPagamento, porDia, totalCentavos, maioresDespesas, montaCSV,
  resumoAPagar, andamentoFixa, linhasLimites, barraDoTotal,
} = await import("../js/report.js");

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
  eq(transp.subs.length, 0, "categoria folha não repete a si mesma no detalhamento");
  // pai cujo gasto veio SÓ de uma subcategoria precisa revelar qual
  const soSub = porCategoria(
    [{ id: "s1", spent_on: "2026-09-02", amount_cents: 7000, category_id: "c1b" }], CATS);
  eq(soSub[0].id, "c1", "rollup no pai");
  eq(soSub[0].subs.length, 1, "revela a subcategoria única");
  eq(soSub[0].subs[0].name, "Restaurante", "nome da subcategoria");
  // percentuais: os exibidos (inteiros) precisam fechar 100 exatamente
  ok(Math.abs(linhas.reduce((s, l) => s + l.pct, 0) - 100) < 0.01, "percentuais brutos somam 100");
  eq(linhas.reduce((s, l) => s + l.pctExib, 0), 100, "percentuais exibidos somam 100");
  // caso clássico do 101%: 99,5% + 0,5% arredondados isoladamente dariam 100+1
  const doisTercos = porCategoria([
    { id: "a", spent_on: "2026-09-01", amount_cents: 199000, category_id: "c3" },
    { id: "b", spent_on: "2026-09-01", amount_cents: 1000, category_id: "c2" },
  ], CATS);
  eq(doisTercos.reduce((s, l) => s + l.pctExib, 0), 100, "99,5/0,5 fecha 100");
  // três iguais: 33+33+34
  const tres = porCategoria([
    { id: "a", spent_on: "2026-09-01", amount_cents: 1000, category_id: "c3" },
    { id: "b", spent_on: "2026-09-01", amount_cents: 1000, category_id: "c2" },
    { id: "c", spent_on: "2026-09-01", amount_cents: 1000, category_id: "c1" },
  ], CATS);
  eq(tres.reduce((s, l) => s + l.pctExib, 0), 100, "três terços fecham 100");
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
  eq(linhas.reduce((s, l) => s + l.pctExib, 0), 100, "percentuais exibidos somam 100");
});

grupo("montaCSV", () => {
  const csv = montaCSV(DESP, CATS, FORMAS);
  const linhas = csv.split("\n");
  eq(linhas.length, DESP.length + 1, "cabeçalho + uma linha por despesa");
  eq(linhas[0], "Data;Descrição;Categoria;Forma de pagamento;Valor", "cabeçalho");
  ok(linhas[1].startsWith("2026-09-01"), "ordenado da data mais antiga");
  ok(csv.includes("Alimentação > Mercado"), "subcategoria sai com o pai");
  ok(csv.includes("200,00"), "valor em vírgula decimal (pt-BR)");
  ok(csv.includes(";;"), "despesa sem forma de pagamento deixa a coluna vazia");
  // ponto e vírgula/aspas no texto não podem quebrar a coluna
  const perigoso = montaCSV(
    [{ id: "p", spent_on: "2026-09-01", description: 'uber; "ida"', amount_cents: 100, category_id: "c2" }],
    CATS, FORMAS);
  ok(perigoso.split("\n")[1].includes('"uber; ""ida"""'), "texto com ; e aspas é escapado");
  eq(montaCSV([], CATS, FORMAS).split("\n").length, 1, "sem despesa, só cabeçalho");
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

// a projeção e a média por dia saíram daqui: a regra mora em controlai._orcamento
// e os casos (180000 no dia 7, null no dia 6...) estão em supabase/checks.sql
grupo("linhasLimites (card Limites)", () => {
  // livre vem do servidor; o consumo e o % são só de exibição
  const item = (category_id, limite, gasto, previsto = 0) => ({
    category_id, limite_cents: limite, gasto_cents: gasto, serie_cents: 0, previsto_cents: previsto,
    livre_cents: limite == null ? null : limite - gasto - previsto, livre_dia_cents: null,
    projecao_cents: null, media_dia_cents: null,
  });
  const orc = [
    item(null, 500000, 400000),          // total: não vira linha
    item("c2", 80000, 62000),            // 77,5% -> 77
    item("c3", 50000, 50000),            // exatamente no limite: 100%, não passou
    item("c1", 30000, 34500),            // passou R$ 45 -> 115%
    item("c1a", 10000, 0),               // sem gasto aparece com 0
    item("c1b", 99900, 99899),           // 99,99...% não pode virar 100
  ];
  const l = linhasLimites(orc, CATS);
  eq(l.length, 5, "uma linha por categoria com limite, sem o total");
  eq(l[0].id, "c1", "quem passou vem primeiro");
  eq(l[0].passou, true, "livre < 0 é passou");
  eq(l[0].pct, 115, "percentual acima de 100 continua aparecendo");
  eq(l[0].barra, 100, "a barra para em 100");
  eq(l[0].name, "Alimentação", "nome da categoria");
  eq(l[0].color, "#ef4444", "cor da categoria");
  eq(l[1].id, "c3", "depois o maior percentual");
  eq(l[1].pct, 100, "no limite: 100%");
  eq(l[1].passou, false, "chegar exatamente no limite não é passar");
  eq(l[2].id, "c1b", "99,99% vem antes de 77%");
  eq(l[2].pct, 99, "percentual com floor");
  eq(l[3].pct, 77, "77,5% vira 77");
  eq(l[4].consumo, 0, "categoria sem gasto aparece com 0");
  eq(l[4].barra, 0, "barra vazia");
  // mês futuro: consumo = lançado + previsto
  const fut = linhasLimites([item("c2", 80000, 1000, 70000)], CATS)[0];
  eq(fut.consumo, 71000, "no futuro o consumo soma o previsto");
  eq(fut.previsto, 70000, "o previsto vai para o texto de comprometidos");
  eq(fut.livre, 9000, "livre é o do servidor");
  // empate no percentual: nome
  const emp = linhasLimites([item("c3", 10000, 5000), item("c2", 10000, 5000)], CATS);
  eq(emp.map((x) => x.id).join(), "c3,c2", "empate de % ordena pelo nome (Moradia < Transporte)");
  eq(linhasLimites(undefined, CATS).length, 0, "snapshot sem orcamento (SQL antigo) não quebra");
  eq(linhasLimites([item(null, null, 1000)], CATS).length, 0, "sem limite nenhum, card some");
});

grupo("barraDoTotal (barra em duas partes)", () => {
  const t = (limite, gasto, serie, previsto = 0) => ({
    category_id: null, limite_cents: limite, gasto_cents: gasto, serie_cents: serie, previsto_cents: previsto,
  });
  eq(barraDoTotal(t(null, 100000, 0)), null, "sem limite total, sem barra");
  eq(barraDoTotal(null), null, "sem linha de total");
  // dia 1: 85% já tomados por fixas e parcelas
  const d1 = barraDoTotal(t(2000000, 1700000, 1700000));
  eq(d1.pctSerie, 85, "a série ocupa 85% do limite");
  eq(d1.pctDiaADia, 0, "o dia a dia ainda não começou");
  const meio = barraDoTotal(t(200000, 180000, 150000));
  eq(meio.serie, 150000, "parte da série");
  eq(meio.diaADia, 30000, "dia a dia = gasto - série");
  eq(meio.pctSerie + meio.pctDiaADia, 90, "as duas partes somam o consumo sobre o limite");
  // passou: a escala vira o consumo e a barra enche sem estourar
  const passou = barraDoTotal(t(100000, 200000, 150000));
  eq(passou.pctSerie + passou.pctDiaADia, 100, "passou do limite: barra cheia");
  eq(passou.pctSerie, 75, "proporção mantida na escala do consumo");
  // futuro: o previsto entra na parte cinza e o lançado no dia a dia
  const fut = barraDoTotal(t(300000, 10000, 0, 230000));
  eq(fut.serie, 230000, "no futuro a parte cinza é o previsto");
  eq(fut.diaADia, 10000, "e o dia a dia é o já lançado");
});

grupo("resumoAPagar (card A pagar)", () => {
  const pend = [
    { id: "a", spent_on: "2026-08-10", amount_cents: 30000 },
    { id: "b", spent_on: "2026-09-10", amount_cents: 30000 },
    { id: "c", spent_on: "2026-09-30", amount_cents: 25000 },
  ];
  const prox = [
    { spent_on: "2026-10-15", amount_cents: 5000, description: "Escola" },
    { spent_on: "2026-10-10", amount_cents: 30000, description: "Geladeira" },
  ];
  const r = resumoAPagar(pend, prox, "2026-09-30");
  eq(r.atrasadas.length, 2, "vencimento antes de hoje é atrasada");
  eq(r.atrasadasCents, 60000, "soma das atrasadas");
  eq(r.esteMes.length, 1, "a que vence hoje ainda não está atrasada");
  eq(r.esteMesCents, 25000, "soma das que vencem este mês");
  eq(r.proxima.description, "Geladeira", "próxima é a de vencimento mais cedo");
  eq(resumoAPagar([], null, "2026-09-30").proxima, null, "sem nada a pagar");
});

grupo("andamentoFixa", () => {
  eq(andamentoFixa({ pagas: 3, pendentes: 1, pendentes_cents: 30000, futuras: 6, futuras_cents: 180000 }),
    `3 de 10 pagas · falta ${fmtBRL(210000)}`, "falta = pendentes + futuras; de M = pagas + pendentes + futuras");
  eq(andamentoFixa({ pagas: 10, pendentes: 0, pendentes_cents: 0, futuras: 0, futuras_cents: 0 }),
    "10 de 10 pagas", "quitada não fala em falta");
  eq(andamentoFixa({ pagas: 5, pendentes: 1, pendentes_cents: 150000, futuras: null, futuras_cents: null }),
    `1 pendente · ${fmtBRL(150000)}`, "sem fim mostra só as pendentes");
  eq(andamentoFixa({ pagas: 5, pendentes: 0, pendentes_cents: 0, futuras: null, futuras_cents: null }),
    "", "sem fim em dia não diz nada");
});

// ---------------------------------------------------------------- planilha Excel
const { montaXLSX, despesasParaXLSX, crc32, serialData, celulaRef, zip } =
  await import("../js/xlsx.js");

/** Lê um ZIP "stored" e devolve { nome: conteudo } — valida a estrutura de verdade. */
function abreZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // acha o End Of Central Directory
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("EOCD não encontrado: não é um ZIP");
  const qtd = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const saida = {};
  const dec = new TextDecoder();
  for (let i = 0; i < qtd; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("cabeçalho central inválido");
    const crcEsperado = dv.getUint32(p + 16, true);
    const tam = dv.getUint32(p + 24, true);
    const nomeLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const comLen = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const nome = dec.decode(bytes.slice(p + 46, p + 46 + nomeLen));
    // vai ao cabeçalho local para extrair o conteúdo
    if (dv.getUint32(off, true) !== 0x04034b50) throw new Error("cabeçalho local inválido");
    const nomeLenL = dv.getUint16(off + 26, true);
    const extraLenL = dv.getUint16(off + 28, true);
    const ini = off + 30 + nomeLenL + extraLenL;
    const corpo = bytes.slice(ini, ini + tam);
    if (crc32(corpo) !== crcEsperado) throw new Error(`CRC não confere em ${nome}`);
    saida[nome] = dec.decode(corpo);
    p += 46 + nomeLen + extraLen + comLen;
  }
  return saida;
}

grupo("xlsx — ZIP e estrutura", () => {
  eq(crc32(new TextEncoder().encode("123456789")), 0xcbf43926, "CRC32 do vetor conhecido");
  eq(celulaRef(0, 0), "A1", "primeira célula");
  eq(celulaRef(1, 25), "Z2", "coluna Z");
  eq(celulaRef(0, 26), "AA1", "coluna AA");
  eq(celulaRef(0, 27), "AB1", "coluna AB");
  // Serial do Excel: base 1899-12-30. Conferido contra o calendário real.
  eq(serialData("2026-09-19"), 46284, "serial de 19/09/2026");
  eq(serialData("2026-01-01"), 46023, "virada de ano");
  eq(serialData("2024-02-29"), 45351, "29/02 de ano bissexto");
  eq(serialData("2026-09-19") - serialData("2026-09-18"), 1, "um dia = um ponto");
  eq(serialData("xx"), null, "data inválida");
  // Nota: para datas anteriores a 01/03/1900 o Excel tem o bug do ano bissexto
  // de 1900 e fica 1 à frente. Irrelevante para despesa, mas fica registrado.

  const z = zip([{ nome: "a.txt", conteudo: "olá" }, { nome: "b/c.xml", conteudo: "<x/>" }]);
  const lido = abreZip(z);
  eq(Object.keys(lido).length, 2, "dois arquivos no zip");
  eq(lido["a.txt"], "olá", "conteúdo com acento preservado");
  eq(lido["b/c.xml"], "<x/>", "arquivo em subpasta");
});

grupo("xlsx — planilha das despesas", () => {
  const bytes = despesasParaXLSX(DESP, CATS, FORMAS, new Date("2026-09-19T12:00:00Z"));
  ok(bytes instanceof Uint8Array && bytes.length > 500, "gera bytes");
  eq(bytes[0], 0x50, "assina PK");
  eq(bytes[1], 0x4b, "assina PK");

  const z = abreZip(bytes);
  for (const parte of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml",
    "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml"]) {
    ok(z[parte] !== undefined, `contém ${parte}`);
  }

  const sheet = z["xl/worksheets/sheet1.xml"];
  ok(sheet.includes("<t>Data</t>"), "cabeçalho Data");
  ok(sheet.includes("<t>Subcategoria</t>"), "coluna de subcategoria");
  ok(sheet.includes("state=\"frozen\""), "cabeçalho congelado");
  ok(sheet.includes("<autoFilter"), "filtro automático");
  // valor entra como NÚMERO (dá para somar), não como texto
  ok(sheet.includes("<v>1500</v>"), "aluguel como número 1500");
  ok(!sheet.includes("R$ 1.500,00"), "valor não vira texto formatado");
  // data entra como serial com estilo de data
  ok(sheet.includes(`s="2"><v>${serialData("2026-09-10")}`), "data como serial");
  // rollup: pai e filha em colunas separadas
  ok(sheet.includes("<t xml:space=\"preserve\">Alimentação</t>"), "categoria pai");
  ok(sheet.includes("<t xml:space=\"preserve\">Mercado</t>"), "subcategoria em coluna própria");
  // uma linha por despesa + cabeçalho
  eq((sheet.match(/<row /g) || []).length, DESP.length + 1, "linhas = despesas + cabeçalho");

  ok(z["xl/workbook.xml"].includes('name="Despesas"'), "aba nomeada");
  // texto perigoso não quebra o XML
  const perigo = despesasParaXLSX(
    [{ id: "x", spent_on: "2026-09-01", amount_cents: 100, category_id: "c2", description: 'a & b <c> "d"' }],
    CATS, FORMAS, new Date("2026-09-19T12:00:00Z"));
  const s2 = abreZip(perigo)["xl/worksheets/sheet1.xml"];
  ok(s2.includes("a &amp; b &lt;c&gt; &quot;d&quot;"), "escapa &, < > e aspas");
  // planilha vazia continua válida
  const vazia = abreZip(despesasParaXLSX([], CATS, FORMAS, new Date("2026-09-19T12:00:00Z")));
  ok(vazia["xl/worksheets/sheet1.xml"].includes("<t>Valor</t>"), "vazia mantém cabeçalho");
});

// ---------------------------------------------------------------- resultado
await Promise.all(pendentes);
console.log(`\n${total - falhas}/${total} verificações passaram.`);
if (falhas) {
  console.error(`${falhas} falha(s).`);
  process.exit(1);
}
console.log("Tudo certo.");
