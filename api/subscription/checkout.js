const {
    PREMIUM_PRODUCT_MARKER,
    checkCheckoutReadiness,
    createAdminClient,
    getAppOrigin,
    getStripeClient,
    getPremiumSubscriptionState,
    methodNotAllowed,
    requireUser,
    sendJson,
} = require("./shared");

const TERMINAL_SUBSCRIPTION_STATUSES = new Set(["canceled", "incomplete_expired"]);

async function saveCheckoutMetadata(adminClient, userId, updates, removals = []) {
    const { data, error: lookupError } = await adminClient.auth.admin.getUserById(userId);
    if (lookupError || !data?.user) throw lookupError || new Error("checkout_user_unavailable");
    const nextMetadata = { ...(data.user.app_metadata || {}), ...updates };
    for (const key of removals) delete nextMetadata[key];
    const { error } = await adminClient.auth.admin.updateUserById(userId, { app_metadata: nextMetadata });
    if (error) throw error;
    return nextMetadata;
}

function createCheckoutHandler(dependencies = {}) {
    const authenticate = dependencies.requireUser || requireUser;
    const stripeFactory = dependencies.getStripeClient || getStripeClient;
    const originFactory = dependencies.getAppOrigin || getAppOrigin;
    const adminFactory = dependencies.createAdminClient || createAdminClient;
    const readinessCheck = dependencies.checkCheckoutReadiness || checkCheckoutReadiness;

    return async function checkoutHandler(req, res) {
        if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

        const auth = await authenticate(req);
        if (!auth.user) return sendJson(res, auth.status || 401, { erro: auth.erro || "Entre com sua conta para continuar." });

        const stripe = stripeFactory();
        const priceId = (process.env.STRIPE_PRICE_ID || "").trim();
        const origin = originFactory();
        const adminClient = adminFactory();
        if (!stripe || !priceId || !origin || !adminClient) {
            return sendJson(res, 503, { erro: "A assinatura ainda não está configurada para este ambiente." });
        }

        try {
            const readiness = await readinessCheck({
                stripe,
                adminClient,
                userId: auth.user.id,
                origin,
                priceId,
            });
            if (!readiness?.ready || !readiness.adminUser) {
                return sendJson(res, 503, {
                    erro: "O Checkout ainda não está pronto. Verifique o preço mensal, o webhook Stripe e a conexão administrativa do Supabase.",
                });
            }

            let appMetadata = readiness.adminUser.app_metadata || {};
            const subscriptionStatus = appMetadata.stripe_subscription_status;
            const hasNonterminalSubscription = Boolean(
                appMetadata.stripe_subscription_id &&
                !TERMINAL_SUBSCRIPTION_STATUSES.has(subscriptionStatus)
            );
            const recordedSubscription = appMetadata.plan === "premium" || hasNonterminalSubscription;
            const customerId = typeof appMetadata.stripe_customer_id === "string"
                ? appMetadata.stripe_customer_id
                : "";
            if (recordedSubscription && !customerId.startsWith("cus_")) {
                return sendJson(res, 409, {
                    erro: "Já existe uma assinatura ou tentativa de cobrança para esta conta. Gerencie a assinatura ou aguarde a confirmação antes de tentar novamente.",
                });
            }
            if (customerId.startsWith("cus_")) {
                let subscriptionState;
                try {
                    subscriptionState = await getPremiumSubscriptionState(stripe, {
                        id: auth.user.id,
                        app_metadata: appMetadata,
                    });
                } catch {
                    return sendJson(res, 503, { erro: "Não foi possível confirmar sua assinatura atual. Tente novamente." });
                }
                if (subscriptionState.hasActive || subscriptionState.hasNonterminal) {
                    return sendJson(res, 409, {
                        erro: "Já existe uma assinatura ou tentativa de cobrança para esta conta. Gerencie a assinatura ou aguarde a confirmação antes de tentar novamente.",
                    });
                }
                if (recordedSubscription) {
                    const previousAttempt = Number(appMetadata.stripe_checkout_attempt);
                    const nextAttempt = Number.isSafeInteger(previousAttempt) && previousAttempt >= 0
                        ? Math.min(previousAttempt + 1, Number.MAX_SAFE_INTEGER)
                        : 1;
                    appMetadata = await saveCheckoutMetadata(
                        adminClient,
                        auth.user.id,
                        { plan: "free", stripe_cancel_at_period_end: false, stripe_checkout_attempt: nextAttempt },
                        [
                            "stripe_subscription_id",
                            "stripe_subscription_status",
                            "premium_until",
                            "stripe_checkout_session_id",
                            "stripe_checkout_session_expires_at",
                        ]
                    );
                }
            }

            const pendingSessionId = typeof appMetadata.stripe_checkout_session_id === "string"
                ? appMetadata.stripe_checkout_session_id
                : "";
            let attempt = Number.isSafeInteger(Number(appMetadata.stripe_checkout_attempt))
                ? Math.max(0, Number(appMetadata.stripe_checkout_attempt))
                : 0;

            if (pendingSessionId) {
                const pendingSession = await stripe.checkout.sessions.retrieve(pendingSessionId);
                const expiresAt = Number(pendingSession?.expires_at) || 0;
                if (
                    pendingSession?.status === "open" &&
                    expiresAt > Math.floor(Date.now() / 1000) &&
                    typeof pendingSession.url === "string" &&
                    pendingSession.url.startsWith("https://")
                ) {
                    return sendJson(res, 200, { url: pendingSession.url, reused: true });
                }
                if (pendingSession?.status === "complete") {
                    return sendJson(res, 409, {
                        erro: "Este Checkout já foi concluído. Estamos aguardando a confirmação segura da assinatura; atualize o status antes de iniciar outra cobrança.",
                    });
                }
                if (pendingSession?.status !== "expired" && pendingSession?.status !== "open") {
                    return sendJson(res, 503, { erro: "Não foi possível confirmar sua tentativa anterior de Checkout." });
                }

                attempt = Math.min(attempt + 1, Number.MAX_SAFE_INTEGER);
                appMetadata = await saveCheckoutMetadata(
                    adminClient,
                    auth.user.id,
                    { stripe_checkout_attempt: attempt },
                    ["stripe_checkout_session_id", "stripe_checkout_session_expires_at"]
                );
            }

            const email = typeof auth.user.email === "string" ? auth.user.email.trim() : "";
            const name = typeof auth.user.user_metadata?.full_name === "string"
                ? auth.user.user_metadata.full_name.trim()
                : "";
            const buyerMetadata = {
                user_id: auth.user.id,
                riff_theory_user_id: auth.user.id,
                riff_theory_product: PREMIUM_PRODUCT_MARKER,
                ...(email ? { customer_email: email } : {}),
                ...(name ? { customer_name: name } : {}),
            };
            const checkoutData = {
                mode: "subscription",
                line_items: [{ price: priceId, quantity: 1 }],
                success_url: `${origin}/?subscription=success`,
                cancel_url: `${origin}/?subscription=cancelled`,
                client_reference_id: auth.user.id,
                allow_promotion_codes: true,
                locale: "pt-BR",
                metadata: buyerMetadata,
                subscription_data: { metadata: buyerMetadata },
                custom_text: {
                    submit: {
                        message: "Assinatura recorrente de R$ 15 por mês. Você pode gerenciar ou cancelar pelo portal de assinatura.",
                    },
                },
            };

            if (customerId.startsWith("cus_")) checkoutData.customer = customerId;
            else if (email) checkoutData.customer_email = email;

            const session = await stripe.checkout.sessions.create(checkoutData, {
                idempotencyKey: `riff-premium-${auth.user.id}-${attempt}`,
            });
            if (typeof session?.url !== "string" || !session.url.startsWith("https://") || typeof session.id !== "string") {
                return sendJson(res, 502, { erro: "Não foi possível iniciar o checkout agora." });
            }

            await saveCheckoutMetadata(adminClient, auth.user.id, {
                stripe_checkout_attempt: attempt,
                stripe_checkout_session_id: session.id,
                stripe_checkout_session_expires_at: Number(session.expires_at) || null,
            });
            return sendJson(res, 200, { url: session.url });
        } catch (error) {
            console.error("Falha ao criar checkout Premium:", error?.type || error?.name || "stripe_error");
            return sendJson(res, 502, { erro: "Não foi possível iniciar o checkout agora. Tente novamente." });
        }
    };
}

module.exports = createCheckoutHandler();
module.exports.createCheckoutHandler = createCheckoutHandler;
