# Preparação da assinatura Premium

O código define um único plano mensal recorrente de **R$ 15,00 (BRL)**. O chat de texto do Thonic continua gratuito; o Premium habilita a interpretação de imagens e arquivos. Nenhum segredo Stripe ou chave administrativa Supabase deve ser colocado no navegador, em `VITE_` ou no Git.

## Configuração Stripe

1. No Stripe, crie o produto **Riff Theory Premium** e um preço recorrente de **R$ 15,00 a cada mês**, em BRL. Copie o identificador `price_...` para `STRIPE_PRICE_ID`. O servidor confere moeda, valor, status ativo e recorrência mensal antes de abrir o checkout.
2. Ative a configuração padrão do Customer Portal no Stripe. Habilite a atualização do meio de pagamento e o cancelamento da assinatura; o servidor só oferece o gerenciamento quando essa configuração está ativa no mesmo modo Test/Live da chave Stripe.
3. Crie no Workbench um destino de webhook para `https://www.rifftheory6.com.br/api/subscription/webhook`. Inscreva estes eventos: `customer.subscription.created`, `customer.subscription.updated` e `customer.subscription.deleted`.
4. Configure no ambiente **server-side** da Vercel, para Preview e Production conforme os testes: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`, `SUPABASE_SERVICE_ROLE_KEY` e `APP_URL`. Para Production, `APP_URL` deve ser `https://www.rifftheory6.com.br`. O servidor também precisa de `SUPABASE_URL` e `SUPABASE_ANON_KEY`, usados pela autenticação atual. Mantenha `STRIPE_WEBHOOK_VERIFIED` ausente ou `false` até concluir o teste ponta a ponta descrito abaixo. Nunca use prefixo `VITE_` nos segredos Stripe ou na service-role key.
5. Use primeiro as chaves de teste `sk_test_...` e o preço de teste do Stripe; depois configure o preço, chave e destino de webhook do modo Live. A checagem de prontidão só habilita o Checkout quando `STRIPE_WEBHOOK_VERIFIED=true`, o preço de R$ 15/mês, o destino ativo com os três eventos e o acesso administrativo ao usuário Supabase estão válidos e no mesmo modo Test/Live. Volte o marcador para `false` sempre que trocar o segredo ou o destino do webhook, até repetir o teste.

A listagem de endpoints Stripe não retorna o segredo de assinatura já existente, portanto o servidor não consegue provar sozinho que `STRIPE_WEBHOOK_SECRET` corresponde ao destino. Antes de habilitar o Checkout em cada modo, conclua uma assinatura em modo de teste com a conta de teste do app; confira no Dashboard Stripe que o evento de assinatura foi entregue com HTTP 200 e que o Premium foi habilitado. Cancele a assinatura de teste pelo Portal e confirme que o evento posterior remove o acesso. Só então marque `STRIPE_WEBHOOK_VERIFIED=true` para aquele ambiente. Faça o mesmo teste com os valores de produção antes de marcar Live como verificado e anunciar a cobrança como ativa.

Quando o webhook confirma uma assinatura `active` ou `trialing`, o servidor atualiza `app_metadata.plan` para `premium`. O endpoint de status e cada envio de anexos também conferem no Stripe que existe uma assinatura atual, correspondente ao usuário e ainda dentro do período; falhas de verificação negam os anexos. O frontend não ativa Premium pelo endereço de retorno do Checkout. O chat textual continua gratuito.

## Referências oficiais

- Stripe, [Build a subscriptions integration with Checkout](https://docs.stripe.com/payments/checkout/build-subscriptions): preço, Checkout, provisionamento a partir de eventos e Customer Portal.
- Stripe, [List webhook endpoints](https://docs.stripe.com/api/webhook_endpoints/list): URL, status, modo e eventos recebidos pelo destino. O segredo só é retornado quando o endpoint é criado.
- Stripe, [List customer portal configurations](https://docs.stripe.com/api/customer_portal/configurations/list): estado ativo, configuração padrão e recursos habilitados.
- Stripe, [Webhooks](https://docs.stripe.com/webhooks?lang=node): verificação da assinatura do evento com o corpo bruto da requisição.
- Stripe, [Create a portal session](https://docs.stripe.com/api/customer_portal/sessions/create): criar sessão autenticada do Billing Portal e definir a URL de retorno.
- Supabase, [Auth Admin updateUserById](https://supabase.com/docs/reference/javascript/auth-admin-updateuserbyid): a service-role key e atualizações administrativas são somente server-side.
