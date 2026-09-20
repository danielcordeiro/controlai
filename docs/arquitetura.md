# Controlaí — arquitetura e decisões

**Data:** 19/09/2026
**Stack:** HTML + CSS + ES modules (sem build) no GitHub Pages · Supabase (Postgres 17)
**Projeto Supabase:** `wkuykhomucxskelbcpmi` — o **mesmo do Rachaí**

---

## 1. Por que este formato

O Rachaí provou que dá para entregar um app útil com front estático e Postgres,
sem servidor para manter. O Controlaí repete a receita e reaproveita o design
system, os helpers de UI e o modelo de segurança. O que muda é o domínio:
em vez de dividir conta entre pessoas, é **acompanhar o próprio gasto mensal**.

---

## 2. Convivência com o Rachaí no mesmo Supabase

O schema `public` já é do Rachaí: `events`, `people`, **`expenses`**, **`payments`**,
`add_expense()`, `get_event()` etc. Colidir ali seria fácil e caro.

Decisão:

| O quê | Onde | Por quê |
|---|---|---|
| Tabelas | schema **`controlai`** | fora do `public`, sem risco de colisão; o PostgREST **não expõe** esse schema, então a API sequer enxerga as tabelas |
| Funções RPC | `public.controlai_*` | o PostgREST só chama funções em schema exposto; o prefixo evita ambiguidade com as do Rachaí |
| Analytics | `public.track()` do Rachaí | não vale uma tabela nova; os eventos vão prefixados (`controlai:pageview`) e os relatórios foram separados: `analytics_summary()` exclui `controlai:%` e `controlai_analytics_summary()` só olha para eles |

Nada de dado do Rachaí foi alterado. A única função dele que mudou foi
`analytics_summary()`, que passou a **excluir** os eventos do Controlaí — sem
isso os totais dos dois apps somavam e inflavam o relatório do Rachaí.

---

## 3. Modelo de dados

```
controlai.ledger          carteira (a unidade de acesso)
  id uuid pk              ← a chave portadora: quem tem o link, entra
  name, email             ← e-mail só para recuperar o id
  created_at, last_seen_at

controlai.ledger_email    todo e-mail já registrado na carteira
  (ledger_id, email) pk   ← trocar o e-mail não tira a recuperação do dono

controlai.category        plano de contas, até 2 níveis
  id, ledger_id, parent_id (self-FK, null = 1º nível)
  name, color, sort_order, archived
  unique (ledger_id, coalesce(parent_id, zero-uuid), lower(name))

controlai.payment_method  forma de pagamento (opcional na despesa)
  id, ledger_id, name, sort_order, archived

controlai.expense         a despesa
  id, ledger_id
  spent_on date           ← obrigatória
  amount_cents integer    ← > 0, sempre em centavos inteiros
  category_id             ← obrigatória, ON DELETE RESTRICT
  payment_method_id       ← OPCIONAL, ON DELETE SET NULL
  description, created_at, updated_at
  index (ledger_id, spent_on desc)   ← a consulta quente: um mês de uma carteira
  recurring_id, recurring_month      ← preenchidos só quando veio de uma fixa
  unique (recurring_id, recurring_month) where recurring_id is not null

controlai.recurring       a despesa fixa — uma REGRA, não lançamentos futuros
  id, ledger_id
  description, amount_cents, category_id, payment_method_id
  dia integer             ← 1..31; mês sem esse dia usa o último
  mes_inicio text         ← 'AAAA-MM', primeiro mês em que aparece
  total_meses integer     ← null = indeterminado (até cancelar)
  cancelado_em text       ← 'AAAA-MM': não gera deste mês em diante
  created_at

controlai.recurring_skip  "apaguei a ocorrência deste mês"
  (recurring_id, month_key) pk
```

**Centavos inteiros** (convenção herdada do Rachaí): nenhum `float` no caminho do
dinheiro, a soma sempre fecha.

**Categoria obrigatória, forma opcional** — exatamente o que o produto pede. A
forma de pagamento é uma dimensão secundária de análise, não um bloqueio no
lançamento.

