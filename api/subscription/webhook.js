const {
    PREMIUM_PRODUCT_MARKER,
    createAdminClient,
    getStripeClient,
    isEntitledSubscriptionStatus,
    methodNotAllowed,
    sendJson,
} = require("./shared");

const MAX_WEBHOOK_BYTES = 1024 * 1024;
const SUBSCRIPTION_EVENTS = new Set([
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
]);

async function readRawBody(req) {
    for (const candidate of [req.rawBody, req.body]) {
        if (Buffer.isBuffer(candidate)) return candidate;
        if (candidate instanceof Uint8Array) return Buffer.from(candidate);
        if (typeof candidate === "string") return Buffer.from(candidate, "utf8");
    }

    if (typeof req[Symbol.asyncIterator] !== "function") throw new Error("raw_body_unavailable");
    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.length;
        if (totalBytes > MAX_WEBHOOK_BYTES) {
            const error = new Error("webhook_body_too_large");
            error.code = "WEBHOOK_BODY_TOO_LARGE";
            throw error;
        }
        chunks.push(buffer);
    }
    return Buffer.concat(chunks);
}

function customerIdOf(subscription) {
    return typeof subscription.customer === "string"
        ? subscription.customer
        : subscription.customer?.id || "";
}

async function findOtherActiveSubscription(stripe, customerId, userId, excludedSubscriptionId) {
    if (!stripe?.subscriptions?.list || !customerId) return null;

    let startingAfter;
    while (true) {
        const page = await stripe.subscriptions.list({
            customer: customerId,
            status: "all",
            limit: 100,
            ...(startingAfter ? { starting_after: startingAfter } : {}),
        });
        if (!Array.isArray(page?.data)) throw new Error("stripe_subscription_list_unavailable");

        const activeMatches = page.data.filter((candidate) =>
            candidate?.id !== excludedSubscriptionId &&
            isEntitledSubscriptionStatus(candidate?.status) &&
            candidate?.metadata?.riff_theory_product === PREMIUM_PRODUCT_MARKER &&
            candidate?.metadata?.riff_theory_user_id === userId
        );
        if (activeMatches.length) {
            return activeMatches.sort((a, b) =>
                (Number(b.current_period_end) || 0) - (Number(a.current_period_end) || 0)
            )[0];
        }

        if (page.has_more !== true) return null;
        const lastId = page.data.at(-1)?.id;
        if (typeof lastId !== "string" || !lastId || lastId === startingAfter) {
            throw new Error("stripe_subscription_list_pagination_invalid");
        }
        startingAfter = lastId;
    }
}

