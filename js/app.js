// Controlaí — app (vanilla ES modules, sem build).
// Rotas: #/ (home) · #/c/<uuid> (carteira) · #/recuperar (recuperar ID por e-mail)
import { db, auth, isConfigured, chegouDoEmail } from "./db.js";
import {
  el, clear, fmtBRL, fmtBRLCurto, parseAmountToCents, toast, confirmAction, copyText,
  hojeISO, mesDe, mesAdd, mesExtenso, dataExtenso, diasNoMes, variacaoPct, downloadText,
} from "./ui.js";
import {
  porCategoria, porFormaPagamento, porDia, totalCentavos, maioresDespesas, montaCSV,
} from "./report.js";

const root = () => document.getElementById("app");

const state = {
  ledgerId: null,
  mes: mesDe(hojeISO()),
  snapshot: null,
  loading: false,
  erro: null,
  tab: "mes", // mes | despesas | plano | ajustes
};

// veio do link do e-mail? precisa ser lido ANTES do supabase-js limpar a URL
const VEIO_DO_EMAIL = chegouDoEmail();

// ---------------------------------------------------------------------------
// Carteiras lembradas neste aparelho
// ---------------------------------------------------------------------------
const CHAVE_CARTEIRAS = "controlai:carteiras";

function carteirasLocais() {
  try {
    const raw = JSON.parse(localStorage.getItem(CHAVE_CARTEIRAS) || "[]");
    return Array.isArray(raw) ? raw.filter((c) => c && c.id) : [];
  } catch {
    return [];
  }
}

function lembrarCarteira(id, name) {
  try {
    const lista = carteirasLocais().filter((c) => c.id !== id);
    lista.unshift({ id, name: name || "Minhas despesas" });
    localStorage.setItem(CHAVE_CARTEIRAS, JSON.stringify(lista.slice(0, 8)));
  } catch { /* localStorage indisponível: segue sem lembrar */ }
}

function esquecerCarteira(id) {
  try {
    localStorage.setItem(CHAVE_CARTEIRAS, JSON.stringify(carteirasLocais().filter((c) => c.id !== id)));
  } catch { /* ignora */ }
}