**Arquivar em vez de excluir**: categoria com histórico não pode ser apagada
(`controlai_del_categoria` recusa e explica). Arquivada, some do formulário e
continua explicando os meses passados.

### Despesa fixa: geração sob demanda, nunca no futuro

A alternativa óbvia — criar as 12 despesas de uma vez — foi descartada por três
motivos concretos:

1. **O mês que vem apareceria pré-gasto.** O app existe para responder "quanto
   gastei", e um outubro com R$ 1.500 de aluguel antes de outubro chegar é uma
   resposta errada.
2. **Corrigir o valor viraria um mutirão.** O aluguel reajusta; com lançamentos
   materializados seria preciso varrer e reescrever cada um.
3. **"Até eu cancelar" não tem fim** — não existe número de linhas a criar.

Então a ocorrência nasce quando o mês é aberto: `controlai_mes` chama
`controlai._gerar_fixas(ledger, mes)`, que é a única coisa que materializa
lançamento de fixa. Ela:

- **retorna imediatamente se o mês pedido é futuro** — a regra que impede o mês
  que vem de chegar pré-gasto;
- é **idempotente**: o índice único `(recurring_id, recurring_month)` e a checagem
  prévia garantem uma ocorrência por fixa por mês, quantas vezes rodar;
- respeita o **skip**: apagar o lançamento de julho grava `(fixa, '2026-07')` em
  `recurring_skip`, e julho não volta;
- **grampeia o dia**: 31 num mês de 30 vira o dia 30, e a ocorrência do mês
  corrente nunca nasce com data futura (cai em hoje).

Cancelar grava `cancelado_em` = mês que vem, então para de gerar dali em diante
sem apagar nada. **Reativar** não pode simplesmente limpar essa marca: os meses
em que a fixa esteve parada viram `recurring_skip` antes, senão a próxima
abertura do app faria meses já fechados brotarem com lançamentos que nunca
foram pagos. **Excluir** apaga só a regra e solta as ocorrências
(`recurring_id` vira nulo): exigir "zero lançamentos" deixaria o botão inútil
para sempre, porque a ocorrência do mês corrente nasce junto com a fixa.

Duas armadilhas resolvidas na revisão:

- **Mudar a data de uma ocorrência para outro mês.** O lançamento continuaria
  marcado como "a ocorrência de setembro" estando em agosto: setembro nunca mais
  seria gerado e agosto ficaria com dois. `controlai._solta_da_fixa` desfaz o
  vínculo e marca o mês de origem como pulado.
- **Quem só fala com o app pela IA.** A geração era disparada só por
  `controlai_mes`, então o conector respondia o total do mês sem nenhuma fixa,
  e o mesmo mês mudava de valor quando a pessoa abria a tela. Agora
  `controlai._catchup_fixas` roda também em `contexto`, `resumo` e `listar`, e
  põe em dia todos os meses pendentes de uma vez — `ledger.fixas_ate` guarda até
  onde já foi, para não varrer o histórico a cada abertura.

Na tela, os atalhos `3x/6x/12x/24x/até eu cancelar` cobrem o caso comum e
`outro` abre um campo livre. O campo livre não é luxo: a IA cria fixa com
qualquer número de meses, e sem ele abrir uma fixa de 7 meses para editar não
acenderia chip nenhum — a pessoa não saberia dizer o que está valendo.

O preço dessa escolha: quem não abre o app por três meses só vê os três meses
materializados quando voltar. Como as ocorrências passadas são geradas ao abrir
cada mês, o histórico fica correto de qualquer forma.

---

## 4. Segurança

Quatro camadas, da mais externa para a mais interna:

1. **Schema não exposto.** `controlai` não está na lista de schemas do PostgREST.
   `GET /rest/v1/expense` com `Accept-Profile: controlai` responde
   *"Invalid schema: only public, graphql_public are exposed"*.
2. **RLS ligada, sem policy.** Nenhuma linha é legível/gravável por `anon`.
3. **Gateway por função.** Só as `public.controlai_*` (`SECURITY DEFINER`,
   `set search_path = controlai, public`) têm `GRANT EXECUTE`. As funções
   internas (`controlai._ledger_ok` etc.) têm o execute revogado.
