const {
    getAppOrigin,
    getStripeClient,
    isBillingPortalConfigured,
    methodNotAllowed,
    requireUser,
    sendJson,
} = require("./shared");

function createPortalHandler(dependencies = {}) {
    const authenticate = dependencies.requireUser || requireUser;
    const stripeFactory = dependencies.getStripeClient || getStripeClient;
    const originFactory = dependencies.getAppOrigin || getAppOrigin;
    const portalReady = dependencies.isBillingPortalConfigured || isBillingPortalConfigured;

    return async function portalHandler(req, res) {
        if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

        const auth = await authenticate(req);
        if (!auth.user) return sendJson(res, auth.status || 401, { erro: auth.erro || "Entre com sua conta para continuar." });

        const stripe = stripeFactory();
        const origin = originFactory();
        const customerId = auth.user.app_metadata?.stripe_customer_id;
        if (!stripe || !origin || typeof customerId !== "string" || !customerId.startsWith("cus_")) {
            return sendJson(res, 503, { erro: "O gerenciamento de assinatura ainda não está disponível para esta conta." });
        }

        if (!await portalReady(stripe)) {
            return sendJson(res, 503, {
                erro: "O Portal de cobrança ainda não está pronto. Ative a configuração padrão com cancelamento e atualização de pagamento.",
            });
        }

        try {
            const portalSession = await stripe.billingPortal.sessions.create({
                customer: customerId,
                return_url: `${origin}/?subscription=manage`,
                locale: "auto",
            });
            if (typeof portalSession?.url !== "string" || !portalSession.url.startsWith("https://")) {
                return sendJson(res, 502, { erro: "Não foi possível abrir o gerenciamento da assinatura." });
            }
            return sendJson(res, 200, { url: portalSession.url });
        } catch (error) {
            console.error("Falha ao criar sessão do Billing Portal:", error?.type || error?.name || "stripe_error");
            return sendJson(res, 502, { erro: "Não foi possível abrir o gerenciamento agora. Tente novamente." });
        }
    };
}

module.exports = createPortalHandler();
module.exports.createPortalHandler = createPortalHandler;
