// ============================================================================
// Controlaí — servidor MCP (Model Context Protocol) como Supabase Edge Function.
//
// Serve para plugar o app como CONECTOR no claude.ai (Customize → Connectors →
// Add custom connector) e em qualquer cliente MCP. O GitHub Pages é estático e
// não hospeda isto; a Edge Function vive no mesmo projeto Supabase do banco.
//
// AUTENTICAÇÃO: o token da carteira vai no fim da URL do conector,
//   https://<ref>.supabase.co/functions/v1/controlai-mcp/ctl_xxxxx
// Cada pessoa cadastra a própria URL. É a mesma chave portadora do link da
// carteira, e é por isso que `verify_jwt` fica desligado: a autenticação é esta,
// não a do Supabase. Sem token válido, nada responde.
//
// Transporte: Streamable HTTP (POST com JSON-RPC 2.0 e resposta JSON direta).
// GET devolve 405, que é o previsto para servidor que não abre stream SSE.
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const VERSAO = "1.0.0";
const PROTOCOLO_PADRAO = "2025-06-18";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, mcp-protocol-version, mcp-session-id, accept",
  "Access-Control-Expose-Headers": "mcp-session-id",
  "Access-Control-Max-Age": "86400",
};

// ----------------------------------------------------------------- ferramentas
// `rpc` é a função no Postgres; `args` mapeia o argumento do MCP para o parâmetro.
type Ferramenta = {
  name: string;
  description: string;
  rpc: string;
  inputSchema: Record<string, unknown>;
  mapa: Record<string, string>;
};

const FERRAMENTAS: Ferramenta[] = [
  {
    name: "contexto",
    description:
      "Lê o contexto da carteira: nome, data de hoje, mês atual, categorias (com subcategorias) e formas de pagamento disponíveis. " +
      "Chame ANTES de lançar a primeira despesa da conversa, para usar nomes de categoria que existem de verdade.",
    rpc: "controlai_api_contexto",
    inputSchema: { type: "object", properties: {}, required: [] },
    mapa: {},
  },
  {
    name: "lancar_despesa",
    description:
      "Lança uma despesa. Valor em reais (62.90, não centavos). A categoria é pelo NOME e aceita sem acento ou abreviada " +
      "('alimentacao', 'morad'). Data no formato AAAA-MM-DD; se omitida, usa hoje. Forma de pagamento é opcional.",
    rpc: "controlai_api_lancar",
    inputSchema: {
      type: "object",
      properties: {
        valor: { type: "number", description: "Valor em reais, ex.: 62.90" },
        categoria: { type: "string", description: "Nome da categoria, ex.: Mercado" },
        data: { type: "string", description: "AAAA-MM-DD. Omita para hoje." },
        forma_pagamento: { type: "string", description: "Ex.: Pix, Cartão de crédito. Opcional." },
        descricao: { type: "string", description: "Texto curto, ex.: 'feira da semana'. Opcional." },
      },
      required: ["valor", "categoria"],
    },
    mapa: {
      valor: "p_valor",
      categoria: "p_categoria",
      data: "p_data",
      forma_pagamento: "p_forma",
      descricao: "p_descricao",
    },
  },
  {
    name: "resumo_do_mes",
    description:
      "Quanto foi gasto no mês, por categoria e por forma de pagamento, com o total do mês anterior e a variação. " +
      "Mês no formato AAAA-MM; se omitido, o mês corrente. É a resposta para 'para onde foi meu dinheiro?'.",
    rpc: "controlai_api_resumo",
    inputSchema: {
      type: "object",
      properties: { mes: { type: "string", description: "AAAA-MM. Omita para o mês atual." } },
      required: [],
    },
    mapa: { mes: "p_mes" },
  },
  {
    name: "listar_despesas",
    description:
      "Lista os lançamentos de um mês, do mais recente para o mais antigo, com o id de cada um. " +
      "Use para achar o id antes de editar ou apagar. Pode filtrar por categoria.",
    rpc: "controlai_api_listar",
    inputSchema: {
      type: "object",
      properties: {
        mes: { type: "string", description: "AAAA-MM. Omita para o mês atual." },
        categoria: { type: "string", description: "Filtra por categoria (inclui as subcategorias dela)." },
        limite: { type: "integer", description: "Máximo de itens (padrão 50, teto 200)." },
      },
      required: [],
    },
    mapa: { mes: "p_mes", categoria: "p_categoria", limite: "p_limite" },
  },
  {
    name: "editar_despesa",
    description:
      "Altera uma despesa existente. Informe o id (veja em listar_despesas) e só os campos que mudam.",
    rpc: "controlai_api_editar",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "id do lançamento (uuid)" },
        valor: { type: "number", description: "Novo valor em reais." },
        categoria: { type: "string", description: "Nova categoria, pelo nome." },
        data: { type: "string", description: "Nova data, AAAA-MM-DD." },
        forma_pagamento: { type: "string", description: "Nova forma de pagamento." },
        descricao: { type: "string", description: "Nova descrição." },
      },
      required: ["id"],
    },
    mapa: {
      id: "p_id",
      valor: "p_valor",
      categoria: "p_categoria",
      data: "p_data",
      forma_pagamento: "p_forma",
      descricao: "p_descricao",
    },
  },
  {
    name: "apagar_despesa",
    description: "Apaga um lançamento pelo id. Confirme com a pessoa antes de chamar.",
    rpc: "controlai_api_apagar",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "id do lançamento (uuid)" } },
      required: ["id"],
    },
    mapa: { id: "p_id" },
  },
  {
    name: "criar_categoria",
    description:
      "Cria uma categoria nova no plano de contas. Use só quando a pessoa pedir ou quando a categoria realmente não existir " +
      "(lancar_despesa avisa e lista as existentes). Informe 'pai' para criar uma subcategoria.",
    rpc: "controlai_api_criar_categoria",
    inputSchema: {
      type: "object",
      properties: {
        nome: { type: "string", description: "Nome da categoria." },
        pai: { type: "string", description: "Categoria pai, para criar uma subcategoria. Opcional." },
      },
      required: ["nome"],
    },
    mapa: { nome: "p_nome", pai: "p_pai" },
  },
];

