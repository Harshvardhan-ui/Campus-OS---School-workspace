-- Campus OS shared database. Run in a new Supabase project's SQL Editor.
-- The browser only uses a publishable key; RLS is the authorization boundary.
-- This migration creates the Phase 1 schema, trusted RPC/helper functions, audit triggers,
-- grants, row policies, and realtime setup. Review policies and backups before live data.
create extension if not exists pgcrypto;

-- One-to-one workspace profile for auth.users. Newly created users default to unassigned;
-- a trusted owner must grant a student or office role after verifying the account.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null default '', display_name text not null default '',
  role text not null default 'unassigned' check (role in ('owner','office','student','unassigned')),
  student_id uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
-- The single school_settings row holds public copy, identity, contact details, and
-- invoice wording. The id check intentionally limits the app to one school workspace.
create table if not exists public.school_settings (
  id integer primary key default 1 check (id=1), school text not null default 'Your School', campus text not null default 'Main campus',
  tagline text not null default 'A place to learn, belong and grow.', hero_line1 text not null default 'Curious minds.',
  hero_line2 text not null default 'Kind hearts.', hero_line3 text not null default 'Wide open futures.', cta_label text not null default 'Contact the school',
  feature1_title text not null default 'Learning with purpose', feature1_body text not null default '',
  feature2_title text not null default 'A campus with possibility', feature2_body text not null default '',
  feature3_title text not null default 'Admissions', feature3_body text not null default '',
  academic_year text not null default '2026–27', accent text not null default '#c9f06c', contact text not null default '',
  show_stats boolean not null default false, school_address text not null default '', school_phone text not null default '',
  registration_number text not null default '', invoice_footer text not null default '',
  updated_at timestamptz not null default now(), updated_by uuid references auth.users(id)
);
-- Owner-maintained class/section plans and per-year fee schedules. Installment labels
-- are JSON so the owner can customize their names without a schema change.
create table if not exists public.class_settings (
  id uuid primary key default gen_random_uuid(), grade text not null, section text not null default '', academic_year text not null,
  capacity integer, annual_fee numeric(12,2) not null default 0 check(annual_fee>=0), late_fee numeric(12,2) not null default 0 check(late_fee>=0),
  installments jsonb not null default '[]'::jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(grade,section,academic_year)
);
-- Enrolled student and guardian details. Restrict support notes to the staff roles in
-- the RLS policies; student accounts are linked by profiles.student_id.
create table if not exists public.students (
  id uuid primary key default gen_random_uuid(), student_code text not null unique, name text not null,
  grade text not null, section text not null default '', academic_year text not null, dob date,
  guardian text not null default '', relationship text not null default '', guardian_phone text not null default '',
  guardian_email text not null default '', address text not null default '', previous_school text not null default '',
  emergency_name text not null default '', emergency_phone text not null default '', support_notes text not null default '',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by uuid references auth.users(id)
);
-- Link profiles to students only after both tables exist. The lower-case unique index
-- prevents duplicate school IDs that differ only by letter casing.
alter table public.profiles drop constraint if exists profiles_student_id_fkey;
alter table public.profiles add constraint profiles_student_id_fkey foreign key(student_id) references public.students(id) on delete set null;
create index if not exists students_class_idx on public.students(grade,section,academic_year);
create unique index if not exists students_code_case_insensitive on public.students(lower(student_code));
create index if not exists students_name_idx on public.students using gin(to_tsvector('simple',name));

-- Public and office admission enquiries are stored separately from enrolled students.
-- The checked status values match the admission stages available in the school app.
create table if not exists public.admissions (
  id uuid primary key default gen_random_uuid(), student_name text not null, grade text not null, date_of_birth date,
  guardian_name text not null, phone text not null, email text not null default '', current_school text not null default '',
  address text not null default '', message text not null default '',
  status text not null default 'New enquiry' check(status in ('New enquiry','Contacted','Application','Assessment','Offered','Admitted','Closed')),
  office_notes text not null default '', created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index if not exists admissions_created_idx on public.admissions(created_at desc);

-- A student has at most one attendance mark for a given date. Actor and update time
-- support accountability and same-day synchronization across signed-in devices.
create table if not exists public.attendance (
  id uuid primary key default gen_random_uuid(), student_id uuid not null references public.students(id) on delete cascade,
  attendance_date date not null, status text not null check(status in ('Present','Absent','Late','Unmarked')),
  note text not null default '', marked_by uuid references auth.users(id), updated_at timestamptz not null default now(),
  unique(student_id,attendance_date)
);
create index if not exists attendance_day_idx on public.attendance(attendance_date,student_id);

-- Owner-created fee accounts. The unique student/year/installment key prevents duplicate
-- charges; payment requests and parent-contact followups are tracked in separate tables.
create table if not exists public.fee_accounts (
  id uuid primary key default gen_random_uuid(), student_id uuid not null references public.students(id) on delete cascade,
  academic_year text not null, installment text not null, amount numeric(12,2) not null check(amount>=0), due_date date not null,
  late_fee numeric(12,2) not null default 0 check(late_fee>=0), late_fee_reason text not null default '',
  status text not null default 'Unpaid' check(status in ('Unpaid','Paid','Waived')), paid_at timestamptz,
  receipt_number text, payment_method text not null default '', payment_reference text not null default '',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), updated_by uuid references auth.users(id),
  unique(student_id,academic_year,installment)
);
create index if not exists fees_due_idx on public.fee_accounts(status,due_date);
create index if not exists fees_student_idx on public.fee_accounts(student_id,academic_year);

