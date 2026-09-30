// Controlaí — app (vanilla ES modules, sem build).
// Rotas: #/ (home) · #/c/<uuid> (carteira) · #/recuperar (recuperar ID por e-mail)
import { db, auth, isConfigured, chegouDoEmail, erroDoEmail } from "./db.js";
import {
  el, clear, fmtBRL, fmtBRLCurto, parseAmountToCents, toast, confirmAction, copyText,
  hojeISO, mesDe, mesAdd, mesExtenso, dataExtenso, dataCurta, variacaoPct,
  downloadText, downloadBytes, MAX_CENTAVOS, acaoUnica, limiteNavegacao, previaParcelas,
  limitesDataEdicao,
} from "./ui.js";
import {
  porCategoria, porFormaPagamento, porDia, totalCentavos, maioresDespesas, montaCSV,
  ritmoDoMes, resumoAPagar, andamentoFixa,
} from "./report.js";
import { despesasParaXLSX } from "./xlsx.js";

// Versão visível no rodapé de Ajustes: toda publicação muda, para dar para
// conferir no aparelho que a versão nova chegou.
const VERSAO = "1.3.0";

const root = () => document.getElementById("app");

const state = {
  ledgerId: null,
  mes: mesDe(hojeISO()),
  snapshot: null,
  loading: false,
  trocandoMes: false,
  novaCarteira: null,   // id da carteira recém-criada: mostra o link uma vez
  erro: null,
  tab: "mes", // mes | despesas | plano | ia | ajustes
};

// Veio do link do e-mail? Precisa ser lido ANTES de o supabase-js limpar a URL.
// É `let` porque a informação se consome: depois de usada uma vez, um logout
// voluntário não pode voltar a acusar "link expirado".
let veioDoEmail = chegouDoEmail();
const ERRO_DO_EMAIL = erroDoEmail();

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

/** Fecha qualquer folha/modal aberta — ela vive no body e sobreviveria à troca de tela. */
function fecharModais() {
  document.querySelectorAll(".overlay").forEach((o) => o.remove());
}

// A última resposta a chegar não pode vencer a última pedida (rede lenta, dois
// toques seguidos no ‹ ›). Cada carga leva um número; respostas velhas morrem.
let reqAtual = 0;

async function router() {
  fecharModais();
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
  const meu = ++reqAtual;
  const idPedido = state.ledgerId;
  state.loading = true;
  state.erro = null;
  render();
  try {
    const snap = await db.mes(idPedido, state.mes);
    if (meu !== reqAtual) return;            // chegou tarde: outra carga já mandou
    state.snapshot = snap;
    lembrarCarteira(snap?.ledger?.id || idPedido, snap?.ledger?.name);
    db.track("pageview", "carteira");
  } catch (e) {
    if (meu !== reqAtual) return;
    state.snapshot = null;
    state.erro = e.message;
  } finally {
    if (meu === reqAtual) {
      state.loading = false;
      render();
    }
  }
}

/**
 * Recarrega o snapshot. O mês só passa a valer se a resposta chegar: senão a
 * tela mostraria os números de um mês sob o título de outro.
 */
async function recarregar(mes = state.mes) {
  const meu = ++reqAtual;
  const idPedido = state.ledgerId;
  try {
    const snap = await db.mes(idPedido, mes);
    if (meu !== reqAtual) return;
    state.mes = mes;
    state.snapshot = snap;
  } catch (e) {
    if (meu !== reqAtual) return;
    toast(e.message, "error");
  }
  if (meu === reqAtual) render();
}

function irParaMes(novoMes) {
  state.trocandoMes = true;
  render();
  recarregar(novoMes).finally(() => { state.trocandoMes = false; render(); });
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

  const criar = acaoUnica(async () => {
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
      state.novaCarteira = res.id;   // a próxima tela entrega o link
      location.hash = `#/c/${res.id}`;
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
      btn.textContent = "Criar minha carteira";
    }
  });
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

  // A flag se consome AQUI, antes do retorno antecipado: se ela só baixasse no
  // caminho sem sessão, quem recuperasse e depois saísse veria "link expirado"
  // no acesso seguinte, sem link nenhum ter expirado.
  const veio = veioDoEmail;
  veioDoEmail = false;

  if (sessao) return renderMinhasCarteiras(sessao.user?.email || "");

  // Sem sessão: pede o e-mail.
  const email = el("input", { class: "input", type: "email", placeholder: "voce@email.com", inputmode: "email", autocomplete: "email" });
  const btn = el("button", { class: "btn btn--primary btn--lg", text: "Enviar link para meu e-mail" });

  const enviar = acaoUnica(async () => {
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
  });
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
  if (veio) toast(ERRO_DO_EMAIL || "Link expirado ou já usado. Peça um novo.", "error");
}

function renderConfirmarCodigo(email) {
  const codigo = el("input", { class: "input input--code", inputmode: "numeric", maxlength: "8", placeholder: "000000", autocomplete: "one-time-code" });
  const btn = el("button", { class: "btn btn--primary btn--lg", text: "Confirmar código" });

  const confirmar = acaoUnica(async () => {
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
  });
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
    : state.tab === "ia" ? abaIA()
    : state.tab === "ajustes" ? abaAjustes()
    : abaMes();

  if (state.novaCarteira && state.novaCarteira === state.ledgerId) {
    state.novaCarteira = null;
    setTimeout(() => abrirBoasVindas(), 120);
  }

  shell(
    header(s.ledger.name),
    el("main", { class: "wrap" }, [
      navegadorMes(),
      el("div", { class: "tabs", role: "tablist", "aria-label": "Seções da carteira" }, [
        tabBtn("mes", "Mês"),
        tabBtn("despesas", "Despesas"),
        tabBtn("plano", "Categorias"),
        tabBtn("ia", "IA"),
        tabBtn("ajustes", "Ajustes"),
      ]),
      conteudo,
    ]),
    el("button", { class: "fab", onClick: () => abrirFormDespesa(null) }, ["＋ Despesa"]),
  );
}

/**
 * Entrega o link logo depois de criar a carteira. Sem isto, a única cópia do id
 * ficava no localStorage: trocar de aparelho ou limpar o navegador perdia tudo,
 * e a pessoa nunca tinha visto um link para guardar.
 */
function abrirBoasVindas() {
  const s = state.snapshot;
  if (!s) return;
  const link = `${location.origin}${location.pathname}#/c/${s.ledger.id}`;

  const corpo = el("div", {}, [
    el("p", { style: "margin:4px 0 0" }, [
      "Tudo pronto. ", el("b", { text: "Este link é a chave da sua carteira" }),
      " — quem tiver ele entra. Guarde agora: salve nos favoritos ou mande para você mesmo.",
    ]),
    el("div", { class: "idbox" }, [el("code", { text: link })]),
    el("div", { class: "row2" }, [
      el("button", {
        class: "btn btn--primary", type: "button", text: "Copiar link",
        onClick: async () => toast((await copyText(link)) ? "Link copiado." : "Não consegui copiar.", "success"),
      }),
      navigator.share
        ? el("button", {
            class: "btn btn--ghost", type: "button", text: "Compartilhar",
            onClick: async () => {
              try { await navigator.share({ title: "Controlaí", text: "Minha carteira no Controlaí", url: link }); }
              catch { /* usuário cancelou */ }
            },
          })
        : el("button", {
            class: "btn btn--ghost", type: "button", text: "Copiar só o ID",
            onClick: async () => toast((await copyText(s.ledger.id)) ? "ID copiado." : "Não consegui copiar.", "success"),
          }),
    ]),
    el("p", { class: "small muted", style: "margin:14px 0 0" }, [
      "Perdeu o link? Dá para recuperar pelo e-mail ", el("b", { text: s.ledger.email }),
      " em “Recuperar meu ID”. Você pode trocar o e-mail depois, em Ajustes.",
    ]),
    // Confirma que a recuperação funciona de verdade ANTES de a pessoa precisar
    // dela: se o e-mail estiver errado ou não chegar, ela descobre agora.
    el("button", {
      class: "btn btn--ghost btn--block", type: "button",
      text: "Testar a recuperação (envia um e-mail)",
      onClick: async (ev) => {
        const b = ev.currentTarget;
        b.disabled = true;
        b.textContent = "Enviando...";
        try {
          await auth.enviarLink(s.ledger.email);
          b.textContent = "E-mail enviado ✓";
          toast(`Mandamos um link para ${s.ledger.email}. Se chegar, sua recuperação está funcionando.`, "success");
        } catch (err) {
          b.disabled = false;
          b.textContent = "Testar a recuperação (envia um e-mail)";
          toast(err.message, "error");
        }
      },
    }),
  ]);

  const { close } = openModal(
    "Carteira criada 🎉",
    corpo,
    el("button", { class: "btn btn--primary btn--lg", type: "button", text: "Já guardei, quero lançar", onClick: () => close() })
  );
}

