const {
    checkCheckoutReadiness,
    createAdminClient,
    getAppOrigin,
    getStripeClient,
    hasActivePremiumSubscription,
    isBillingPortalConfigured,
    methodNotAllowed,
    requireUser,
    sendJson,
} = require("./shared");

function createStatusHandler(dependencies = {}) {
    const authenticate = dependencies.requireUser || requireUser;
    const stripeFactory = dependencies.getStripeClient || getStripeClient;
    const adminFactory = dependencies.createAdminClient || createAdminClient;
    const originFactory = dependencies.getAppOrigin || getAppOrigin;
    const readinessCheck = dependencies.checkCheckoutReadiness || checkCheckoutReadiness;
    const portalReady = dependencies.isBillingPortalConfigured || isBillingPortalConfigured;
    const premiumCheck = dependencies.hasActivePremiumSubscription || ((stripeClient, user) =>
        hasActivePremiumSubscription(stripeClient, user)
    );

    return async function statusHandler(req, res) {
        if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

        const auth = await authenticate(req);
        if (!auth.user) return sendJson(res, auth.status || 401, { erro: auth.erro || "Entre com sua conta para continuar." });

        const appMetadata = auth.user.app_metadata || {};
        const customerId = appMetadata.stripe_customer_id;
        const hasStripeCustomer = typeof customerId === "string" && customerId.startsWith("cus_");
        const stripe = stripeFactory();
        const origin = originFactory();
        const priceId = (process.env.STRIPE_PRICE_ID || "").trim();
        let premiumActive = appMetadata.plan === "premium";
        let checkoutConfigured = false;
        let canManageBilling = false;

        if (premiumActive) {
            try {
                premiumActive = await premiumCheck(stripe, auth.user);
            } catch {
                premiumActive = false;
            }
        }

        try {
            const [checkoutReadiness, portalConfigured] = await Promise.all([
                readinessCheck({
                    stripe,
                    adminClient: adminFactory(),
                    userId: auth.user.id,
                    origin,
                    priceId,
                }),
                hasStripeCustomer && stripe && origin
                    ? portalReady(stripe)
                    : Promise.resolve(false),
            ]);
            checkoutConfigured = Boolean(checkoutReadiness?.ready);
            canManageBilling = Boolean(hasStripeCustomer && origin && portalConfigured);
        } catch {
            checkoutConfigured = false;
            canManageBilling = false;
        }

        return sendJson(res, 200, {
            plan: premiumActive ? "premium" : "free",
            subscriptionStatus: premiumActive && typeof appMetadata.stripe_subscription_status === "string"
                ? appMetadata.stripe_subscription_status
                : null,
            premiumUntil: premiumActive && typeof appMetadata.premium_until === "string" ? appMetadata.premium_until : null,
            cancelAtPeriodEnd: premiumActive && appMetadata.stripe_cancel_at_period_end === true,
            checkoutConfigured,
            canManageBilling,
        });
    };
}

module.exports = createStatusHandler();
module.exports.createStatusHandler = createStatusHandler;
