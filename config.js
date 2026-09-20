// Configuração do Controlaí.
// A "publishable key" do Supabase é pública por design — o acesso é protegido por
// RLS + funções SECURITY DEFINER (as tabelas moram no schema "controlai", que nem
// é exposto pela API). Por isso pode ficar versionada aqui.
// Mesmo projeto Supabase do Rachaí.
window.CONTROLAI_CONFIG = {
  SUPABASE_URL: "https://wkuykhomucxskelbcpmi.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_1fbD4ErD8Si-pS18ZUSvKA_8REzN256",

  // Apoio via Pix no rodapé da aba Mês. Mesma chave do Rachaí (aleatória,
  // pública por design). Sem este bloco, o card simplesmente não aparece.
  PIX: {
    key: "0e93184e-08d3-410b-a397-651a73653849",
    name: "Apoie o Controlaí",
  },
};
