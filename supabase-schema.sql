create extension if not exists pgcrypto;

create table if not exists public.venues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  "legalBusinessName" text not null default '',
  gstin text,
  category text not null default 'venue',
  type text not null default 'Event Venue',
  location text not null default '',
  address text not null default '',
  pincode text not null default '',
  state text not null default '',
  country text not null default 'India',
  lat double precision not null default 0,
  lng double precision not null default 0,
  capacity integer,
  "priceUnit" text not null default 'daily',
  "basePrice" numeric(14,2) not null default 0,
  "gstRate" numeric(6,2) not null default 18,
  "gstAmount" numeric(14,2),
  "priceWithGst" numeric(14,2),
  "priceRange" text not null default '',
  rating double precision not null default 0,
  "imageEmoji" text not null default 'pin',
  images text[] not null default '{}',
  thumbnails text[] not null default '{}',
  "specTable" jsonb not null default '{"rows":[]}'::jsonb,
  spaces jsonb not null default '[]'::jsonb,
  status text not null default 'pending',
  "ownerId" text not null,
  "ownerEmail" text,
  "ownerName" text not null default '',
  verified boolean not null default false,
  "verificationStatus" text not null default 'pending_contact',
  "verificationNotes" text,
  "rejectionReason" text,
  "contactedAt" timestamptz,
  "submittedAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  "approvedAt" timestamptz
);

alter table public.venues add column if not exists "ownerEmail" text;

create index if not exists venues_status_idx on public.venues (status);
create index if not exists venues_owner_id_idx on public.venues ("ownerId");
create index if not exists venues_owner_email_idx on public.venues ("ownerEmail");
create index if not exists venues_updated_at_idx on public.venues ("updatedAt" desc);

create table if not exists public.profiles (
  id text primary key,
  email text,
  display_name text,
  role text not null default 'client',
  parent_id text references public.profiles(id) on delete set null,
  permissions jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  manual_location jsonb,
  is_premium boolean not null default false,
  premium_since timestamptz,
  last_payment_id text,
  ad_access_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles add column if not exists role text not null default 'client';
alter table public.profiles add column if not exists parent_id text references public.profiles(id) on delete set null;
alter table public.profiles add column if not exists permissions jsonb not null default '{}'::jsonb;
alter table public.profiles add column if not exists active boolean not null default true;
alter table public.profiles add column if not exists manual_location jsonb;
alter table public.profiles add column if not exists ad_access_until timestamptz;

update public.profiles
set role = case
  when role in ('manager', 'support', 'reviewer') then 'staff'
  when role in ('admin', 'staff', 'host', 'hoststaff', 'client') then role
  else 'client'
end;

do $$ begin
  alter table public.profiles add constraint profiles_role_check
    check (role in ('admin', 'staff', 'host', 'hoststaff', 'client'));
exception when duplicate_object then null;
end $$;

create index if not exists profiles_role_idx on public.profiles (role);
create index if not exists profiles_parent_idx on public.profiles (parent_id);

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name, role)
  values (
    new.id::text,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'name', split_part(coalesce(new.email, ''), '@', 1), 'Dvenue User'),
    'client'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'razorpay',
  razorpay_order_id text,
  razorpay_payment_id text unique,
  razorpay_signature text,
  type text,
  reference_id text,
  user_id text,
  amount_paise integer,
  status text,
  metadata jsonb not null default '{}'::jsonb,
  verified_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists payments_user_id_idx on public.payments (user_id);
create index if not exists payments_reference_id_idx on public.payments (reference_id);

alter table public.venues enable row level security;
alter table public.profiles enable row level security;
alter table public.payments enable row level security;

grant all on public.venues, public.profiles, public.payments to service_role;
grant select on public.profiles to authenticated;

drop policy if exists profiles_read_self on public.profiles;
create policy profiles_read_self on public.profiles
  for select to authenticated using (id = auth.uid()::text);

drop policy if exists profiles_update_self on public.profiles;
