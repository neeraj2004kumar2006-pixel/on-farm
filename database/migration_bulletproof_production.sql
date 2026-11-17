-- =========================================================================
-- ON-FARM COMPREHENSIVE PRODUCTION HARDENING MIGRATION
-- =========================================================================

-- 1. KILA CHARGES TWO-PHASE LEDGER
CREATE TABLE IF NOT EXISTS public.kila_charges (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  charge_key TEXT NOT NULL,
  amount NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
  status TEXT NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED','COMMITTED','REFUNDED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, charge_key)
);
ALTER TABLE public.kila_charges ENABLE ROW LEVEL SECURITY;

-- 2. DEDICATED REFERRALS TABLE
CREATE TABLE IF NOT EXISTS public.referrals (
  referred_user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  referrer_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  bonus NUMERIC(10,2) NOT NULL DEFAULT 25.00,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rewarded_at TIMESTAMPTZ,
  CHECK (referred_user_id <> referrer_user_id)
);
ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;

-- Migrate any existing app_config ref_links into the new referrals table
DO $$
DECLARE
    r RECORD;
    v_ref_uid UUID;
    v_target_uid UUID;
    v_rewarded_at TIMESTAMPTZ;
BEGIN
    FOR r IN SELECT key, value FROM public.app_config WHERE key LIKE 'ref_link_%' LOOP
        BEGIN
            v_ref_uid := (r.value->>'referrer_user_id')::UUID;
            v_target_uid := (r.value->>'referred_user_id')::UUID;
            IF (r.value->>'rewarded')::BOOLEAN THEN
                v_rewarded_at := COALESCE((r.value->>'rewarded_at')::TIMESTAMPTZ, NOW());
            ELSE
                v_rewarded_at := NULL;
            END IF;
            
            IF v_target_uid IS NOT NULL AND v_ref_uid IS NOT NULL AND v_target_uid <> v_ref_uid THEN
                INSERT INTO public.referrals (referred_user_id, referrer_user_id, bonus, linked_at, rewarded_at)
                VALUES (v_target_uid, v_ref_uid, 25.00, COALESCE((r.value->>'linked_at')::TIMESTAMPTZ, NOW()), v_rewarded_at)
                ON CONFLICT (referred_user_id) DO NOTHING;
            END IF;
        EXCEPTION WHEN OTHERS THEN
            -- Skip any malformed row
        END;
    END LOOP;
END $$;

-- 3. UNIQUE CONSTRAINTS & PERFORMANCE INDEXES
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_hwid_uq ON public.users(hwid) WHERE hwid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_cashfree_order_id ON public.transactions(cashfree_order_id) WHERE cashfree_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_subs_user_active_exp ON public.subscriptions(user_id, is_active, expires_at);
CREATE INDEX IF NOT EXISTS idx_tx_user_created ON public.transactions(user_id, created_at DESC);

-- 4. AUTHORIZE KILA (Phase 1: Reserve & Deduct atomically)
CREATE OR REPLACE FUNCTION public.authorize_kila(p_user UUID, p_key TEXT, p_amount NUMERIC)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE 
    v_id BIGINT; 
    v_bal NUMERIC; 
    v_status TEXT;
    v_is_sub BOOLEAN;
BEGIN
    -- Check if user has an active unlimited 30-day subscription
    SELECT EXISTS (
        SELECT 1 FROM public.subscriptions 
        WHERE user_id = p_user AND is_active = true AND expires_at > NOW()
    ) INTO v_is_sub;

    IF v_is_sub THEN
        -- Unlimited Pass holders pay 0.00
        p_amount := 0.00;
    END IF;

    -- Idempotent insert into kila_charges ledger
    INSERT INTO public.kila_charges(user_id, charge_key, amount, status)
    VALUES (p_user, p_key, p_amount, 'RESERVED')
    ON CONFLICT (user_id, charge_key) DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
        -- Retry of earlier call: never charge twice!
        SELECT status INTO v_status FROM public.kila_charges WHERE user_id = p_user AND charge_key = p_key;
        SELECT balance INTO v_bal FROM public.wallets WHERE user_id = p_user;
        RETURN jsonb_build_object(
            'ok', true, 
            'duplicate', true, 
            'status', v_status, 
            'remaining_balance', COALESCE(v_bal, 0),
            'plan', CASE WHEN v_is_sub THEN 'SUBSCRIPTION_UNLIMITED' ELSE 'WALLET_PAY_PER_KILA' END
        );
    END IF;

    IF v_is_sub THEN
        -- Subscription user: just increment kila counter
        UPDATE public.wallets
        SET total_kilas_processed = total_kilas_processed + 1,
            updated_at = NOW()
        WHERE user_id = p_user
        RETURNING balance INTO v_bal;

        RETURN jsonb_build_object(
            'ok', true, 
            'remaining_balance', COALESCE(v_bal, 0),
            'deducted', 0.00,
            'plan', 'SUBSCRIPTION_UNLIMITED'
        );
    END IF;

    -- Regular wallet user: deduct balance atomically with row check
    UPDATE public.wallets
    SET balance = balance - p_amount,
        total_kilas_processed = total_kilas_processed + 1,
        updated_at = NOW()
    WHERE user_id = p_user AND balance >= p_amount
    RETURNING balance INTO v_bal;

    IF NOT FOUND THEN
        -- Insufficient balance: remove reservation row so ledger stays clean
        DELETE FROM public.kila_charges WHERE id = v_id;
        RETURN jsonb_build_object('ok', false, 'code', 'INSUFFICIENT_FUNDS', 'message', 'Wallet balance insufficient.');
    END IF;

    -- Record in transactions table
    INSERT INTO public.transactions (user_id, amount, type, status, details)
    VALUES (p_user, p_amount, 'KILA_DEBIT', 'SUCCESS', jsonb_build_object('charge_key', p_key));

    RETURN jsonb_build_object(
        'ok', true, 
        'remaining_balance', v_bal,
        'deducted', p_amount,
        'plan', 'WALLET_PAY_PER_KILA'
    );