function tabBtn(key, label) {
  const ativa = state.tab === key;
  return el("button", {
    class: `tab ${ativa ? "tab--active" : ""}`,
    text: label,
    type: "button",
    role: "tab",
    "aria-selected": ativa ? "true" : "false",
    onClick: () => { state.tab = key; render(); },
  });
}

/** O mês aberto ainda não chegou: a tela mostra o comprometido, não o gasto. */
const ehFuturo = () => state.mes > mesDe(hojeISO());

function navegadorMes() {
  const s = state.snapshot;
  const mesAtual = mesDe(hojeISO());
  const proximo = mesAdd(state.mes, 1);
  const legenda = state.trocandoMes ? "carregando..."
    : state.mes === mesAtual ? "mês atual"
    : state.mes > mesAtual ? "previsão · toque para voltar ao mês atual"
    : "toque para voltar ao mês atual";
  return el("div", { class: `monthnav ${state.trocandoMes ? "monthnav--carregando" : ""}` }, [
    el("button", {
      class: "monthnav__btn", text: "‹", "aria-label": "Mês anterior",
      disabled: state.trocandoMes,
      onClick: () => irParaMes(mesAdd(state.mes, -1)),
    }),
    el("div", { class: "monthnav__mid", onClick: () => irParaMes(mesAtual) }, [
      el("div", { class: "monthnav__label", text: mesExtenso(state.mes) }),
      el("div", { class: "monthnav__total", text: legenda }),
    ]),
    el("button", {
      class: "monthnav__btn",
      text: "›",
      "aria-label": "Próximo mês",
      // o futuro só vai até onde alguma série ainda tem ocorrência
      disabled: state.trocandoMes || proximo > limiteNavegacao(s.fixas, mesAtual),
      onClick: () => irParaMes(proximo),
    }),
  ]);
}

// ---- aba MÊS ---------------------------------------------------------------
/**
 * Card discreto de "me paga um café via Pix", no fim da aba Mês — depois de o
 * app já ter mostrado para onde foi o dinheiro, não antes. Opt-in: sem PIX no
 * config.js devolve null e nada aparece.
 */
function cardApoio() {
  const pix = (window.CONTROLAI_CONFIG || {}).PIX;
  const valor = pix && (pix.payload || pix.key);
  if (!valor) return null;

  const btn = el("button", {
    class: "btn btn--primary btn--sm", type: "button",
    text: pix.payload ? "💚 Pix copia e cola" : "💚 Copiar chave Pix",
    onClick: async () => {
      const ok = await copyText(valor);
      if (ok) db.track("apoio_copiar", "carteira");
      toast(ok ? "Pix copiado — é só colar no seu banco 💚" : "Não consegui copiar.", ok ? "success" : "error");
    },
  });

  return el("div", { class: "donate" }, [
    el("p", { class: "donate__title", text: "Curtiu o controlaí? ☕" }),
    el("p", { class: "donate__sub", text:
      "É grátis e sem anúncio. Se ajudou, me paga um café — qualquer valor ajuda a manter de pé." }),
    btn,
    pix.name ? el("p", { class: "donate__name muted small", text: pix.name }) : null,
  ]);
}

function abaMes() {
  const s = state.snapshot;
  // antes do "Nenhuma despesa": o mês futuro sem linha real ainda tem previstas
  if (ehFuturo()) return abaMesFuturo();
  const desp = s.expenses || [];
  const total = s.total_cents ?? totalCentavos(desp);
  const anterior = s.total_anterior ?? 0;
  const aPagar = totalCentavos(desp.filter((d) => d.a_pagar));

  if (!desp.length) {
    return el("div", {}, [
      cardTotal(total, anterior, aPagar),
      cardAPagar(),
      el("div", { class: "card empty" }, [
        el("h2", { text: "Nenhuma despesa neste mês" }),
        el("p", { text: "Toque em “＋ Despesa” para lançar a primeira." }),
      ]),
      cardApoio(),
    ]);
  }

  const cats = porCategoria(desp, s.categories || []);
  const formas = porFormaPagamento(desp, s.payment_methods || []);
  const maiores = maioresDespesas(desp, 5);
  const { mediaDia, projecao } = ritmoDoMes(desp, state.mes, hojeISO());

  return el("div", {}, [
    cardTotal(total, anterior, aPagar),
    cardAPagar(),

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
            el("span", { class: "muted small", style: "width:44px;text-align:right", text: `${f.pctExib}%` }),
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

    cardApoio(),
  ]);
}

/**
 * Mês futuro: nada aconteceu ainda, então não há "gastei" nem KPI. O card mostra
 * o que as séries já comprometem (previstas: calculadas, nunca gravadas) e, à
 * parte, o que já foi lançado de verdade no mês (a avulsa de amanhã, no dia 30).
 */
function abaMesFuturo() {
  const s = state.snapshot;
  const previstas = s.previstas || [];
  const reais = s.expenses || [];
  const todas = [...reais, ...previstas];
  const comprometido = totalCentavos(previstas);
  const aConfirmar = totalCentavos(previstas.filter((p) => p.a_pagar));
  const lancado = totalCentavos(reais);
  const cats = porCategoria(todas, s.categories || []);
  const catMap = new Map((s.categories || []).map((c) => [c.id, c]));
  const formas = new Map((s.payment_methods || []).map((f) => [f.id, f]));
  const hoje = hojeISO();

  return el("div", {}, [
    el("div", { class: "total total--futuro" }, [
      el("div", { class: "total__label", text: `Já comprometido em ${mesExtenso(state.mes)}` }),
      el("div", { class: "total__value", text: fmtBRL(comprometido) }),
      aConfirmar ? el("div", { class: "total__cmp", text: `${fmtBRL(aConfirmar)} a confirmar` }) : null,
      lancado ? el("div", { class: "total__cmp", text: `Já lançado ${fmtBRL(lancado)}` }) : null,
    ]),
    todas.length
      ? el("div", {}, [
          el("h3", { class: "section", text: "Para onde vai o dinheiro" }),
          donutCard(cats, comprometido + lancado),
          el("ul", { class: "catlist", style: "margin-top:12px" }, cats.map((c) => linhaCategoria(c, cats[0].cents))),
          el("h3", { class: "section", text: "Vencimentos" }),
          el("div", {}, [...todas].sort((a, b) => a.spent_on.localeCompare(b.spent_on))
            .map((d) => linhaDespesa(d, catMap, formas, hoje))),
        ])
      : vazioFuturo(),
  ]);
}

function vazioFuturo() {
  return el("div", { class: "card empty" }, [
    el("h2", { text: "Nada previsto para este mês" }),
    el("p", { text: "Parcelas e fixas aparecem aqui antes de o mês chegar." }),
  ]);
}

/**
 * Contas a pagar da carteira inteira, não só do mês aberto: a parcela atrasada
 * de agosto precisa aparecer em setembro. Some quando não há pendente nem série
 * ativa que peça confirmação.
 */
