const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const PREMIUM_AMOUNT_CENTS = 1500;
const PREMIUM_PRODUCT_MARKER = "rifftheory_premium";
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);
const REQUIRED_SUBSCRIPTION_WEBHOOK_EVENTS = [
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
];

function sendJson(res, status, body) {
    if (typeof res.setHeader === "function") {
        res.setHeader("Cache-Control", "private, no-store");
    }
    return res.status(status).json(body);
}

function methodNotAllowed(res, allowed) {
    if (typeof res.setHeader === "function") res.setHeader("Allow", allowed.join(", "));
    return sendJson(res, 405, { erro: "Método não permitido." });
}

function getBearerToken(req) {
    const authorization = typeof req.headers?.authorization === "string"
        ? req.headers.authorization
        : "";
    const match = authorization.match(/^Bearer\s+(\S+)$/i);
    return match?.[1] || "";
}

async function requireUser(req) {
    const token = getBearerToken(req);
    if (!token) return { status: 401, erro: "Entre com sua conta para continuar." };

    const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
    const anonKey = process.env.SUPABASE_ANON_KEY || "";
    if (!supabaseUrl || !anonKey) {
        return { status: 503, erro: "A autenticação não está configurada no servidor." };
    }

    try {
        const authClient = createClient(supabaseUrl, anonKey, {
            auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
        });
        const { data, error } = await authClient.auth.getUser(token);
        if (error || !data?.user?.id) {
            const status = Number(error?.status);
            return status === 400 || status === 401 || status === 403
                ? { status: 401, erro: "Sua sessão expirou. Entre novamente." }
                : { status: 503, erro: "Não foi possível validar sua sessão agora." };
        }
        return { user: data.user };
    } catch {
        return { status: 503, erro: "Não foi possível validar sua sessão agora." };
    }
}

function getStripeClient() {
    const secretKey = (process.env.STRIPE_SECRET_KEY || "").trim();
    if (!secretKey.startsWith("sk_test_") && !secretKey.startsWith("sk_live_")) return null;
    try {
        return new Stripe(secretKey);
    } catch {
        return null;
    }
}