4. **Validação de posse dentro da função.** Toda mutação recebe o id da
   **carteira** além do id do objeto e confere o vínculo (`controlai._pertence`).
   Conhecer o uuid de uma despesa ou categoria solta não permite alterá-la nem
   apagá-la — verificado: a carteira B recebe *"Este registro não é desta
   carteira."* ao tentar apagar despesa da carteira A.
5. **`EXECUTE` revogado de `PUBLIC`.** No Postgres a função nasce aberta para
   `PUBLIC`; o grant para `anon` não tirava isso. Agora só `anon` e
   `authenticated` executam, e `search_path` é fixo com `pg_temp` em todas.
6. **Revogação do link.** `controlai_rotacionar_id` troca o uuid (cascata leva
   despesas e categorias junto) — é a única forma de derrubar um link vazado.

O UUID v4 da carteira é a credencial (122 bits — não se adivinha). É o mesmo
modelo de "link secreto" do Rachaí, e está declarado na UI: *"quem tem o link,
abre a carteira"*.

### Recuperação do ID — o ponto delicado

Mostrar o UUID para quem digita um e-mail seria um furo: qualquer um que soubesse
o e-mail leria as despesas. Por isso o e-mail precisa ser **provado**:

```
usuário digita e-mail
   → supabase.auth.signInWithOtp()        (link mágico e/ou código de 6 dígitos)
   → usuário abre o e-mail e volta autenticado
   → controlai_meus_ids() lê auth.jwt()->>'email'   ← do token, não do formulário
   → devolve as carteiras daquele e-mail
```

Sem sessão, a função levanta *"Confirme o e-mail para recuperar seus IDs."*
(verificado: chamada anônima é recusada).

**Configuração necessária no Supabase** (uma vez, no painel):
- *Authentication → URL Configuration → Redirect URLs*: incluir
  `https://danielcordeiro.github.io/controlai/**`. Sem isso o link mágico volta
  para a Site URL do projeto (que é do Rachaí).
- *Authentication → Email Templates → Magic Link*: incluir `{{ .Token }}` se quiser
  que o e-mail traga também o código de 6 dígitos. O app aceita os dois caminhos
  (link e código), então isso é opcional.
- O SMTP embutido do Supabase limita a poucos e-mails por hora. Para uso real,
  configurar SMTP próprio.

---

## 5. API para IA e conector MCP

O app expõe as despesas para uma IA por dois caminhos, ambos autenticados por um
**token próprio da carteira** (`ctl_...`), guardado em `controlai.ledger.api_token`
e **separado do UUID do link**. Rotacionar um não derruba o outro: revogar o
acesso da IA não invalida o seu link, e trocar o link não desconecta a IA.

### Por que uma API separada em vez de reusar as RPCs do app
As RPCs do app falam em `uuid` e centavos. Uma IA recebe *"gastei 62 no mercado"*.
As `controlai_api_*` falam a língua do meio: **valor em reais**, **categoria pelo
nome**, data opcional. O casamento de categoria é sem acento e por prefixo ou
trecho (`alimentacao`, `morad`, e `credito` acha "Cartão de crédito"), e quando
não acha **erra listando as existentes** em vez
de criar uma nova — categoria nascida de erro de digitação some do relatório e
estraga justamente o número que o app existe para mostrar.

| Função | Para quê |
|---|---|
| `controlai_api_contexto` | categorias, subcategorias, formas, hoje e mês atual |
| `controlai_api_lancar` | valor em reais, categoria por nome, data e forma opcionais |
| `controlai_api_resumo` | total do mês por categoria e por forma, com o mês anterior |
| `controlai_api_listar` | lançamentos do mês com id, para editar ou apagar |
| `controlai_api_editar` / `apagar` | alteram só o que foi informado |
| `controlai_api_criar_fixa` | despesa fixa: `meses` para um número de repetições, omitido para "até cancelar" |
| `controlai_api_listar_fixas` | as fixas com valor, dia, quantas foram lançadas e se estão ativas |
| `controlai_api_editar_fixa` | muda a série daqui para frente (`ate_cancelar` tira o prazo) |
| `controlai_api_cancelar_fixa` | para de lançar do mês que vem; o histórico continua |
| `controlai_api_criar_categoria` | quando a pessoa realmente quer uma nova |
| `controlai_get_api_token` / `rotate_api_token` | chamadas pelo app, recebem o uuid da carteira |