function cardAPagar() {
  const s = state.snapshot;
  const pendentes = s.pendentes || [];
  if (!pendentes.length && !(s.fixas || []).some((f) => f.confirmar && f.ativa)) return null;
  const hoje = hojeISO();
  const r = resumoAPagar(pendentes, s.proximas, hoje);
  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
  // o card é da carteira inteira: aberto num mês passado, "este mês" seria mentira
  const quando = state.mes === mesDe(hoje) ? "este mês" : `em ${mesExtenso(mesDe(hoje))}`;
  const linhas = [
    r.atrasadas.length
      ? el("div", { class: "apagar__atraso", text: `${plural(r.atrasadas.length, "atrasada", "atrasadas")} · ${fmtBRL(r.atrasadasCents)}` })
      : null,
    r.esteMes.length
      ? el("div", { text: `${plural(r.esteMes.length, "vence", "vencem")} ${quando} · ${fmtBRL(r.esteMesCents)}` })
      : null,
    r.proxima
      ? el("div", { class: "muted", text: `Próximo: ${nomeDe(r.proxima)} ${dataCurta(r.proxima.spent_on)} · ${fmtBRL(r.proxima.amount_cents)}` })
      : null,
  ].filter(Boolean);
  return el("button", { class: "apagar", type: "button", "aria-haspopup": "dialog", onClick: () => abrirContasAPagar() }, [
    el("span", { class: "apagar__head" }, [
      el("span", { class: "apagar__title", text: "A pagar" }),
      el("span", { class: "exp__chevron", "aria-hidden": "true", text: "›" }),
    ]),
    ...(linhas.length ? linhas : [el("div", { class: "muted", text: "Nada pendente agora." })]),
  ]);
}

/**
 * Folha "Contas a pagar". "Paguei" não tira a linha da lista: ela fica como
 * "paga · desfazer" até a folha fechar, para um toque errado ter volta. A tela
 * de trás recarrega em segundo plano a cada toque.
 */
function abrirContasAPagar() {
  const s = state.snapshot;
  const hoje = hojeISO();
  // o snapshot não repete a_pagar nas pendentes: todas são, por definição
  const pendentes = (s.pendentes || []).map((d) => ({ ...d, a_pagar: true }));
  const proximas = s.proximas || [];
  const series = (s.fixas || []).filter((f) => f.confirmar && (f.ativa || f.pendentes));
  // a série quitada agora continua na lista, como a linha paga: só os números mudam
  const idsSeries = new Set(series.map((f) => f.id));
  const andamento = el("ul", { class: "list" });
  function desenhaAndamento() {
    clear(andamento);
    andamento.append(...(state.snapshot?.fixas || []).filter((f) => idsSeries.has(f.id)).map((f) =>
      el("li", { class: "list__item" }, [
        el("div", { style: "flex:1;min-width:0" }, [
          el("div", { class: "list__name", text: nomeDe(f) }),
          el("div", { class: "list__sub", text: andamentoFixa(f) || "nada pendente" }),
        ]),
      ])));
  }
  desenhaAndamento();

  const info = (d) => el("div", { style: "flex:1;min-width:0" }, [
    el("div", { class: "list__name", text: nomeDe(d) }),
    el("div", { class: "list__sub" }, [
      ...tagsDespesa(d, hoje),
      `vence ${dataCurta(d.spent_on)} · ${fmtBRL(d.amount_cents)}`,
    ]),
  ]);

  function linhaPendente(d) {
    let paga = false;
    const acao = el("div", { class: "list__actions" });
    const li = el("li", { class: "list__item" }, [info(d), acao]);
    const alterna = acaoUnica(async () => {
      try {
        await db.marcarPago(state.ledgerId, d.id, !paga);
        paga = !paga;
        desenha();
        acao.querySelector("button")?.focus();   // o botão tocado acabou de ser trocado
        recarregar().then(desenhaAndamento);
      } catch (e) { toast(e.message, "error"); }
    });
    function desenha() {
      clear(acao);
      li.classList.toggle("list__item--paga", paga);
      acao.append(...(paga
        ? [el("span", { class: "small muted", text: "paga ·" }),
           el("button", { class: "btn btn--ghost btn--sm", type: "button", text: "desfazer",
             "aria-label": `Desfazer: ${nomeDe(d)} volta para a pagar`, onClick: alterna })]
        : [el("button", { class: "btn btn--primary btn--sm", type: "button", text: "Paguei",
             "aria-label": `Paguei ${nomeDe(d)}, ${fmtBRL(d.amount_cents)}`, onClick: alterna })]));
    }
    desenha();
    return li;
  }

  openModal("Contas a pagar", el("div", {}, [
    pendentes.length
      ? el("ul", { class: "list" }, pendentes.map(linhaPendente))
      : el("p", { class: "muted", style: "margin:4px 0 0", text: "Nenhuma conta pendente." }),
    proximas.length ? el("h3", { class: "section", text: "Próximo mês" }) : null,
    proximas.length
      ? el("ul", { class: "list" }, proximas.map((d) => el("li", { class: "list__item list__item--prevista" }, [info(d)])))
      : null,
    series.length ? el("h3", { class: "section", text: "Andamento" }) : null,
    series.length ? andamento : null,
  ]));
}

