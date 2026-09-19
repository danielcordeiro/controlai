// Testes das funções puras do Controlaí — dinheiro, datas/meses e agregação do mês.
// Sem dependência externa: `node tests/unit.mjs` (sai 0 se passar, 1 se falhar).

import {
  parseAmountToCents, fmtBRL, hojeISO, mesDe, mesAdd, mesExtenso, mesCurto,
  dataCurta, diasNoMes, variacaoPct, MAX_CENTAVOS,
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
const { porCategoria, porFormaPagamento, porDia, totalCentavos, maioresDespesas, montaCSV } =
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
console.log(`\n${total - falhas}/${total} verificações passaram.`);
if (falhas) {
  console.error(`${falhas} falha(s).`);
  process.exit(1);
}
console.log("Tudo certo.");