### Conector no claude.ai
GitHub Pages é estático e não hospeda MCP, então o servidor é uma **Supabase Edge
Function** no mesmo projeto: `supabase/functions/controlai-mcp/`. Transporte
Streamable HTTP, JSON-RPC 2.0, respostas JSON diretas (sem SSE — `GET` devolve
405, que é o previsto).

O token vai **no fim da URL** do conector:

```
https://<ref>.supabase.co/functions/v1/controlai-mcp/ctl_xxxxxxxx
```

`verify_jwt` fica **desligado** porque o claude.ai não manda chave do Supabase: a
autenticação é esse token, validado dentro da função pela `controlai._por_token`.
É a mesma chave portadora do link da carteira, e está escrito na tela que a URL
deve ser tratada como senha.

As instruções do servidor dizem explicitamente que gasto que se repete todo mês é
`criar_fixa`, não uma despesa lançada doze vezes — sem isso o modelo tende a
resolver "todo mês pago 1500 de aluguel" com um laço de `lancar_despesa`, que é
justamente o que a seção 3 descarta.

Erro de ferramenta volta como `isError` com o texto da exceção, não como erro de
protocolo — assim o modelo lê *"Categoria X não existe. Disponíveis: ..."* e se
corrige sozinho em vez de desistir.

## 6. Exportação para Excel

`js/xlsx.js` gera um `.xlsx` **de verdade**, sem dependência: um ZIP (modo
*stored*, que dispensa deflate) com os XMLs do OOXML. CSV continua disponível,
mas deixou de ser o padrão porque no Excel em português ele vira uma coluna só e
o valor entra como texto — não dá para somar nem montar tabela dinâmica.

A planilha sai com data como **data**, valor como **moeda**, cabeçalho congelado,
filtro automático e **categoria e subcategoria em colunas separadas**, que é o
formato que serve para tabela dinâmica.

Os testes não confiam no gerador: eles **abrem o ZIP produzido**, conferem o CRC32
de cada parte e leem o XML da planilha. Fora isso, o `file` do sistema reconhece
o arquivo como *Microsoft Excel 2007+* e o `unzip -t` passa sem erro.

## 7. RPCs

| Função | Para quê |
|---|---|
| `controlai_criar(name, email)` | cria a carteira e **semeia** 10 categorias e 5 formas de pagamento, para a pessoa já sair lançando |
| `controlai_mes(ledger, mes)` | **uma chamada** devolve tudo da tela: carteira, categorias, formas, despesas do mês, fixas, total do mês, total do mês anterior e os meses com lançamento. É também o gatilho que materializa as ocorrências das fixas daquele mês |
| `controlai_meus_ids()` | recuperação (lê o e-mail do JWT) |
| `controlai_add_despesa` / `update` / `del` | CRUD da despesa, com as validações de posse e de data futura |
| `controlai_add_categoria` / `update` / `del` | plano de contas (impede subcategoria de subcategoria) |
| `controlai_add_forma` / `update` / `del` | formas de pagamento |
| `controlai_add_fixa` / `update_fixa` | cria e edita a despesa fixa (a edição vale daqui para frente) |
| `controlai_cancelar_fixa` / `reativar_fixa` / `del_fixa` | cancelar para de gerar do mês que vem; reativar não ressuscita o período parado; excluir tira a regra e mantém o histórico |
| `controlai_renomear` / `set_email` | ajustes da carteira (o e-mail antigo continua valendo) |
| `controlai_rotacionar_id(ledger)` | troca o uuid: a única revogação possível de um link vazado |
| `controlai_apagar(ledger, confirmacao)` | exclusão self-service, com o id repetido como confirmação |
| `controlai_exportar(ledger)` | todas as despesas; o CSV é montado no navegador |
| `controlai_analytics_summary(dias)` | uso do app (service_role); `analytics_summary` voltou a contar só o Rachaí |