END $$;

-- 5. COMMIT KILA (Phase 2: Success on portal flips RESERVED -> COMMITTED)
CREATE OR REPLACE FUNCTION public.commit_kila(p_user UUID, p_key TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    UPDATE public.kila_charges 
    SET status = 'COMMITTED', updated_at = NOW()
    WHERE user_id = p_user AND charge_key = p_key AND status = 'RESERVED';

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND_OR_ALREADY_COMMITTED');
    END IF;

    RETURN jsonb_build_object('ok', true, 'status', 'COMMITTED');
END $$;

-- 6. REFUND KILA (Phase 3: Rollback on portal crash ONLY if still RESERVED within 10 minutes)
CREATE OR REPLACE FUNCTION public.refund_kila(p_user UUID, p_key TEXT, p_reason TEXT DEFAULT 'Portal error rollback')
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE 
    v_amt NUMERIC; 
    v_bal NUMERIC; 
    v_recent INT;
BEGIN
    -- Anti-abuse rate limit: Max 20 refunds in 24 hours per user
    SELECT COUNT(*) INTO v_recent FROM public.kila_charges
    WHERE user_id = p_user AND status = 'REFUNDED' AND updated_at > NOW() - INTERVAL '24 hours';
    
    IF v_recent >= 20 THEN
        RETURN jsonb_build_object('ok', false, 'code', 'REFUND_LIMIT', 'message', 'Refund limit reached. Please contact admin.');
    END IF;

    -- Only allow refund from 'RESERVED' state within 10 minutes of creation
    UPDATE public.kila_charges 
    SET status = 'REFUNDED', updated_at = NOW()
    WHERE user_id = p_user AND charge_key = p_key AND status = 'RESERVED' AND created_at > NOW() - INTERVAL '10 minutes'
    RETURNING amount INTO v_amt;

    IF NOT FOUND THEN 
        RETURN jsonb_build_object('ok', false, 'code', 'NOT_REFUNDABLE', 'message', 'Kila charge is not eligible for refund.'); 
    END IF;

    IF v_amt > 0 THEN
        UPDATE public.wallets 
        SET balance = balance + v_amt,
            total_kilas_processed = GREATEST(total_kilas_processed - 1, 0), 
            updated_at = NOW()
        WHERE user_id = p_user 
        RETURNING balance INTO v_bal;

        -- Record refund credit
        INSERT INTO public.transactions (user_id, amount, type, status, details)
        VALUES (p_user, v_amt, 'WALLET_RECHARGE', 'SUCCESS', jsonb_build_object('is_refund', true, 'type', 'KILA_ROLLBACK', 'charge_key', p_key, 'reason', p_reason));
    ELSE
        SELECT balance INTO v_bal FROM public.wallets WHERE user_id = p_user;
    END IF;

    RETURN jsonb_build_object('ok', true, 'refunded_amount', v_amt, 'remaining_balance', v_bal);
END $$;

-- 7. ATOMIC REFERRAL BONUS GRANT
CREATE OR REPLACE FUNCTION public.grant_referral_bonus(p_referred UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE 
    v_referrer UUID; 
    v_bonus NUMERIC;
BEGIN
    -- Atomic claim: only update if rewarded_at is NULL
    UPDATE public.referrals 
    SET rewarded_at = NOW()
    WHERE referred_user_id = p_referred AND rewarded_at IS NULL
    RETURNING referrer_user_id, bonus INTO v_referrer, v_bonus;

    IF NOT FOUND THEN 
        RETURN FALSE; 
    END IF;

    -- Credit referrer wallet
    UPDATE public.wallets 
    SET balance = balance + v_bonus, 
        total_recharged = total_recharged + v_bonus,
        updated_at = NOW() 
    WHERE user_id = v_referrer;

    -- Insert reward transaction
    INSERT INTO public.transactions(user_id, amount, type, status, details)
    VALUES (v_referrer, v_bonus, 'WALLET_RECHARGE', 'SUCCESS',
            jsonb_build_object('is_referral', true, 'type', 'REFERRAL_BONUS', 'referred_user_id', p_referred));

    RETURN TRUE;
END $$;

-- 8. ATOMIC CASHFREE PAYMENT APPLICATION (Webhooks & Verify)
CREATE OR REPLACE FUNCTION public.apply_cashfree_payment(p_order_id TEXT, p_payload JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE 
    tx public.transactions%ROWTYPE;
BEGIN
    -- Lock transaction row exclusively
    SELECT * INTO tx FROM public.transactions WHERE cashfree_order_id = p_order_id FOR UPDATE;
    
    IF NOT FOUND THEN 
        RETURN jsonb_build_object('ok', false, 'code', 'NO_TX', 'message', 'Transaction not found'); 
    END IF;
    
    IF tx.status = 'SUCCESS' THEN 
        RETURN jsonb_build_object('ok', true, 'already_processed', true); 
    END IF;

    UPDATE public.transactions 
    SET status = 'SUCCESS', 
        details = COALESCE(details, '{}'::jsonb) || jsonb_build_object('gateway', p_payload)
    WHERE id = tx.id;

    IF tx.type = 'WALLET_RECHARGE' THEN
        INSERT INTO public.wallets(user_id, balance, total_recharged) 
        VALUES (tx.user_id, tx.amount, tx.amount)
        ON CONFLICT (user_id) DO UPDATE
            SET balance = wallets.balance + EXCLUDED.balance,
                total_recharged = wallets.total_recharged + EXCLUDED.total_recharged, 
                updated_at = NOW();
    ELSIF tx.type = 'SUBSCRIPTION_699' THEN
        INSERT INTO public.subscriptions(user_id, plan_name, expires_at, is_active)
        VALUES (
            tx.user_id, 
            'MONTHLY_699',
            GREATEST(NOW(), COALESCE((SELECT MAX(expires_at) FROM public.subscriptions WHERE user_id = tx.user_id AND is_active = true), NOW())) + INTERVAL '30 days',
            true
        );
        PERFORM public.grant_referral_bonus(tx.user_id);
    END IF;

    RETURN jsonb_build_object('ok', true);
END $$;

-- 9. ADMIN FINANCIAL SUMMARY (Resolves Supabase 1,000 row truncation limit)
CREATE OR REPLACE FUNCTION public.admin_financial_summary()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_users BIGINT;
    v_subs BIGINT;
    v_wallet_bal NUMERIC;
    v_kilas BIGINT;
    v_recharges NUMERIC;
    v_referral_rewards NUMERIC;
    v_referral_count BIGINT;
BEGIN
    SELECT COUNT(*) INTO v_users FROM public.users;
    SELECT COUNT(*) INTO v_subs FROM public.subscriptions WHERE is_active = true AND expires_at > NOW();
    SELECT COALESCE(SUM(balance), 0), COALESCE(SUM(total_kilas_processed), 0) INTO v_wallet_bal, v_kilas FROM public.wallets;
    
    SELECT COALESCE(SUM(amount), 0) INTO v_recharges
    FROM public.transactions
    WHERE status = 'SUCCESS' AND type = 'WALLET_RECHARGE' AND (details->>'is_referral' IS NULL OR details->>'is_referral' != 'true');

    SELECT COUNT(*), COALESCE(SUM(bonus), 0) INTO v_referral_count, v_referral_rewards
    FROM public.referrals
    WHERE rewarded_at IS NOT NULL;

    RETURN jsonb_build_object(
        'total_users', v_users,
        'active_subscriptions', v_subs,
        'total_wallet_money', v_wallet_bal,
        'total_recharge_money', v_recharges,
        'total_referral_money', v_referral_rewards,
        'total_combined_funds', (v_recharges + v_referral_rewards),
        'total_referral_passes', v_referral_count,
        'total_kilas_processed', v_kilas
    );
END $$;

-- 10. STRICT ACCESS CONTROL ON RPCs
REVOKE ALL ON FUNCTION public.authorize_kila(UUID, TEXT, NUMERIC) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commit_kila(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refund_kila(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.grant_referral_bonus(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_cashfree_payment(TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_financial_summary() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.authorize_kila(UUID, TEXT, NUMERIC) TO service_role;
GRANT EXECUTE ON FUNCTION public.commit_kila(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_kila(UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.grant_referral_bonus(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_cashfree_payment(TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_financial_summary() TO service_role;