// ---------------------------------------------------------------------------
// Roteamento
// ---------------------------------------------------------------------------
function parseRoute() {
  const h = location.hash.replace(/^#/, "");
  const m = h.match(/^\/c\/([0-9a-f-]{36})/i);
  if (m) return { name: "carteira", id: m[1] };
  if (h.startsWith("/recuperar")) return { name: "recuperar" };
  return { name: "home" };
}

async function router() {
  const r = parseRoute();
  if (r.name === "carteira") {
    if (state.ledgerId !== r.id) {
      state.ledgerId = r.id;
      state.snapshot = null;
      state.mes = mesDe(hojeISO());
      state.tab = "mes";
    }
    await carregar();
  } else {
    state.ledgerId = null;
    state.snapshot = null;
    render();
    db.track("pageview", r.name);
  }
}

async function carregar() {
  state.loading = true;
  state.erro = null;
  render();
  try {
    state.snapshot = await db.mes(state.ledgerId, state.mes);
    lembrarCarteira(state.ledgerId, state.snapshot?.ledger?.name);
    db.track("pageview", "carteira");
  } catch (e) {
    state.snapshot = null;
    state.erro = e.message;
  } finally {
    state.loading = false;
    render();
  }
}

async function recarregar() {
  try {
    state.snapshot = await db.mes(state.ledgerId, state.mes);
  } catch (e) {
    toast(e.message, "error");
  }
  render();
}

function irParaMes(novoMes) {
  state.mes = novoMes;
  recarregar();
}

// ---------------------------------------------------------------------------
// Render principal
// ---------------------------------------------------------------------------
function render() {
  if (!isConfigured) return renderNaoConfigurado();
  const r = parseRoute();
  if (r.name === "recuperar") return renderRecuperar();
  if (r.name === "home") return renderHome();
  if (state.loading && !state.snapshot) return renderCarregando();
  if (state.erro) return renderErro(state.erro);
  if (state.snapshot) return renderCarteira();
  return renderCarregando();
}

function shell(...children) {
  const app = root();
  clear(app);
  app.append(...children);
}

function header(subtitle) {
  return el("header", { class: "topbar" }, [
    el("a", { class: "brand", href: "#/" }, [
      el("img", { class: "brand__logo", src: "assets/logo.png", alt: "Controlaí", width: "28", height: "28" }),
      el("span", { class: "brand__name", text: "Controlaí" }),
    ]),
    subtitle ? el("span", { class: "topbar__sub", text: subtitle }) : null,
  ]);
}

function renderNaoConfigurado() {
  shell(header(), el("main", { class: "wrap" }, [
    el("div", { class: "card empty" }, [
      el("h2", { text: "App não configurado" }),
      el("p", { html: "Edite o arquivo <code>config.js</code> com a URL e a chave pública do seu projeto Supabase." }),
    ]),
  ]));
}

function renderCarregando() {
  shell(header(), el("main", { class: "wrap" }, [el("div", { class: "spinner" })]));
}

function renderErro(msg) {
  shell(header(), el("main", { class: "wrap" }, [
    el("div", { class: "card empty" }, [
      el("h2", { text: "Não consegui abrir esta carteira" }),
      el("p", { text: msg }),
      el("a", { class: "btn btn--primary", href: "#/recuperar", text: "Recuperar meu ID pelo e-mail" }),
      el("div", {}, [el("a", { class: "btn btn--ghost btn--block", href: "#/", text: "Voltar ao início" })]),
    ]),
  ]));
}

// ---------------------------------------------------------------------------
// HOME
// ---------------------------------------------------------------------------
function renderHome() {
  const locais = carteirasLocais();

  const nome = el("input", { class: "input", placeholder: "Ex.: Minhas despesas", maxlength: "80" });
  const email = el("input", { class: "input", type: "email", placeholder: "voce@email.com", inputmode: "email", autocomplete: "email" });
  const btn = el("button", { class: "btn btn--primary btn--lg", text: "Criar minha carteira" });

  const criar = async () => {
    const n = nome.value.trim();
    const e = email.value.trim();
    if (!e || !e.includes("@")) {
      toast("Informe um e-mail válido — é assim que você recupera seu ID depois.", "error");
      email.focus();
      return;
    }
    btn.disabled = true;
    btn.textContent = "Criando...";
    try {
      const res = await db.criar(n, e);
      lembrarCarteira(res.id, res.name);
      db.track("criar_carteira", "home");
      location.hash = `#/c/${res.id}`;
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
      btn.textContent = "Criar minha carteira";
    }
  };
  btn.addEventListener("click", criar);
  email.addEventListener("keydown", (ev) => { if (ev.key === "Enter") criar(); });

  shell(header(), el("main", { class: "wrap hero" }, [
    el("div", { class: "hero__pitch" }, [
      el("h1", { class: "hero__title", text: "Para onde foi seu dinheiro?" }),
      el("p", { class: "hero__sub", text: "Lance o gasto em segundos e veja, no fim do mês, quanto foi para cada categoria. Sem app para instalar, sem planilha." }),
      el("ol", { class: "hero__steps" }, [
        el("li", { text: "Crie sua carteira com seu e-mail." }),
        el("li", { text: "Lance a despesa: valor, data e categoria." }),
        el("li", { text: "Veja o mês fechado por categoria." }),
      ]),
    ]),

    el("div", { class: "card" }, [
      el("h2", { class: "sheet__title", text: "Criar carteira" }),
      el("label", { class: "label", text: "Nome (opcional)" }), nome,
      el("label", { class: "label", text: "Seu e-mail" }), email,
      el("p", { class: "small muted", style: "margin-top:6px", text: "Usamos só para você recuperar o ID da carteira se perder o link. Nada de spam." }),
      btn,
    ]),

    locais.length
      ? el("div", { class: "card" }, [
          el("h2", { class: "sheet__title", text: "Neste aparelho" }),
          el("ul", { class: "list", style: "margin-top:10px" }, locais.map((c) =>
            el("li", { class: "list__item" }, [
              el("a", { class: "list__name", href: `#/c/${c.id}`, style: "text-decoration:none;color:inherit;flex:1", text: c.name || "Minhas despesas" }),
              el("a", { class: "btn btn--ghost btn--sm", href: `#/c/${c.id}`, text: "Abrir" }),
            ])
          )),
        ])
      : null,

    el("div", { class: "card center" }, [
      el("p", { class: "small muted", style: "margin:0 0 10px", text: "Já tem uma carteira e perdeu o link?" }),
      el("a", { class: "btn btn--ghost", href: "#/recuperar", text: "Recuperar meu ID pelo e-mail" }),
    ]),
  ]));
}

// ---------------------------------------------------------------------------
// RECUPERAR ID
// ---------------------------------------------------------------------------
async function renderRecuperar() {
  const corpo = el("div", { class: "card" }, [el("div", { class: "spinner" })]);
  shell(header("Recuperar ID"), el("main", { class: "wrap" }, [corpo]));

  // Se voltou do link do e-mail (ou já tem sessão), lista as carteiras direto.
  let sessao = null;
  try { sessao = await auth.sessao(); } catch { sessao = null; }

  if (sessao) return renderMinhasCarteiras(sessao.user?.email || "");

  // Sem sessão: pede o e-mail.
  const email = el("input", { class: "input", type: "email", placeholder: "voce@email.com", inputmode: "email", autocomplete: "email" });
  const btn = el("button", { class: "btn btn--primary btn--lg", text: "Enviar link para meu e-mail" });

  const enviar = async () => {
    const e = email.value.trim();
    if (!e || !e.includes("@")) { toast("Informe um e-mail válido.", "error"); email.focus(); return; }
    btn.disabled = true;
    btn.textContent = "Enviando...";
    try {
      await auth.enviarLink(e);
      db.track("recuperar_enviar", "recuperar");
      renderConfirmarCodigo(e);
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
      btn.textContent = "Enviar link para meu e-mail";
    }
  };
  btn.addEventListener("click", enviar);
  email.addEventListener("keydown", (ev) => { if (ev.key === "Enter") enviar(); });

  clear(corpo);
  corpo.append(
    el("h2", { class: "sheet__title", text: "Recuperar meu ID" }),
    el("p", { class: "small muted", style: "margin:8px 0 0", text: "Enviamos um link (ou um código) para o e-mail que você cadastrou. Só quem abre esse e-mail consegue ver as carteiras — ninguém recupera o ID dos outros." }),
    el("label", { class: "label", text: "E-mail cadastrado" }), email,
    btn,
    el("a", { class: "btn btn--ghost btn--block", href: "#/", text: "Voltar" }),
  );
  if (VEIO_DO_EMAIL) toast("Link expirado ou já usado. Peça um novo.", "error");
}

function renderConfirmarCodigo(email) {
  const codigo = el("input", { class: "input input--code", inputmode: "numeric", maxlength: "8", placeholder: "000000", autocomplete: "one-time-code" });
  const btn = el("button", { class: "btn btn--primary btn--lg", text: "Confirmar código" });

  const confirmar = async () => {
    const c = codigo.value.trim();
    if (c.length < 6) { toast("Digite o código de 6 dígitos do e-mail.", "error"); return; }
    btn.disabled = true;
    btn.textContent = "Confirmando...";
    try {
      await auth.verificarCodigo(email, c);
      renderMinhasCarteiras(email);
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
      btn.textContent = "Confirmar código";
    }
  };
  btn.addEventListener("click", confirmar);
  codigo.addEventListener("keydown", (ev) => { if (ev.key === "Enter") confirmar(); });

  shell(header("Recuperar ID"), el("main", { class: "wrap" }, [
    el("div", { class: "card" }, [
      el("h2", { class: "sheet__title", text: "Confira seu e-mail 📬" }),
      el("p", { style: "margin:10px 0 0" }, [
        "Mandamos uma mensagem para ", el("b", { text: email }), ".",
      ]),
      el("p", { class: "small muted", style: "margin:8px 0 0", text: "Abra o link da mensagem para voltar já conectado. Se o e-mail trouxer um código de 6 dígitos, digite-o abaixo." }),
      el("label", { class: "label", text: "Código do e-mail (se houver)" }), codigo,
      btn,
      el("a", { class: "btn btn--ghost btn--block", href: "#/recuperar", text: "Usar outro e-mail" }),
    ]),
  ]));
}

async function renderMinhasCarteiras(email) {
  const corpo = el("div", { class: "card" }, [el("div", { class: "spinner" })]);
  shell(header("Minhas carteiras"), el("main", { class: "wrap" }, [corpo]));

  let lista = [];
  let erro = null;
  try {
    lista = (await auth.meusIds()) || [];
  } catch (e) {
    erro = e.message;
  }

  clear(corpo);
  corpo.append(el("h2", { class: "sheet__title", text: "Suas carteiras" }));
  if (email) corpo.append(el("p", { class: "small muted", style: "margin:6px 0 0", text: `E-mail confirmado: ${email}` }));

  if (erro) {
    corpo.append(el("p", { class: "small", style: "margin-top:12px", text: erro }));
  } else if (!lista.length) {
    corpo.append(
      el("p", { class: "muted", style: "margin-top:14px", text: "Nenhuma carteira registrada neste e-mail." }),
      el("a", { class: "btn btn--primary btn--block", href: "#/", text: "Criar uma carteira" }),
    );
  } else {
    corpo.append(el("ul", { class: "list", style: "margin-top:14px" }, lista.map((c) =>
      el("li", { class: "list__item" }, [
        el("div", { style: "flex:1;min-width:0" }, [
          el("div", { class: "list__name", text: c.name || "Minhas despesas" }),
          el("div", { class: "list__sub", text: `${c.despesas || 0} despesa(s) · criada em ${String(c.created_at || "").slice(0, 10).split("-").reverse().join("/")}` }),
        ]),
        el("a", {
          class: "btn btn--primary btn--sm",
          href: `#/c/${c.id}`,
          text: "Abrir",
          onClick: () => lembrarCarteira(c.id, c.name),
        }),
      ])
    )));
  }

  corpo.append(el("button", {
    class: "btn btn--ghost btn--block",
    text: "Sair desta confirmação",
    onClick: async () => { await auth.sair(); location.hash = "#/"; },
  }));
}

// ---------------------------------------------------------------------------
// CARTEIRA
// ---------------------------------------------------------------------------
function renderCarteira() {
  const s = state.snapshot;
  const conteudo =
    state.tab === "despesas" ? abaDespesas()
    : state.tab === "plano" ? abaPlano()
    : state.tab === "ajustes" ? abaAjustes()
    : abaMes();

  shell(
    header(s.ledger.name),
    el("main", { class: "wrap" }, [
      navegadorMes(),
      el("div", { class: "tabs" }, [
        tabBtn("mes", "Mês"),
        tabBtn("despesas", "Despesas"),
        tabBtn("plano", "Categorias"),
        tabBtn("ajustes", "Ajustes"),
      ]),
      conteudo,
    ]),
    el("button", { class: "fab", onClick: () => abrirFormDespesa(null) }, ["＋ Despesa"]),
  );
}

function tabBtn(key, label) {
  return el("button", {
    class: `tab ${state.tab === key ? "tab--active" : ""}`,
    text: label,
    onClick: () => { state.tab = key; render(); },
  });
}

function navegadorMes() {
  const s = state.snapshot;
  const mesAtual = mesDe(hojeISO());
  const proximo = mesAdd(state.mes, 1);
  return el("div", { class: "monthnav" }, [
    el("button", { class: "monthnav__btn", text: "‹", "aria-label": "Mês anterior", onClick: () => irParaMes(mesAdd(state.mes, -1)) }),
    el("div", { class: "monthnav__mid", onClick: () => irParaMes(mesAtual) }, [
      el("div", { class: "monthnav__label", text: mesExtenso(state.mes) }),
      el("div", { class: "monthnav__total", text: state.mes === mesAtual ? "mês atual" : "toque para voltar ao mês atual" }),
    ]),
    el("button", {
      class: "monthnav__btn",
      text: "›",
      "aria-label": "Próximo mês",
      disabled: proximo > mesAtual,
      onClick: () => irParaMes(proximo),
    }),
  ]);
}

// ---- aba MÊS ---------------------------------------------------------------
function abaMes() {
  const s = state.snapshot;
  const desp = s.expenses || [];
  const total = s.total_cents ?? totalCentavos(desp);
  const anterior = s.total_anterior ?? 0;

  if (!desp.length) {
    return el("div", {}, [
      cardTotal(total, anterior),
      el("div", { class: "card empty" }, [
        el("h2", { text: "Nenhuma despesa neste mês" }),
        el("p", { text: "Toque em “＋ Despesa” para lançar a primeira." }),
      ]),
    ]);
  }

  const cats = porCategoria(desp, s.categories || []);
  const formas = porFormaPagamento(desp, s.payment_methods || []);
  const maiores = maioresDespesas(desp, 5);
  const dias = diasNoMes(state.mes);
  const hoje = hojeISO();
  const diaAtual = mesDe(hoje) === state.mes ? Number(hoje.slice(8, 10)) : dias;
  const mediaDia = diaAtual > 0 ? Math.round(total / diaAtual) : 0;
  const projecao = mesDe(hoje) === state.mes ? mediaDia * dias : null;

  return el("div", {}, [
    cardTotal(total, anterior),

    el("div", { class: "kpis" }, [
      kpi(String(desp.length), desp.length === 1 ? "lançamento" : "lançamentos"),
      kpi(fmtBRLCurto(mediaDia), "por dia"),
      kpi(fmtBRLCurto(cats[0]?.cents || 0), `maior: ${cats[0]?.name || "-"}`),
      projecao != null ? kpi(fmtBRLCurto(projecao), "projeção do mês") : kpi(fmtBRLCurto(Math.max(...desp.map((d) => d.amount_cents))), "maior despesa"),
    ]),

    el("h3", { class: "section", text: "Onde foi o dinheiro" }),
    donutCard(cats, total),

    el("ul", { class: "catlist", style: "margin-top:12px" }, cats.map((c) => linhaCategoria(c, cats[0].cents))),

    formas.length > 1 ? el("h3", { class: "section", text: "Por forma de pagamento" }) : null,
    formas.length > 1
      ? el("div", { class: "card" }, formas.map((f) =>
          el("div", { style: "display:flex;gap:8px;padding:6px 0;font-size:14px" }, [
            el("span", { style: "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap", text: f.name }),
            el("b", { text: fmtBRL(f.cents) }),
            el("span", { class: "muted small", style: "width:44px;text-align:right", text: `${f.pct.toFixed(0)}%` }),
          ])
        ))
      : null,

    el("h3", { class: "section", text: "Maiores despesas" }),
    el("ul", { class: "list" }, maiores.map((d) => {
      const cat = (s.categories || []).find((c) => c.id === d.category_id);
      return el("li", { class: "list__item" }, [
        el("span", { class: "exp__dot", style: `background:${cat?.color || "#9ca3af"}` }),
        el("div", { style: "flex:1;min-width:0" }, [
          el("div", { class: "list__name", text: d.description || cat?.name || "Despesa" }),
          el("div", { class: "list__sub", text: `${dataExtenso(d.spent_on)} · ${cat?.name || "Sem categoria"}` }),
        ]),
        el("b", { text: fmtBRL(d.amount_cents) }),
      ]);
    })),
  ]);
}

function cardTotal(total, anterior) {
  const varPct = variacaoPct(total, anterior);
  let cmp = null;
  if (varPct == null) {
    cmp = anterior > 0 ? null : "Primeiro mês com lançamentos.";
  } else if (Math.abs(varPct) < 1) {
    cmp = `Praticamente igual ao mês anterior (${fmtBRL(anterior)}).`;
  } else {
    const dir = varPct > 0 ? "a mais" : "a menos";
    cmp = `${Math.abs(varPct).toFixed(0)}% ${dir} que o mês anterior (${fmtBRL(anterior)}).`;
  }
  return el("div", { class: "total" }, [
    el("div", { class: "total__label", text: `Total de ${mesExtenso(state.mes)}` }),
    el("div", { class: "total__value", text: fmtBRL(total) }),
    cmp ? el("div", { class: "total__cmp", text: cmp }) : null,
  ]);
}

function kpi(value, label) {
  return el("div", { class: "kpi" }, [
    el("div", { class: "kpi__value", text: value }),
    el("div", { class: "kpi__label", text: label }),
  ]);
}

function donutCard(cats, total) {
  const C = 2 * Math.PI * 78;
  let acc = 0;
  let segs = "";
  for (const c of cats) {
    const len = total > 0 ? (c.cents / total) * C : 0;
    segs += `<circle cx="100" cy="100" r="78" fill="none" stroke="${c.color}" stroke-width="30" `
      + `stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-acc).toFixed(2)}"></circle>`;
    acc += len;
  }
  const svg = el("div", { class: "donut" });
  svg.innerHTML =
    `<svg viewBox="0 0 200 200" role="img" aria-label="Gastos por categoria">
       <circle cx="100" cy="100" r="78" fill="none" stroke="#eceef1" stroke-width="30"></circle>
       <g transform="rotate(-90 100 100)">${segs}</g>
       <text x="100" y="94" text-anchor="middle" class="donut__total">${fmtBRLCurto(total)}</text>
       <text x="100" y="114" text-anchor="middle" class="donut__cap">no mês</text>
     </svg>`;

  const legend = el("ul", { class: "legend" }, cats.slice(0, 6).map((c) =>
    el("li", { class: "legend__item" }, [
      el("span", { class: "legend__dot", style: `background:${c.color}` }),
      el("span", { class: "legend__name", text: c.name }),
      el("span", { class: "legend__val", text: `${fmtBRL(c.cents)} · ${c.pct.toFixed(0)}%` }),
    ])
  ));

  return el("div", { class: "card donutcard" }, [svg, legend]);
}

function linhaCategoria(c, maiorValor) {
  const largura = maiorValor > 0 ? Math.max(2, (c.cents / maiorValor) * 100) : 0;
  return el("li", { class: "catrow" }, [
    el("div", { class: "catrow__top" }, [
      el("span", { class: "catrow__dot", style: `background:${c.color}` }),
      el("span", { class: "catrow__name", text: c.name }),
      el("span", { class: "catrow__amount", text: fmtBRL(c.cents) }),
    ]),
    el("div", { class: "catrow__track" }, [
      el("div", { class: "catrow__fill", style: `width:${largura.toFixed(1)}%;background:${c.color}` }),
    ]),
    el("div", { class: "catrow__meta" }, [
      el("span", { text: `${c.pct.toFixed(1).replace(".", ",")}% do mês` }),
      el("span", { text: `${c.count} lançamento${c.count === 1 ? "" : "s"}` }),
    ]),
    c.subs.length
      ? el("ul", { class: "catrow__sub" }, c.subs.map((sb) =>
          el("li", { class: "catrow__subitem" }, [
            el("b", { text: sb.name }),
            el("span", { text: fmtBRL(sb.cents) }),
          ])
        ))
      : null,
  ]);
}

// ---- aba DESPESAS ----------------------------------------------------------
function abaDespesas() {
  const s = state.snapshot;
  const desp = s.expenses || [];
  if (!desp.length) {
    return el("div", { class: "card empty" }, [
      el("h2", { text: "Nenhuma despesa neste mês" }),
      el("p", { text: "Toque em “＋ Despesa” para lançar a primeira." }),
    ]);
  }
  const cats = new Map((s.categories || []).map((c) => [c.id, c]));
  const formas = new Map((s.payment_methods || []).map((f) => [f.id, f]));

  return el("div", {}, porDia(desp).map((g) =>
    el("section", { class: "daygroup" }, [
      el("div", { class: "daygroup__head" }, [
        el("span", { class: "daygroup__day", text: dataExtenso(g.dia) }),
        el("span", { class: "daygroup__sum", text: fmtBRL(g.cents) }),
      ]),
      ...g.itens.map((d) => {
        const cat = cats.get(d.category_id);
        const pai = cat?.parent_id ? cats.get(cat.parent_id) : null;
        const nomeCat = cat ? (pai ? `${pai.name} › ${cat.name}` : cat.name) : "Sem categoria";
        const forma = d.payment_method_id ? formas.get(d.payment_method_id)?.name : null;
        return el("div", { class: "exp" }, [
          el("span", { class: "exp__dot", style: `background:${(pai || cat)?.color || "#9ca3af"}` }),
          el("div", { class: "exp__main", onClick: () => abrirFormDespesa(d) }, [
            el("div", { class: "exp__desc", text: d.description || nomeCat }),
            el("div", { class: "exp__meta", text: d.description ? `${nomeCat}${forma ? ` · ${forma}` : ""}` : (forma || "sem forma de pagamento") }),
          ]),
          el("div", { class: "exp__right" }, [
            el("span", { class: "exp__amount", text: fmtBRL(d.amount_cents) }),
            el("button", { class: "iconbtn", text: "✏️", title: "Editar", onClick: () => abrirFormDespesa(d) }),
          ]),
        ]);
      }),
    ])
  ));
}

// ---- formulário de despesa -------------------------------------------------
function abrirFormDespesa(despesa) {
  const s = state.snapshot;
  const editando = !!despesa;
  const cats = (s.categories || []).filter((c) => !c.archived || c.id === despesa?.category_id);
  const pais = cats.filter((c) => !c.parent_id);
  const formas = (s.payment_methods || []).filter((f) => !f.archived || f.id === despesa?.payment_method_id);

  const catInicial = cats.find((c) => c.id === despesa?.category_id) || null;
  let paiSel = catInicial ? (catInicial.parent_id || catInicial.id) : null;
  let catSel = catInicial ? catInicial.id : null;
  let formaSel = despesa?.payment_method_id || null;

  const valor = el("input", { class: "input input--amount", inputmode: "decimal", placeholder: "0,00",
    value: despesa ? (despesa.amount_cents / 100).toFixed(2).replace(".", ",") : "" });
  const data = el("input", { class: "input", type: "date", value: despesa?.spent_on || hojeISO(), max: hojeISO() });
  const descricao = el("input", { class: "input", maxlength: "140", placeholder: "Ex.: mercado da esquina", value: despesa?.description || "" });

  const chipsSub = el("div", { class: "chips" });
  const chipsCat = el("div", { class: "chips" });
  const chipsForma = el("div", { class: "chips" });

  function desenhaCategorias() {
    clear(chipsCat);
    for (const c of pais) {
      const on = paiSel === c.id;
      chipsCat.append(el("button", { class: `chip ${on ? "chip--on" : ""}`, type: "button",
        onClick: () => { paiSel = c.id; catSel = c.id; desenhaCategorias(); desenhaSubs(); } }, [
        el("span", { class: "chip__dot", style: `background:${c.color}` }),
        c.name,
      ]));
    }
    chipsCat.append(el("button", { class: "chip chip--add", type: "button", text: "＋ nova",
      onClick: () => { fechar(); state.tab = "plano"; render(); toast("Cadastre a categoria e lance a despesa em seguida."); } }));
  }

  function desenhaSubs() {
    clear(chipsSub);
    const filhas = cats.filter((c) => c.parent_id === paiSel);
    if (!paiSel || !filhas.length) { chipsSub.style.display = "none"; return; }
    chipsSub.style.display = "";
    chipsSub.append(el("button", { class: `chip ${catSel === paiSel ? "chip--on" : ""}`, type: "button", text: "geral",
      onClick: () => { catSel = paiSel; desenhaSubs(); } }));
    for (const f of filhas) {
      chipsSub.append(el("button", { class: `chip ${catSel === f.id ? "chip--on" : ""}`, type: "button", text: f.name,
        onClick: () => { catSel = f.id; desenhaSubs(); } }));
    }
  }

  function desenhaFormas() {
    clear(chipsForma);
    chipsForma.append(el("button", { class: `chip ${!formaSel ? "chip--on" : ""}`, type: "button", text: "não informar",
      onClick: () => { formaSel = null; desenhaFormas(); } }));
    for (const f of formas) {
      chipsForma.append(el("button", { class: `chip ${formaSel === f.id ? "chip--on" : ""}`, type: "button", text: f.name,
        onClick: () => { formaSel = f.id; desenhaFormas(); } }));
    }
  }

  desenhaCategorias();
  desenhaSubs();
  desenhaFormas();

  const btnSalvar = el("button", { class: "btn btn--primary btn--lg", text: editando ? "Salvar" : "Lançar despesa" });

  const salvar = async () => {
    const cents = parseAmountToCents(valor.value);
    if (!cents) { toast("Informe um valor maior que zero.", "error"); valor.focus(); return; }
    if (!catSel) { toast("Escolha uma categoria.", "error"); return; }
    if (!data.value) { toast("Informe a data.", "error"); return; }
    btnSalvar.disabled = true;
    btnSalvar.textContent = "Salvando...";
    try {
      if (editando) {
        await db.updateDespesa(state.ledgerId, despesa.id, data.value, cents, catSel, formaSel, descricao.value);
      } else {
        await db.addDespesa(state.ledgerId, data.value, cents, catSel, formaSel, descricao.value);
        db.track("lancar_despesa", "carteira");
      }
      fechar();
      // lançou em outro mês? vai junto, senão a despesa "some" da tela
      const mesDaDespesa = mesDe(data.value);
      if (mesDaDespesa !== state.mes) state.mes = mesDaDespesa;
      await recarregar();
      toast(editando ? "Despesa atualizada." : "Despesa lançada.", "success");
    } catch (err) {
      toast(err.message, "error");
      btnSalvar.disabled = false;
      btnSalvar.textContent = editando ? "Salvar" : "Lançar despesa";
    }
  };
  btnSalvar.addEventListener("click", salvar);
  valor.addEventListener("keydown", (ev) => { if (ev.key === "Enter") salvar(); });

  const corpo = el("div", {}, [
    el("label", { class: "label", text: "Valor" }), valor,
    el("label", { class: "label", text: "Data" }), data,
    el("label", { class: "label", text: "Categoria" }), chipsCat, chipsSub,
    el("label", { class: "label", text: "Forma de pagamento (opcional)" }), chipsForma,
    el("label", { class: "label", text: "Descrição (opcional)" }), descricao,
    btnSalvar,
    editando
      ? el("button", {
          class: "btn btn--danger btn--block",
          text: "Excluir despesa",
          onClick: async () => {
            if (!confirmAction("Excluir esta despesa?")) return;
            try {
              await db.delDespesa(state.ledgerId, despesa.id);
              fechar();
              await recarregar();
              toast("Despesa excluída.", "success");
            } catch (err) { toast(err.message, "error"); }
          },
        })
      : null,
  ]);

  const { close } = openModal(editando ? "Editar despesa" : "Nova despesa", corpo);
  const fechar = close;
  setTimeout(() => valor.focus(), 60);
}

// ---- aba CATEGORIAS (plano de contas) --------------------------------------
function abaPlano() {
  const s = state.snapshot;
  const cats = s.categories || [];
  const pais = cats.filter((c) => !c.parent_id);
  const novo = el("input", { class: "input", placeholder: "Nova categoria", maxlength: "40" });

  const criar = async () => {
    const nome = novo.value.trim();
    if (!nome) return;
    try {
      await db.addCategoria(state.ledgerId, nome, null, corDisponivel(cats));
      novo.value = "";
      await recarregar();
      toast("Categoria criada.", "success");
    } catch (e) { toast(e.message, "error"); }
  };
  novo.addEventListener("keydown", (ev) => { if (ev.key === "Enter") criar(); });

  const linhas = [];
  for (const p of pais) {
    linhas.push(itemCategoria(p, false));
    for (const f of cats.filter((c) => c.parent_id === p.id)) linhas.push(itemCategoria(f, true));
  }

  return el("div", {}, [
    el("div", { class: "card" }, [
      el("h3", { class: "sheet__title", text: "Plano de contas" }),
      el("p", { class: "small muted", style: "margin:6px 0 12px", text: "Categorias organizam o relatório do mês. Você pode criar subcategorias dentro de cada uma (ex.: Alimentação › Restaurante)." }),
      el("div", { class: "addrow" }, [novo, el("button", { class: "btn btn--primary", text: "Criar", onClick: criar })]),
      el("ul", { class: "list" }, linhas),
    ]),
    cardFormas(),
  ]);
}

function itemCategoria(c, filha) {
  return el("li", { class: `list__item ${filha ? "list__item--child" : ""}` }, [
    el("span", { class: "catrow__dot", style: `background:${c.color}` }),
    el("div", { style: "flex:1;min-width:0" }, [
      el("div", { class: "list__name", text: c.name }),
      c.archived ? el("span", { class: "badge badge--off", text: "arquivada" }) : null,
    ]),
    el("div", { class: "list__actions" }, [
      !filha
        ? el("button", { class: "iconbtn", text: "➕", title: "Nova subcategoria", onClick: () => abrirFormSubcategoria(c) })
        : null,
      el("button", { class: "iconbtn", text: "✏️", title: "Editar", onClick: () => abrirFormCategoria(c) }),
      el("button", {
        class: "iconbtn", text: "🗑️", title: "Excluir",
        onClick: async () => {
          if (!confirmAction(`Excluir a categoria "${c.name}"?`)) return;
          try {
            await db.delCategoria(state.ledgerId, c.id);
            await recarregar();
            toast("Categoria excluída.", "success");
          } catch (e) { toast(e.message, "error"); }
        },
      }),
    ]),
  ]);
}

function abrirFormCategoria(c) {
  const nome = el("input", { class: "input", value: c.name, maxlength: "40" });
  const cor = el("input", { class: "input", type: "color", value: c.color, style: "height:46px;padding:4px" });
  const arquivada = el("input", { type: "checkbox", checked: c.archived });

  const corpo = el("div", {}, [
    el("label", { class: "label", text: "Nome" }), nome,
    el("label", { class: "label", text: "Cor" }), cor,
    el("label", { class: "choice", style: "margin-top:12px" }, [arquivada, "Arquivar (some do formulário, histórico continua)"]),
    el("button", {
      class: "btn btn--primary btn--lg", text: "Salvar",
      onClick: async () => {
        try {
          await db.updateCategoria(state.ledgerId, c.id, nome.value, cor.value, arquivada.checked);
          close();
          await recarregar();
          toast("Categoria atualizada.", "success");
        } catch (e) { toast(e.message, "error"); }
      },
    }),
  ]);
  const { close } = openModal("Editar categoria", corpo);
}

function abrirFormSubcategoria(pai) {
  const nome = el("input", { class: "input", placeholder: `Ex.: dentro de ${pai.name}`, maxlength: "40" });
  const corpo = el("div", {}, [
    el("label", { class: "label", text: `Nova subcategoria de ${pai.name}` }), nome,
    el("button", {
      class: "btn btn--primary btn--lg", text: "Criar",
      onClick: async () => {
        if (!nome.value.trim()) { toast("Dê um nome.", "error"); return; }
        try {
          await db.addCategoria(state.ledgerId, nome.value, pai.id, pai.color);
          close();
          await recarregar();
          toast("Subcategoria criada.", "success");
        } catch (e) { toast(e.message, "error"); }
      },
    }),
  ]);
  const { close } = openModal("Nova subcategoria", corpo);
  setTimeout(() => nome.focus(), 60);
}

function cardFormas() {
  const s = state.snapshot;
  const formas = s.payment_methods || [];
  const novo = el("input", { class: "input", placeholder: "Nova forma de pagamento", maxlength: "40" });

  const criar = async () => {
    const nome = novo.value.trim();
    if (!nome) return;
    try {
      await db.addForma(state.ledgerId, nome);
      novo.value = "";
      await recarregar();
      toast("Forma de pagamento criada.", "success");
    } catch (e) { toast(e.message, "error"); }
  };
  novo.addEventListener("keydown", (ev) => { if (ev.key === "Enter") criar(); });

  return el("div", { class: "card" }, [
    el("h3", { class: "sheet__title", text: "Formas de pagamento" }),
    el("p", { class: "small muted", style: "margin:6px 0 12px", text: "Informar a forma é opcional em cada despesa — serve para você ver quanto passou no cartão, no Pix, etc." }),
    el("div", { class: "addrow" }, [novo, el("button", { class: "btn btn--primary", text: "Criar", onClick: criar })]),
    el("ul", { class: "list" }, formas.map((f) =>
      el("li", { class: "list__item" }, [
        el("div", { style: "flex:1;min-width:0" }, [
          el("span", { class: "list__name", text: f.name }),
          f.archived ? el("span", { class: "badge badge--off", text: "arquivada" }) : null,
        ]),
        el("div", { class: "list__actions" }, [
          el("button", { class: "iconbtn", text: "✏️", title: "Renomear", onClick: () => abrirFormForma(f) }),
          el("button", {
            class: "iconbtn", text: "🗑️", title: "Excluir",
            onClick: async () => {
              if (!confirmAction(`Excluir "${f.name}"? As despesas ficam sem forma de pagamento.`)) return;
              try {
                await db.delForma(state.ledgerId, f.id);
                await recarregar();
                toast("Forma removida.", "success");
              } catch (e) { toast(e.message, "error"); }
            },
          }),
        ]),
      ])
    )),
  ]);
}

function abrirFormForma(f) {
  const nome = el("input", { class: "input", value: f.name, maxlength: "40" });
  const arquivada = el("input", { type: "checkbox", checked: f.archived });
  const corpo = el("div", {}, [
    el("label", { class: "label", text: "Nome" }), nome,
    el("label", { class: "choice", style: "margin-top:12px" }, [arquivada, "Arquivar"]),
    el("button", {
      class: "btn btn--primary btn--lg", text: "Salvar",
      onClick: async () => {
        try {
          await db.updateForma(state.ledgerId, f.id, nome.value, arquivada.checked);
          close();
          await recarregar();
          toast("Atualizado.", "success");
        } catch (e) { toast(e.message, "error"); }
      },
    }),
  ]);
  const { close } = openModal("Editar forma de pagamento", corpo);
}

// ---- aba AJUSTES -----------------------------------------------------------
function abaAjustes() {
  const s = state.snapshot;
  const link = `${location.origin}${location.pathname}#/c/${s.ledger.id}`;

  const nome = el("input", { class: "input", value: s.ledger.name, maxlength: "80" });
  const email = el("input", { class: "input", type: "email", value: s.ledger.email, inputmode: "email" });

  return el("div", {}, [
    el("div", { class: "card" }, [
      el("h3", { class: "sheet__title", text: "Seu ID de acesso" }),
      el("p", { class: "small muted", style: "margin:6px 0 0", text: "Guarde este link: quem tem ele abre a carteira. Se perder, recupere pelo e-mail cadastrado." }),
      el("div", { class: "idbox" }, [el("code", { text: s.ledger.id })]),
      el("div", { class: "row2" }, [
        el("button", { class: "btn btn--primary", text: "Copiar link", onClick: async () => {
          toast((await copyText(link)) ? "Link copiado." : "Não consegui copiar.", "success");
        } }),
        el("button", { class: "btn btn--ghost", text: "Copiar ID", onClick: async () => {
          toast((await copyText(s.ledger.id)) ? "ID copiado." : "Não consegui copiar.", "success");
        } }),
      ]),
    ]),

    el("div", { class: "card" }, [
      el("h3", { class: "sheet__title", text: "Carteira" }),
      el("label", { class: "label", text: "Nome" }), nome,
      el("label", { class: "label", text: "E-mail de recuperação" }), email,
      el("button", {
        class: "btn btn--primary btn--block", text: "Salvar",
        onClick: async () => {
          try {
            if (nome.value.trim() !== s.ledger.name) await db.renomear(state.ledgerId, nome.value);
            if (email.value.trim().toLowerCase() !== s.ledger.email) await db.setEmail(state.ledgerId, email.value);
            await recarregar();
            toast("Salvo.", "success");
          } catch (e) { toast(e.message, "error"); }
        },
      }),
    ]),

    el("div", { class: "card" }, [
      el("h3", { class: "sheet__title", text: "Exportar" }),
      el("p", { class: "small muted", style: "margin:6px 0 10px", text: "Baixa todas as despesas em CSV (abre no Excel e no Google Sheets)." }),
      el("button", {
        class: "btn btn--ghost btn--block", text: "Baixar CSV de tudo",
        onClick: async () => {
          try {
            const todas = await db.exportar(state.ledgerId);
            const csv = montaCSV(todas, s.categories, s.payment_methods);
            downloadText(`controlai-${s.ledger.name.replace(/\W+/g, "-").toLowerCase()}.csv`, csv);
            db.track("exportar_csv", "carteira");
          } catch (e) { toast(e.message, "error"); }
        },
      }),
    ]),

    el("div", { class: "card" }, [
      el("h3", { class: "sheet__title", text: "Neste aparelho" }),
      el("p", { class: "small muted", style: "margin:6px 0 10px", text: "Remove o atalho desta carteira só deste navegador. Os dados continuam no servidor e o link continua funcionando." }),
      el("button", {
        class: "btn btn--danger btn--block", text: "Remover atalho deste aparelho",
        onClick: () => {
          if (!confirmAction("Remover o atalho desta carteira deste aparelho?")) return;
          esquecerCarteira(state.ledgerId);
          location.hash = "#/";
        },
      }),
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const PALETA = ["#8b5cf6", "#ef4444", "#f97316", "#3b82f6", "#10b981", "#6366f1",
  "#ec4899", "#14b8a6", "#a855f7", "#eab308", "#06b6d4", "#84cc16"];

function corDisponivel(cats) {
  const usadas = new Set((cats || []).map((c) => c.color));
  return PALETA.find((c) => !usadas.has(c)) || PALETA[(cats?.length || 0) % PALETA.length];
}

function openModal(title, contentNode) {
  const overlay = el("div", { class: "overlay" });
  const close = () => { overlay.classList.remove("overlay--show"); setTimeout(() => overlay.remove(), 200); };
  const sheet = el("div", { class: "sheet" }, [
    el("div", { class: "sheet__head" }, [
      el("h2", { class: "sheet__title", text: title }),
      el("button", { class: "iconbtn", text: "✕", "aria-label": "Fechar", onClick: close }),
    ]),
    el("div", { class: "sheet__body" }, [contentNode]),
  ]);
  overlay.append(sheet);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.body.append(overlay);
  void overlay.offsetWidth;
  overlay.classList.add("overlay--show");
  return { close };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
window.addEventListener("hashchange", router);

if (VEIO_DO_EMAIL && !parseRoute().id) {
  // Voltou do link mágico do e-mail. O token vem no fragmento da URL e quem o
  // consome é o supabase-js, de forma assíncrona. Trocar a rota agora apagaria
  // o fragmento ANTES disso e a sessão nunca seria criada — por isso esperamos
  // a sessão resolver (o próprio supabase-js limpa o token da URL) e só então
  // mandamos para a tela de recuperação.
  renderCarregando();
  auth.sessao()
    .catch(() => null)
    .then(() => {
      history.replaceState(null, "", `${location.pathname}#/recuperar`);
      router();
    });
} else {
  router();
}