-- Office staff request payment verification; only an Owner review can mark the fee paid.
-- Followup rows preserve the contact method, reason, promised date, and staff account.
create table if not exists public.fee_payment_requests (
  id uuid primary key default gen_random_uuid(), fee_account_id uuid not null references public.fee_accounts(id) on delete cascade,
  amount numeric(12,2) not null check(amount>0), method text not null, reference text not null default '', note text not null default '',
  status text not null default 'Pending' check(status in ('Pending','Approved','Rejected')),
  requested_by uuid not null references auth.users(id), reviewed_by uuid references auth.users(id), reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists public.fee_followups (
  id uuid primary key default gen_random_uuid(), fee_account_id uuid not null references public.fee_accounts(id) on delete cascade,
  parent_contact text not null, method text not null, reason text not null, promised_date date,
  late_fee_discussed boolean not null default false, note text not null default '',
  contacted_by uuid not null references auth.users(id), created_at timestamptz not null default now()
);
create table if not exists public.audit_logs (
  id bigint generated always as identity primary key, table_name text not null, record_id text not null,
  operation text not null, changed_fields text[] not null default '{}', changed_by uuid, changed_at timestamptz not null default now()
);
create index if not exists audit_logs_time_idx on public.audit_logs(changed_at desc);

-- Public enquiry rate limiting stores a salted caller-IP hash rather than the raw IP.
-- The table is RLS-enabled and its RPC is executable only by the server service role.
create table if not exists public.admission_rate_limits (
  ip_hash text primary key, hit_count integer not null default 0, window_started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.admission_rate_limits enable row level security;
-- Atomically allow up to five submissions per hashed address in a rolling twenty-minute
-- window. A denied conflict update returns no row, which the function reports as false.
create or replace function public.consume_admission_rate_limit(p_ip_hash text)
returns boolean language plpgsql security definer set search_path=public,pg_temp
as $$ declare allowed boolean:=false; begin
  insert into public.admission_rate_limits as limits(ip_hash,hit_count,window_started_at,updated_at)
  values(p_ip_hash,1,now(),now())
  on conflict(ip_hash) do update set
    hit_count=case when limits.window_started_at<=now()-interval '20 minutes' then 1 else limits.hit_count+1 end,
    window_started_at=case when limits.window_started_at<=now()-interval '20 minutes' then now() else limits.window_started_at end,
    updated_at=now()
  where limits.window_started_at<=now()-interval '20 minutes' or limits.hit_count<5
  returning true into allowed;
  return coalesce(allowed,false);
end $$;
revoke all on function public.consume_admission_rate_limit(text) from public;
grant execute on function public.consume_admission_rate_limit(text) to service_role;

-- SECURITY DEFINER lookup helpers avoid recursive RLS checks against profiles.
-- These helpers return only the current user's role, linked student, or staff flag so
-- policies can avoid querying profiles recursively under the same row policy.
create or replace function public.campus_role() returns text
language sql stable security definer set search_path=public,pg_temp
as $$ select coalesce((select role from public.profiles where id=auth.uid()),'unassigned') $$;
create or replace function public.campus_student_id() returns uuid
language sql stable security definer set search_path=public,pg_temp
as $$ select student_id from public.profiles where id=auth.uid() $$;
create or replace function public.is_campus_staff() returns boolean
language sql stable security definer set search_path=public,pg_temp
as $$ select public.campus_role() in ('owner','office') $$;
revoke all on function public.campus_role() from public;
revoke all on function public.campus_student_id() from public;
revoke all on function public.is_campus_staff() from public;
grant execute on function public.campus_role(),public.campus_student_id(),public.is_campus_staff() to authenticated;

-- New Auth users start unassigned. A trusted owner must grant a workspace role.
-- Ignore any role in user-supplied metadata; new profiles always receive the least
-- privilege until a trusted owner assigns access through the verified workflow.
create or replace function public.handle_new_campus_user() returns trigger
language plpgsql security definer set search_path=public,pg_temp
as $$ begin
  insert into public.profiles(id,email,display_name,role)
  values(new.id,coalesce(new.email,''),coalesce(new.raw_user_meta_data->>'display_name',''),'unassigned') on conflict(id) do nothing;
  return new;
end $$;
drop trigger if exists campus_auth_user_created on auth.users;
create trigger campus_auth_user_created after insert on auth.users
for each row execute function public.handle_new_campus_user();

-- Audit field names and actor, without copying sensitive student data into a second table.
-- Compare old/new row JSON to identify changed field names, then record only the row key,
-- operation, actor, and fields in the audit table (never the sensitive values themselves).
create or replace function public.write_campus_audit() returns trigger
language plpgsql security definer set search_path=public,pg_temp
as $$ declare old_data jsonb; new_data jsonb; row_key text; fields text[];
begin
  old_data:=case when tg_op='INSERT' then '{}'::jsonb else to_jsonb(old) end;
  new_data:=case when tg_op='DELETE' then '{}'::jsonb else to_jsonb(new) end;
  row_key:=coalesce(new_data->>'id',old_data->>'id',new_data->>'student_code',old_data->>'student_code','unknown');
  select coalesce(array_agg(k order by k),'{}') into fields from (
    select key as k from jsonb_each(new_data) union select key as k from jsonb_each(old_data)
    except select n.key from jsonb_each(new_data) n join jsonb_each(old_data) o using(key) where n.value=o.value
  ) changed;
  insert into public.audit_logs(table_name,record_id,operation,changed_fields,changed_by)
  values(tg_table_name,row_key,tg_op,fields,auth.uid());
  return null;
end $$;
do $$ declare t text; begin
  foreach t in array array['profiles','school_settings','class_settings','students','admissions','attendance','fee_accounts','fee_payment_requests','fee_followups'] loop
    execute format('drop trigger if exists campus_audit_%I on public.%I',t,t);
    execute format('create trigger campus_audit_%I after insert or update or delete on public.%I for each row execute function public.write_campus_audit()',t,t);
  end loop;
end $$;

-- These functions make owner-only fee state transitions atomic and auditable.
-- The first RPC validates the Owner role and updates status/payment metadata together;
-- a receipt number is assigned only for a Paid state and cleared for other states.
create or replace function public.owner_set_fee_status(p_fee_id uuid,p_status text,p_reason text default '',p_method text default '',p_reference text default '',p_late_fee numeric default null)
returns public.fee_accounts language plpgsql security definer set search_path=public,pg_temp
as $$ declare result public.fee_accounts; begin
  if public.campus_role()<>'owner' then raise exception 'Only the owner can change fee status'; end if;
  if p_status not in ('Paid','Unpaid','Waived') then raise exception 'Invalid fee status'; end if;
  update public.fee_accounts set status=p_status,late_fee_reason=coalesce(p_reason,''),late_fee=coalesce(p_late_fee,late_fee),
    payment_method=case when p_status='Paid' then coalesce(p_method,'') else '' end,
    payment_reference=case when p_status='Paid' then coalesce(p_reference,'') else '' end,
    paid_at=case when p_status='Paid' then coalesce(paid_at,now()) else null end,
    receipt_number=case when p_status='Paid' then coalesce(receipt_number,'INV-'||to_char(now(),'YYYYMMDD')||'-'||upper(substr(replace(id::text,'-',''),1,8))) else null end,
    updated_by=auth.uid(),updated_at=now() where id=p_fee_id returning * into result;
  if not found then raise exception 'Fee record not found'; end if;
  return result;
end $$;
-- Review one pending office request under a row lock, validate the exact amount due,
-- and update the fee plus request in the same database transaction.
create or replace function public.review_fee_payment_request(p_request_id uuid,p_approve boolean)
returns public.fee_payment_requests language plpgsql security definer set search_path=public,pg_temp
as $$ declare req public.fee_payment_requests; account_row public.fee_accounts; expected_amount numeric; begin
  if public.campus_role()<>'owner' then raise exception 'Only the owner can review payment requests'; end if;
  select * into req from public.fee_payment_requests where id=p_request_id for update;
  if not found or req.status<>'Pending' then raise exception 'Pending request not found'; end if;
  if p_approve then
    select * into account_row from public.fee_accounts where id=req.fee_account_id for update;
    if not found or account_row.status<>'Unpaid' then raise exception 'Fee account is no longer unpaid'; end if;
    expected_amount:=account_row.amount + case when account_row.due_date<current_date then account_row.late_fee else 0 end;
    if req.amount<>expected_amount then raise exception 'Payment amount does not match this installment and applicable late fee'; end if;
    perform public.owner_set_fee_status(req.fee_account_id,'Paid','',req.method,req.reference);
    update public.fee_payment_requests set status='Approved',reviewed_by=auth.uid(),reviewed_at=now() where id=p_request_id returning * into req;
  else
    update public.fee_payment_requests set status='Rejected',reviewed_by=auth.uid(),reviewed_at=now() where id=p_request_id returning * into req;
  end if;
  return req;
end $$;
-- Generate one installment for each student matching grade, section, and academic year.
-- The unique key makes repeated generation idempotent by skipping existing installments.
create or replace function public.generate_class_fee(p_class_id uuid,p_installment text,p_amount numeric,p_due_date date)
returns integer language plpgsql security definer set search_path=public,pg_temp
as $$ declare cls public.class_settings; inserted integer; begin
  if public.campus_role()<>'owner' then raise exception 'Only the owner can create class fee charges'; end if;
  if p_amount<=0 then raise exception 'Installment amount must be greater than zero'; end if;
  select * into cls from public.class_settings where id=p_class_id;
  if not found then raise exception 'Class and section not found'; end if;
  insert into public.fee_accounts(student_id,academic_year,installment,amount,due_date,late_fee,updated_by)
  select s.id,cls.academic_year,p_installment,p_amount,p_due_date,cls.late_fee,auth.uid()
  from public.students s where s.grade=cls.grade and s.section=cls.section and s.academic_year=cls.academic_year
  on conflict(student_id,academic_year,installment) do nothing;
  get diagnostics inserted=row_count;
  return inserted;
end $$;
-- Import a reviewed JSON roster in one transaction. The function checks staff access and
-- enforces a 1–10,000 row limit; table constraints reject duplicate/invalid student IDs.
create or replace function public.import_students(p_students jsonb)
returns integer language plpgsql security invoker set search_path=public,pg_temp
as $$ declare imported integer; total integer; begin
  if not public.is_campus_staff() then raise exception 'School office or owner access required'; end if;
  if jsonb_typeof(p_students)<>'array' then raise exception 'Roster must be a JSON array'; end if;
  total:=jsonb_array_length(p_students);
  if total<1 or total>10000 then raise exception 'Import between 1 and 10000 rows'; end if;
  insert into public.students(student_code,name,grade,section,academic_year,guardian,guardian_phone,guardian_email,created_by)
  select trim(x.student_code),trim(x.name),trim(x.grade),coalesce(trim(x.section),''),coalesce(nullif(trim(x.academic_year),''),'2026–27'),
         coalesce(trim(x.guardian),''),coalesce(trim(x.guardian_phone),''),coalesce(trim(x.guardian_email),''),auth.uid()
  from jsonb_to_recordset(p_students) as x(student_code text,name text,grade text,section text,academic_year text,guardian text,guardian_phone text,guardian_email text);
  get diagnostics imported=row_count;
  return imported;
end $$;
revoke all on function public.owner_set_fee_status(uuid,text,text,text,text,numeric) from public;
revoke all on function public.review_fee_payment_request(uuid,boolean) from public;
revoke all on function public.generate_class_fee(uuid,text,numeric,date) from public;
revoke all on function public.import_students(jsonb) from public;
grant execute on function public.owner_set_fee_status(uuid,text,text,text,text,numeric),public.review_fee_payment_request(uuid,boolean),public.generate_class_fee(uuid,text,numeric,date),public.import_students(jsonb) to authenticated;

-- Enable RLS before granting app roles access. SQL grants determine which operations can
-- reach a table; the policies below determine which authenticated rows those operations
-- may read or change. The service role is reserved for the server-side Edge Functions.
alter table public.profiles enable row level security;
alter table public.school_settings enable row level security;
alter table public.class_settings enable row level security;
alter table public.students enable row level security;
alter table public.admissions enable row level security;
alter table public.attendance enable row level security;
alter table public.fee_accounts enable row level security;
alter table public.fee_payment_requests enable row level security;
alter table public.fee_followups enable row level security;
alter table public.audit_logs enable row level security;

grant select on public.school_settings to anon,authenticated;
grant insert,update,delete on public.school_settings to authenticated;
grant select,insert,update,delete on public.profiles,public.class_settings,public.students,public.attendance,public.fee_accounts,public.fee_payment_requests,public.fee_followups,public.admissions to authenticated;
grant select,insert,update,delete on public.profiles,public.admissions,public.fee_accounts,public.fee_payment_requests,public.admission_rate_limits to service_role;
grant select on public.audit_logs to authenticated;

-- Public visitors may read school identity; only Owners may edit it. The remaining
-- policies keep office, student, and owner access scoped to their defined workflows.
create policy "Public reads school identity" on public.school_settings for select to anon,authenticated using(true);
create policy "Owner manages school identity" on public.school_settings for all to authenticated using(public.campus_role()='owner') with check(public.campus_role()='owner');
create policy "Profiles visible to self and owner" on public.profiles for select to authenticated using(id=auth.uid() or public.campus_role()='owner');
create policy "Owner manages roles" on public.profiles for update to authenticated using(public.campus_role()='owner') with check(public.campus_role()='owner' and (id<>auth.uid() or role='owner'));
create policy "School team reads classes" on public.class_settings for select to authenticated using(public.is_campus_staff());
create policy "Owner manages classes" on public.class_settings for all to authenticated using(public.campus_role()='owner') with check(public.campus_role()='owner');
create policy "Team manages student records" on public.students for all to authenticated using(public.is_campus_staff()) with check(public.is_campus_staff());
create policy "Students read own profile" on public.students for select to authenticated using(id=public.campus_student_id());
create policy "School team records enquiries" on public.admissions for insert to authenticated
with check(public.is_campus_staff() and created_by=auth.uid() and status='New enquiry');
create policy "School team reads enquiries" on public.admissions for select to authenticated using(public.is_campus_staff());
create policy "School team updates enquiries" on public.admissions for update to authenticated using(public.is_campus_staff()) with check(public.is_campus_staff());
-- School staff manage class attendance; student accounts can read only their own marks.
create policy "Team reads attendance" on public.attendance for select to authenticated using(public.is_campus_staff());
create policy "Team marks attendance" on public.attendance for insert to authenticated with check(public.is_campus_staff());
create policy "Team updates attendance" on public.attendance for update to authenticated using(public.is_campus_staff()) with check(public.is_campus_staff());
create policy "Students read own attendance" on public.attendance for select to authenticated using(student_id=public.campus_student_id());
create policy "Team and student read fees" on public.fee_accounts for select to authenticated using(public.is_campus_staff() or student_id=public.campus_student_id());
create policy "Owner creates fees" on public.fee_accounts for insert to authenticated with check(public.campus_role()='owner');
create policy "Owner edits fees" on public.fee_accounts for update to authenticated using(public.campus_role()='owner') with check(public.campus_role()='owner');
-- Office users can submit requests and read their own requests; only an Owner can review
-- a request. Fee status itself is only mutable through the owner-only RPC above.
create policy "Office creates payment request" on public.fee_payment_requests for insert to authenticated with check(public.campus_role()='office' and requested_by=auth.uid());
create policy "Owner and requester read payment requests" on public.fee_payment_requests for select to authenticated using(public.campus_role()='owner' or requested_by=auth.uid());
create policy "Owner reviews requests" on public.fee_payment_requests for update to authenticated using(public.campus_role()='owner') with check(public.campus_role()='owner');
create policy "Team reads fee followups" on public.fee_followups for select to authenticated using(public.is_campus_staff());
create policy "Team records fee followups" on public.fee_followups for insert to authenticated with check(public.is_campus_staff() and contacted_by=auth.uid());
create policy "Owner reads audit history" on public.audit_logs for select to authenticated using(public.campus_role()='owner');

-- RLS also governs realtime events; this only publishes eligible tables.
-- Adding a table to the publication enables change notifications, not broader access.
-- Existing publication members are ignored so a second migration run remains harmless.
do $$ declare t text; begin
  foreach t in array array['school_settings','class_settings','students','admissions','attendance','fee_accounts','fee_payment_requests','fee_followups','profiles'] loop
    begin execute format('alter publication supabase_realtime add table public.%I',t);
    exception when duplicate_object then null; when undefined_object then raise notice 'Create supabase_realtime publication and add public.%',t; end;
  end loop;
end $$;

-- First owner: create that user under Supabase Auth, then run this in SQL Editor
-- after replacing the email. Later accounts start unassigned and must be invited by Owner.
-- This bootstrap stays commented out so running the migration never creates an owner
-- automatically or grants privileged access to an arbitrary email address.
-- update public.profiles p set role='owner',display_name='School Owner'
-- from auth.users u where p.id=u.id and lower(u.email)=lower('owner@your-school.example');