// ----------------------------------------------------------------- utilidades

function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function erroRpc(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/** Pega o token do fim do caminho (/controlai-mcp/ctl_xxx) ou de ?token=. */
function extraiToken(req: Request): string | null {
  const url = new URL(req.url);
  const doQuery = url.searchParams.get("token");
  if (doQuery && doQuery.startsWith("ctl_")) return doQuery;
  const partes = url.pathname.split("/").filter(Boolean);
  const ultima = partes[partes.length - 1];
  return ultima && ultima.startsWith("ctl_") ? ultima : null;
}

/** Chama a RPC do Postgres com a chave pública; o token é o que autoriza. */
async function chamaRpc(fn: string, params: Record<string, unknown>) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const texto = await resp.text();
  let dado: unknown = texto;
  try { dado = texto ? JSON.parse(texto) : null; } catch { /* mantém texto cru */ }
  if (!resp.ok) {
    const msg = (dado as { message?: string })?.message || `Erro ${resp.status} ao falar com o banco.`;
    throw new Error(msg);
  }
  return dado;
}

async function executaFerramenta(nome: string, args: Record<string, unknown>, token: string) {
  const f = FERRAMENTAS.find((x) => x.name === nome);
  if (!f) throw new Error(`Ferramenta desconhecida: ${nome}`);
  const params: Record<string, unknown> = { p_token: token };
  for (const [de, para] of Object.entries(f.mapa)) {
    const v = args?.[de];
    if (v !== undefined && v !== null && v !== "") params[para] = v;
  }
  return await chamaRpc(f.rpc, params);
}

