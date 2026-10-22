import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders as defaultCorsHeaders } from "npm:@supabase/supabase-js@^2/cors";

// Public admissions endpoint. It performs server-side validation and rate limiting,
// then writes only to the admissions table using a server-only service key. Configure
// CAMPUS_ALLOWED_ORIGIN to exact production origins; the wildcard fallback is for setup
// and should not be left open on a production deployment.
const allowedOrigins = (Deno.env.get("CAMPUS_ALLOWED_ORIGIN") ?? "*")
  .split(",").map((origin) => origin.trim().replace(/\/+$/, "")).filter(Boolean);

// Build browser CORS headers from the deployment allow-list; requests outside it fail.
function corsHeaders(request: Request): Headers {
  const requestOrigin = request.headers.get("Origin")?.replace(/\/+$/, "") ?? "";
  const allowsOrigin = !requestOrigin || allowedOrigins.includes("*") || allowedOrigins.includes(requestOrigin);
  const headers = new Headers(defaultCorsHeaders);
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.append("Vary", "Origin");
  if (requestOrigin && allowsOrigin) headers.set("Access-Control-Allow-Origin", allowedOrigins.includes("*") ? "*" : requestOrigin);
  else if (requestOrigin) headers.delete("Access-Control-Allow-Origin");
  return headers;
}

Deno.serve(async (request) => {
  // Handle browser preflight before parsing or processing enquiry data.
  if (request.method === "OPTIONS") {
    const headers = corsHeaders(request);
    if (request.headers.get("Origin") && !headers.get("Access-Control-Allow-Origin")) return new Response("Origin not allowed", { status: 403, headers });
    return new Response("ok", { headers });
  }
  const respond = (body: unknown, status = 200) => {
    const headers = corsHeaders(request);
    headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify(body), { status, headers });
  };
  try {
    // This function intentionally accepts public POSTs, so its route is deployed with
    // JWT verification disabled. Input validation, honeypot, rate limit, and narrowly
    // scoped database writes below provide the application-level protections.
    if (request.method !== "POST") return respond({ error: "POST required" }, 405);
    const { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: serviceKey } = Deno.env.toObject();
    if (!url || !serviceKey) return respond({ error: "Admissions service is not configured." }, 500);
    // The hidden website field is a honeypot: normal users leave it empty, while basic
    // automated submissions are acknowledged without creating a database record.
    const body = await request.json();
    if (String(body.website ?? "").trim()) return respond({ ok: true }); // honeypot for basic bots
    const studentName = String(body.student_name ?? "").trim();
    const grade = String(body.grade ?? "").trim();
    const guardianName = String(body.guardian_name ?? "").trim();
    const phone = String(body.phone ?? "").trim();
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!studentName || !grade || !guardianName || !phone) return respond({ error: "Student, grade, guardian and contact are required." }, 400);
    if (studentName.length > 140 || guardianName.length > 140 || grade.length > 80 || phone.length > 40 || email.length > 180) {
      return respond({ error: "One or more fields are too long." }, 400);
    }
    if (email && !/^\S+@\S+\.\S+$/.test(email)) return respond({ error: "Enter a valid email address." }, 400);

    // Hash the best available caller IP instead of storing its raw value. The database
    // rate-limit RPC caps each hash and starts a new window after twenty minutes.
    const forwarded = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const hashInput = new TextEncoder().encode((Deno.env.get("ADMISSION_RATE_SALT") ?? url) + ":" + forwarded);
    const digest = await crypto.subtle.digest("SHA-256", hashInput);
    const ipHash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: withinLimit, error: limitError } = await service.rpc("consume_admission_rate_limit", { p_ip_hash: ipHash });
    if (limitError) return respond({ error: "Enquiries are temporarily unavailable." }, 503);
    if (!withinLimit) return respond({ error: "Please wait a little before sending another enquiry." }, 429);

    // Write the normalized, length-limited fields only after the rate limit succeeds.
    const { data, error } = await service.from("admissions").insert({
      student_name: studentName,
      grade,
      date_of_birth: body.date_of_birth || null,
      guardian_name: guardianName,
      phone,
      email,
      current_school: String(body.current_school ?? "").trim().slice(0, 180),
      address: String(body.address ?? "").trim().slice(0, 500),
      message: String(body.message ?? "").trim().slice(0, 2000),
      status: "New enquiry",
    }).select("id").single();
    if (error) return respond({ error: "We could not save this enquiry. Please contact the school office." }, 503);
    return respond({ ok: true, reference: data.id }, 201);
  } catch (error) {
    // Log diagnostics server-side and keep public responses free of internal details.
    console.error("submit-admission failed", error);
    return respond({ error: "We could not save this enquiry. Please try again." }, 500);
  }
});