function cardTotal(total, anterior, aPagar) {
  const varPct = variacaoPct(total, anterior);
  let cmp = null;
  if (varPct == null) {
    // sem base de comparação: "primeiro mês" só se não houver NENHUM mês
    // anterior com gasto (um mês pulado no meio não é o primeiro)
    const meses = state.snapshot?.meses_com_gasto || [];
    const houveAntes = meses.some((m) => m < state.mes);
    cmp = houveAntes ? "Nada lançado no mês anterior." : "Primeiro mês com lançamentos.";
  } else if (Math.abs(varPct) < 1) {
    cmp = `Praticamente igual ao mês anterior (${fmtBRL(anterior)}).`;
  } else {
    const dir = varPct > 0 ? "a mais" : "a menos";
    cmp = `${Math.abs(varPct).toFixed(0)}% ${dir} que o mês anterior (${fmtBRL(anterior)}).`;
  }
  return el("div", { class: "total" }, [
    el("div", { class: "total__label", text: `Total de ${mesExtenso(state.mes)}` }),
    el("div", { class: "total__value", text: fmtBRL(total) }),
    // a parcela a pagar conta no mês do vencimento; a divisão só aparece se houver
    aPagar ? el("div", { class: "total__pago", text: `Pago ${fmtBRL(total - aPagar)} · A pagar ${fmtBRL(aPagar)}` }) : null,
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
      el("span", { class: "legend__val", text: `${fmtBRL(c.cents)} · ${c.pctExib}%` }),
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
      el("span", { text: `${c.pctExib}% do mês` }),
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
  // o ramo do futuro vem antes do "Nenhuma despesa": lá as previstas contam
  const futuro = ehFuturo();
  const desp = [...(s.expenses || []), ...(futuro ? s.previstas || [] : [])];
  if (!desp.length) {
    return futuro ? vazioFuturo() : el("div", { class: "card empty" }, [
      el("h2", { text: "Nenhuma despesa neste mês" }),
      el("p", { text: "Toque em “＋ Despesa” para lançar a primeira." }),
    ]);
  }
  const cats = new Map((s.categories || []).map((c) => [c.id, c]));
  const formas = new Map((s.payment_methods || []).map((f) => [f.id, f]));
  const hoje = hojeISO();

  return el("div", {}, porDia(desp).map((g) =>
    el("section", { class: "daygroup" }, [
      el("div", { class: "daygroup__head" }, [
        el("span", { class: "daygroup__day", text: dataExtenso(g.dia) }),
        el("span", { class: "daygroup__sum", text: fmtBRL(g.cents) }),
      ]),
      ...g.itens.map((d) => linhaDespesa(d, cats, formas, hoje)),
    ])
  ));
}

/** Selos da linha: parcela (3/10) ou fixa, e a situação (a pagar, atrasada, previsto). */
function tagsDespesa(d, hoje) {
  return [
    d.parcelas ? el("span", { class: "tag tag--fixa", text: `${d.parcela}/${d.parcelas}` })
      : d.recurring_id ? el("span", { class: "tag tag--fixa", text: "fixa" }) : null,
    d.prevista ? el("span", { class: "tag tag--previsto", text: "previsto" })
      : !d.a_pagar ? null
      : d.spent_on < hoje ? el("span", { class: "tag tag--atrasada", text: "atrasada" })
      : el("span", { class: "tag tag--apagar", text: "a pagar" }),
  ];
}

/** Uma despesa da lista. A prevista (mês futuro) é só leitura: não tem id para editar. */
function linhaDespesa(d, cats, formas, hoje) {
  const cat = cats.get(d.category_id);
  const pai = cat?.parent_id ? cats.get(cat.parent_id) : null;
  const nomeCat = cat ? (pai ? `${pai.name} › ${cat.name}` : cat.name) : "Sem categoria";
  const forma = d.payment_method_id ? formas.get(d.payment_method_id)?.name : null;
  const miolo = [
    el("span", { class: "exp__dot", style: `background:${(pai || cat)?.color || "#9ca3af"}` }),
    el("div", { class: "exp__main" }, [
      el("div", { class: "exp__desc", text: d.description || nomeCat }),
      el("div", { class: "exp__meta" }, [
        ...tagsDespesa(d, hoje),
        d.description ? `${nomeCat}${forma ? ` · ${forma}` : ""}` : (forma || "sem forma de pagamento"),
      ]),
    ]),
    el("span", { class: "exp__amount", text: fmtBRL(d.amount_cents) }),
  ];
  if (d.prevista) return el("div", { class: "exp exp--prevista" }, miolo);
  const situacao = !d.a_pagar ? "" : d.spent_on < hoje ? ", atrasada" : ", a pagar";
  // a linha INTEIRA é o alvo: no celular ninguém acerta um texto de 4 letras
  return el("button", {
    class: "exp", type: "button",
    "aria-label": `Editar ${d.description || nomeCat}, ${fmtBRL(d.amount_cents)}${situacao}`,
    onClick: () => abrirFormDespesa(d),
  }, [...miolo, el("span", { class: "exp__chevron", "aria-hidden": "true", text: "›" })]);
}

/** Nome para mostrar: a descrição ou, sem ela, a categoria. */
function nomeDe(d) {
  return d.description || (state.snapshot?.categories || []).find((c) => c.id === d.category_id)?.name || "Despesa";
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
  const hoje = hojeISO();
  const lim = despesa ? limitesDataEdicao(despesa, hoje) : { min: null, max: hoje };
  const data = el("input", { class: "input", type: "date", value: despesa?.spent_on || hoje,
    min: lim.min, max: lim.max });
  const descricao = el("input", { class: "input", maxlength: "140", placeholder: "Ex.: mercado da esquina", value: despesa?.description || "" });

  const chipsSub = el("div", { class: "chips" });
  const chipsCat = el("div", { class: "chips" });
  const chipsForma = el("div", { class: "chips" });

  function desenhaCategorias() {
    clear(chipsCat);
    for (const c of pais) {
      const on = paiSel === c.id;
      chipsCat.append(el("button", { class: `chip ${on ? "chip--on" : ""}`, type: "button",
        "aria-pressed": on ? "true" : "false",
        onClick: () => { paiSel = c.id; catSel = c.id; desenhaCategorias(); desenhaSubs(); } }, [
        el("span", { class: "chip__dot", style: `background:${c.color}` }),
        c.name,
      ]));
    }
    chipsCat.append(el("button", { class: "chip chip--add", type: "button", text: "＋ nova",
      onClick: () => criarCategoriaNoFormulario() }));
  }

  function desenhaSubs() {
    clear(chipsSub);
    const filhas = cats.filter((c) => c.parent_id === paiSel);
    if (!paiSel || !filhas.length) { chipsSub.style.display = "none"; return; }
    chipsSub.style.display = "";
    chipsSub.append(el("button", { class: `chip ${catSel === paiSel ? "chip--on" : ""}`, type: "button", text: "geral",
      "aria-pressed": catSel === paiSel ? "true" : "false",
      onClick: () => { catSel = paiSel; desenhaSubs(); } }));
    for (const f of filhas) {
      chipsSub.append(el("button", { class: `chip ${catSel === f.id ? "chip--on" : ""}`, type: "button", text: f.name,
        "aria-pressed": catSel === f.id ? "true" : "false",
        onClick: () => { catSel = f.id; desenhaSubs(); } }));
    }
  }

  function desenhaFormas() {
    clear(chipsForma);
    chipsForma.append(el("button", { class: `chip ${!formaSel ? "chip--on" : ""}`, type: "button", text: "não informar",
      "aria-pressed": !formaSel ? "true" : "false",
      onClick: () => { formaSel = null; desenhaFormas(); } }));
    for (const f of formas) {
      chipsForma.append(el("button", { class: `chip ${formaSel === f.id ? "chip--on" : ""}`, type: "button", text: f.name,
        "aria-pressed": formaSel === f.id ? "true" : "false",
        onClick: () => { formaSel = f.id; desenhaFormas(); } }));
    }
  }

  /** Cria a categoria numa folha POR CIMA do formulário e já a seleciona —
   *  fechar o formulário jogaria fora valor, data e descrição já digitados. */
  function criarCategoriaNoFormulario() {
    const nome = el("input", { class: "input", placeholder: "Ex.: Pet, Viagem, Presentes", maxlength: "40" });
    const salvarCat = acaoUnica(async () => {
      const texto = nome.value.trim();
      if (!texto) { toast("Dê um nome para a categoria.", "error"); nome.focus(); return; }
      try {
        const cor = corDisponivel(cats);
        const novoId = await db.addCategoria(state.ledgerId, texto, null, cor);
        const nova = { id: novoId, name: texto, color: cor, parent_id: null, archived: false };
        cats.push(nova);
        pais.push(nova);
        paiSel = novoId;
        catSel = novoId;
        fecharCat();
        desenhaCategorias();
        desenhaSubs();
        toast(`Categoria "${texto}" criada e escolhida.`, "success");
        recarregar();   // sincroniza o resto da tela em segundo plano
      } catch (e) { toast(e.message, "error"); }
    });
    nome.addEventListener("keydown", (ev) => { if (ev.key === "Enter") salvarCat(); });
    const { close: fecharCat } = openModal(
      "Nova categoria",
      el("div", {}, [campo("Nome da categoria", nome)]),
      el("button", { class: "btn btn--primary btn--lg", type: "button", text: "Criar e usar", onClick: salvarCat })
    );
  }

  // --- repetir ou parcelar (só ao criar; editar mexe na ocorrência, não na série)
  let repetir = false;
  let ehTotal = false;   // com N finito: o valor digitado é o total, e o servidor divide
  const previa = el("div", { class: "previa", "aria-live": "polite" });
  const chipsValorEh = el("div", { class: "chips", role: "group", "aria-label": "O valor digitado é" });
  const blocoParcelas = el("div", { style: "display:none" }, [
    el("div", { class: "small muted", style: "margin-top:10px", text: "O valor é:" }), chipsValorEh, previa,
  ]);
  const repeticoes = seletorRepeticoes(12, atualizaPrevia);
  const checkConfirmar = el("input", { type: "checkbox" });   // desmarcado (D7): cartão não confirma
  const blocoRepetir = el("div", { style: "display:none" });

  function atualizaPrevia() {
    const r = repeticoes.ler();
    const n = r.ok ? r.vezes : null;
    blocoParcelas.style.display = n ? "" : "none";
    const cents = parseAmountToCents(valor.value);
    previa.textContent = n && cents ? previaParcelas(cents, n, ehTotal) : "";
  }

  function desenhaValorEh() {
    clear(chipsValorEh);
    for (const [v, rotulo] of [[false, "da parcela"], [true, "total"]]) {
      chipsValorEh.append(el("button", { class: `chip ${ehTotal === v ? "chip--on" : ""}`, type: "button", text: rotulo,
        "aria-pressed": ehTotal === v ? "true" : "false",
        onClick: () => { ehTotal = v; desenhaValorEh(); } }));
    }
    atualizaPrevia();
  }
  valor.addEventListener("input", atualizaPrevia);

  const checkRepetir = el("input", { type: "checkbox" });
  checkRepetir.addEventListener("change", () => {
    repetir = checkRepetir.checked;
    blocoRepetir.style.display = repetir ? "" : "none";
    // a série pode começar no mês que vem (1º vencimento); a avulsa não passa de hoje
    if (repetir) data.removeAttribute("max");
    else {
      data.max = hojeISO();
      if (data.value > data.max) data.value = data.max;
    }
  });
  blocoRepetir.append(
    el("div", { class: "small muted", style: "margin:2px 0 6px" , text:
      "Um lançamento por mês, no dia da data acima — que pode ser no mês que vem. Os meses seguintes já aparecem como previstos." }),
    repeticoes.node,
    blocoParcelas,
    el("label", { class: "choice", style: "margin-top:12px" }, [checkConfirmar, "Preciso confirmar cada pagamento (boleto, carnê)"]),
    el("div", { class: "small muted", style: "margin-top:6px", text:
      "Marcado, cada mês entra “a pagar” até você marcar como paga. No cartão não precisa: a parcela já está paga. "
      + "O que já venceu antes de hoje entra como pago; se não pagou, abra a despesa e use “Voltar para a pagar”." }),
  );
  desenhaValorEh();

  desenhaCategorias();
  desenhaSubs();
  desenhaFormas();

  const btnSalvar = el("button", { class: "btn btn--primary btn--lg", text: editando ? "Salvar" : "Lançar despesa" });

  const salvar = acaoUnica(async () => {
    const cents = parseAmountToCents(valor.value);
    if (!cents) { toast("Informe um valor maior que zero.", "error"); valor.focus(); return; }
    if (cents > MAX_CENTAVOS) {
      toast("Esse valor é grande demais. Confira os zeros.", "error");
      valor.focus();
      return;
    }
    if (!catSel) { toast("Escolha uma categoria.", "error"); return; }
    if (!data.value) { toast("Informe a data.", "error"); return; }
    const rep = repetir ? repeticoes.ler() : { ok: true, vezes: null };
    if (!rep.ok) { toast(rep.erro, "error"); return; }
    const peloTotal = repetir && rep.vezes && ehTotal;
    if (peloTotal && cents < rep.vezes) {
      toast("O total é pequeno demais para tantas parcelas.", "error");
      return;
    }
    btnSalvar.disabled = true;
    btnSalvar.textContent = "Salvando...";
    try {
      if (editando) {
        await db.updateDespesa(state.ledgerId, despesa.id, data.value, cents, catSel, formaSel, descricao.value);
      } else if (repetir) {
        // cria só a SÉRIE: o servidor lança os meses que já chegaram; os seguintes são previstos
        const dia = Number(String(data.value).slice(8, 10)) || 1;
        await db.addFixa(state.ledgerId, descricao.value, peloTotal ? null : cents, catSel, dia,
          mesDe(data.value), rep.vezes, formaSel, checkConfirmar.checked, peloTotal ? cents : null);
        db.track("criar_fixa", "carteira");
      } else {
        await db.addDespesa(state.ledgerId, data.value, cents, catSel, formaSel, descricao.value);
        db.track("lancar_despesa", "carteira");
      }
      fechar();
      // lançou em outro mês? a tela vai junto, senão a despesa "some"
      await recarregar(mesDe(data.value));
      toast(editando ? "Despesa atualizada."
        : repetir ? (rep.vezes ? `Criada em ${rep.vezes}x: os próximos meses já aparecem como previstos.` : "Fixa criada: lança todo mês até você cancelar.")
        : "Despesa lançada.", "success");
    } catch (err) {
      toast(err.message, "error");
      btnSalvar.disabled = false;
      btnSalvar.textContent = editando ? "Salvar" : "Lançar despesa";
    }
  });
  btnSalvar.addEventListener("click", salvar);
  valor.addEventListener("keydown", (ev) => { if (ev.key === "Enter") salvar(); });

  const corpo = el("div", {}, [
    campo("Valor", valor),
    el("label", { class: "label", text: "Categoria" }), chipsCat, chipsSub,
    // a data da parcela a pagar é o vencimento: mudá-la de mês a soltaria da série
    campo("Data", data, despesa?.a_pagar ? "É o vencimento. Pagou? Use “Marcar como paga”." : null),
    el("label", { class: "label", text: "Forma de pagamento (opcional)" }), chipsForma,
    campo("Descrição (opcional)", descricao),
    !editando
      ? el("div", { style: "margin-top:14px" }, [
          el("label", { class: "choice" }, [checkRepetir, "Repetir ou parcelar"]),
          blocoRepetir,
        ])
      : null,
    editando && despesa.recurring_id
      ? el("p", { class: "small muted", style: "margin-top:12px", text:
          "Esta veio de uma fixa ou parcelado. A alteração vale só para este mês; para mudar a série, use Ajustes → Fixas e parceladas." })
      : null,
    // avulsa é sempre paga: só linha que nasceu de série volta para "a pagar"
    editando && (despesa.a_pagar || despesa.recurring_month)
      ? el("button", {
          class: "btn btn--ghost btn--block", type: "button",
          text: despesa.a_pagar ? "Marcar como paga" : "Voltar para a pagar",
          onClick: acaoUnica(async () => {
            try {
              await db.marcarPago(state.ledgerId, despesa.id, !!despesa.a_pagar);
              fechar();
              await recarregar();
              toast(despesa.a_pagar ? "Marcada como paga." : "Voltou para a pagar.", "success");
            } catch (err) { toast(err.message, "error"); }
          }),
        })
      : null,
    editando
      ? el("button", {
          class: "btn btn--danger btn--block",
          type: "button",
          text: "Excluir despesa",
          onClick: async () => {
            if (!confirmAction(despesa.a_pagar
              ? "Excluir esta parcela a pagar? Ela fica como “não será paga” e não volta. Se você pagou, use Marcar como paga."
              : "Excluir esta despesa?")) return;
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

  // botão no rodapé grudado: no celular ele ficaria ~600px abaixo do valor
  const { close } = openModal(editando ? "Editar despesa" : "Nova despesa", corpo, btnSalvar);
  const fechar = close;
  setTimeout(() => valor.focus(), 80);
}

// ---- aba CATEGORIAS (plano de contas) --------------------------------------
function abaPlano() {
  const s = state.snapshot;
  const cats = s.categories || [];
  const pais = cats.filter((c) => !c.parent_id);
  const novo = el("input", { class: "input", placeholder: "Nova categoria", maxlength: "40" });

  const criar = acaoUnica(async () => {
    const nome = novo.value.trim();
    if (!nome) return;
    try {
      await db.addCategoria(state.ledgerId, nome, null, corDisponivel(cats));
      novo.value = "";
      await recarregar();
      toast("Categoria criada.", "success");
    } catch (e) { toast(e.message, "error"); }
  });
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

  const criar = acaoUnica(async () => {
    const nome = novo.value.trim();
    if (!nome) return;
    try {
      await db.addForma(state.ledgerId, nome);
      novo.value = "";
      await recarregar();
      toast("Forma de pagamento criada.", "success");
    } catch (e) { toast(e.message, "error"); }
  });
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

/**
 * Escolha de quantas vezes a fixa se repete. Os atalhos cobrem o caso comum,
 * mas "outro" existe porque a IA pode criar uma fixa de 7 ou 18 meses — sem o
 * campo livre, abrir essa fixa para editar não mostraria nenhum chip aceso e a
 * pessoa não saberia dizer o que está valendo.
 */
function seletorRepeticoes(inicial, aoMudar) {
  const PADRAO = [3, 6, 10, 12, 24];
  const ini = inicial === undefined ? 12 : inicial;
  // uma variável só: um dos atalhos, null (até cancelar) ou "livre".
  // O número do campo livre mora no próprio input, lido só na hora de salvar.
  let escolha = ini === null || PADRAO.includes(ini) ? ini : "livre";

  const chips = el("div", { class: "chips" });
  const campoNum = el("input", {
    type: "number", min: "1", max: "600", inputmode: "numeric",
    class: "input", style: "max-width:10rem;margin-top:8px",
    placeholder: "quantos meses", "aria-label": "Quantas vezes repetir",
  });
  if (escolha === "livre") campoNum.value = String(ini);
  // aoMudar só em gesto da pessoa: na montagem quem chama ainda nem terminou de se montar
  if (aoMudar) campoNum.addEventListener("input", aoMudar);

  function desenha() {
    clear(chips);
    for (const [v, rotulo] of [...PADRAO.map((n) => [n, `${n}x`]),
                               ["livre", "outro"], [null, "até eu cancelar"]]) {
      const on = v === escolha;
      chips.append(el("button", {
        class: `chip ${on ? "chip--on" : ""}`, type: "button", text: rotulo,
        "aria-pressed": on ? "true" : "false",
        onClick: () => {
          escolha = v;
          desenha();
          aoMudar?.();
          if (v === "livre") campoNum.focus();
        },
      }));
    }
    campoNum.style.display = escolha === "livre" ? "" : "none";
  }
  desenha();

  return {
    node: el("div", {}, [chips, campoNum]),
    // null = indeterminada; erro quando escolheu "outro" e não digitou nada
    ler() {
      if (escolha !== "livre") return { ok: true, vezes: escolha };
      const n = parseInt(campoNum.value, 10);
      if (!(n >= 1)) return { ok: false, erro: "Diga em quantos meses a despesa se repete." };
      return { ok: true, vezes: Math.min(n, 600) };
    },
  };
}

/**
 * Fixas e parceladas. O andamento vem pronto do servidor (linhas pagas e
 * pendentes, ocorrências que faltam), nunca de N × valor: skip, quitação e
 * reativação quebrariam a conta.
 */
function cardFixas() {
  const s = state.snapshot;
  const fixas = s.fixas || [];
  const cats = new Map((s.categories || []).map((c) => [c.id, c]));
  const formas = new Map((s.payment_methods || []).map((f) => [f.id, f]));

  const corpo = fixas.length
    ? el("ul", { class: "list" }, fixas.map((f) => {
        const cat = cats.get(f.category_id);
        const forma = f.payment_method_id ? formas.get(f.payment_method_id)?.name : null;
        const nome = nomeDe(f);
        const situacao = [
          f.cancelado_em ? `cancelada a partir de ${mesExtenso(f.cancelado_em)}`
            : f.total_meses == null ? "até você cancelar" : null,
          andamentoFixa(f) || `${f.lancadas} lançada${f.lancadas === 1 ? "" : "s"}`,
        ].filter(Boolean).join(" · ");
        return el("li", { class: "list__item" }, [
          el("span", { class: "catrow__dot", style: `background:${cat?.color || "#9ca3af"}` }),
          el("div", { style: "flex:1;min-width:0" }, [
            el("div", { class: "list__name", text: nome }),
            el("div", { class: "list__sub", text:
              `${fmtBRL(f.amount_cents)} · dia ${f.dia} · ${cat?.name || "sem categoria"}${forma ? ` · ${forma}` : ""}`
              + (f.total_cents ? ` · total ${fmtBRL(f.total_cents)}` : "") }),
            el("div", { class: "list__sub" }, [
              f.ativa ? el("span", { class: "tag tag--fixa", text: "ativa" }) : el("span", { class: "badge badge--off", text: "parada" }),
              f.confirmar ? el("span", { class: "tag tag--apagar", text: "confirma pagamento" }) : null,
              ` ${situacao}`,
            ]),
          ]),
          el("div", { class: "list__actions" }, [
            el("button", { class: "iconbtn", text: "✏️", title: "Editar", "aria-label": `Editar ${nome}`, onClick: () => abrirFormFixa(f) }),
            f.cancelado_em
              ? el("button", {
                  class: "iconbtn", text: "▶️", title: "Reativar", "aria-label": `Reativar ${nome}`,
                  onClick: async () => {
                    try {
                      await db.reativarFixa(state.ledgerId, f.id);
                      await recarregar();
                      toast("Fixa reativada.", "success");
                    } catch (e) { toast(e.message, "error"); }
                  },
                })
              : el("button", {
                  class: "iconbtn", text: "⏸️", title: "Cancelar", "aria-label": `Cancelar ${nome}`,
                  onClick: async () => {
                    // a dívida não some com o cancelamento: as pendentes continuam
                    const pend = f.pendentes || 0;
                    const aviso = [`Parar "${nome}"? O que já foi lançado continua; ela para de aparecer a partir do mês que vem.`];
                    if (pend) {
                      aviso.push(`${pend === 1 ? "A parcela a pagar continua pendente" : `As ${pend} parcelas a pagar continuam pendentes`}.`,
                        "Se está quitando, lance a quitação como despesa e exclua as parcelas a pagar que ela cobre.");
                    } else if (f.total_meses != null) {
                      aviso.push("Se está quitando, lance a quitação como despesa.");
                    }
                    if (!confirmAction(aviso.join(" "))) return;
                    try {
                      await db.cancelarFixa(state.ledgerId, f.id);
                      await recarregar();
                      toast("Fixa cancelada. O histórico continua.", "success");
                    } catch (e) { toast(e.message, "error"); }
                  },
                }),
            el("button", { class: "iconbtn", text: "🗑️", title: "Excluir", "aria-label": `Excluir ${nome}`, onClick: () => abrirExcluirFixa(f) }),
          ]),
        ]);
      }))
    : el("p", { class: "muted small", style: "margin:4px 0 0", text:
        "Nenhuma fixa ou parcelado. Ao lançar uma despesa, marque “Repetir ou parcelar”." });

  return el("div", { class: "card" }, [
    el("h3", { class: "sheet__title", text: "Fixas e parceladas" }),
    el("p", { class: "small muted", style: "margin:6px 0 12px", text:
      "Aluguel, assinatura, compra parcelada. Cada mês entra quando chega, no dia da série; os próximos já aparecem como previstos ao avançar o mês." }),
    corpo,
  ]);
}

/**
 * Excluir a regra. Apagar junto os lançamentos é para quem cadastrou errado:
 * sem isso, cadastrar de novo duplicaria os meses já lançados.
 */
function abrirExcluirFixa(f) {
  const n = f.lancadas || 0;
  const apagar = el("input", { type: "checkbox" });
  const btn = el("button", { class: "btn btn--danger btn--lg", type: "button", text: "Excluir" });
  btn.onclick = acaoUnica(async () => {
    try {
      await db.delFixa(state.ledgerId, f.id, n > 0 && !apagar.checked, apagar.checked);
      close();
      await recarregar();
      toast(apagar.checked ? "Excluída junto com os lançamentos." : "Fixa excluída.", "success");
    } catch (e) { toast(e.message, "error"); }
  });
  const { close } = openModal(`Excluir "${nomeDe(f)}"?`, el("div", {}, n
    ? [
        el("p", { style: "margin:4px 0 0", text:
          `A regra some e ${n === 1 ? "o lançamento já feito continua" : `os ${n} lançamentos já feitos continuam`} no histórico.` }),
        el("label", { class: "choice", style: "margin-top:12px" }, [apagar, n === 1 ? "Apagar também o lançamento" : `Apagar também os ${n} lançamentos`]),
        el("p", { class: "small muted", style: "margin-top:8px", text:
          "Marque se cadastrou errado: sem isso, cadastrar de novo duplicaria os meses já lançados." }),
      ]
    : [el("p", { style: "margin:4px 0 0", text: "Ela ainda não lançou nada; a regra some de vez." })]), btn);
}

function abrirFormFixa(f) {
  const s = state.snapshot;
  const cats = (s.categories || []).filter((c) => !c.archived || c.id === f.category_id);
  const formas = (s.payment_methods || []).filter((m) => !m.archived || m.id === f.payment_method_id);

  const descricao = el("input", { class: "input", maxlength: "140", value: f.description || "" });
  const valor = el("input", { class: "input input--amount", inputmode: "decimal",
    value: (f.amount_cents / 100).toFixed(2).replace(".", ",") });
  const dia = el("input", { class: "input", type: "number", min: "1", max: "31", value: String(f.dia) });

  const selCat = el("select", { class: "input" }, cats.map((c) =>
    el("option", { value: c.id, selected: c.id === f.category_id ? "" : null,
      text: c.parent_id ? `   ${cats.find((x) => x.id === c.parent_id)?.name || ""} › ${c.name}` : c.name })));
  const selForma = el("select", { class: "input" }, [
    el("option", { value: "", text: "não informar" }),
    ...formas.map((m) => el("option", { value: m.id, selected: m.id === f.payment_method_id ? "" : null, text: m.name })),
  ]);

  const repeticoes = seletorRepeticoes(f.total_meses);
  const confirmar = el("input", { type: "checkbox", checked: !!f.confirmar });

  const salvar = el("button", { class: "btn btn--primary btn--lg", type: "button", text: "Salvar" });
  salvar.onclick = acaoUnica(async () => {
    const cents = parseAmountToCents(valor.value);
    if (!cents) { toast("Informe um valor maior que zero.", "error"); return; }
    if (cents > MAX_CENTAVOS) { toast("Esse valor é grande demais.", "error"); return; }
    const d = Number(dia.value);
    if (!d || d < 1 || d > 31) { toast("O dia precisa estar entre 1 e 31.", "error"); return; }
    const rep = repeticoes.ler();
    if (!rep.ok) { toast(rep.erro, "error"); return; }
    try {
      await db.updateFixa(state.ledgerId, f.id, descricao.value, cents, selCat.value, d, rep.vezes,
        selForma.value || null, confirmar.checked);
      close();
      await recarregar();
      toast("Fixa atualizada. Vale para os próximos lançamentos.", "success");
    } catch (e) { toast(e.message, "error"); }
  });

  const { close } = openModal("Editar fixa ou parcelado", el("div", {}, [
    campo("Descrição", descricao),
    campo("Valor de cada mês", valor, f.total_cents
      ? `Parcela de um total de ${fmtBRL(f.total_cents)}. Mudar o valor ou o número de meses desfaz a divisão pelo total.` : null),
    campo("Dia do mês", dia, "Mês sem esse dia usa o último dia."),
    campo("Categoria", selCat),
    campo("Forma de pagamento", selForma),
    el("label", { class: "label", text: "Por quantos meses" }), repeticoes.node,
    el("label", { class: "choice", style: "margin-top:12px" }, [confirmar, "Preciso confirmar cada pagamento (boleto, carnê)"]),
    el("p", { class: "small muted", style: "margin-top:8px", text:
      `Já lançou ${f.lancadas} vez${f.lancadas === 1 ? "" : "es"}. Alterar aqui não mexe no que já foi lançado.` }),
  ]), salvar);
}

// ---- aba IA ----------------------------------------------------------------
/**
 * Conecta o Controlaí a uma IA. Dois caminhos:
 *  1. conector MCP no claude.ai — a URL leva o token no fim, cada pessoa cadastra a sua;
 *  2. bloco de instruções para colar em Claude Code, Cursor ou ChatGPT, que falam
 *     direto com a API REST.
 * O token é separado do link da carteira de propósito: revogar o acesso da IA
 * não derruba o seu link, e trocar o link não desconecta a IA.
 */
function abaIA() {
  const s = state.snapshot;
  const cfg = window.CONTROLAI_CONFIG || {};
  const base = String(cfg.SUPABASE_URL || "").replace(/\/$/, "");

  const campoToken = el("code", { text: "gerando…" });
  const campoUrl = el("code", { text: "gerando…" });
  const btnToken = el("button", { class: "btn btn--ghost btn--sm", text: "Copiar token", disabled: "" });
  const btnUrl = el("button", { class: "btn btn--primary btn--sm", text: "Copiar URL", disabled: "" });
  const prompt = el("textarea", { class: "input prompt", rows: "8", readonly: "" });
  const btnPrompt = el("button", { class: "btn btn--ghost btn--block", text: "Copiar instruções", disabled: "" });
  const btnRotacionar = el("button", { class: "btn btn--danger btn--block", text: "Gerar um token novo (desconecta as IAs)" });

  function aplica(token) {
    const url = `${base}/functions/v1/controlai-mcp/${token}`;
    campoToken.textContent = token;
    campoUrl.textContent = url;
    btnToken.removeAttribute("disabled");
    btnUrl.removeAttribute("disabled");
    btnPrompt.removeAttribute("disabled");
    btnToken.onclick = async () =>
      toast((await copyText(token)) ? "Token copiado." : "Não consegui copiar.", "success");
    btnUrl.onclick = async () =>
      toast((await copyText(url)) ? "URL do conector copiada." : "Não consegui copiar.", "success");
    prompt.value = montaPromptIA(base, cfg.SUPABASE_ANON_KEY || "", token);
    btnPrompt.onclick = async () =>
      toast((await copyText(prompt.value)) ? "Instruções copiadas." : "Não consegui copiar.", "success");
  }

  db.getApiToken(state.ledgerId).then(aplica, (e) => {
    campoToken.textContent = "erro ao gerar";
    campoUrl.textContent = "-";
    prompt.value = "Não foi possível gerar o token. Recarregue a página.";
    toast(e.message, "error");
  });

  btnRotacionar.onclick = async () => {
    if (!confirmAction("Gerar um token novo? Os conectores e conversas que usam o token atual param de funcionar até você atualizar a URL.")) return;
    try {
      const novo = await db.rotateApiToken(state.ledgerId);
      aplica(novo);
      toast("Token trocado. Atualize a URL no conector.", "success");
    } catch (e) { toast(e.message, "error"); }
  };

  return el("div", {}, [
    el("p", { class: "muted", style: "margin:0 0 14px" , text:
      "Deixe uma IA lançar despesa e responder \u201cquanto gastei esse mês\u201d por você — é só conversar." }),

    el("div", { class: "card" }, [
      el("h3", { class: "sheet__title", text: "Conector no Claude" }),
      el("p", { class: "small muted", style: "margin:6px 0 10px", text:
        "No Claude (app ou site): Customize → Connectors → Add custom connector. Cole a URL abaixo e salve." }),
      el("div", { class: "idbox" }, [campoUrl]),
      el("div", { class: "row2" }, [btnUrl, btnToken]),
      el("ol", { class: "steps", style: "margin-top:14px" }, [
        el("li", { text: "Copie a URL acima." }),
        el("li", { text: "No Claude, vá em Customize → Connectors → Add custom connector." }),
        el("li", { text: "Cole a URL e clique em Add. Não precisa preencher OAuth." }),
        el("li", { text: "Fale natural: \u201cgastei 62 no mercado hoje\u201d ou \u201cresumo do mês\u201d." }),
      ]),
      el("p", { class: "small muted", style: "margin-top:10px", text:
        "A URL contém o seu token: trate como senha. Quem tiver ela lança e lê despesas desta carteira." }),
    ]),

    el("div", { class: "card" }, [
      el("h3", { class: "sheet__title", text: "Claude Code, Cursor, ChatGPT" }),
      el("p", { class: "small muted", style: "margin:6px 0 8px", text:
        "Para IA que acessa a web mas não usa conector: cole o bloco abaixo na conversa. Ela passa a usar a API direto, sem instalar nada." }),
      prompt,
      btnPrompt,
    ]),

    el("div", { class: "card" }, [
      el("h3", { class: "sheet__title", text: "Revogar o acesso" }),
      el("p", { class: "small muted", style: "margin:6px 0 10px", text:
        "O token da IA é separado do link da carteira: trocar um não mexe no outro." }),
      btnRotacionar,
    ]),
  ]);
}

/** Bloco que a pessoa cola numa IA com acesso a HTTP. */
function montaPromptIA(base, anon, token) {
  const rpc = `${base}/rest/v1/rpc`;
  return [
    "Você vai cuidar das minhas despesas pessoais no Controlaí, via API REST (curl).",
    "",
    `Base: ${rpc}`,
    "Em toda requisição: POST, com os headers",
    `  apikey: ${anon}`,
    "  Content-Type: application/json",
    `E sempre inclua no corpo: "p_token": "${token}"`,
    "",
    "Antes de lançar a primeira despesa, chame controlai_api_contexto para ver as",
    "categorias que existem. Valores em REAIS (62.90), categoria pelo NOME.",
    "",
    "Funções:",
    "  controlai_api_contexto   {}",
    "  controlai_api_lancar     {p_valor, p_categoria, p_data?, p_forma?, p_descricao?}",
    "  controlai_api_resumo     {p_mes?}            -> total do mês por categoria",
    "  controlai_api_listar     {p_mes?, p_categoria?, p_limite?}",
    "  controlai_api_editar     {p_id, p_valor?, p_categoria?, p_data?, p_forma?, p_descricao?}",
    "  controlai_api_apagar     {p_id}",
    "  controlai_api_criar_categoria {p_nome, p_pai?}",
    "  controlai_api_criar_fixa {p_valor | p_valor_total, p_categoria, p_meses?, p_dia?, p_forma?,",
    "                            p_descricao?, p_mes_inicio?, p_confirmar?}",
    "                           -> todo mês (sem p_meses) ou parcelado (p_meses = nº de parcelas)",
    "  controlai_api_marcar_pago {p_id, p_pago?}   -> p_pago false volta para a pagar",
    "  controlai_api_contas_a_pagar {}              -> atrasadas, vencem este mês, próximas",
    "  controlai_api_listar_fixas {}",
    "  controlai_api_editar_fixa {p_id, p_valor?, p_categoria?, p_dia?, p_meses?, p_ate_cancelar?,",
    "                             p_forma?, p_descricao?, p_confirmar?}",
    "  controlai_api_cancelar_fixa {p_id}",
    "",
    "Parcelado (\"10x\"): criar_fixa com p_meses; se disseram o total, p_valor_total",
    "em vez de p_valor. Boleto ou carnê: p_confirmar true. \"Paguei X\": contas_a_pagar",
    "para achar o id e depois marcar_pago.",
    "Mudar uma fixa é editar_fixa (cancelar e criar outra duplica o mês); quitar = cancelar_fixa + apagar as pendentes cobertas + lancar.",
    "",
    "Confirme comigo antes de apagar qualquer coisa.",
  ].join("\n");
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

    cardFixas(),

    el("div", { class: "card" }, [
      el("h3", { class: "sheet__title", text: "Exportar" }),
      el("p", { class: "small muted", style: "margin:6px 0 10px", text: "A planilha sai com a data como data e o valor como moeda, cabeçalho congelado e filtro — dá para somar e montar tabela dinâmica na hora." }),
      el("button", {
        class: "btn btn--primary btn--block", text: "Baixar Excel (.xlsx)",
        onClick: async (ev) => {
          const b = ev.currentTarget;
          b.disabled = true;
          const antes = b.textContent;
          b.textContent = "Montando...";
          try {
            const todas = await db.exportar(state.ledgerId);
            const bytes = despesasParaXLSX(todas, s.categories, s.payment_methods);
            downloadBytes(`${arquivoBase(s.ledger.name)}.xlsx`, bytes,
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
            db.track("exportar_xlsx", "carteira");
            toast(`${todas.length} lançamento(s) exportado(s).`, "success");
          } catch (e) { toast(e.message, "error"); }
          b.disabled = false;
          b.textContent = antes;
        },
      }),
      el("button", {
        class: "btn btn--ghost btn--block", text: "Prefiro CSV",
        onClick: async () => {
          try {
            const todas = await db.exportar(state.ledgerId);
            downloadText(`${arquivoBase(s.ledger.name)}.csv`, montaCSV(todas, s.categories, s.payment_methods));
            db.track("exportar_csv", "carteira");
          } catch (e) { toast(e.message, "error"); }
        },
      }),
    ]),

    el("div", { class: "card" }, [
      el("h3", { class: "sheet__title", text: "Segurança do link" }),
      el("p", { class: "small muted", style: "margin:6px 0 10px", text: "Mandou o link para alguém sem querer? Gerar um ID novo derruba o link antigo na hora. Suas despesas continuam todas aqui." }),
      el("button", {
        class: "btn btn--ghost btn--block", text: "Gerar um ID novo (invalida o link atual)",
        onClick: async () => {
          if (!confirmAction("Gerar um ID novo? O link atual para de funcionar — quem tiver ele perde o acesso, inclusive seus outros aparelhos.")) return;
          try {
            const novoId = await db.rotacionarId(state.ledgerId);
            esquecerCarteira(state.ledgerId);
            lembrarCarteira(novoId, s.ledger.name);
            toast("ID trocado. Guarde o link novo.", "success");
            location.hash = `#/c/${novoId}`;
          } catch (e) { toast(e.message, "error"); }
        },
      }),
    ]),

    el("div", { class: "card" }, [
      el("h3", { class: "sheet__title", text: "Apagar esta carteira" }),
      el("p", { class: "small muted", style: "margin:6px 0 10px", text: "Apaga de vez as despesas, categorias e o e-mail. Não dá para desfazer — exporte o CSV antes se quiser guardar." }),
      el("button", {
        class: "btn btn--danger btn--block", text: "Apagar tudo",
        onClick: async () => {
          if (!confirmAction(`Apagar "${s.ledger.name}" e TODAS as despesas? Isso não tem volta.`)) return;
          if (!confirmAction("Confirmando: tudo será apagado agora.")) return;
          try {
            await db.apagar(state.ledgerId, state.ledgerId);
            esquecerCarteira(state.ledgerId);
            toast("Carteira apagada.", "success");
            location.hash = "#/";
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

    el("p", { class: "versao", text: `Controlaí ${VERSAO}` }),
  ]);
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
/** "Casa do Daniel" -> "controlai-casa-do-daniel-2026-09" */
function arquivoBase(nome) {
  const limpo = String(nome || "despesas")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\W+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "despesas";
  return `controlai-${limpo}-${hojeISO()}`;
}

const PALETA = ["#8b5cf6", "#ef4444", "#f97316", "#3b82f6", "#10b981", "#6366f1",
  "#ec4899", "#14b8a6", "#a855f7", "#eab308", "#06b6d4", "#84cc16"];

function corDisponivel(cats) {
  const usadas = new Set((cats || []).map((c) => c.color));
  return PALETA.find((c) => !usadas.has(c)) || PALETA[(cats?.length || 0) % PALETA.length];
}

let seqId = 0;
/** Campo com rótulo REALMENTE associado (for/id) — leitor de tela anuncia o nome. */
function campo(rotulo, input, dica) {
  const id = `ladfb-c${++seqId}`;
  input.id = id;
  return el("div", {}, [
    el("label", { class: "label", for: id, text: rotulo }),
    dica ? el("div", { class: "small muted", style: "margin:-2px 0 6px", text: dica }) : null,
    input,
  ]);
}

/**
 * Folha inferior acessível: role=dialog, fecha no ✕/backdrop/Esc, devolve o foco
 * para quem abriu e prende o Tab dentro dela. `rodape` fica grudado embaixo, para
 * o botão principal não ficar 600px abaixo do primeiro campo no celular.
 */
function openModal(title, contentNode, rodape) {
  const antes = document.activeElement;
  const overlay = el("div", { class: "overlay" });
  const tituloId = `ladfb-t${++seqId}`;
  let fechado = false;
  const close = () => {
    if (fechado) return;
    fechado = true;
    document.removeEventListener("keydown", onKey, true);
    overlay.classList.remove("overlay--show");
    setTimeout(() => overlay.remove(), 200);
    // a tela de trás pode ter sido redesenhada com a folha aberta (recarregar):
    // quem abriu já não existe, e o foco cairia no body
    const alvo = antes?.isConnected ? antes : document.querySelector(".apagar") || document.querySelector(".fab");
    try { alvo?.focus?.(); } catch { /* ignora */ }
  };
  const focaveis = () => sheet.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])');
  const onKey = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); return; }
    if (e.key !== "Tab") return;
    const f = focaveis();
    if (!f.length) return;
    const primeiro = f[0], ultimo = f[f.length - 1];
    if (e.shiftKey && document.activeElement === primeiro) { e.preventDefault(); ultimo.focus(); }
    else if (!e.shiftKey && document.activeElement === ultimo) { e.preventDefault(); primeiro.focus(); }
  };
  const sheet = el("div", {
    class: "sheet", role: "dialog", "aria-modal": "true", "aria-labelledby": tituloId,
  }, [
    el("div", { class: "sheet__head" }, [
      el("h2", { class: "sheet__title", id: tituloId, text: title }),
      el("button", { class: "iconbtn", type: "button", text: "✕", "aria-label": "Fechar", onClick: close }),
    ]),
    el("div", { class: "sheet__body" }, [contentNode]),
    rodape ? el("div", { class: "sheet__foot" }, [rodape]) : null,
  ]);
  overlay.append(sheet);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey, true);
  document.body.append(overlay);
  void overlay.offsetWidth;
  overlay.classList.add("overlay--show");
  const f = focaveis();
  setTimeout(() => { try { (f[1] || f[0])?.focus(); } catch { /* ignora */ } }, 60);
  return { close };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
window.addEventListener("hashchange", router);

if (veioDoEmail && !parseRoute().id) {
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
