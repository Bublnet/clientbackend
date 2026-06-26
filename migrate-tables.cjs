const { Client } = require('pg');
const client = new Client({ connectionString: 'postgresql://postgres.vorsywdfxvzkdhzaastf:aTc7L!@.tGSs&L8@aws-1-ap-northeast-2.pooler.supabase.com:6543/postgres?pgbouncer=true' });

async function run() {
  await client.connect();
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.bookings (
      id text PRIMARY KEY,
      "venueId" text,
      "venueName" text,
      "customerName" text,
      "userId" text,
      "customerPhone" text,
      "ownerId" text,
      "ownerName" text,
      "ownerPhone" text,
      "venueAddress" text,
      amount numeric,
      guests numeric,
      status text,
      "paymentStatus" text,
      "ticketCode" text,
      "ticketImage" text,
      "verificationToken" text,
      "qrPayload" text,
      "ownerVerifiedAt" text,
      "bookedAt" text,
      "eventDate" text,
      "paidAt" text,
      "confirmedAt" text,
      "receiptUrl" text
    );
  `);
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.admin_sessions (
      id text PRIMARY KEY,
      subject text,
      role text,
      "createdAt" numeric,
      "expiresAt" numeric,
      "lastSeenAt" numeric,
      "userAgent" text
    );
  `);
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.auth_otps (
      id text PRIMARY KEY,
      identifier text,
      "otpHash" text,
      purpose text,
      "expiresAt" numeric,
      attempts numeric,
      "createdAt" text
    );
  `);
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.settings (
      id text PRIMARY KEY,
      version text,
      features jsonb,
      "maintenanceMode" boolean,
      "updatedAt" text
    );
  `);

  console.log('Tables created successfully');
  await client.end();
}
run().catch(console.error);
