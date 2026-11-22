import { useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { supabase } from "../auth/supabase";
import "./SubscriptionModal.css";

function dataCurta(value) {
    if (!value) return "";
    const data = new Date(value);
    if (Number.isNaN(data.getTime())) return "";
    return new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium" }).format(data);
}

async function requisitarJson(url, { token, method = "GET" }) {
    const response = await fetch(url, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
        },
        ...(method !== "GET" ? { body: "{}" } : {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.erro || "Não foi possível concluir esta ação.");
    return data;
}

export default function SubscriptionModal({ open, onClose, checkoutComplete = false }) {
    const { session, user, loading: authLoading, authConfigured, signInWithGoogle } = useAuth();
    const [status, setStatus] = useState(null);
    const [loadingStatus, setLoadingStatus] = useState(false);
    const [working, setWorking] = useState(false);
    const [error, setError] = useState("");
    const dialogRef = useRef(null);
    const closeRef = useRef(null);

    async function atualizarStatus(token = session?.access_token) {
        if (!token) {
            setStatus(null);
            return;
        }
        setLoadingStatus(true);
        setError("");
        try {
            const next = await requisitarJson("/api/subscription/status", { token });
            setStatus(next);
            if (next.plan === "premium" && user?.app_metadata?.plan !== "premium" && supabase) {
                await supabase.auth.refreshSession().catch(() => {});
            }
        } catch (err) {
            setError(err.message || "Não foi possível consultar a assinatura.");
        } finally {
            setLoadingStatus(false);
        }
    }

    useEffect(() => {
        if (!open) return undefined;
        const previousFocus = document.activeElement;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        window.requestAnimationFrame(() => closeRef.current?.focus());

        function onKeyDown(event) {
            if (event.key === "Escape") {
                event.preventDefault();
                onClose?.();
                return;
            }
            if (event.key !== "Tab") return;
            const focusable = dialogRef.current?.querySelectorAll(
                'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
            );
            if (!focusable?.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }
        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("keydown", onKeyDown);
            document.body.style.overflow = previousOverflow;
            previousFocus?.focus?.();
        };
    }, [open, onClose]);

    useEffect(() => {
        if (!open || !session?.access_token) {
            if (!open) {
                setStatus(null);
                setError("");
            }
            return undefined;
        }
        let active = true;
        setLoadingStatus(true);
        setError("");
        requisitarJson("/api/subscription/status", { token: session.access_token })
            .then(async (next) => {
                if (!active) return;
                setStatus(next);
                if (next.plan === "premium" && user?.app_metadata?.plan !== "premium" && supabase) {
                    await supabase.auth.refreshSession().catch(() => {});
                }
            })
            .catch((err) => {
                if (active) setError(err.message || "Não foi possível consultar a assinatura.");
            })
            .finally(() => {
                if (active) setLoadingStatus(false);
            });
        return () => { active = false; };
    }, [open, session?.access_token, user?.app_metadata?.plan]);

    if (!open) return null;

    async function iniciarCheckout() {
        if (!session?.access_token || working) return;
        setWorking(true);
        setError("");
        try {
            const data = await requisitarJson("/api/subscription/checkout", {
                token: session.access_token,
                method: "POST",
            });
            window.location.assign(data.url);
        } catch (err) {
            setError(err.message || "Não foi possível iniciar o checkout.");
        } finally {
            setWorking(false);
        }
    }

    async function gerenciarAssinatura() {
        if (!session?.access_token || working) return;
        setWorking(true);
        setError("");
        try {
            const data = await requisitarJson("/api/subscription/portal", {
                token: session.access_token,
                method: "POST",
            });
            window.location.assign(data.url);
        } catch (err) {
            setError(err.message || "Não foi possível abrir o gerenciamento da assinatura.");
        } finally {
            setWorking(false);
        }
    }

    async function entrarComGoogle() {
        const returnUrl = new URL(window.location.href);
        returnUrl.searchParams.set("subscription", "open");
        await signInWithGoogle(returnUrl.toString());
    }

    const premium = status?.plan === "premium";
    const periodEnd = dataCurta(status?.premiumUntil);

    return (
        <div className="subscription-overlay" onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose?.();
        }}>
            <section
                ref={dialogRef}
                className="subscription-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="subscription-title"
                aria-describedby="subscription-description"
            >
                <button
                    ref={closeRef}
                    className="subscription-close"
                    type="button"
                    aria-label="Fechar janela de assinatura"
                    onClick={onClose}
                >
                    ×
                </button>
                <span className="subscription-eyebrow">Riff Theory · Thonic</span>
                <h2 id="subscription-title">Assinatura Premium</h2>
                <p id="subscription-description" className="subscription-price">
                    <strong>R$ 15</strong><span>/ mês</span>
                </p>
                <p className="subscription-renewal">Cobrança recorrente mensal. Cancele quando quiser pelo gerenciamento da assinatura.</p>

                <div className="subscription-benefits">
                    <strong>O que está incluído</strong>
                    <ul>
                        <li>Chat de texto do Thonic, como no plano grátis</li>
                        <li>Envio de imagens e arquivos para interpretação musical</li>
                        <li>Ferramentas abertas do Riff Theory continuam gratuitas</li>
                    </ul>
                </div>

                {authLoading && <p className="subscription-notice" role="status">Verificando sua conta…</p>}
                {!authLoading && !user && (
                    <div className="subscription-account">
                        <p>Entre com Google para assinar ou consultar o estado da sua assinatura.</p>
                        <button className="subscription-primary" type="button" onClick={entrarComGoogle} disabled={!authConfigured}>
                            Entrar com Google
                        </button>
                        {!authConfigured && <small>O login Google ainda não está configurado neste ambiente.</small>}
                    </div>
                )}

                {!authLoading && user && loadingStatus && (
                    <p className="subscription-notice" role="status">Consultando sua assinatura…</p>
                )}

                {!authLoading && user && !loadingStatus && premium && (
                    <div className="subscription-active" role="status">
                        <strong>Premium ativo</strong>
                        {status?.cancelAtPeriodEnd && periodEnd
                            ? <span>Acesso disponível até {periodEnd}; o cancelamento já está agendado.</span>
                            : periodEnd && <span>Próxima data de renovação: {periodEnd}.</span>}
                        {status?.canManageBilling && (
                            <button className="subscription-primary" type="button" onClick={gerenciarAssinatura} disabled={working}>
                                {working ? "Abrindo…" : "Gerenciar ou cancelar assinatura"}
                            </button>
                        )}
                    </div>
                )}

                {!authLoading && user && !loadingStatus && !premium && (
                    <div className="subscription-action">
                        {checkoutComplete && (
                            <p className="subscription-pending" role="status">
                                Pagamento recebido. Estamos aguardando a confirmação segura do provedor para ativar o Premium.
                            </p>
                        )}
                        <button
                            className="subscription-primary"
                            type="button"
                            onClick={iniciarCheckout}
                            disabled={working || !status?.checkoutConfigured}
                        >
                            {working ? "Abrindo checkout…" : "Assinar por R$ 15/mês"}
                        </button>
                        {!status?.checkoutConfigured && (
                            <small>A cobrança ainda não está configurada neste ambiente. Nenhum pagamento será iniciado.</small>
                        )}
                        {checkoutComplete && (
                            <button className="subscription-secondary" type="button" onClick={() => atualizarStatus()} disabled={loadingStatus}>
                                Atualizar status
                            </button>
                        )}
                    </div>
                )}

                {error && <p className="subscription-error" role="alert">{error}</p>}
                <p className="subscription-footnote">O Premium só é ativado após a confirmação do pagamento pelo servidor. Dúvidas: <a href="mailto:rifftheory6@gmail.com">rifftheory6@gmail.com</a>.</p>
            </section>
        </div>
    );
}
