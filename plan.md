# Plano de implementação — melhorias do roadmap

## Objetivo
Transformar os itens do TODO em uma primeira versão funcional, prática e testável dentro de uma nova área **Prática**, sem remover as ferramentas existentes.

## Direção de produto
- **Experiência:** estúdio editorial de guitarra, direto ao instrumento.
- **Princípios:** uma próxima ação clara, teoria ligada a som e execução, progressão visível e conteúdo organizado por contexto.
- **Paleta/interação:** reutilizar tokens e componentes existentes; cartões curtos, botões de ação e áudio iniciado por ação explícita do usuário.

## Entregas
1. **Prática guiada e base:** rotas de iniciante, progresso modular, exercícios e badge beta.
2. **Acordes práticos:** voicings alternativos, comparação de uso e reprodução de som.
3. **Harmonia aplicada:** tonalidade, campo harmônico, progressões sugeridas e relação escala–acorde.
4. **Improviso:** notas-alvo, caminhos guiados, arpejos e sobreposições de escalas.
5. **Especialização:** estilos, guia de timbres e orientações de equipamento.
6. **Avançado e ouvido:** conteúdos aprofundados e exercício de identificação auditiva.

## Estrutura
- `src/components/pages/Pratica.jsx`: página e interações dos módulos.
- `src/components/pages/praticaData.js`: catálogo curado e funções musicais da área.
- `src/assets/css/13-pratica.css`: estilos isolados da nova área.
- `src/App.jsx`: entrada da página na navegação.
- `TODO.md`: status atualizado somente após validação do build.

## Restrições
- Não alterar o fluxo de login, avaliações ou chatbot; as mudanças no Supabase ficam limitadas ao monitor de acessos já aprovado.
- Não introduzir dependências novas para os itens do roadmap; a assinatura Premium adiciona apenas o SDK oficial `stripe` para Checkout e verificação de webhooks.
- Manter a cascata CSS modular e a interface em português.
- Áudio deve ser local via Web Audio API, sem enviar dados para servidor.

## Atualização de escopo — monitor de acessos (15/10/2026)
- Manter a contagem consentida por identificador aleatório de navegador, sem usar contas Google para identificar visitantes.
- Remover a gravação direta do cliente; aceitar gravações apenas via Edge Function com validação server-side do Cloudflare Turnstile, assinatura HMAC do identificador e limites por dispositivo.
- O Riff Theory não coleta, armazena nem deriva IP. A Cloudflare pode processar dados técnicos da conexão ao executar o desafio.
- Exibir totais por dia de São Paulo, navegadores pseudônimos únicos, sessões e média de entradas por navegador; preservar o histórico em vez de apagar contadores na virada do dia.
- Exigir consentimento opcional; recusar ou revogar continua permitindo o uso do site.

## Assinatura Premium — R$ 15/mês
- **Oferta inicial:** assinatura recorrente mensal em BRL por R$ 15; não exibir plano anual. Manter o chat básico de texto gratuito e reservar a interpretação de imagens e arquivos para assinantes, conforme a decisão anterior do proprietário.
- **Interface:** criar uma janela modal responsiva e acessível, acionável pelo comparativo de planos da página inicial e pela área do Thonic. Mostrar preço, cobrança recorrente, status da assinatura, opção de entrar com Google, assinar e gerenciar/cancelar a assinatura.
- **Pagamento:** criar sessões Stripe Checkout `subscription` somente no servidor; vincular o Checkout e a assinatura à identidade Supabase autenticada. Criar também sessão do Stripe Billing Portal para consulta/cancelamento.
- **Ativação:** implementar webhook Stripe com verificação de assinatura sobre o corpo bruto e sincronizar `app_metadata.plan` somente com o status atual confirmado da assinatura. O servidor, nunca o navegador ou os parâmetros de retorno, decide se o usuário é Premium.
- **Estrutura:** usar as rotas Vercel `api/subscription/checkout.js`, `portal.js`, `status.js` e `webhook.js`; centralizar validação e integração Stripe em `api/subscription/shared.js`; reutilizar Supabase Auth atual. A referência mensal de preço é `STRIPE_PRICE_ID`, configurada com R$ 15/mês no Stripe.
- **Configuração de implantação:** manter `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID` e `SUPABASE_SERVICE_ROLE_KEY` somente no ambiente server-side da Vercel. Documentar o endpoint e os eventos Stripe necessários. Não gravar nem solicitar segredos no chat ou no repositório.
- **Compatibilidade:** manter as ferramentas abertas e o chat de texto disponíveis para usuários gratuitos. Preservar a validação Premium server-side já existente em `api/chat.js` para anexos.
