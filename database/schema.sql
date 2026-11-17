-- =========================================================================
-- ON-FARM DATABASE SCHEMA (SUPABASE POSTGRESQL) - BULLETPROOF PRODUCTION
-- =========================================================================

-- 1. Enable UUID Extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Users Table
CREATE TABLE IF NOT EXISTS public.users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    phone TEXT UNIQUE NOT NULL,
    email TEXT,
    hwid TEXT, -- Hardware Device ID (CPU + Motherboard UUID locked on first login)
    is_blocked BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    last_active_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_hwid_uq ON public.users(hwid) WHERE hwid IS NOT NULL;

-- 3. Wallets Table (For Model A: ₹1/kila pay-per-use)
CREATE TABLE IF NOT EXISTS public.wallets (
    user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    balance NUMERIC(10, 2) DEFAULT 0.00 CHECK (balance >= 0.00),
    total_recharged NUMERIC(10, 2) DEFAULT 0.00,
    total_kilas_processed INTEGER DEFAULT 0,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 4. Subscriptions Table (For Model B: ₹699/month unlimited pass)
CREATE TABLE IF NOT EXISTS public.subscriptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    plan_name TEXT DEFAULT 'MONTHLY_699',
    starts_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subs_user_active_exp ON public.subscriptions(user_id, is_active, expires_at);

-- 5. Transactions Table (Cashfree Payment History & Wallet Ledger)
CREATE TABLE IF NOT EXISTS public.transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    amount NUMERIC(10, 2) NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('WALLET_RECHARGE', 'SUBSCRIPTION_699', 'KILA_DEBIT', 'REFERRAL_LINKED', 'REFERRAL_BONUS')),
    cashfree_order_id TEXT,
    payment_session_id TEXT,
    status TEXT DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SUCCESS', 'FAILED', 'COMPLETED')),
    details JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_cashfree_order_id ON public.transactions(cashfree_order_id) WHERE cashfree_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tx_user_created ON public.transactions(user_id, created_at DESC);

-- 6. Two-Phase Kila Charges Ledger
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
CREATE INDEX IF NOT EXISTS idx_kila_charges_user_refund_window ON public.kila_charges (user_id, created_at DESC) WHERE status = 'REFUNDED';

-- 7. Dedicated Referrals Table
CREATE TABLE IF NOT EXISTS public.referrals (
    referred_user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    referrer_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    bonus NUMERIC(10,2) NOT NULL DEFAULT 25.00,
    linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    rewarded_at TIMESTAMPTZ,
    CHECK (referred_user_id <> referrer_user_id)
);

-- 8. App Configuration Table (Public config only)
CREATE TABLE IF NOT EXISTS public.app_config (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 9. Remote Encrypted Scripts Table (Anti-Reverse Engineering)
CREATE TABLE IF NOT EXISTS public.remote_scripts (
    version TEXT PRIMARY KEY,
    encrypted_code TEXT NOT NULL,
    iv TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Seed Public Config
INSERT INTO public.app_config (key, value)
VALUES 
    ('version_gate', '{"latest_version": "1.0.0", "min_supported_version": "1.0.0", "force_update": true, "update_url": "https://onfarm-tech.vercel.app"}'::jsonb),
    ('pricing_plans', '{"kila_rate": 1.00, "monthly_subscription": 699.00, "min_wallet_recharge": 100.00}'::jsonb),
    ('announcements', '{"active": false, "message": "Welcome to On-Farm Official Automation!"}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- Automatic Wallet Creation Trigger
CREATE OR REPLACE FUNCTION public.handle_new_user_wallet()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.wallets (user_id, balance, total_recharged, total_kilas_processed)
    VALUES (NEW.id, 0.00, 0.00, 0)
    ON CONFLICT (user_id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trigger_new_user_wallet ON public.users;
CREATE TRIGGER trigger_new_user_wallet
    AFTER INSERT ON public.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_wallet();

-- Strict Row Level Security: Deny all direct public/anon access
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kila_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.remote_scripts ENABLE ROW LEVEL SECURITY;

-- Only service_role can access tables directly
DROP POLICY IF EXISTS "service_role_all_users" ON public.users;
DROP POLICY IF EXISTS "service_role_all_wallets" ON public.wallets;
DROP POLICY IF EXISTS "service_role_all_subscriptions" ON public.subscriptions;
DROP POLICY IF EXISTS "service_role_all_transactions" ON public.transactions;
DROP POLICY IF EXISTS "service_role_all_app_config" ON public.app_config;
DROP POLICY IF EXISTS "service_role_all_remote_scripts" ON public.remote_scripts;

CREATE POLICY "service_role_users" ON public.users TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_wallets" ON public.wallets TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_subscriptions" ON public.subscriptions TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_transactions" ON public.transactions TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_kila_charges" ON public.kila_charges TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_referrals" ON public.referrals TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_app_config" ON public.app_config TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_remote_scripts" ON public.remote_scripts TO service_role USING (true) WITH CHECK (true);
