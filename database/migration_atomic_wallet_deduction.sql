-- =========================================================================
-- MIGRATION: HARDENING PRODUCTION SECURITY & ATOMIC RPC
-- Run this in Supabase Dashboard -> SQL Editor -> Click "Run"
-- =========================================================================

-- 1. Ensure unique constraint on cashfree_order_id to prevent double-credit on webhook retries
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_cashfree_order_id 
ON public.transactions(cashfree_order_id) 
WHERE cashfree_order_id IS NOT NULL;

-- 2. Atomic Wallet Deduction RPC Function (Prevents Race Conditions)
-- Executes inside a PostgreSQL atomic transaction: balances can NEVER become negative
CREATE OR REPLACE FUNCTION public.deduct_kila_wallet_atomic(
    p_user_id UUID,
    p_amount NUMERIC DEFAULT 1.00,
    p_kila TEXT DEFAULT 'Unknown'
)
RETURNS JSONB AS $$
DECLARE
    v_cur_bal NUMERIC;
    v_new_bal NUMERIC;
    v_kilas_done INTEGER;
BEGIN
    -- Row-level locking on wallet
    SELECT balance, total_kilas_processed 
    INTO v_cur_bal, v_kilas_done
    FROM public.wallets 
    WHERE user_id = p_user_id 
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'code', 'WALLET_NOT_FOUND', 'message', 'Wallet not found.');
    END IF;

    IF v_cur_bal < p_amount THEN
        RETURN jsonb_build_object('ok', false, 'code', 'INSUFFICIENT_FUNDS', 'message', 'Wallet balance insufficient.');
    END IF;

    v_new_bal := v_cur_bal - p_amount;
    v_kilas_done := v_kilas_done + 1;

    -- Atomic update
    UPDATE public.wallets
    SET balance = v_new_bal,
        total_kilas_processed = v_kilas_done,
        updated_at = timezone('utc'::text, now())
    WHERE user_id = p_user_id;

    -- Record transaction
    INSERT INTO public.transactions (user_id, amount, type, status, details)
    VALUES (p_user_id, p_amount, 'KILA_DEBIT', 'SUCCESS', jsonb_build_object('kila', p_kila));

    RETURN jsonb_build_object(
        'ok', true,
        'remaining_balance', v_new_bal,
        'deducted', p_amount,
        'total_kilas', v_kilas_done
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
