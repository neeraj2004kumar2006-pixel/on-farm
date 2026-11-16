-- =========================================================================
-- ON-FARM DATABASE SCHEMA (SUPABASE POSTGRESQL)
-- Run this in Supabase Dashboard -> SQL Editor -> Click "Run"
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

-- 5. Transactions Table (Cashfree Payment History)
CREATE TABLE IF NOT EXISTS public.transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    amount NUMERIC(10, 2) NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('WALLET_RECHARGE', 'SUBSCRIPTION_699', 'KILA_DEBIT')),
    cashfree_order_id TEXT,
    payment_session_id TEXT,
    status TEXT DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SUCCESS', 'FAILED')),
    details JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 6. App Configuration & Remote Update Control Table
CREATE TABLE IF NOT EXISTS public.app_config (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 7. Remote Encrypted Scripts Table (Anti-Reverse Engineering)
-- Core automation code is stored encrypted here and delivered to RAM only.
CREATE TABLE IF NOT EXISTS public.remote_scripts (
    version TEXT PRIMARY KEY,
    encrypted_code TEXT NOT NULL,
    iv TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- =========================================================================
-- INITIAL SEED CONFIGURATION
-- =========================================================================

-- Version & Enforcement Settings
INSERT INTO public.app_config (key, value)
VALUES 
    ('version_gate', '{"latest_version": "1.0.0", "min_supported_version": "1.0.0", "force_update": true, "update_url": "https://onfarm-tech.vercel.app"}'::jsonb),
    ('pricing_plans', '{"kila_rate": 1.00, "monthly_subscription": 699.00, "min_wallet_recharge": 100.00}'::jsonb),
    ('announcements', '{"active": false, "message": "Welcome to On-Farm Official Automation!"}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- =========================================================================
-- AUTOMATIC WALLET CREATION TRIGGER
-- =========================================================================
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

-- Grant permissions for service role
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.remote_scripts ENABLE ROW LEVEL SECURITY;

-- Allow service_role full bypass
CREATE POLICY "service_role_all_users" ON public.users FOR ALL USING (true);
CREATE POLICY "service_role_all_wallets" ON public.wallets FOR ALL USING (true);
CREATE POLICY "service_role_all_subscriptions" ON public.subscriptions FOR ALL USING (true);
CREATE POLICY "service_role_all_transactions" ON public.transactions FOR ALL USING (true);
CREATE POLICY "service_role_all_app_config" ON public.app_config FOR ALL USING (true);
CREATE POLICY "service_role_all_remote_scripts" ON public.remote_scripts FOR ALL USING (true);