function createWebhookHandler(dependencies = {}) {
    const stripeFactory = dependencies.getStripeClient || getStripeClient;
    const adminFactory = dependencies.createAdminClient || createAdminClient;
    const rawBodyReader = dependencies.readRawBody || readRawBody;

    return async function webhookHandler(req, res) {
        if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

        const webhookSecret = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();
        const stripe = stripeFactory();
        if (!webhookSecret || !stripe) {
            return sendJson(res, 503, { erro: "O webhook de assinatura não está configurado." });
        }

        let event;
        try {
            const rawBody = await rawBodyReader(req);
            if (!rawBody.length || rawBody.length > MAX_WEBHOOK_BYTES) {
                return sendJson(res, rawBody.length > MAX_WEBHOOK_BYTES ? 413 : 400, { erro: "Corpo de webhook inválido." });
            }
            const signature = req.headers?.["stripe-signature"];
            event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
        } catch (error) {
            if (error?.code === "WEBHOOK_BODY_TOO_LARGE") {
                return sendJson(res, 413, { erro: "Corpo de webhook muito grande." });
            }
            return sendJson(res, 400, { erro: "Assinatura de webhook inválida." });
        }

        if (!SUBSCRIPTION_EVENTS.has(event.type)) {
            return sendJson(res, 200, { received: true, ignored: true });
        }

        const eventObject = event.data?.object;
        if (!eventObject?.id || typeof eventObject.id !== "string") {
            return sendJson(res, 400, { erro: "Evento de assinatura inválido." });
        }

        let subscription = eventObject;
        if (event.type !== "customer.subscription.deleted") {
            try {
                subscription = await stripe.subscriptions.retrieve(eventObject.id);
            } catch (error) {
                console.error("Falha ao buscar assinatura Stripe:", error?.type || error?.name || "stripe_error");
                return sendJson(res, 503, { erro: "Não foi possível confirmar a assinatura agora." });
            }
        }

        const metadata = subscription.metadata || {};
        const userId = metadata.riff_theory_user_id;
        if (metadata.riff_theory_product !== PREMIUM_PRODUCT_MARKER || typeof userId !== "string" || !userId) {
            return sendJson(res, 200, { received: true, ignored: true });
        }

        const admin = adminFactory();
        if (!admin) return sendJson(res, 503, { erro: "O sincronizador de assinaturas não está configurado." });

        try {
            const { data, error: lookupError } = await admin.auth.admin.getUserById(userId);
            if (lookupError) {
                const lookupStatus = Number(lookupError.status);
                if (lookupStatus === 400 || lookupStatus === 404) {
                    return sendJson(res, 200, { received: true, ignored: true });
                }
                throw lookupError;
            }
            if (!data?.user) return sendJson(res, 200, { received: true, ignored: true });

            const user = data.user;
            const currentMetadata = user.app_metadata || {};
            const eventCreated = Number(event.created) || 0;
            const previousEventCreated = Number(currentMetadata.stripe_subscription_event_created) || 0;
            if (
                (event.id && currentMetadata.stripe_subscription_event_id === event.id) ||
                (eventCreated > 0 && eventCreated < previousEventCreated)
            ) {
                return sendJson(res, 200, { received: true, ignored: true });
            }

            let entitlementSubscription = subscription;
            let active = isEntitledSubscriptionStatus(subscription.status);
            if (!active) {
                try {
                    const anotherActiveSubscription = await findOtherActiveSubscription(
                        stripe,
                        customerIdOf(subscription),
                        userId,
                        subscription.id
                    );
                    if (anotherActiveSubscription) {
                        entitlementSubscription = anotherActiveSubscription;
                        active = true;
                    }
                } catch (error) {
                    console.error("Falha ao conferir assinaturas relacionadas:", error?.type || error?.name || "stripe_error");
                    return sendJson(res, 503, { erro: "Não foi possível confirmar o estado da assinatura agora." });
                }
            }

            const currentSubscriptionId = currentMetadata.stripe_subscription_id;
            if (
                !active &&
                currentSubscriptionId &&
                currentSubscriptionId !== subscription.id &&
                isEntitledSubscriptionStatus(currentMetadata.stripe_subscription_status)
            ) {
                return sendJson(res, 200, { received: true, ignored: true });
            }

            const nextMetadata = {
                ...currentMetadata,
                plan: active ? "premium" : "free",
                stripe_customer_id: customerIdOf(entitlementSubscription) || currentMetadata.stripe_customer_id || "",
                stripe_subscription_id: entitlementSubscription.id,
                stripe_subscription_status: String(entitlementSubscription.status || "unknown"),
                stripe_cancel_at_period_end: Boolean(entitlementSubscription.cancel_at_period_end),
                stripe_checkout_attempt: Math.min(
                    (Number.isSafeInteger(Number(currentMetadata.stripe_checkout_attempt))
                        ? Math.max(0, Number(currentMetadata.stripe_checkout_attempt))
                        : 0) + 1,
                    Number.MAX_SAFE_INTEGER
                ),
                stripe_subscription_event_created: eventCreated,
                stripe_subscription_event_id: String(event.id || ""),
            };
            delete nextMetadata.stripe_checkout_session_id;
            delete nextMetadata.stripe_checkout_session_expires_at;
            const periodEnd = Number(entitlementSubscription.current_period_end);
            if (active && Number.isFinite(periodEnd) && periodEnd > 0) {
                nextMetadata.premium_until = new Date(periodEnd * 1000).toISOString();
            } else {
                delete nextMetadata.premium_until;
            }

            const { error: updateError } = await admin.auth.admin.updateUserById(userId, {
                app_metadata: nextMetadata,
            });
            if (updateError) throw updateError;
            return sendJson(res, 200, { received: true });
        } catch (error) {
            console.error("Falha ao sincronizar direito Premium:", error?.name || "supabase_error");
            return sendJson(res, 503, { erro: "Não foi possível sincronizar o direito Premium agora." });
        }
    };
}

module.exports = createWebhookHandler();
module.exports.createWebhookHandler = createWebhookHandler;
module.exports.readRawBody = readRawBody;
module.exports.config = {
    api: {
        bodyParser: false,
    },
};