O snapshot de mês em **uma chamada** é deliberado: a tela inteira (total, rosca,
barras, lista, comparação) é desenhada de um JSON só, sem N+1 de rede.

---

## 8. Front

```
js/ui.js       DOM, dinheiro em centavos (parse pt-BR/en-US), datas e meses, toast, CSV download
js/report.js   agregações PURAS: por categoria (com rollup pai/filho), por forma,
               por dia, maiores despesas, CSV
js/db.js       wrapper das RPCs + fluxo de Auth da recuperação
js/xlsx.js     gerador de .xlsx (ZIP stored + OOXML), puro e testado
js/app.js      rotas (#/ · #/c/<uuid> · #/recuperar), telas e formulários
```

`report.js` e os helpers de `ui.js` são puros e cobertos por `tests/unit.mjs`
(**162 verificações**): conversão de valor, aritmética de meses (virada de ano,
bissexto), rollup de subcategoria, despesa órfã que não some do total, ida e
volta de formatação.

**Rollup pai/filho:** o relatório soma a subcategoria no pai e só mostra o
detalhamento quando o valor do pai vem de mais de uma origem — categoria folha
não ganha uma linha redundante repetindo a si mesma.

---

## 9. Verificação feita

- `npm test` — 162/162 (inclui um leitor de ZIP que confere o CRC32 de cada parte do .xlsx gerado).
- RPCs testadas via REST com a publishable key (criar, lançar com e sem forma de
  pagamento, snapshot, validações de valor zero, data futura, categoria de outra
  carteira, e-mail inválido, carteira inexistente).
- Segurança: leitura direta das tabelas recusada nas duas formas (schema público
  e `Accept-Profile`); `controlai_meus_ids()` recusado sem sessão.
- Regressão do Rachaí: `get_event()` responde normalmente e as tabelas dele
  continuam bloqueadas.
- Navegador (Playwright, viewport de celular), local e **na URL pública**: criar
  carteira, folha de boas-vindas com o link, lançar despesa, criar categoria de
  dentro do formulário sem perder o que foi digitado, aba Mês com rosca/KPIs/
  barras, aba Despesas agrupada por dia, subcategoria, navegação entre meses com
  comparação, tela de recuperação e exclusão da carteira. Zero erro no console.
- Rotação de id e exclusão testadas ponta a ponta (link antigo deixa de abrir,
  dados preservados na rotação; cascata limpa tudo na exclusão).
- **Despesas fixas**, no banco: uma fixa de 3 meses começando em junho gerou
  junho, julho e agosto e **parou** — nada em setembro (limite atingido) nem em
  outubro (futuro); dia 31 caiu em 30/06; rodar a geração de novo não duplicou; e
  apagar a ocorrência de julho pelo caminho oficial não a fez voltar.
- **Despesas fixas**, no navegador: criar "Aluguel" de R$ 1.500 no dia 5 "até eu
  cancelar" lançou a ocorrência de setembro na hora, com o selo `fixa` na lista e
  a regra em Ajustes com editar, pausar e excluir.
- **Conector MCP** com as 10 ferramentas: `criar_fixa` (com número de meses e
  indeterminada), `listar_fixas` e `cancelar_fixa` por `curl` no endpoint
  publicado; id de outra carteira é recusado.
- **SQL versionado aplicado do zero** num Postgres 16 limpo, na ordem
  `schema.sql → fixas.sql → api-ia.sql`, e depois de novo por cima para conferir
  a idempotência. O teste funcional rodou nesse banco descartável.
- **Paridade repo × produção**: o md5 do corpo de cada uma das 49 funções (sem
  comentários nem espaços) bate entre o banco criado a partir dos `.sql`
  versionados e o banco real. O arquivo não é a intenção, é o que está rodando.
- **Cenários de fixa conferidos no banco descartável**: mover a ocorrência de
  setembro para agosto solta da série sem duplicar nem deixar buraco; apagar
  pelo conector grava o skip; cancelar em junho e reativar mantém junho e julho
  fora; excluir a regra preserva o lançamento; excluir categoria usada por fixa
  dá mensagem de gente.

