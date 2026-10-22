import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders as defaultCorsHeaders } from "npm:@supabase/supabase-js@^2/cors";

// This Edge Function is the trusted bridge for account invitations. It accepts a
// signed-in Owner request, verifies that role against the database, then uses the
// server-only service key to create Auth users and assign their least-privilege role.
// Never move SUPABASE_SERVICE_ROLE_KEY into browser code or return it in a response.
// Configure CAMPUS_ALLOWED_ORIGIN as exact comma-separated origins before deployment;
// the wildcard fallback is intended for setup and should not be left in production.
const allowedOrigins = (Deno.env.get("CAMPUS_ALLOWED_ORIGIN") ?? "*")
  .split(",").map((origin) => origin.trim().replace(/\/+$/, "")).filter(Boolean);

// Reflect only allowed request origins and include the preflight headers browsers need.
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
  // Supabase invokes OPTIONS before cross-origin POSTs. Reject disallowed origins early.
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
    // Validate the HTTP method and require a bearer token before reading the request.
    if (request.method !== "POST") return respond({ error: "POST required" }, 405);
    const authorization = request.headers.get("Authorization");
    if (!authorization?.startsWith("Bearer ")) return respond({ error: "Sign in as an owner first." }, 401);

    const url = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !anonKey || !serviceKey) return respond({ error: "Invite function is not configured." }, 500);

    // Use the caller's JWT for role/profile reads; this ensures the caller is an actual
    // signed-in user and lets database policies restrict which student can be linked.
    const caller = createClient(url, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await caller.auth.getUser(authorization.slice("Bearer ".length));
    if (authError || !authData.user) return respond({ error: "Your sign-in expired. Sign in again." }, 401);
    const { data: callerProfile, error: roleError } = await caller.from("profiles")
      .select("role").eq("id", authData.user.id).single();
    if (roleError || callerProfile.role !== "owner") return respond({ error: "Only the owner can invite accounts." }, 403);

    // Normalize and validate input on the server rather than trusting the form's HTML.
    const payload = await request.json();
    const email = String(payload.email ?? "").trim().toLowerCase();
    const displayName = String(payload.display_name ?? "").trim();
    const role = String(payload.role ?? "");
    const studentId = payload.student_id ? String(payload.student_id) : null;
    if (!/^\S+@\S+\.\S+$/.test(email) || !displayName || !["office", "student"].includes(role)) {
      return respond({ error: "Enter a valid email, name and School office or Student role." }, 400);
    }
    if (role === "student" && !studentId) return respond({ error: "Link a student record before sending a student invitation." }, 400);

    // Check a student link using the caller's access, then invite with the service key.
    // The trusted profile update assigns access only after Supabase Auth creates the user.
    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    if (studentId) {
      const { data: student, error } = await caller.from("students").select("id").eq("id", studentId).maybeSingle();
      if (error || !student) return respond({ error: "That student record could not be found." }, 400);
    }
    const { data: invitation, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { display_name: displayName },
      redirectTo: new URL("./index.html", request.headers.get("origin") ?? url).toString(),
    });
    if (inviteError || !invitation.user) return respond({ error: inviteError?.message ?? "Invitation could not be sent." }, 400);
    const { error: profileError } = await admin.from("profiles").update({
      email,
      display_name: displayName,
      role,
      student_id: role === "student" ? studentId : null,
    }).eq("id", invitation.user.id);
    if (profileError) return respond({ error: "Invitation sent, but role assignment failed. Have the owner finish the account setup." }, 500);
    return respond({ ok: true, email });
  } catch (error) {
    // Keep internal errors in server logs; return a generic message to the browser.
    console.error("invite-campus-user failed", error);
    return respond({ error: "Could not send the invitation. Check the function logs." }, 500);
  }
});
