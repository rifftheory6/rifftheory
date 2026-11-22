const test = require("node:test");
const assert = require("node:assert/strict");
const Stripe = require("stripe");
const { createCheckoutHandler } = require("../api/subscription/checkout.js");
const { createPortalHandler } = require("../api/subscription/portal.js");
const { createStatusHandler } = require("../api/subscription/status.js");
const { createWebhookHandler } = require("../api/subscription/webhook.js");
const { checkCheckoutReadiness, hasActivePremiumSubscription, isBillingPortalConfigured } = require("../api/subscription/shared.js");

const ENV_NAMES = ["APP_URL", "STRIPE_SECRET_KEY", "STRIPE_PRICE_ID", "STRIPE_WEBHOOK_SECRET", "STRIPE_WEBHOOK_VERIFIED", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
const originalEnv = Object.fromEntries(ENV_NAMES.map((key) => [key, process.env[key]]));
const REQUIRED_EVENTS = [
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
];

function makeResponse() {
    return {
        statusCode: 200,
        body: undefined,
        headers: {},
        setHeader(name, value) { this.headers[name] = value; },
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
}

function makeRequest({ method = "POST", headers = {}, body = {} } = {}) {
    return { method, headers, body };
}

function setBaseEnv() {
    process.env.APP_URL = "https://www.rifftheory6.com.br";
    process.env.STRIPE_SECRET_KEY = "sk_test_riff_unit_test";
    process.env.STRIPE_PRICE_ID = "price_riff_monthly";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_riff_test";
    process.env.STRIPE_WEBHOOK_VERIFIED = "true";
    process.env.SUPABASE_URL = "https://riff-test.supabase.co";
    process.env.SUPABASE_ANON_KEY = "test-anon-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
}

function makePrice(overrides = {}) {
    return {
        id: "price_riff_monthly",
        active: true,
        currency: "brl",
        unit_amount: 1500,
        recurring: { interval: "month", interval_count: 1 },
        livemode: false,
        ...overrides,
    };
}

function makeWebhookEndpoint(overrides = {}) {
    return {
        id: "we_test_riff_subscription",
        url: "https://www.rifftheory6.com.br/api/subscription/webhook",
        status: "enabled",
        livemode: false,
        enabled_events: [...REQUIRED_EVENTS],
        ...overrides,
    };
}

function makeAdminClient({ valid = true, initialMetadata = {} } = {}) {
    let appMetadata = { ...initialMetadata };
    const client = { auth: { admin: {
        getUserById: async (id) => valid
            ? { data: { user: { id, app_metadata: { ...appMetadata } } }, error: null }
            : { data: { user: null }, error: { status: 401 } },
        updateUserById: async (_id, payload) => {
            appMetadata = { ...(payload.app_metadata || {}) };
            return { error: null };
        },
    } } };
    client.getMetadata = () => ({ ...appMetadata });
    return client;
}

function makeReadyStripe({ price, endpoints, portalConfigurations, checkoutCreate, portalCreate } = {}) {
    return {
        subscriptions: {
            list: async ({ customer }) => ({ data: [{
                id: "sub_test_premium",
                customer,
                status: "active",
                current_period_end: Math.floor(Date.now() / 1000) + 3600,
                metadata: { riff_theory_user_id: "verified-user", riff_theory_product: "rifftheory_premium" },
            }], has_more: false }),
        },
        prices: {
            retrieve: async () => price || makePrice(),
        },
        webhookEndpoints: {
            list: async () => ({ data: endpoints || [makeWebhookEndpoint()] }),
        },
        billingPortal: {
            configurations: {
                list: async () => ({ data: portalConfigurations || [{
                    id: "bpc_test_riff",
                    active: true,
                    is_default: true,
                    livemode: false,
                    features: {
                        subscription_cancel: { enabled: true },
                        payment_method_update: { enabled: true },
                    },
                }] }),
            },
            sessions: {
                create: async (input) => portalCreate ? portalCreate(input) : { url: "https://billing.stripe.com/p/session" },
            },
        },
        checkout: {
            sessions: {
                create: async (input, options) => checkoutCreate
                    ? checkoutCreate(input, options)
                    : { id: "cs_test_riff", url: "https://checkout.stripe.com/c/pay_test", expires_at: Math.floor(Date.now() / 1000) + 3600 },
                retrieve: async (id) => ({
                    id,
                    status: "open",
                    url: "https://checkout.stripe.com/c/pay_test",
                    expires_at: Math.floor(Date.now() / 1000) + 3600,
                }),
            },
        },
    };
}

function restoreEnvironment() {
    for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

test.afterEach(restoreEnvironment);

test("checkout rejects non-POST requests without authenticating", async () => {
    let authenticated = false;
    const handler = createCheckoutHandler({ requireUser: async () => { authenticated = true; return { user: { id: "u1" } }; } });
    const response = makeResponse();
    await handler(makeRequest({ method: "GET" }), response);
    assert.equal(response.statusCode, 405);
    assert.equal(response.headers.Allow, "POST");
    assert.equal(authenticated, false);
});

test("checkout accepts only the configured R$15 BRL monthly price and uses the verified user ID", async () => {
    setBaseEnv();
    let checkoutInput;
    let idempotencyOptions;
    const fakeStripe = makeReadyStripe({ checkoutCreate: async (input) => {
        checkoutInput = input;
        return { id: "cs_test_checkout", url: "https://checkout.stripe.com/c/pay_test", expires_at: Math.floor(Date.now() / 1000) + 3600 };
    } });
    fakeStripe.checkout.sessions.create = async (input, options) => {
        checkoutInput = input;
        idempotencyOptions = options;
        return { id: "cs_test_checkout", url: "https://checkout.stripe.com/c/pay_test", expires_at: Math.floor(Date.now() / 1000) + 3600 };
    };
    const adminClient = makeAdminClient();
    const handler = createCheckoutHandler({
        requireUser: async () => ({ user: {
            id: "verified-user",
            email: "user@example.com",
            user_metadata: { full_name: "Músico" },
            app_metadata: {},
        } }),
        getStripeClient: () => fakeStripe,
        createAdminClient: () => adminClient,
    });
    const response = makeResponse();
    await handler(makeRequest({ body: { priceId: "price_untrusted_from_browser" } }), response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.url, "https://checkout.stripe.com/c/pay_test");
    assert.equal(checkoutInput.mode, "subscription");
    assert.deepEqual(checkoutInput.line_items, [{ price: "price_riff_monthly", quantity: 1 }]);
    assert.equal(checkoutInput.allow_promotion_codes, true);
    assert.equal(checkoutInput.client_reference_id, "verified-user");
    assert.equal(checkoutInput.metadata.user_id, "verified-user");
    assert.equal(checkoutInput.metadata.customer_email, "user@example.com");
    assert.equal(checkoutInput.metadata.customer_name, "Músico");
    assert.equal(idempotencyOptions.idempotencyKey, "riff-premium-verified-user-0");
    assert.equal(adminClient.getMetadata().stripe_checkout_session_id, "cs_test_checkout");
    assert.equal(checkoutInput.subscription_data.metadata.riff_theory_user_id, "verified-user");
    assert.equal(checkoutInput.subscription_data.metadata.riff_theory_product, "rifftheory_premium");
    assert.equal(checkoutInput.success_url, "https://www.rifftheory6.com.br/?subscription=success");
});

test("checkout reuses an existing open session instead of creating another", async () => {
    setBaseEnv();
    let created = false;
    const fakeStripe = makeReadyStripe({ checkoutCreate: async () => {
        created = true;
        return { id: "cs_new", url: "https://checkout.stripe.com/c/new", expires_at: Math.floor(Date.now() / 1000) + 3600 };
    } });
    const adminClient = makeAdminClient({ initialMetadata: {
        stripe_checkout_attempt: 3,
        stripe_checkout_session_id: "cs_pending",
    } });
    const handler = createCheckoutHandler({
        requireUser: async () => ({ user: { id: "verified-user", app_metadata: {} } }),
        getStripeClient: () => fakeStripe,
        createAdminClient: () => adminClient,
    });
    const response = makeResponse();
    await handler(makeRequest(), response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.reused, true);
    assert.equal(response.body.url, "https://checkout.stripe.com/c/pay_test");
    assert.equal(created, false);
});

test("checkout refuses a completed session until its subscription status is synchronized", async () => {
    setBaseEnv();
    let created = false;
    const fakeStripe = makeReadyStripe({ checkoutCreate: async () => {
        created = true;
        return { id: "cs_new", url: "https://checkout.stripe.com/c/new", expires_at: Math.floor(Date.now() / 1000) + 3600 };
    } });
    fakeStripe.checkout.sessions.retrieve = async (id) => ({ id, status: "complete", url: "https://checkout.stripe.com/c/completed" });
    const adminClient = makeAdminClient({ initialMetadata: { stripe_checkout_session_id: "cs_completed" } });
    const handler = createCheckoutHandler({
        requireUser: async () => ({ user: { id: "verified-user", app_metadata: {} } }),
        getStripeClient: () => fakeStripe,
        createAdminClient: () => adminClient,
    });
    const response = makeResponse();
    await handler(makeRequest(), response);
    assert.equal(response.statusCode, 409);
    assert.equal(created, false);
});

test("checkout blocks another attempt while Stripe reports a matching nonterminal subscription", async () => {
    setBaseEnv();
    let created = false;
    const fakeStripe = makeReadyStripe({ checkoutCreate: async () => {
        created = true;
        return { id: "cs_duplicate", url: "https://checkout.stripe.com/c/duplicate", expires_at: Math.floor(Date.now() / 1000) + 3600 };
    } });
    const adminClient = makeAdminClient({ initialMetadata: {
        stripe_customer_id: "cus_verified",
        stripe_subscription_id: "sub_test_premium",
        stripe_subscription_status: "incomplete",
    } });
    const handler = createCheckoutHandler({
        requireUser: async () => ({ user: { id: "verified-user", app_metadata: {} } }),
        getStripeClient: () => fakeStripe,
        createAdminClient: () => adminClient,
    });
    const response = makeResponse();
    await handler(makeRequest(), response);
    assert.equal(response.statusCode, 409);
    assert.equal(created, false);
});

test("checkout clears stale Premium metadata after Stripe confirms every matching subscription is terminal", async () => {
    setBaseEnv();
    let idempotencyOptions;
    const fakeStripe = makeReadyStripe({ checkoutCreate: async (_input, options) => {
        idempotencyOptions = options;
        return {
            id: "cs_after_cancel",
            url: "https://checkout.stripe.com/c/after-cancel",
            expires_at: Math.floor(Date.now() / 1000) + 3600,
        };
    } });
    fakeStripe.subscriptions.list = async ({ customer }) => ({ data: [{
        id: "sub_canceled",
        customer,
        status: "canceled",
        current_period_end: Math.floor(Date.now() / 1000) - 3600,
        metadata: { riff_theory_user_id: "verified-user", riff_theory_product: "rifftheory_premium" },
    }], has_more: false });
    const adminClient = makeAdminClient({ initialMetadata: {
        plan: "premium",
        stripe_customer_id: "cus_verified",
        stripe_subscription_id: "sub_canceled",
        stripe_subscription_status: "active",
        premium_until: "2026-12-20T00:00:00.000Z",
        stripe_checkout_attempt: 7,
        stripe_checkout_session_id: "cs_old_completed",
    } });
    const handler = createCheckoutHandler({
        requireUser: async () => ({ user: { id: "verified-user", app_metadata: {} } }),
        getStripeClient: () => fakeStripe,
        createAdminClient: () => adminClient,
    });
    const response = makeResponse();
    await handler(makeRequest(), response);
    assert.equal(response.statusCode, 200);
    assert.equal(adminClient.getMetadata().plan, "free");
    assert.equal(adminClient.getMetadata().stripe_subscription_id, undefined);
    assert.equal(adminClient.getMetadata().stripe_checkout_session_id, "cs_after_cancel");
    assert.equal(idempotencyOptions.idempotencyKey, "riff-premium-verified-user-8");
});

test("checkout fails closed if the Stripe webhook is missing a required subscription event", async () => {
    setBaseEnv();
    let created = false;
    const fakeStripe = makeReadyStripe({
        endpoints: [makeWebhookEndpoint({ enabled_events: REQUIRED_EVENTS.slice(0, 2) })],
        checkoutCreate: async () => { created = true; return { url: "https://checkout.stripe.com/c/pay_test" }; },
    });
    const handler = createCheckoutHandler({
        requireUser: async () => ({ user: { id: "verified-user", app_metadata: {} } }),
        getStripeClient: () => fakeStripe,
        createAdminClient: () => makeAdminClient(),
    });
    const response = makeResponse();
    await handler(makeRequest(), response);
    assert.equal(response.statusCode, 503);
    assert.equal(created, false);
});

test("checkout remains disabled until the webhook secret has passed an end-to-end test", async () => {
    setBaseEnv();
    process.env.STRIPE_WEBHOOK_VERIFIED = "false";
    let created = false;
    const handler = createCheckoutHandler({
        requireUser: async () => ({ user: { id: "verified-user", app_metadata: {} } }),
        getStripeClient: () => makeReadyStripe({ checkoutCreate: async () => {
            created = true;
            return { id: "cs_unexpected", url: "https://checkout.stripe.com/c/unexpected", expires_at: Math.floor(Date.now() / 1000) + 3600 };
        } }),
        createAdminClient: () => makeAdminClient(),
    });
    const response = makeResponse();
    await handler(makeRequest(), response);
    assert.equal(response.statusCode, 503);
    assert.equal(created, false);
});

test("checkout fails closed when Stripe price is not R$15 monthly in BRL", async () => {
    setBaseEnv();
    let created = false;
    const fakeStripe = makeReadyStripe({
        price: makePrice({ unit_amount: 15000 }),
        checkoutCreate: async () => { created = true; return { url: "https://checkout.stripe.com" }; },
    });
    const handler = createCheckoutHandler({
        requireUser: async () => ({ user: { id: "verified-user", app_metadata: {} } }),
        getStripeClient: () => fakeStripe,
        createAdminClient: () => makeAdminClient(),
    });
    const response = makeResponse();
    await handler(makeRequest(), response);
    assert.equal(response.statusCode, 503);
    assert.equal(created, false);
});

test("checkout fails closed when the Supabase service-role credential cannot resolve the user", async () => {
    setBaseEnv();
    let created = false;
    const fakeStripe = makeReadyStripe({ checkoutCreate: async () => { created = true; return { url: "https://checkout.stripe.com" }; } });
    const handler = createCheckoutHandler({
        requireUser: async () => ({ user: { id: "verified-user", app_metadata: {} } }),
        getStripeClient: () => fakeStripe,
        createAdminClient: () => makeAdminClient({ valid: false }),
    });
    const response = makeResponse();
    await handler(makeRequest(), response);
    assert.equal(response.statusCode, 503);
    assert.equal(created, false);
});

test("checkout readiness requires matching live/test mode for price and webhook", async () => {
    setBaseEnv();
    const fakeStripe = makeReadyStripe({ endpoints: [makeWebhookEndpoint({ livemode: true })] });
    const readiness = await checkCheckoutReadiness({
        stripe: fakeStripe,
        adminClient: makeAdminClient(),
        userId: "verified-user",
        origin: "https://www.rifftheory6.com.br",
        priceId: "price_riff_monthly",
    });
    assert.equal(readiness.ready, false);
});

test("Premium authorization requires an active current Stripe subscription for the authenticated user", async () => {
    const stripe = makeReadyStripe();
    const user = { id: "verified-user", app_metadata: { stripe_customer_id: "cus_verified" } };
    assert.equal(await hasActivePremiumSubscription(stripe, user), true);
    stripe.subscriptions.list = async ({ customer }) => ({ data: [{
        id: "sub_canceled",
        customer,
        status: "canceled",
        current_period_end: Math.floor(Date.now() / 1000) + 3600,
        metadata: { riff_theory_user_id: "verified-user", riff_theory_product: "rifftheory_premium" },
    }], has_more: false });
    assert.equal(await hasActivePremiumSubscription(stripe, user), false);
});

test("status exposes Premium state and actual readiness without exposing Stripe customer ID", async () => {
    setBaseEnv();
    const handler = createStatusHandler({
        requireUser: async () => ({ user: { id: "verified-user", app_metadata: {
            plan: "premium", stripe_subscription_status: "active", premium_until: "2026-12-20T00:00:00.000Z",
            stripe_customer_id: "cus_private_value", stripe_cancel_at_period_end: true,
        } } }),
        getStripeClient: () => makeReadyStripe(),
        createAdminClient: () => makeAdminClient(),
    });
    const response = makeResponse();
    await handler(makeRequest({ method: "GET" }), response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.plan, "premium");
    assert.equal(response.body.cancelAtPeriodEnd, true);
    assert.equal(response.body.checkoutConfigured, true);
    assert.equal(response.body.canManageBilling, true);
    assert.equal(JSON.stringify(response.body).includes("cus_private_value"), false);
});

test("status does not advertise Premium when stored metadata is stale and Stripe has no active subscription", async () => {
    setBaseEnv();
    const fakeStripe = makeReadyStripe();
    fakeStripe.subscriptions.list = async () => ({ data: [], has_more: false });
    const handler = createStatusHandler({
        requireUser: async () => ({ user: { id: "verified-user", app_metadata: {
            plan: "premium",
            stripe_customer_id: "cus_verified",
            stripe_subscription_status: "active",
            premium_until: "2026-12-20T00:00:00.000Z",
        } } }),
        getStripeClient: () => fakeStripe,
        createAdminClient: () => makeAdminClient(),
    });
    const response = makeResponse();
    await handler(makeRequest({ method: "GET" }), response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.plan, "free");
    assert.equal(response.body.subscriptionStatus, null);
    assert.equal(response.body.premiumUntil, null);
});

test("status does not advertise billing management without an active default portal configuration", async () => {
    setBaseEnv();
    const fakeStripe = makeReadyStripe({ portalConfigurations: [] });
    const handler = createStatusHandler({
        requireUser: async () => ({ user: { id: "verified-user", app_metadata: { stripe_customer_id: "cus_verified" } } }),
        getStripeClient: () => fakeStripe,
        createAdminClient: () => makeAdminClient(),
    });
    const response = makeResponse();
    await handler(makeRequest({ method: "GET" }), response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.canManageBilling, false);
});

test("portal session is created only for the authenticated user's stored customer", async () => {
    setBaseEnv();
    let portalInput;
    const fakeStripe = makeReadyStripe({ portalCreate: async (input) => {
        portalInput = input;
        return { url: "https://billing.stripe.com/p/session" };
    } });
    const handler = createPortalHandler({
        requireUser: async () => ({ user: { id: "verified-user", app_metadata: { stripe_customer_id: "cus_verified" } } }),
        getStripeClient: () => fakeStripe,
    });
    const response = makeResponse();
    await handler(makeRequest(), response);
    assert.equal(response.statusCode, 200);
    assert.equal(portalInput.customer, "cus_verified");
    assert.equal(portalInput.return_url, "https://www.rifftheory6.com.br/?subscription=manage");
});

test("portal is unavailable when cancellation or payment-method updates are disabled", async () => {
    setBaseEnv();
    const ready = await isBillingPortalConfigured(makeReadyStripe({
        portalConfigurations: [{
            active: true,
            is_default: true,
            livemode: false,
            features: {
                subscription_cancel: { enabled: false },
                payment_method_update: { enabled: true },
            },
        }],
    }));
    assert.equal(ready, false);
});

test("webhook rejects an invalid signature before touching Supabase", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret";
    const stripe = new Stripe("sk_test_riff_unit_test");
    let adminAccessed = false;
    const handler = createWebhookHandler({
        getStripeClient: () => stripe,
        createAdminClient: () => { adminAccessed = true; return null; },
    });
    const response = makeResponse();
    await handler({ method: "POST", headers: { "stripe-signature": "t=1,v1=invalid" }, body: Buffer.from("{}") }, response);
    assert.equal(response.statusCode, 400);
    assert.equal(adminAccessed, false);
});

test("verified subscription webhook grants Premium in app_metadata", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_riff_test_secret";
    const stripe = new Stripe("sk_test_riff_unit_test");
    const subscription = {
        id: "sub_123",
        customer: "cus_123",
        status: "active",
        current_period_end: 1797724800,
        cancel_at_period_end: false,
        metadata: { riff_theory_user_id: "verified-user", riff_theory_product: "rifftheory_premium" },
    };
    stripe.subscriptions.retrieve = async (id) => {
        assert.equal(id, "sub_123");
        return subscription;
    };
    let savedMetadata;
    const admin = { auth: { admin: {
        getUserById: async (id) => ({ data: { user: { id, app_metadata: {
            unrelated_claim: "keep",
            stripe_checkout_attempt: 0,
            stripe_checkout_session_id: "cs_completed",
            stripe_checkout_session_expires_at: 1797728400,
        } } }, error: null }),
        updateUserById: async (_id, payload) => { savedMetadata = payload.app_metadata; return { error: null }; },
    } } };
    const event = {
        id: "evt_subscription_active",
        type: "customer.subscription.updated",
        created: 1795046400,
        data: { object: { id: subscription.id } },
    };
    const rawBody = Buffer.from(JSON.stringify(event));
    const signature = stripe.webhooks.generateTestHeaderString({ payload: rawBody, secret: process.env.STRIPE_WEBHOOK_SECRET });
    const handler = createWebhookHandler({ getStripeClient: () => stripe, createAdminClient: () => admin });
    const response = makeResponse();
    await handler({ method: "POST", headers: { "stripe-signature": signature }, body: rawBody }, response);

    assert.equal(response.statusCode, 200);
    assert.equal(savedMetadata.plan, "premium");
    assert.equal(savedMetadata.stripe_subscription_status, "active");
    assert.equal(savedMetadata.stripe_customer_id, "cus_123");
    assert.equal(savedMetadata.unrelated_claim, "keep");
    assert.equal(savedMetadata.stripe_checkout_attempt, 1);
    assert.equal(savedMetadata.stripe_checkout_session_id, undefined);
    assert.ok(savedMetadata.premium_until);
});

test("verified cancellation removes Premium and preserves unrelated app metadata", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_riff_cancel_test";
    const stripe = new Stripe("sk_test_riff_unit_test");
    const subscription = {
        id: "sub_123", customer: "cus_123", status: "canceled", current_period_end: 1797724800,
        cancel_at_period_end: false,
        metadata: { riff_theory_user_id: "verified-user", riff_theory_product: "rifftheory_premium" },
    };
    stripe.subscriptions.list = async () => ({ data: [subscription], has_more: false });
    let savedMetadata;
    const admin = { auth: { admin: {
        getUserById: async (id) => ({ data: { user: { id, app_metadata: {
            plan: "premium",
            premium_until: "2026-12-20",
            unrelated_claim: "keep",
            stripe_checkout_attempt: 3,
            stripe_checkout_session_id: "cs_previous",
        } } }, error: null }),
        updateUserById: async (_id, payload) => { savedMetadata = payload.app_metadata; return { error: null }; },
    } } };
    const event = { id: "evt_subscription_deleted", type: "customer.subscription.deleted", created: 1795046400, data: { object: subscription } };
    const rawBody = Buffer.from(JSON.stringify(event));
    const signature = stripe.webhooks.generateTestHeaderString({ payload: rawBody, secret: process.env.STRIPE_WEBHOOK_SECRET });
    const handler = createWebhookHandler({ getStripeClient: () => stripe, createAdminClient: () => admin });
    const response = makeResponse();
    await handler({ method: "POST", headers: { "stripe-signature": signature }, body: rawBody }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(savedMetadata.plan, "free");
    assert.equal(savedMetadata.premium_until, undefined);
    assert.equal(savedMetadata.stripe_checkout_attempt, 4);
    assert.equal(savedMetadata.stripe_checkout_session_id, undefined);
    assert.equal(savedMetadata.unrelated_claim, "keep");
});

test("canceling one subscription preserves Premium when another matching subscription remains active", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_riff_duplicate_test";
    const stripe = new Stripe("sk_test_riff_unit_test");
    const canceledSubscription = {
        id: "sub_canceled", customer: "cus_123", status: "canceled", current_period_end: 1797724800,
        cancel_at_period_end: false,
        metadata: { riff_theory_user_id: "verified-user", riff_theory_product: "rifftheory_premium" },
    };
    const activeSubscription = {
        id: "sub_still_active", customer: "cus_123", status: "active", current_period_end: 1797728400,
        cancel_at_period_end: true,
        metadata: { riff_theory_user_id: "verified-user", riff_theory_product: "rifftheory_premium" },
    };
    stripe.subscriptions.list = async (input) => {
        assert.equal(input.customer, "cus_123");
        assert.equal(input.status, "all");
        return { data: [canceledSubscription, activeSubscription], has_more: false };
    };
    let savedMetadata;
    const admin = { auth: { admin: {
        getUserById: async (id) => ({ data: { user: { id, app_metadata: { plan: "premium", stripe_subscription_id: "sub_canceled" } } }, error: null }),
        updateUserById: async (_id, payload) => { savedMetadata = payload.app_metadata; return { error: null }; },
    } } };
    const event = {
        id: "evt_duplicate_subscription_deleted",
        type: "customer.subscription.deleted",
        created: 1795046400,
        data: { object: canceledSubscription },
    };
    const rawBody = Buffer.from(JSON.stringify(event));
    const signature = stripe.webhooks.generateTestHeaderString({ payload: rawBody, secret: process.env.STRIPE_WEBHOOK_SECRET });
    const handler = createWebhookHandler({ getStripeClient: () => stripe, createAdminClient: () => admin });
    const response = makeResponse();
    await handler({ method: "POST", headers: { "stripe-signature": signature }, body: rawBody }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(savedMetadata.plan, "premium");
    assert.equal(savedMetadata.stripe_subscription_id, "sub_still_active");
    assert.equal(savedMetadata.stripe_subscription_status, "active");
    assert.equal(savedMetadata.stripe_cancel_at_period_end, true);
});