### O que NÃO foi verificado
O **recebimento do e-mail de recuperação**. Falta um passo no painel do Supabase
(Redirect URLs) que exige acesso de dono, e não há caixa de entrada disponível
aqui para abrir o link. A lógica foi conferida (a RPC recusa sem sessão e lê o
e-mail do JWT), mas o ciclo "pedi o link → abri o e-mail → voltei autenticado"
continua por testar.

## 10. Achados da revisão adversarial e o que mudou

Duas rodadas de revisão por agentes independentes (segurança, front, números, UX,
aderência ao pedido) com verificação cética de cada achado. O que virou correção:

| Achado | Correção |
|---|---|
| Mutação aceitava só o id do objeto | toda RPC passou a exigir o id da carteira |
| Link mágico nunca autenticava (o boot apagava o token da URL antes do supabase-js lê-lo) | o boot espera a sessão resolver |
| `EXECUTE` estava aberto para `PUBLIC` | revogado; só `anon`/`authenticated` |
| Trocar o e-mail sequestrava a recuperação | histórico `ledger_email`: o antigo continua valendo |
| Link nunca era entregue depois de criar | folha de boas-vindas com link, cópia e teste de recuperação |
| Botão de salvar ~600px abaixo do valor no celular | rodapé grudado no sheet |
| Modal sobrevivia à troca de rota | `router()` fecha as folhas |
| Resposta lenta vencia a mais recente | número de sequência por requisição |
| Mês trocava antes da resposta chegar | o mês só vale no sucesso |
| Projeção multiplicava o aluguel do dia 1 | só a partir do 7º dia |
| Percentuais somavam 101% | maior resto, fecham 100 |
| `hojeISO` usava o fuso do aparelho | `America/Sao_Paulo`, igual ao banco |
| Analytics inflava os números do Rachaí | relatórios separados |
| Erro do e-mail (`otp_expired`) caía sem explicação | mensagem real na tela |
| `＋ nova` categoria descartava o formulário | modal por cima, já seleciona a nova |
| Sem `role=dialog`, Esc, foco, rótulos, `aria-pressed` | tudo adicionado |
| `schema.sql` não migrava FK em banco existente | bloco `ALTER` idempotente |

## 10b. Segunda revisão adversarial (despesas fixas)

Cinco revisores por dimensão (SQL, segurança, front, conector, produto) e três
céticos por achado, cada um com uma lente diferente. Sobreviveram e viraram
correção:

| Achado | Correção |
|---|---|
| Editar a data de uma ocorrência para outro mês duplicava o destino e furava a origem para sempre | `controlai._solta_da_fixa` em `update_despesa` e `api_editar` |
| Reativar uma fixa fazia os meses parados nascerem retroativamente | reativar grava `recurring_skip` do período parado antes de limpar `cancelado_em` |
| `resumo` e `listar` da API nunca geravam as fixas: o conector respondia um mês sem elas | `_catchup_fixas` nas três leituras, com marcador `ledger.fixas_ate` |
| Excluir categoria usada só por uma fixa estourava o erro cru de FK | `del_categoria` checa `controlai.recurring` e explica |
| O botão de excluir fixa nunca funcionava: a ocorrência do mês nasce junto com ela | excluir solta os lançamentos e preserva o histórico, com confirmação que diz isso |

Achados menores corrigidos no mesmo passo: `api_apagar` não gravava o skip,
`api_editar` aceitava data futura, o filtro de argumentos do MCP comia `false`,
`cancelar_fixa` aceitava mês malformado, `del_fixa` consultava sem o id da
carteira, `update_fixa` não validava `total_meses`, "faltam N" contava
lançamentos em vez de meses restantes, e o Enter repetido no campo Valor criava
duas fixas iguais.

---

## 11. O que ficou fora da v1

Orçamento/meta por categoria, despesa recorrente, receitas (o app é só de
despesa), múltiplas moedas e anexo de comprovante. OAuth no conector MCP também
ficou fora: para conector pessoal o claude.ai aceita servidor sem autenticação, e
o token na URL já é o mesmo nível de segredo do link da carteira. O modelo comporta todos —
nenhum exigiria migração destrutiva.
