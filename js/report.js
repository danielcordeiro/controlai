// Agregações do mês — funções PURAS (sem DOM, sem rede), exercitadas por tests/unit.mjs.
// Todas recebem a lista de despesas do mês já carregada pelo snapshot e devolvem
// linhas prontas para desenhar. Valores sempre em centavos inteiros.

export const SEM_CATEGORIA = { id: null, name: "Sem categoria", color: "#9ca3af" };
export const SEM_FORMA = { id: null, name: "Não informada" };

/** Soma simples das despesas, em centavos. */
export function totalCentavos(despesas) {
  return (despesas || []).reduce((s, d) => s + (d.amount_cents || 0), 0);
}

function pctDe(cents, total) {
  return total > 0 ? (cents * 100) / total : 0;
}

/**
 * Percentual INTEIRO para exibir, pelo método do maior resto: a soma das linhas
 * fecha exatamente 100. Arredondar cada linha isolada faria "100% + 1% = 101%".
 * Grava `pctExib` em cada linha (mutação local, as linhas acabaram de ser criadas).
 */
function distribuiPctExib(linhas, total) {
  if (!linhas.length || total <= 0) {
    linhas.forEach((l) => { l.pctExib = 0; });
    return linhas;
  }
  const brutos = linhas.map((l) => (l.cents * 100) / total);
  const baixo = brutos.map(Math.floor);
  let resto = 100 - baixo.reduce((a, b) => a + b, 0);
  // quem tem a maior parte fracionária leva os pontos que sobraram
  const ordem = brutos
    .map((b, i) => ({ i, frac: b - Math.floor(b) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const extra = new Array(linhas.length).fill(0);
  for (let k = 0; k < ordem.length && resto > 0; k++, resto--) extra[ordem[k].i] = 1;
  linhas.forEach((l, i) => { l.pctExib = baixo[i] + extra[i]; });
  return linhas;
}

/** Ordena por valor decrescente e, no empate, por nome (resultado estável). */
function porValorDepoisNome(a, b) {
  if (b.cents !== a.cents) return b.cents - a.cents;
  return String(a.name).localeCompare(String(b.name), "pt-BR");
}

/**
 * Gasto por categoria, com rollup de subcategoria no pai.
 *
 * Devolve: [{ id, name, color, cents, pct, count, subs: [{ id, name, cents, pct, count }] }]
 * ordenado por valor decrescente. `subs` só vem preenchido quando o valor do pai
 * se divide em mais de uma origem (subcategorias e/ou lançamentos direto no pai) —
 * uma categoria folha não ganha detalhamento redundante.
 * Despesa cuja categoria não existe mais cai em "Sem categoria" (nunca some do total).
 */
export function porCategoria(despesas, categorias) {
  const cats = categorias || [];
  const porId = new Map(cats.map((c) => [c.id, c]));

  // resolve o topo da hierarquia (pai de quem tem pai; ele mesmo caso contrário).
  const topoDe = (catId) => {
    const c = porId.get(catId);
    if (!c) return null;                               // categoria apagada
    if (!c.parent_id) return c;
    return porId.get(c.parent_id) || c;                // pai sumiu: vira topo
  };

  const grupos = new Map(); // topoId -> { cat, cents, count, origens: Map(origemId -> {name, cents, count}) }

  for (const d of despesas || []) {
    const cents = d.amount_cents || 0;
    const topo = topoDe(d.category_id) || SEM_CATEGORIA;
    const chave = topo.id;
    if (!grupos.has(chave)) grupos.set(chave, { cat: topo, cents: 0, count: 0, origens: new Map() });
    const g = grupos.get(chave);
    g.cents += cents;
    g.count += 1;

    // origem = a própria categoria lançada (subcategoria ou o pai direto)
    const propria = porId.get(d.category_id);
    const origemId = propria ? propria.id : SEM_CATEGORIA.id;
    const origemNome = propria
      ? (propria.parent_id ? propria.name : `${propria.name} (direto)`)
      : SEM_CATEGORIA.name;
    if (!g.origens.has(origemId)) g.origens.set(origemId, { id: origemId, name: origemNome, cents: 0, count: 0 });
    const o = g.origens.get(origemId);
    o.cents += cents;
    o.count += 1;
  }

  const total = totalCentavos(despesas);

  return distribuiPctExib([...grupos.values()]
    .map((g) => {
      // Detalha quando o valor vem de mais de uma origem OU quando a única
      // origem é uma subcategoria (senão a linha "Alimentação" esconderia que
      // tudo foi em "Restaurante"). Categoria folha não repete a si mesma.
      const origens = [...g.origens.values()];
      const soOPai = origens.length === 1 && origens[0].id === g.cat.id;
      const subs = soOPai
        ? []
        : origens.map((o) => ({ ...o, pct: pctDe(o.cents, g.cents) })).sort(porValorDepoisNome);
      return {
        id: g.cat.id,
        name: g.cat.name,
        color: g.cat.color || SEM_CATEGORIA.color,
        cents: g.cents,
        count: g.count,
        pct: pctDe(g.cents, total),
        subs,
      };
    })
    .sort(porValorDepoisNome), total);
}

/**
 * Gasto por forma de pagamento. Despesa sem forma (o campo é opcional) entra
 * numa linha "Não informada" — nunca é descartada.
 * Devolve: [{ id, name, cents, pct, count }] por valor decrescente.
 */
export function porFormaPagamento(despesas, formas) {
  const porId = new Map((formas || []).map((f) => [f.id, f]));
  const grupos = new Map();

  for (const d of despesas || []) {
    const f = d.payment_method_id ? porId.get(d.payment_method_id) : null;
    const id = f ? f.id : SEM_FORMA.id;
    const name = f ? f.name : SEM_FORMA.name;
    if (!grupos.has(id)) grupos.set(id, { id, name, cents: 0, count: 0 });
    const g = grupos.get(id);
    g.cents += d.amount_cents || 0;
    g.count += 1;
  }

  const total = totalCentavos(despesas);
  return distribuiPctExib(
    [...grupos.values()].map((g) => ({ ...g, pct: pctDe(g.cents, total) })).sort(porValorDepoisNome),
    total
  );
}

/**
 * Despesas agrupadas por dia, do mais recente para o mais antigo.
 * Devolve: [{ dia: "YYYY-MM-DD", cents, itens: [despesa] }]
 */
export function porDia(despesas) {
  const grupos = new Map();
  for (const d of despesas || []) {
    const dia = d.spent_on;
    if (!grupos.has(dia)) grupos.set(dia, { dia, cents: 0, itens: [] });
    const g = grupos.get(dia);
    g.cents += d.amount_cents || 0;
    g.itens.push(d);
  }
  const lista = [...grupos.values()].sort((a, b) => (a.dia < b.dia ? 1 : a.dia > b.dia ? -1 : 0));
  // dentro do dia, maior valor primeiro (o que pesou aparece no topo)
  for (const g of lista) g.itens.sort((a, b) => (b.amount_cents || 0) - (a.amount_cents || 0));
  return lista;
}

/** As N maiores despesas do período, da maior para a menor. */
export function maioresDespesas(despesas, n = 5) {
  return [...(despesas || [])]
    .sort((a, b) => (b.amount_cents || 0) - (a.amount_cents || 0))
    .slice(0, Math.max(0, n));
}

/** Monta o CSV do período (Excel/Sheets abrem direto; separador ponto e vírgula). */
export function montaCSV(despesas, categorias, formas) {
  const cat = new Map((categorias || []).map((c) => [c.id, c]));
  const forma = new Map((formas || []).map((f) => [f.id, f]));
  const nomeCat = (id) => {
    const c = cat.get(id);
    if (!c) return SEM_CATEGORIA.name;
    const pai = c.parent_id ? cat.get(c.parent_id) : null;
    return pai ? `${pai.name} > ${c.name}` : c.name;
  };
  const esc = (v) => {
    const s = String(v ?? "");
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const linhas = [["Data", "Descrição", "Categoria", "Forma de pagamento", "Valor"].join(";")];
  for (const d of [...(despesas || [])].sort((a, b) => (a.spent_on < b.spent_on ? -1 : 1))) {
    linhas.push([
      esc(d.spent_on),
      esc(d.description || ""),
      esc(nomeCat(d.category_id)),
      esc(d.payment_method_id ? (forma.get(d.payment_method_id)?.name || "") : ""),
      esc(((d.amount_cents || 0) / 100).toFixed(2).replace(".", ",")),
    ].join(";"));
  }
  return linhas.join("\n");
}
