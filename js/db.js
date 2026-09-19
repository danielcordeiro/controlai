// Camada de acesso ao Supabase. Todo acesso aos dados passa pelas RPC
// public.controlai_* (SECURITY DEFINER) — a publishable key não lê as tabelas
// direto (elas moram no schema "controlai", fora do PostgREST).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cfg = window.CONTROLAI_CONFIG || {};

export const isConfigured =
  !!cfg.SUPABASE_URL &&
  !!cfg.SUPABASE_ANON_KEY &&
  !cfg.SUPABASE_URL.includes("SUA_") &&
  !cfg.SUPABASE_ANON_KEY.includes("SUA_");

// A sessão do Auth é usada SÓ na recuperação de ID por e-mail (link mágico ou
// código). Por isso persistSession + detectSessionInUrl: o link do e-mail volta
// para cá com o token no fragmento e o supabase-js o consome sozinho.
const supabase = isConfigured
  ? createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        detectSessionInUrl: true,
        autoRefreshToken: true,
        storageKey: "controlai.auth",
      },
    })
  : null;

/** true quando a URL atual é o retorno de um link mágico/código do e-mail. */
export function chegouDoEmail() {
  const h = String(location.hash || "");
  const q = String(location.search || "");
  return /access_token=|[?&#]code=|type=(magiclink|recovery|email|signup)/.test(h + q);
}

/** Traduz o erro do Supabase para uma frase que o usuário entende. */
function amigavel(error) {
  const msg = String(error?.message || "").toLowerCase();
  if (msg.includes("rate limit") || msg.includes("too many") || msg.includes("after"))
    return "Muitas tentativas seguidas. Espere alguns minutos e tente de novo.";
  if (msg.includes("expired")) return "Esse código/link expirou. Peça um novo.";
  if (msg.includes("invalid") && msg.includes("token")) return "Código inválido. Confira e tente de novo.";
  if (msg.includes("failed to fetch") || msg.includes("networkerror"))
    return "Sem conexão com o servidor. Verifique a internet e tente de novo.";
  return error?.message || "Erro ao falar com o servidor.";
}

/** Executa uma RPC e devolve os dados, com erro amigável em caso de falha. */
async function rpc(fn, params) {
  if (!supabase) throw new Error("App não configurado (veja o config.js).");
  const { data, error } = await supabase.rpc(fn, params);
  if (error) throw new Error(amigavel(error));
  return data;
}

/** Id anônimo do navegador (não-PII), só para contar visitantes únicos. */
function sessionId() {
  const KEY = "controlai:sid";
  try {
    let sid = localStorage.getItem(KEY);
    if (!sid) {
      sid = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2);
      localStorage.setItem(KEY, sid);
    }
    return sid;
  } catch {
    return "";
  }
}

export const db = {
  // ---- carteira -------------------------------------------------------------
  criar: (name, email) => rpc("controlai_criar", { p_name: name, p_email: email }),
  mes: (ledgerId, mes) => rpc("controlai_mes", { p_ledger: ledgerId, p_mes: mes || null }),
  renomear: (ledgerId, name) => rpc("controlai_renomear", { p_ledger: ledgerId, p_name: name }),
  setEmail: (ledgerId, email) => rpc("controlai_set_email", { p_ledger: ledgerId, p_email: email }),
  exportar: (ledgerId) => rpc("controlai_exportar", { p_ledger: ledgerId }),

  // ---- despesas -------------------------------------------------------------
  addDespesa: (ledgerId, spentOn, amountCents, categoryId, paymentMethodId, description) =>
    rpc("controlai_add_despesa", {
      p_ledger: ledgerId,
      p_spent_on: spentOn,
      p_amount_cents: amountCents,
      p_category: categoryId,
      p_payment_method: paymentMethodId || null,
      p_description: description || "",
    }),
  updateDespesa: (expenseId, spentOn, amountCents, categoryId, paymentMethodId, description) =>
    rpc("controlai_update_despesa", {
      p_expense: expenseId,
      p_spent_on: spentOn,
      p_amount_cents: amountCents,
      p_category: categoryId,
      p_payment_method: paymentMethodId || null,
      p_description: description || "",
    }),
  delDespesa: (expenseId) => rpc("controlai_del_despesa", { p_expense: expenseId }),

  // ---- plano de contas ------------------------------------------------------
  addCategoria: (ledgerId, name, parentId, color) =>
    rpc("controlai_add_categoria", { p_ledger: ledgerId, p_name: name, p_parent: parentId || null, p_color: color || null }),
  updateCategoria: (categoryId, name, color, archived) =>
    rpc("controlai_update_categoria", { p_category: categoryId, p_name: name, p_color: color || null, p_archived: archived ?? null }),
  delCategoria: (categoryId) => rpc("controlai_del_categoria", { p_category: categoryId }),

  // ---- formas de pagamento --------------------------------------------------
  addForma: (ledgerId, name) => rpc("controlai_add_forma", { p_ledger: ledgerId, p_name: name }),
  updateForma: (methodId, name, archived) =>
    rpc("controlai_update_forma", { p_method: methodId, p_name: name, p_archived: archived ?? null }),
  delForma: (methodId) => rpc("controlai_del_forma", { p_method: methodId }),

  /** Registra um evento de uso. Fire-and-forget: nunca lança nem bloqueia a UI.
   *  Reaproveita o public.track() já existente no projeto (do Rachaí), com o
   *  nome do evento prefixado para os relatórios não se misturarem. */
  track(name, path) {
    if (!supabase) return;
    supabase
      .rpc("track", {
        p_name: `controlai:${name}`,
        p_path: path || "",
        p_session: sessionId(),
        p_referrer: (typeof document !== "undefined" && document.referrer) || "",
      })
      .then(() => {}, () => {});
  },
};

// ---------------------------------------------------------------- recuperação
// O e-mail nunca é fonte de verdade aqui: quem prova a posse da caixa é o
// Supabase Auth. A RPC controlai_meus_ids() lê o e-mail do JWT, não do campo.
export const auth = {
  /** Envia o link mágico (e o código, se o template do projeto incluir {{ .Token }}). */
  async enviarLink(email) {
    if (!supabase) throw new Error("App não configurado (veja o config.js).");
    const redirect = `${location.origin}${location.pathname}`;
    const { error } = await supabase.auth.signInWithOtp({
      email: String(email || "").trim().toLowerCase(),
      options: { shouldCreateUser: true, emailRedirectTo: redirect },
    });
    if (error) throw new Error(amigavel(error));
    return true;
  },

  /** Caminho alternativo: a pessoa digita o código de 6 dígitos do e-mail. */
  async verificarCodigo(email, codigo) {
    if (!supabase) throw new Error("App não configurado (veja o config.js).");
    const { error } = await supabase.auth.verifyOtp({
      email: String(email || "").trim().toLowerCase(),
      token: String(codigo || "").trim(),
      type: "email",
    });
    if (error) throw new Error(amigavel(error));
    return true;
  },

  /** Sessão atual (ou null). Também consome o token que veio na URL. */
  async sessao() {
    if (!supabase) return null;
    const { data } = await supabase.auth.getSession();
    return data?.session || null;
  },

  /** E-mail verificado da sessão atual. */
  async emailAtual() {
    const s = await this.sessao();
    return s?.user?.email || null;
  },

  /** Carteiras registradas no e-mail verificado da sessão. */
  meusIds: () => rpc("controlai_meus_ids", {}),

  async sair() {
    if (!supabase) return;
    try { await supabase.auth.signOut(); } catch { /* ignora */ }
  },
};