function createAdminClient() {
    const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
    const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
    if (!supabaseUrl || !serviceRoleKey) return null;
    return createClient(supabaseUrl, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
}

function getAppOrigin() {
    const configured = (process.env.APP_URL || "").trim();
    if (!configured) return "";
    try {
        const url = new URL(configured);
        const localHttp = ["localhost", "127.0.0.1"].includes(url.hostname) && url.protocol === "http:";
        if (url.username || url.password || (url.protocol !== "https:" && !localHttp)) return "";
        return url.origin;
    } catch {
        return "";
    }
}

function isRiffTheoryPremiumPrice(price) {
    return Boolean(
        price?.active === true &&
        price.currency === "brl" &&
        Number(price.unit_amount) === PREMIUM_AMOUNT_CENTS &&
        price.recurring?.interval === "month" &&
        Number(price.recurring?.interval_count || 1) === 1
    );
}

function checkoutIsConfigured() {
    return Boolean(
        process.env.STRIPE_WEBHOOK_VERIFIED?.trim() === "true" &&
        process.env.STRIPE_SECRET_KEY?.trim() &&
        process.env.STRIPE_WEBHOOK_SECRET?.trim() &&
        process.env.STRIPE_PRICE_ID?.trim() &&
        process.env.SUPABASE_URL?.trim() &&
        process.env.SUPABASE_ANON_KEY?.trim() &&
        process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() &&
        getAppOrigin()
    );
}

function isLiveStripeMode() {
    return (process.env.STRIPE_SECRET_KEY || "").trim().startsWith("sk_live_");
}

async function checkCheckoutReadiness({ stripe, adminClient, userId, origin, priceId } = {}) {
    if (
        !checkoutIsConfigured() ||
        !stripe ||
        !adminClient?.auth?.admin?.getUserById ||
        typeof userId !== "string" ||
        !userId ||
        !origin ||
        !priceId ||
        !stripe.webhookEndpoints?.list
    ) {
        return { ready: false, price: null, adminUser: null };
    }

    try {
        const [price, endpoints, adminResult] = await Promise.all([
            stripe.prices.retrieve(priceId),
            stripe.webhookEndpoints.list({ limit: 100 }),
            adminClient.auth.admin.getUserById(userId),
        ]);
        const liveMode = isLiveStripeMode();
        const expectedWebhookUrl = `${origin}/api/subscription/webhook`;
        const webhookReady = endpoints?.data?.some((endpoint) =>
            endpoint.url === expectedWebhookUrl &&
            endpoint.status === "enabled" &&
            endpoint.livemode === liveMode &&
            Array.isArray(endpoint.enabled_events) &&
            (endpoint.enabled_events.includes("*") ||
                REQUIRED_SUBSCRIPTION_WEBHOOK_EVENTS.every((event) => endpoint.enabled_events.includes(event)))
        );
        const adminReady = !adminResult?.error && adminResult?.data?.user?.id === userId;
        const priceReady = isRiffTheoryPremiumPrice(price) && price.livemode === liveMode;

        const ready = Boolean(webhookReady && adminReady && priceReady);
        return {
            ready,
            price: ready ? price : null,
            adminUser: ready ? adminResult.data.user : null,
        };
    } catch {
        return { ready: false, price: null, adminUser: null };
    }
}

async function isBillingPortalConfigured(stripe) {
    if (!stripe?.billingPortal?.configurations?.list) return false;
    try {
        const configurations = await stripe.billingPortal.configurations.list({
            active: true,
            is_default: true,
            limit: 1,
        });
        const liveMode = isLiveStripeMode();
        return Boolean(configurations?.data?.some((configuration) =>
            configuration.active === true &&
            configuration.is_default === true &&
            configuration.livemode === liveMode &&
            configuration.features?.subscription_cancel?.enabled === true &&
            configuration.features?.payment_method_update?.enabled === true
        ));
    } catch {
        return false;
    }
}

function isEntitledSubscriptionStatus(status) {
    return ACTIVE_SUBSCRIPTION_STATUSES.has(status);
}

async function getPremiumSubscriptionState(stripe, user) {
    const userId = typeof user?.id === "string" ? user.id : "";
    const appMetadata = user?.app_metadata || {};
    const customerId = typeof appMetadata.stripe_customer_id === "string"
        ? appMetadata.stripe_customer_id
        : "";
    if (!userId || !customerId.startsWith("cus_")) return { hasActive: false, hasNonterminal: false };
    if (!stripe?.subscriptions?.list) throw new Error("stripe_subscription_list_unavailable");

    let startingAfter;
    const subscriptions = [];
    while (true) {
        const page = await stripe.subscriptions.list({
            customer: customerId,
            status: "all",
            limit: 100,
            ...(startingAfter ? { starting_after: startingAfter } : {}),
        });
        if (!Array.isArray(page?.data)) throw new Error("stripe_subscription_list_invalid");

        subscriptions.push(...page.data.filter((subscription) =>
            (typeof subscription?.customer === "string" ? subscription.customer : subscription?.customer?.id) === customerId &&
            subscription?.metadata?.riff_theory_product === PREMIUM_PRODUCT_MARKER &&
            subscription?.metadata?.riff_theory_user_id === userId
        ));
        if (page.has_more !== true) break;

        const lastId = page.data.at(-1)?.id;
        if (typeof lastId !== "string" || !lastId || lastId === startingAfter) {
            throw new Error("stripe_subscription_list_pagination_invalid");
        }
        startingAfter = lastId;
    }

    const now = Math.floor(Date.now() / 1000);
    return {
        hasActive: subscriptions.some((subscription) =>
            isEntitledSubscriptionStatus(subscription.status) &&
            Number(subscription.current_period_end) > now
        ),
        hasNonterminal: subscriptions.some((subscription) =>
            !["canceled", "incomplete_expired"].includes(subscription.status)
        ),
    };
}

async function hasActivePremiumSubscription(stripe, user) {
    const state = await getPremiumSubscriptionState(stripe, user);
    return state.hasActive;
}

module.exports = {
    ACTIVE_SUBSCRIPTION_STATUSES,
    PREMIUM_PRODUCT_MARKER,
    PREMIUM_AMOUNT_CENTS,
    REQUIRED_SUBSCRIPTION_WEBHOOK_EVENTS,
    checkCheckoutReadiness,
    checkoutIsConfigured,
    createAdminClient,
    getAppOrigin,
    getPremiumSubscriptionState,
    getStripeClient,
    hasActivePremiumSubscription,
    isBillingPortalConfigured,
    isEntitledSubscriptionStatus,
    isLiveStripeMode,
    isRiffTheoryPremiumPrice,
    methodNotAllowed,
    requireUser,
    sendJson,
};
