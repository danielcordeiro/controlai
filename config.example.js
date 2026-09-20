// Modelo de configuração. Copie para config.js e preencha com os dados do seu
// projeto Supabase (Project Settings → API). A publishable/anon key é pública
// por design (o acesso é protegido por RLS + funções SECURITY DEFINER), então
// pode ser versionada.
window.CONTROLAI_CONFIG = {
  SUPABASE_URL: "https://SUA_REF.supabase.co",
  SUPABASE_ANON_KEY: "SUA_PUBLISHABLE_OU_ANON_KEY",

  // Opcional: card "me paga um café" no fim da aba Mês. Sem este bloco, o card
  // não aparece. Use `key` para uma chave Pix avulsa ou `payload` para um
  // Pix copia e cola completo (payload tem prioridade).
  // PIX: { key: "SUA_CHAVE_PIX", name: "Apoie o Controlaí" },
};
