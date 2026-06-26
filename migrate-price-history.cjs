const { Client } = require('pg');
const client = new Client({ connectionString: 'postgresql://postgres.vorsywdfxvzkdhzaastf:aTc7L!@.tGSs&L8@aws-1-ap-northeast-2.pooler.supabase.com:6543/postgres?pgbouncer=true' });

async function run() {
  await client.connect();
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.venue_price_history (
      id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      "venueId" text,
      source text,
      "actorId" text,
      "actorName" text,
      "changedAt" text,
      changes jsonb
    );
  `);
  
  console.log('Tables created successfully');
  await client.end();
}
run().catch(console.error);
