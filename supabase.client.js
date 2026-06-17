import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.warn(
    '⚠️  Supabase credentials missing in env. /api/cdn/upload (image CDN) and other Supabase features will be disabled or fail.'
  );
}

// Service role client (server only — full access, bypasses RLS).
// Used here for secure direct uploads to the public 'venue-images' bucket from the clientbackend proxy.
export const supabase = (supabaseUrl && supabaseServiceKey)
  ? createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  : null;

// Helper to check if Supabase is configured (for CDN + future use)
export function isSupabaseConfigured() {
  return !!(supabaseUrl && supabaseServiceKey);
}

export default supabase;
