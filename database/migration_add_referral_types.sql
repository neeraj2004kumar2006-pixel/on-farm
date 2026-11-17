-- =========================================================================
-- MIGRATION: Add REFERRAL_LINKED, REFERRAL_BONUS types and COMPLETED status
-- Run this in Supabase Dashboard -> SQL Editor -> Click "Run"
-- =========================================================================

-- Drop old type constraint
ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_type_check;

-- Add new type constraint with referral types
ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_type_check
    CHECK (type IN ('WALLET_RECHARGE', 'SUBSCRIPTION_699', 'KILA_DEBIT', 'REFERRAL_LINKED', 'REFERRAL_BONUS'));

-- Drop old status constraint
ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_status_check;

-- Add new status constraint with COMPLETED
ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_status_check
    CHECK (status IN ('PENDING', 'SUCCESS', 'FAILED', 'COMPLETED'));