// ------------------------------------------------------------------- JSON-RPC

async function trata(msg: Record<string, unknown>, token: string): Promise<unknown | null> {
  const { id, method, params } = msg as {
    id?: unknown; method?: string; params?: Record<string, unknown>;
  };
  const ehNotificacao = id === undefined || id === null;

  switch (method) {
    case "initialize": {
      const pedido = (params?.protocolVersion as string) || PROTOCOLO_PADRAO;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: pedido,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "controlai", version: VERSAO },
          instructions:
            "Controle de despesas pessoais do Controlaí. Valores em reais e categorias pelo nome. " +
            "Chame 'contexto' no início para saber quais categorias existem. Para 'quanto gastei este mês', use 'resumo_do_mes'.",
        },
      };
    }

    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // notificação: não se responde

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: FERRAMENTAS.map((f) => ({
            name: f.name,
            description: f.description,
            inputSchema: f.inputSchema,
          })),
        },
      };

    case "tools/call": {
      const nome = params?.name as string;
      const args = (params?.arguments as Record<string, unknown>) || {};
      try {
        const dado = await executaFerramenta(nome, args, token);
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: JSON.stringify(dado, null, 2) }] },
        };
      } catch (e) {
        // erro de ferramenta volta como resultado com isError, não como erro de
        // protocolo: assim o modelo lê a mensagem e se corrige sozinho
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: String((e as Error).message) }], isError: true },
        };
      }
    }

    case "resources/list":
      return { jsonrpc: "2.0", id, result: { resources: [] } };
    case "prompts/list":
      return { jsonrpc: "2.0", id, result: { prompts: [] } };

    default:
      if (ehNotificacao) return null;
      return erroRpc(id, -32601, `Método não suportado: ${method}`);
  }
}

// ---------------------------------------------------------------------- server

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const token = extraiToken(req);

  if (req.method === "GET") {
    // Não abrimos stream SSE. 405 é a resposta prevista pelo Streamable HTTP.
    return new Response(
      JSON.stringify({
        nome: "controlai-mcp",
        versao: VERSAO,
        comoUsar:
          "Servidor MCP do Controlaí. Use POST com JSON-RPC 2.0 e inclua o token da carteira no fim da URL: " +
          "/functions/v1/controlai-mcp/ctl_xxxxx (pegue o seu na aba IA do app).",
        tokenNaUrl: token ? "presente" : "ausente",
      }),
      { status: 405, headers: { ...CORS, "Content-Type": "application/json", Allow: "POST, OPTIONS" } },
    );
  }

  if (req.method !== "POST") {
    return json({ error: "Use POST." }, 405);
  }

  let corpo: unknown;
  try {
    corpo = await req.json();
  } catch {
    return json(erroRpc(null, -32700, "JSON inválido."), 400);
  }

  const lote = Array.isArray(corpo) ? corpo : [corpo];

  // Sem token não há o que fazer, mas o `initialize` ainda responde: assim o
  // cliente conecta e o erro aparece na primeira ferramenta, com texto claro.
  if (!token) {
    const respostas = lote
      .map((m) => {
        const msg = m as Record<string, unknown>;
        if (msg.id === undefined || msg.id === null) return null;
        return erroRpc(
          msg.id,
          -32001,
          "Token ausente na URL do conector. Ela precisa terminar com /controlai-mcp/ctl_... (pegue o seu na aba IA do Controlaí).",
        );
      })
      .filter(Boolean);
    return respostas.length ? json(Array.isArray(corpo) ? respostas : respostas[0]) : new Response(null, { status: 202, headers: CORS });
  }

  const respostas: unknown[] = [];
  for (const m of lote) {
    const r = await trata(m as Record<string, unknown>, token);
    if (r !== null) respostas.push(r);
  }

  if (respostas.length === 0) return new Response(null, { status: 202, headers: CORS });
  return json(Array.isArray(corpo) ? respostas : respostas[0]);
});
