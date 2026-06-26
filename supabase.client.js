import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function isServerKey(value) {
  if (!value) return false;
  if (value.startsWith('sb_secret_')) return true;
  if (!value.startsWith('eyJ')) return false;
  try {
    const payload = JSON.parse(
      Buffer.from(value.split('.')[1], 'base64url').toString('utf8'),
    );
    return payload.role === 'service_role';
  } catch (_) {
    return false;
  }
}

const hasServerKey = isServerKey(supabaseServiceKey);

if (!supabaseUrl || !hasServerKey) {
  console.warn(
    'Supabase server credentials are missing or publishable-only. Set SUPABASE_SERVICE_ROLE_KEY to an sb_secret_ key or legacy service_role JWT.',
  );
}

// Server-only client. Never expose this credential to Flutter or browser code.
export const supabase = (supabaseUrl && hasServerKey)
  ? createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  : null;

export function isSupabaseConfigured() {
  return !!(supabaseUrl && hasServerKey);
}

export default supabase;
