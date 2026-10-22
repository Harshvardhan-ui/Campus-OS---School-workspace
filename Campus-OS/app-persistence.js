/*
 * Campus OS data, authentication, and event layer.
 * The HTML file supplies the layout and starter renderers; this file connects that
 * interface to Supabase, loads authorized records, replaces the prototype renderers,
 * and routes forms/actions. Client-side role checks improve navigation, while the
 * database's Row Level Security (RLS) policies remain the authority for access.
 */
(function () {
  'use strict';
  // Real user/profile state is loaded from Supabase. Local preview identities below
  // exist only in memory and never create records or persistent authentication tokens.
  var client = null;
  var user = null;
  var profile = null;
  var selectedRole = 'owner';
  var localDemoEnabled = false;
  var demoMode = false;
  var demoAccounts = {
    owner: { email: 'owner.demo@campus.test', password: 'CampusDemo-Owner-2026!', name: 'Demo Owner' },
    office: { email: 'office.demo@campus.test', password: 'CampusDemo-Office-2026!', name: 'Demo School Office' },
    student: { email: 'student.demo@campus.test', password: 'CampusDemo-Student-2026!', name: 'Demo Student' }
  };
  var feeAccounts = [];
  var paymentRequests = [];
  var feeFollowups = [];
  var classRows = [];
  var userProfiles = [];
  var auditRows = [];
  var refreshTimer = 0;
  // Display fallbacks only; a real school_settings row replaces them after sign-in.
  // These defaults intentionally do not include any sample students or school records.
  var defaultCopy = {
    school: 'Your School', campus: 'Main campus', tagline: 'A place to learn, belong and grow.',
    heroLine1: 'Curious minds.', heroLine2: 'Kind hearts.', heroLine3: 'Wide open futures.',
    ctaLabel: 'Contact the school', feature1Title: 'Learning with purpose', feature1Body: '',
    feature2Title: 'A campus with possibility', feature2Body: '', feature3Title: 'Admissions', feature3Body: '',
    academicYear: '2026–27', accent: '#c9f06c', contact: '', showStats: false,
    schoolAddress: '', schoolPhone: '', registrationNumber: '', invoiceFooter: ''
  };
  var roleLabels = { owner: 'Owner', office: 'School office', student: 'Student', unassigned: 'Awaiting access' };
  // Tables watched for changes from other authenticated devices.
  var dbTables = ['school_settings','class_settings','students','admissions','attendance','fee_accounts','fee_payment_requests','fee_followups','profiles'];

  // Show inline login feedback while signed out and toast feedback in the workspace.
  function say(message, isError) {
    var status = document.getElementById('loginStatus');
    if (status && document.body.classList.contains('signed-out')) {
      status.textContent = message;
      status.style.color = isError ? '#a95544' : '#397455';
    }
    if (typeof toast === 'function') toast(message);
  }
  function fail(error) {
    console.error('Campus OS request failed', error);
    var message = error && error.message ? error.message : 'The request could not be completed.';
    if (/Failed to fetch|NetworkError/i.test(message)) message = 'Could not reach the shared school database. Check the connection and try again.';
    throw new Error(message);
  }
  async function edgeFunctionErrorMessage(error, functionName) {
    console.error('Campus Edge Function request failed: ' + functionName, error);
    var name = error && (error.name || error.constructor && error.constructor.name) || '';
    var context = error && error.context;
    if (context && typeof context.clone === 'function') {
      try {
        var response = context.clone();
        var payload = await response.json();
        if (payload && (payload.error || payload.message)) return payload.error || payload.message;
      } catch (_) { }
      if (context.status === 404) return 'The invitation service was not found. Deploy the invite-campus-user Edge Function to the connected Supabase project.';
    }
    if (/FunctionsFetchError|Failed to send a request/i.test(name + ' ' + (error && error.message || ''))) {
      return 'The invitation service could not be reached. Deploy invite-campus-user to the connected Supabase project and allow this site origin in CAMPUS_ALLOWED_ORIGIN.';
    }
    if (/FunctionsRelayError/i.test(name)) {
      return 'Supabase could not route the invitation request. Check the project URL and Edge Function status, then deploy invite-campus-user if needed.';
    }
    return error && error.message || 'The invitation request failed. Check the Supabase Edge Function logs.';
  }
  // Supabase query responses use `{ data, error }`. Convert errors into thrown
  // exceptions so each form/action can show one consistent message to the user.
  function must(result) {
    if (result && result.error) fail(result.error);
    return result ? result.data : null;
  }
  // Mutate arrays in place because the prototype renderer and later event callbacks
  // hold references to these shared arrays for the lifetime of this page.
  function replaceList(target, rows) {
    target.length = 0;
    (rows || []).forEach(function (row) { target.push(row); });
  }
  // Use the ISO date representation expected by PostgreSQL DATE columns and form values.
  function currentISODate() { return new Date().toISOString().slice(0, 10); }
  // Password recovery and invitation links include an action type in the URL/hash.
  function authCallbackType() {
    try {
      return new URLSearchParams((location.hash || '').replace(/^#/, '')).get('type') || new URLSearchParams(location.search || '').get('type') || '';
    } catch (_) { return ''; }
  }
  // Convert database snake_case columns to the camelCase names used by UI renderers.
  // Missing settings return safe display defaults rather than creating a database row.
  function normalizeSettings(row) {
    if (!row) return Object.assign({}, defaultCopy);
    return {
      school: row.school, campus: row.campus, tagline: row.tagline, heroLine1: row.hero_line1,
      heroLine2: row.hero_line2, heroLine3: row.hero_line3, ctaLabel: row.cta_label,
      feature1Title: row.feature1_title, feature1Body: row.feature1_body, feature2Title: row.feature2_title,
      feature2Body: row.feature2_body, feature3Title: row.feature3_title, feature3Body: row.feature3_body,
      academicYear: row.academic_year, accent: row.accent, contact: row.contact, showStats: row.show_stats,
      schoolAddress: row.school_address, schoolPhone: row.school_phone,
      registrationNumber: row.registration_number, invoiceFooter: row.invoice_footer
    };
  }
  // Convert edited UI values back to the schema's field names and attach the real actor.
  function settingsPayload(data) {
    return {
      id: 1, school: data.school, campus: data.campus, tagline: data.tagline,
      hero_line1: data.heroLine1, hero_line2: data.heroLine2, hero_line3: data.heroLine3,
      cta_label: data.ctaLabel, feature1_title: data.feature1Title, feature1_body: data.feature1Body,
      feature2_title: data.feature2Title, feature2_body: data.feature2Body, feature3_title: data.feature3Title,
      feature3_body: data.feature3Body, academic_year: data.academicYear, accent: data.accent,
      contact: data.contact, show_stats: !!data.showStats, school_address: data.schoolAddress,
      school_phone: data.schoolPhone, registration_number: data.registrationNumber,
      invoice_footer: data.invoiceFooter, updated_by: user.id
    };
  }
  // Authorization helpers are presentation checks only; matching RLS policies enforce
  // the same restrictions at the database for every request.
  function isOwner() { return !!profile && profile.role === 'owner'; }
  function isStaff() { return !!profile && (profile.role === 'owner' || profile.role === 'office'); }
  function formatMoney(value) { return '₹' + Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
  function escape(value) { return escapeHtml(value == null ? '' : String(value)); }
  function appConfig() {
    // A deployed config file takes precedence; browser-local values are for local setup
    // only and do not automatically configure other devices.
    var injected = window.CAMPUS_CONFIG || {};
    var local = {};
    try { local = JSON.parse(localStorage.getItem('campusSupabaseConfig') || '{}'); } catch (_) { }
    return {
      url: injected.supabaseUrl || local.supabaseUrl || '',
      key: injected.publishableKey || local.publishableKey || ''
    };
  }
  // Demo accounts are synthetic, read-only sessions and are exposed only on loopback
  // hostnames. They are not Supabase users and cannot sign in to a deployed website.
  function isLocalDemoHost() {
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(location.hostname.toLowerCase());
  }
  function renderDemoAccounts() {
    var panel = document.getElementById('demoAccounts');
    var list = document.getElementById('demoAccountList');
    if (!panel) {
      var form = document.getElementById('loginForm');
      if (!form || !form.parentElement) return;
      panel = document.createElement('details');
      panel.id = 'demoAccounts';
      panel.className = 'login-config demo-accounts';
      panel.innerHTML = '<summary>Local demo accounts</summary><p class="panel-sub">Preview each role. These are temporary local sign-ins and cannot save changes.</p><div id="demoAccountList"></div>';
      form.insertAdjacentElement('afterend', panel);
      list = document.getElementById('demoAccountList');
    }
    if (!panel || !list) return;
    panel.hidden = !localDemoEnabled;
    if (!localDemoEnabled) return;
    panel.open = true;
    list.innerHTML = Object.keys(demoAccounts).map(function (role) {
      var account = demoAccounts[role];
      return '<article class="demo-account"><div><b>' + escape(roleLabels[role]) + '</b><span>' + escape(account.email) + '</span><code>' + escape(account.password) + '</code></div><button class="btn" type="button" data-demo-login="' + escape(role) + '">Open ' + escape(roleLabels[role]) + ' demo</button></article>';
    }).join('');
  }
  function startDemoSession(role) {
    if (!localDemoEnabled || !demoAccounts[role]) return say('Local demo sign-in is available only in the localhost preview.', true);
    clearPrivateData();
    demoMode = true;
    selectedRole = role;
    user = { id: 'local-demo-' + role, email: demoAccounts[role].email };
    profile = { id: user.id, email: user.email, role: role, display_name: demoAccounts[role].name, student_id: null };
    state.userRole = role;
    state.loginName = demoAccounts[role].name;
    document.querySelectorAll('[data-login-role]').forEach(function (button) { button.classList.toggle('active', button.dataset.loginRole === role); });
    document.body.classList.remove('signed-out');
    updateProfileUI();
    render('overview');
    say('Local demo only · read-only · no school data is saved.');
  }
  // Create the browser client from a public project URL and publishable key. Secret
  // service-role keys must never be placed in this client-side configuration.
  function connect(cfg) {
    if (!window.supabase || !window.supabase.createClient) throw new Error('Database client could not load. Check the internet connection and reload.');
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(cfg.url) || !cfg.key) throw new Error('Enter the Supabase project URL and publishable key.');
    client = window.supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    localDemoEnabled = isLocalDemoHost();
    demoMode = false;
    renderDemoAccounts();
    var form = document.getElementById('backendConfigForm');
    if (form) { form.elements.projectUrl.value = cfg.url; form.elements.publishableKey.value = cfg.key; }
    var button = document.getElementById('loginSubmit');
    if (button) button.disabled = false;
  }
  function setupConfigUI() {
    var cfg = appConfig();
    var details = document.getElementById('connectionSetup');
    var login = document.getElementById('loginSubmit');
    try {
      if (cfg.url && cfg.key) connect(cfg);
      else {
        if (details) details.open = true;
        localDemoEnabled = !cfg.url && !cfg.key && isLocalDemoHost();
        if (login) login.disabled = !localDemoEnabled;
        renderDemoAccounts();
        say(localDemoEnabled ? 'Local preview accounts are available below. Changes are read-only and are not saved.' : 'Connect the school database before signing in.');
      }
    } catch (error) {
      localDemoEnabled = false;
      renderDemoAccounts();
      if (details) details.open = true;
      if (login) login.disabled = true;
      say(error.message, true);
    }
  }
  // Page through large tables to avoid fetching a full 10,000-student roster in one
  // response. The supplied ordering and filter are applied consistently to each page.
  async function getAll(table, columns, orderColumn, filter) {
    var all = [];
    var start = 0;
    var pageSize = 1000;
    while (true) {
      var ordering = typeof orderColumn === 'object' && orderColumn ? orderColumn : { column: orderColumn || 'created_at', ascending: false };
      var query = client.from(table).select(columns || '*').order(ordering.column, { ascending: !!ordering.ascending }).range(start, start + pageSize - 1);
      if (filter) query = filter(query);
      var rows = must(await query) || [];
      all = all.concat(rows);
      if (rows.length < pageSize) break;
      start += pageSize;
    }
    return all;
  }
  async function loadProfile(authUser) {
    // A successful password alone is not enough: require a profile, a granted role, and
    // a workspace choice matching the role before loading any private tables.
    var row = must(await client.from('profiles').select('*').eq('id', authUser.id).maybeSingle());
    if (!row) throw new Error('No school profile is linked to this login. Ask the owner to set up your account.');
    profile = row;
    if (row.role === 'unassigned') throw new Error('This account is awaiting a workspace role. Ask the school owner to grant access.');
    if (row.role !== selectedRole) {
      throw new Error('This login is set up as ' + (roleLabels[row.role] || row.role) + '. Choose that workspace to continue.');
    }
    state.userRole = row.role;
    state.loginName = row.display_name || authUser.email || roleLabels[row.role];
    updateProfileUI();
    document.body.classList.remove('signed-out');
    await refreshData(false);
    subscribeChanges();
    render('overview');
    say('Signed in. Your school data is shared with your authorized devices.');
  }
  // Reflect the verified user and workspace in the sidebar profile chip.
  function updateProfileUI() {
    var name = document.getElementById('profileName');
    var role = document.getElementById('profileRole');
    var avatar = document.getElementById('profileAvatar');
    if (name) name.textContent = state.loginName || roleLabels[state.userRole] || 'Account';
    if (role) role.textContent = (roleLabels[state.userRole] || state.userRole) + (demoMode ? ' · local demo · read-only' : ' · shared workspace');
    if (avatar) avatar.textContent = initials(state.loginName || state.userRole);
  }
  async function refreshData(shouldRender) {
    if (!client || !user || !profile) return;
    // Load independent tables concurrently, while avoiding owner/office-only data for
    // students. RLS narrows each query even if a client attempts a different request.
    var settingsPromise = client.from('school_settings').select('*').eq('id', 1).maybeSingle();
    var studentPromise = getAll('students', '*', { column: 'name', ascending: true });
    var admissionsPromise = isStaff() ? getAll('admissions', '*', 'created_at') : Promise.resolve([]);
    var classesPromise = isStaff() ? getAll('class_settings', '*', { column: 'grade', ascending: true }) : Promise.resolve([]);
    var feesPromise = getAll('fee_accounts', '*', 'due_date', function (q) { return q.order('due_date', { ascending: true }); });
    var requestsPromise = isStaff() ? getAll('fee_payment_requests', '*', 'created_at') : Promise.resolve([]);
    var followupsPromise = isStaff() ? getAll('fee_followups', '*', 'created_at') : Promise.resolve([]);
    var attendancePromise = getAll('attendance', '*', 'attendance_date', function (q) { return q.eq('attendance_date', currentISODate()); });
    var auditPromise = isOwner() ? getAll('audit_logs', '*', 'changed_at') : Promise.resolve([]);
    var profilesPromise = isOwner() ? getAll('profiles', '*', 'display_name') : Promise.resolve([]);
    var results = await Promise.all([settingsPromise, studentPromise, admissionsPromise, classesPromise, feesPromise, requestsPromise, followupsPromise, attendancePromise, auditPromise, profilesPromise]);
    var settingRow = must(results[0]);
    schoolSettings = normalizeSettings(settingRow);
    applySettings();
    replaceList(students, (results[1] || []).map(function (row) {
      return Object.assign({}, row, { id: row.student_code, dbId: row.id, guardianPhone: row.guardian_phone, guardianEmail: row.guardian_email, academicYear: row.academic_year, ini: initials(row.name), color: '#dce8df', att: '—', fee: 'Unassigned' });
    }));
    replaceList(leads, (results[2] || []).map(function (row) {
      return Object.assign({}, row, { name: row.student_name, grade: row.grade, parent: row.guardian_name, stage: row.status, contact: row.phone });
    }));
    replaceList(classRows, results[3] || []);
    replaceList(feeAccounts, results[4] || []);
    var feeById = Object.create(null);
    feeAccounts.forEach(function (fee) { feeById[fee.id] = fee; });
    replaceList(paymentRequests, (results[5] || []).map(function (request) { return Object.assign({}, request, { fee: feeById[request.fee_account_id] || null }); }));
    replaceList(feeFollowups, results[6] || []);
    var studentByDbId = Object.create(null);
    students.forEach(function (student) { studentByDbId[student.dbId] = student; });
    var recordsByStudent = Object.create(null);
    (results[7] || []).forEach(function (record) { recordsByStudent[record.student_id] = record; });
    replaceList(attendance, students.map(function (student) {
      var record = recordsByStudent[student.dbId];
      return Object.assign({}, student, { status: record ? record.status : 'Unmarked', attendanceId: record ? record.id : null, note: record ? record.note : '' });
    }));
    replaceList(auditRows, results[8] || []);
    replaceList(userProfiles, results[9] || []);
    if (shouldRender && !document.body.classList.contains('signed-out')) render(state.page);
  }
  // Live changes redraw the workspace for all devices in the same school. If the
  // current account loses its role, sign it out before retaining access to old views.
  function subscribeChanges() {
    if (!client || !user || client.__campusChannel) return;
    var channel = client.channel('campus-shared-data');
    dbTables.forEach(function (table) {
      channel = channel.on('postgres_changes', { event: '*', schema: 'public', table: table }, function (change) {
        if (table === 'profiles' && change.new && change.new.id === user.id) {
          client.from('profiles').select('*').eq('id', user.id).maybeSingle().then(function (result) {
            if (result.error || !result.data || result.data.role !== profile.role) {
              signOut().then(function () { say('Your access changed. Sign in again with the updated role.'); });
            } else { profile = result.data; refreshData(true).catch(function (error) { say(error.message, true); }); }
          });
          return;
        }
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(function () { refreshData(true).catch(function (error) { say(error.message, true); }); }, 450);
      });
    });
    client.__campusChannel = channel;
    channel.subscribe();
  }
  async function signIn(event) {
    event.preventDefault();
    selectedRole = document.querySelector('[data-login-role].active')?.dataset.loginRole || 'owner';
    var enteredEmail = document.getElementById('loginName').value.trim().toLowerCase();
    var enteredPassword = document.getElementById('loginPassword').value;
    if (localDemoEnabled) {
      var demoRole = Object.keys(demoAccounts).find(function (role) { return demoAccounts[role].email === enteredEmail; });
      if (demoRole) {
        if (demoRole !== selectedRole) return say('Choose the ' + roleLabels[demoRole] + ' workspace for this demo account.', true);
        if (enteredPassword !== demoAccounts[demoRole].password) return say('The password for this local demo account is incorrect.', true);
        return startDemoSession(demoRole);
      }
    }
    if (!client) return say('Connect the school database before signing in.', true);
    var button = document.getElementById('loginSubmit');
    button.disabled = true;
    try {
      var result = await client.auth.signInWithPassword({ email: document.getElementById('loginName').value.trim(), password: document.getElementById('loginPassword').value });
      if (result.error) throw result.error;
      user = result.data.user;
      await loadProfile(user);
    } catch (error) {
      document.body.classList.add('signed-out');
      say(error.message || 'Sign in failed.', true);
    } finally { button.disabled = false; }
  }
  // Restore real Supabase sessions and handle invitation/recovery callbacks. The
  // local preview path intentionally skips this persistent-session mechanism.
  async function restoreSession() {
    if (!client) return;
    var result = await client.auth.getSession();
    if (result.error || !result.data.session) {
      if (authCallbackType() === 'invite') say('This invitation link could not be verified. Ask the Owner to send a new invitation.', true);
      return;
    }
    user = result.data.session.user;
    if (authCallbackType() === 'recovery') { passwordRecoveryModal('recovery'); return; }
    if (authCallbackType() === 'invite') { passwordRecoveryModal('invite'); return; }
    profile = must(await client.from('profiles').select('*').eq('id', user.id).maybeSingle());
    if (!profile || profile.role === 'unassigned') return;
    selectedRole = profile.role;
    document.querySelectorAll('[data-login-role]').forEach(function (button) { button.classList.toggle('active', button.dataset.loginRole === selectedRole); });
    await loadProfile(user);
  }
  function passwordRecoveryModal(mode) {
    var isInvite = mode === 'invite';
    if (isInvite && document.querySelector('#overlay [data-type="invite-password"]')) return;
    document.body.classList.add('signed-out');
    var type = isInvite ? 'invite-password' : 'password-recovery';
    var title = isInvite ? 'Create your school account password' : 'Set a new password';
    var description = isInvite ? 'Your school has invited you. Choose a password, then sign in using the workspace assigned by your school.' : 'Choose a strong password for your school account.';
    var button = isInvite ? 'Activate account' : 'Update password';
    openModal(title,description,'<form id="modalForm" data-type="' + type + '"><div class="field"><label>New password</label><input name="password" type="password" minlength="10" autocomplete="new-password" required></div><div class="field" style="margin-top:14px"><label>Confirm new password</label><input name="confirm" type="password" minlength="10" autocomplete="new-password" required></div><div class="modal-actions"><button class="btn btn-primary" type="submit">' + button + '</button></div></form>');
  }
  // Clear session data and realtime subscriptions on logout so a later user does not
  // briefly see the previous account's in-memory roster or financial information.
  async function signOut() {
    if (client) await client.auth.signOut();
    clearPrivateData();
    user = null; profile = null; demoMode = false; state.userRole = null; state.loginName = '';
    document.body.classList.add('signed-out');
    document.querySelectorAll('[data-login-role]').forEach(function (button) { button.classList.toggle('active', button.dataset.loginRole === 'owner'); });
    document.getElementById('loginPassword').value = '';
    say('Signed out.');
  }
  function clearPrivateData() {
    [students,attendance,leads,feeAccounts,paymentRequests,feeFollowups,classRows,userProfiles,auditRows].forEach(function (items) { items.length = 0; });
    if (client && client.__campusChannel) { client.removeChannel(client.__campusChannel); client.__campusChannel = null; }
  }
  function permission(page) {
    // Keep the client-side page map aligned with the database role model for usability.
    if (!profile) return false;
    if (profile.role === 'student') return ['overview','family-portal','school-site'].includes(page);
    if (profile.role === 'office') return page !== 'school-settings' && page !== 'roadmap' && page !== 'class-fees' && page !== 'users' && page !== 'audit';
    return profile.role === 'owner';
  }
  // Enforce workspace navigation rules and fetch attendance only for a real session.
  // RLS remains responsible for rejecting requests that do not meet database policy.
  async function navigate(page) {
    if (!permission(page)) { say('Your account does not have permission to open that page.', true); return; }
    if (page === 'school-site') { window.open('./public.html', '_blank', 'noopener'); return; }
    if (client && !demoMode && page === 'attendance') {
      try {
        var dayRows = await getAll('attendance', '*', 'attendance_date', function (q) { return q.eq('attendance_date', currentISODate()); });
        var byId = Object.create(null); dayRows.forEach(function (row) { byId[row.student_id] = row; });
        attendance.forEach(function (student) { var row = byId[student.dbId]; student.status = row ? row.status : 'Unmarked'; student.attendanceId = row ? row.id : null; });
      } catch (error) { say(error.message, true); }
    }
    render(page);
  }

  // The renderers below build role-specific HTML from data already held in memory.
  // They do not write to Supabase; all writes go through the guarded form/action paths.
  function appDashboard() {
    if (state.userRole === 'student') return appStudentHome();
    var pendingLeads = leads.filter(function (lead) { return !['Admitted','Closed'].includes(lead.status); }).length;
    var unpaid = feeAccounts.filter(function (fee) { return fee.status === 'Unpaid'; }).length;
    var paid = feeAccounts.filter(function (fee) { return fee.status === 'Paid'; });
    var collected = paid.reduce(function (sum, fee) { return sum + Number(fee.amount) + Number(fee.late_fee || 0); }, 0);
    var ownerPanel = isOwner()
      ? '<section class="panel panel-pad"><div class="panel-head"><div><div class="panel-title">Owner controls</div><div class="panel-sub">Your changes synchronize across signed-in school devices.</div></div></div><div class="notice-row"><span class="notice-symbol">⚙</span><div class="notice-copy"><b>School identity and invoices</b><span>Edit contact details, academic year and invoice wording</span></div><button class="btn" data-page="school-settings">School settings</button></div><div class="notice-row"><span class="notice-symbol">▦</span><div class="notice-copy"><b>Class and fee structure</b><span>Set grades, sections, installments and late fees</span></div><button class="btn" data-page="class-fees">Classes & fees</button></div><div class="notice-row"><span class="notice-symbol">♙</span><div class="notice-copy"><b>Accounts and access</b><span>Invite an office user or link a student account</span></div><button class="btn" data-page="users">Manage users</button></div></section>'
      : '<section class="panel panel-pad"><div class="panel-head"><div><div class="panel-title">School office tools</div><div class="panel-sub">The owner controls fee status and shared school setup.</div></div></div><div class="notice-row"><span class="notice-symbol">✓</span><div class="notice-copy"><b>Take attendance</b><span>Changes are shared with the owner immediately</span></div><button class="btn" data-page="attendance">Attendance</button></div><div class="notice-row"><span class="notice-symbol">＋</span><div class="notice-copy"><b>Admissions</b><span>Open an enquiry to see the full family details</span></div><button class="btn" data-page="admissions">Open</button></div><div class="notice-row"><span class="notice-symbol">₹</span><div class="notice-copy"><b>Fee verification</b><span>Record parent contact and request owner approval</span></div><button class="btn" data-page="fees">Open fees</button></div></section>';
    return '<div class="page"><div class="welcome-row"><div><div class="eyebrow"><i class="live-dot"></i> SCHOOL WORKSPACE · ' + escape(schoolSettings.academicYear) + '</div><h1>Welcome, ' + escape(state.loginName || roleLabels[state.userRole]) + ' <span style="font-size:21px">✳</span></h1><p>Shared school records, protected by your account permissions.</p></div><div class="actions">' + (isStaff() ? '<button class="btn" data-page="student-import">⇧ Import roster</button><button class="btn btn-primary" data-page="student-add">＋ Add student</button>' : '') + '</div></div><div class="metric-grid">' + metric('STUDENTS', String(students.length), 'Live from shared database', 'users', 'i-green', '0,20 76,20') + metric('ADMISSIONS', String(leads.length), pendingLeads + ' open enquiries', 'users', 'i-orange', '0,20 76,20') + metric('PAID FEES', formatMoney(collected), paid.length + ' payments confirmed', 'money', 'i-blue', '0,20 76,20') + metric('UNPAID ACCOUNTS', String(unpaid), 'Owner sets payment status', 'clock', 'i-rose', '0,20 76,20') + '</div><div class="dashboard-grid"><section class="panel panel-pad"><div class="panel-head"><div><div class="panel-title">' + (isOwner() ? 'School operations' : 'Your school day') + '</div><div class="panel-sub">No sample student records are loaded.</div></div></div>' + (isStaff() ? emptyState('Your roster is ready to connect','Add a student manually or import a validated CSV roster. Student, attendance and fee records sync to the shared database.', '<button class="btn" data-page="student-add">＋ Add one student</button><button class="btn btn-primary" data-page="student-import">⇧ Import CSV</button>') : appStudentSummary()) + '</section>' + ownerPanel + '</div></div>';
  }
  function appStudentSummary() {
    var own = profile && profile.student_id ? students.find(function (student) { return student.dbId === profile.student_id; }) : null;
    if (!own) return emptyState('Your school has not linked a student profile yet','Ask the school office to link your login to your student record.');
    return '<div class="notice-row"><span class="notice-symbol">🎒</span><div class="notice-copy"><b>' + escape(own.name) + '</b><span>' + escape(classLabel(own)) + ' · ' + escape(own.id) + '</span></div><span class="status s-active">Profile linked</span></div><div class="actions"><button class="btn btn-primary" data-page="family-portal">Open student interface</button></div>';
  }
  function appStudentHome() {
    var own = profile && profile.student_id ? students.find(function (student) { return student.dbId === profile.student_id; }) : null;
    if (!own) return '<div class="page">' + pageHeader('STUDENT WORKSPACE','Your school, all in one place.','Your profile and attendance sync with the school office.') + emptyState('No student profile linked','Ask the school office to link your login to your student record.') + '</div>';
    var myFees = feeAccounts.filter(function (fee) { return fee.student_id === own.dbId; });
    var myAttendance = attendance.filter(function (row) { return row.dbId === own.dbId; })[0];
    return '<div class="page">' + pageHeader('STUDENT WORKSPACE',escape(own.name),'Class ' + escape(classLabel(own)) + ' · ' + escape(schoolSettings.school), '<button class="btn" data-action="logout">Sign out</button>') + '<div class="kpi-row"><div class="kpi"><span>Today attendance</span><strong>' + escape(myAttendance ? myAttendance.status : 'Not marked') + '</strong></div><div class="kpi"><span>Fee accounts</span><strong>' + myFees.length + '</strong></div><div class="kpi"><span>Payments recorded</span><strong>' + myFees.filter(function (fee) { return fee.status === 'Paid'; }).length + '</strong></div></div><section class="panel panel-pad"><div class="panel-title">My fee schedule</div>' + (myFees.length ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>Installment</th><th>Due date</th><th>Amount</th><th>Status</th></tr></thead><tbody>' + myFees.map(function (fee) { return '<tr><td>' + escape(fee.installment) + '</td><td>' + escape(fee.due_date) + '</td><td>' + formatMoney(Number(fee.amount) + (fee.status === 'Unpaid' && fee.due_date < currentISODate() ? Number(fee.late_fee) : 0)) + '</td><td><span class="status ' + statusClass(fee.status) + '">' + escape(fee.status) + '</span></td></tr>'; }).join('') + '</tbody></table></div>' : emptyState('No fee schedule yet','The school office will publish your fee schedule here.')) + '</section></div>';
  }
  // Office and owner views for admissions, student records, roster import, finance,
  // attendance, class plans, owner settings, account access, and audit history.
  function appAdmissions() {
    var rows = leads.map(function (lead) {
      return '<tr><td><button class="text-link" data-action="lead-details" data-id="' + escape(lead.id) + '">' + escape(lead.student_name) + '</button><small style="display:block;color:#82909d">' + escape(lead.phone) + '</small></td><td>' + escape(lead.grade) + '</td><td>' + escape(lead.guardian_name) + '</td><td><span class="status s-pending">' + escape(lead.status) + '</span></td><td>' + escape(new Date(lead.created_at).toLocaleDateString()) + '</td></tr>';
    }).join('');
    return '<div class="page">' + pageHeader('SCHOOL OFFICE · ADMISSIONS','Admissions workspace','Click a student name to review the full enquiry and update its stage.', '<button class="btn btn-primary" data-action="new-enquiry">＋ Add enquiry</button>') + '<div class="kpi-row"><div class="kpi"><span>Open enquiries</span><strong>' + leads.filter(function (x) { return !['Admitted','Closed'].includes(x.status); }).length + '</strong></div><div class="kpi"><span>Offers</span><strong>' + leads.filter(function (x) { return x.status === 'Offered'; }).length + '</strong></div><div class="kpi"><span>Admitted</span><strong>' + leads.filter(function (x) { return x.status === 'Admitted'; }).length + '</strong></div></div><section class="table-card"><div class="panel-head"><div><div class="panel-title">Enquiry pipeline</div><div class="panel-sub">Public website enquiries appear here as soon as they are submitted.</div></div></div>' + (rows ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>Student / contact</th><th>Grade</th><th>Parent / guardian</th><th>Stage</th><th>Received</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : emptyState('No admission enquiries yet','Share the public website enquiry link with families. Submitted details stay private to the school team.','<button class="btn btn-primary" data-action="new-enquiry">＋ Add office enquiry</button>')) + '</section></div>';
  }
  function appStudentDirectory() {
    var query = state.studentQuery.toLowerCase();
    var filtered = students.filter(function (s) { return [s.name,s.id,s.grade,s.section,s.guardian,s.guardianPhone].join(' ').toLowerCase().includes(query); });
    var start = state.studentPage * 100;
    var shown = filtered.slice(start, start + 100);
    var body = shown.map(function (s) {
      return '<tr><td><button class="text-link" data-action="student-details" data-id="' + escape(s.dbId) + '">' + escape(s.name) + '</button><small style="display:block;color:#82909d">' + escape(s.id) + '</small></td><td>' + escape(classLabel(s)) + '</td><td>' + escape(s.guardian || '—') + '</td><td>' + escape(s.guardianPhone || s.guardianEmail || '—') + '</td></tr>';
    }).join('');
    return '<div class="page">' + pageHeader('SCHOOL OFFICE · STUDENTS','Student directory','Search and open a profile, add a student or import up to 10,000 rows from CSV.', '<button class="btn" data-page="student-import">⇧ Import CSV</button><button class="btn btn-primary" data-page="student-add">＋ Add student</button>') + '<div class="kpi-row"><div class="kpi"><span>Enrolled records</span><strong>' + students.length.toLocaleString() + '</strong></div><div class="kpi"><span>Classes</span><strong>' + new Set(students.map(classLabel)).size + '</strong></div><div class="kpi"><span>Page size</span><strong>100</strong></div></div><section class="table-card"><div class="toolbar"><label class="searchbox">⌕ <input id="studentFilter" value="' + escape(state.studentQuery) + '" placeholder="Find student, ID or parent"></label><button class="btn" data-action="export">↓ Export roster</button></div><div class="table-wrap">' + (body ? '<table class="data-table"><thead><tr><th>Student</th><th>Class</th><th>Guardian</th><th>Contact</th></tr></thead><tbody>' + body + '</tbody></table>' : emptyState(query ? 'No matching students' : 'No students yet', query ? 'Try a different name, ID or class.' : 'Add a student or import a reviewed CSV roster.', '<button class="btn btn-primary" data-page="student-add">＋ Add student</button>')) + '</div><div class="toolbar" style="justify-content:space-between;margin-top:12px"><span class="panel-sub">Showing ' + (filtered.length ? start + 1 : 0) + '–' + Math.min(start + 100, filtered.length) + ' of ' + filtered.length.toLocaleString() + ' records · shared database</span><div class="actions"><button class="btn" data-action="student-prev" ' + (start === 0 ? 'disabled' : '') + '>← Previous</button><button class="btn" data-action="student-next" ' + (start + 100 >= filtered.length ? 'disabled' : '') + '>Next →</button></div></div></section></div>';
  }
  function appStudentAdd() {
    return '<div class="page">' + pageHeader('SCHOOL OFFICE · STUDENT ENTRY','Add a student','Student information is saved to the shared school database.', '<button class="btn" data-page="students">← Student directory</button>') + '<form id="studentRecordForm" class="record-form"><div class="form-grid"><div class="form-section-title">Student</div><div class="field"><label>Student ID *</label><input name="id" required></div><div class="field"><label>Full legal name *</label><input name="name" required></div><div class="field"><label>Date of birth</label><input name="dob" type="date"></div><div class="field"><label>Academic year</label><input name="academicYear" value="' + escape(schoolSettings.academicYear) + '"></div><div class="field"><label>Grade / class *</label><input name="grade" required></div><div class="field"><label>Section</label><input name="section"></div><div class="field wide"><label>Previous school</label><input name="previousSchool"></div><div class="form-section-title">Parent or guardian</div><div class="field"><label>Guardian full name</label><input name="guardian"></div><div class="field"><label>Relationship</label><input name="relationship"></div><div class="field"><label>Phone</label><input name="guardianPhone" type="tel"></div><div class="field"><label>Email</label><input name="guardianEmail" type="email"></div><div class="field wide"><label>Home address</label><textarea name="address"></textarea></div><div class="form-section-title">Emergency and care notes</div><div class="field"><label>Emergency contact</label><input name="emergencyName"></div><div class="field"><label>Emergency phone</label><input name="emergencyPhone" type="tel"></div><div class="field wide"><label>Health or learning support notes</label><textarea name="supportNotes"></textarea></div></div><div class="actions"><button class="btn" type="button" data-page="students">Cancel</button><button class="btn btn-primary" type="submit">Save student record</button></div></form></div>';
  }
  function appImportPage() {
    var rows = state.importRows || [];
    var good = rows.filter(function (row) { return row.valid; }).length;
    var errors = rows.length - good;
    var preview = rows.slice(0, 30).map(function (row) { return '<tr><td>' + escape(row.id) + '</td><td>' + escape(row.name) + '</td><td>' + escape(classLabel(row)) + '</td><td>' + escape(row.guardian || '—') + '</td><td><span class="status ' + (row.valid ? 's-present' : 's-absent') + '">' + (row.valid ? 'Ready' : escape(row.error)) + '</span></td></tr>'; }).join('');
    return '<div class="page">' + pageHeader('SCHOOL OFFICE · BULK ROSTER','Import student roster','Upload up to 10,000 checked rows. The reviewed roster is saved to the shared database in one transaction.', '<button class="btn" data-action="download-template">↓ Download CSV template</button>') + '<div class="plan-banner"><h3>Use a student information export when available</h3><p>Student ID, name and grade are required. CSV is more reliable than photos of attendance sheets; every row is checked for required fields and duplicate IDs before the school submits the import.</p></div><section class="panel panel-pad"><div class="panel-title">Choose a CSV roster</div><div class="panel-sub">Required: student_id, student_name, grade. Optional: section, guardian_name, guardian_phone, guardian_email, academic_year.</div><div class="drop-zone"><label for="rosterFile"><b>Select a CSV file</b></label><p class="panel-sub">The browser checks a local preview. The file is sent to the school database only when you confirm import.</p><input type="file" id="rosterFile" accept=".csv,text/csv"></div>' + (rows.length ? '<div class="import-summary"><div class="kpi"><span>Rows read</span><strong>' + rows.length.toLocaleString() + '</strong></div><div class="kpi"><span>Ready to import</span><strong>' + good.toLocaleString() + '</strong></div><div class="kpi"><span>Rows with errors</span><strong>' + errors.toLocaleString() + '</strong></div></div><div class="import-preview"><div class="panel-title" style="margin:14px 0">Review first 30 rows</div><div class="table-wrap"><table class="data-table"><thead><tr><th>Student ID</th><th>Name</th><th>Class / section</th><th>Guardian</th><th>Validation</th></tr></thead><tbody>' + preview + '</tbody></table></div></div><div class="actions" style="margin-top:16px"><button class="btn" data-action="clear-import">Clear file</button><button class="btn btn-primary" data-action="confirm-import" ' + (good ? '' : 'disabled') + '>Import ' + good.toLocaleString() + ' valid rows</button></div>' : '') + '</section></div>';
  }
  function appFeesPage() {
    var filtered = feeAccounts.filter(function (fee) {
      var late = fee.status === 'Unpaid' && fee.due_date < currentISODate();
      return state.feeFilter === 'All' || (state.feeFilter === 'Overdue' ? late : fee.status === state.feeFilter);
    });
    var paid = feeAccounts.filter(function (fee) { return fee.status === 'Paid'; });
    var pending = feeAccounts.filter(function (fee) { return fee.status === 'Unpaid'; });
    var totalPaid = paid.reduce(function (sum, fee) { return sum + Number(fee.amount) + Number(fee.late_fee || 0); }, 0);
    var rows = filtered.map(function (fee) {
      var student = students.find(function (s) { return s.dbId === fee.student_id; });
      var latestTouch = feeFollowups.filter(function (entry) { return entry.fee_account_id === fee.id; }).sort(function (a, b) { return b.created_at.localeCompare(a.created_at); })[0];
      var late = fee.status === 'Unpaid' && fee.due_date < currentISODate();
      var status = fee.status === 'Unpaid' && late ? 'Overdue' : fee.status;
      var amountDue = Number(fee.amount) + ((fee.status === 'Paid' || late) ? Number(fee.late_fee || 0) : 0);
      var controls = '<button class="table-actions" title="Record parent contact" data-action="fee-followup" data-id="' + escape(fee.id) + '">☎</button>';
      if (isOffice() && fee.status !== 'Paid') controls += ' <button class="table-actions" title="Request owner payment approval" data-action="fee-payment-request" data-id="' + escape(fee.id) + '">↗</button>';
      if (isOwner()) controls += ' <button class="table-actions" title="Edit payment status and late fee" data-action="fee-status" data-id="' + escape(fee.id) + '">✎</button>';
      if (fee.status === 'Paid') controls += ' <button class="table-actions" title="Download invoice PDF" data-action="invoice" data-id="' + escape(fee.id) + '">↓</button>';
      return '<tr><td><button class="text-link" data-action="student-details" data-id="' + escape(fee.student_id) + '">' + escape(student ? student.name : 'Student') + '</button><small style="display:block;color:#82909d">' + escape(student ? student.guardian : '') + ' · ' + escape(student ? student.guardianPhone : '') + '</small>' + (latestTouch ? '<small style="display:block;color:#8a684b">Last contact: ' + escape(latestTouch.reason) + (latestTouch.promised_date ? ' · pays by ' + escape(latestTouch.promised_date) : '') + (latestTouch.late_fee_discussed ? ' · late fee discussed' : '') + '</small>' : '') + '</td><td>' + escape(fee.installment) + '</td><td>' + escape(fee.due_date) + '</td><td>' + formatMoney(amountDue) + (Number(fee.late_fee || 0) ? '<small style="display:block;color:#82909d">incl. late fee ' + formatMoney(fee.late_fee) + '</small>' : '') + '</td><td><span class="status ' + statusClass(status) + '">' + escape(status) + '</span></td><td>' + (fee.status === 'Paid' ? '<small>' + escape(fee.receipt_number || 'Receipt') + '</small>' : controls) + (fee.status === 'Paid' ? controls : '') + '</td></tr>';
    }).join('');
    var requests = paymentRequests.filter(function (request) { return isOwner() ? request.status === 'Pending' : request.requested_by === user.id; });
    var requestPanel = requests.length ? '<section class="panel panel-pad" style="margin-top:14px"><div class="panel-title">' + (isOwner() ? 'Office payment requests · owner review' : 'Your payment requests') + '</div>' + requests.map(function (request) {
      var fee = request.fee;
      var st = fee && fee.students ? fee.students : (fee ? students.find(function (x) { return x.dbId === fee.student_id; }) : null);
      var desc = (st ? st.name : 'Student') + ' · ' + (fee ? fee.installment : 'Fee') + ' · ' + formatMoney(request.amount) + ' · ' + request.method + (request.reference ? ' · ' + request.reference : '');
      return '<div class="notice-row"><span class="notice-symbol">₹</span><div class="notice-copy"><b>' + escape(desc) + '</b><span>' + escape(request.note || 'Office requested owner verification') + ' · ' + escape(request.status) + '</span></div>' + (isOwner() ? '<button class="btn btn-primary" data-action="review-payment" data-approve="true" data-id="' + escape(request.id) + '">Approve & mark paid</button><button class="btn" data-action="review-payment" data-approve="false" data-id="' + escape(request.id) + '">Reject</button>' : '') + '</div>';
    }).join('') + '</section>' : '';
    return '<div class="page">' + pageHeader('SCHOOL FINANCE','Fees & finance','The owner controls fee configuration and payment status. Office staff record family contact and request payment verification.', isOwner() ? '<button class="btn" data-action="new-fee-entry">＋ Add fee account</button><button class="btn btn-primary" data-page="class-fees">Classes & fee plans</button>' : '') + '<div class="kpi-row"><div class="kpi"><span>Unpaid accounts</span><strong>' + pending.length.toLocaleString() + '</strong></div><div class="kpi"><span>Paid students / accounts</span><strong>' + paid.length.toLocaleString() + '</strong></div><div class="kpi"><span>Collected</span><strong>' + formatMoney(totalPaid) + '</strong></div></div><section class="table-card"><div class="toolbar"><span class="panel-title">Student fee accounts</span><div class="segmented"><button data-fee="All" class="' + (state.feeFilter === 'All' ? 'active' : '') + '">All</button><button data-fee="Unpaid" class="' + (state.feeFilter === 'Unpaid' ? 'active' : '') + '">Unpaid</button><button data-fee="Overdue" class="' + (state.feeFilter === 'Overdue' ? 'active' : '') + '">Overdue</button><button data-fee="Paid" class="' + (state.feeFilter === 'Paid' ? 'active' : '') + '">Paid</button></div></div>' + (rows ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>Student / parent contact</th><th>Installment</th><th>Due date</th><th>Amount due</th><th>Status</th><th>Actions / invoice</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : emptyState('No fee accounts yet',isOwner() ? 'Set class and section fees, then generate an installment for a class roster.' : 'The owner will publish student fee accounts here.')) + '</section>' + requestPanel + '</div>';
  }
  function isOffice() { return !!profile && profile.role === 'office'; }
  function appAttendancePage() {
    var classes = Array.from(new Set(students.map(classLabel).filter(Boolean))).sort();
    var selected = state.attendanceClass || classes[0] || '';
    var rows = attendance.filter(function (student) { return classLabel(student) === selected; });
    var present = rows.filter(function (student) { return student.status === 'Present'; }).length;
    var absent = rows.filter(function (student) { return student.status === 'Absent'; }).length;
    var late = rows.filter(function (student) { return student.status === 'Late'; }).length;
    return '<div class="page">' + pageHeader('SCHOOL OFFICE · DAILY ROUTINE','Attendance','Today’s class register. Save it to sync changes to every signed-in device.', '<button class="btn" data-action="mark-all" ' + (rows.length ? '' : 'disabled') + '>✓ Mark present</button><button class="btn btn-primary" data-action="save-attendance" ' + (rows.length ? '' : 'disabled') + '>Save register</button>') + '<div class="toolbar"><label class="field">Class / section<select id="attendanceClassSelect">' + classes.map(function (name) { return '<option ' + (name === selected ? 'selected' : '') + '>' + escape(name) + '</option>'; }).join('') + '</select></label><button class="btn" data-filter="All">All (' + rows.length + ')</button><button class="btn" data-filter="Present">Present (' + present + ')</button><button class="btn" data-filter="Absent">Absent (' + absent + ')</button><button class="btn" data-filter="Late">Late (' + late + ')</button></div><section class="table-card">' + (rows.length ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>Student</th><th>School ID</th><th>Attendance</th></tr></thead><tbody>' + rows.filter(function (student) { return state.attendanceFilter === 'All' || student.status === state.attendanceFilter; }).map(function (student) { return '<tr><td>' + escape(student.name) + '</td><td>' + escape(student.id) + '</td><td><button class="toggle-status ' + student.status.toLowerCase() + '" data-action="cycle-attendance" data-id="' + escape(student.id) + '">' + escape(student.status) + '</button></td></tr>'; }).join('') + '</tbody></table></div>' : emptyState('No class roster yet','Import the verified student roster before taking attendance.','<button class="btn btn-primary" data-page="student-import">Import roster</button>')) + '<p class="panel-sub" style="padding-top:10px">Record changes are committed to the shared database when you save.</p></section></div>';
  }
  function appClassFeesPage() {
    var rows = classRows.map(function (row) {
      var count = students.filter(function (student) { return student.grade === row.grade && student.section === row.section && student.academic_year === row.academic_year; }).length;
      return '<tr><td>' + escape(row.grade) + '</td><td>' + escape(row.section || '—') + '</td><td>' + escape(row.academic_year) + '</td><td>' + count + '</td><td>' + formatMoney(row.annual_fee) + '</td><td>' + formatMoney(row.late_fee) + '</td><td><button class="table-actions" title="Edit class fees" data-action="edit-class-setting" data-id="' + escape(row.id) + '">✎ Edit</button> <button class="table-actions" title="Generate class installment" data-action="generate-class-fee" data-id="' + escape(row.id) + '">＋ Generate</button></td></tr>';
    }).join('');
    return '<div class="page">' + pageHeader('OWNER · SCHOOL STRUCTURE','Classes & fee plans','Set every grade, section, annual fee and late fee. Generate installments for enrolled students in one action.', '<button class="btn" data-action="new-fee-entry">＋ Single student fee</button>') + '<section class="panel panel-pad"><div class="panel-title">Add a class / section</div><form id="classSettingsForm" class="form-grid" style="margin-top:14px"><div class="field"><label>Grade / class *</label><input name="grade" required placeholder="Grade 6"></div><div class="field"><label>Section</label><input name="section" placeholder="A"></div><div class="field"><label>Academic year *</label><input name="academicYear" value="' + escape(schoolSettings.academicYear) + '" required></div><div class="field"><label>Class capacity</label><input name="capacity" type="number" min="1"></div><div class="field"><label>Annual fee (₹)</label><input name="annualFee" type="number" min="0" step="0.01" value="0"></div><div class="field"><label>Late fee (₹)</label><input name="lateFee" type="number" min="0" step="0.01" value="0"></div><div class="field wide"><label>Installment plan labels (comma separated)</label><input name="installments" placeholder="Term 1, Term 2, Term 3"></div><div class="field wide"><button class="btn btn-primary" type="submit">Save class and fee plan</button></div></form></section><section class="table-card" style="margin-top:14px"><div class="panel-head"><div><div class="panel-title">School classes and sections</div><div class="panel-sub">Set up every class separately by section and academic year.</div></div></div>' + (rows ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>Grade</th><th>Section</th><th>Academic year</th><th>Students</th><th>Annual fee</th><th>Late fee</th><th>Fee generation</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : emptyState('No classes configured','Add each grade and section. Fees are not generated until you choose an installment.')) + '</section></div>';
  }
  function appSettingsPage() {
    return '<div class="page">' + pageHeader('OWNER · SCHOOL SETUP','School settings','These settings are stored centrally and appear on every authorized device and invoice.', '<button class="btn" data-page="school-site">Preview public website</button>') + '<form id="schoolSettingsForm" class="record-form"><div class="form-grid"><div class="field"><label>School display name *</label><input name="school" required value="' + escape(schoolSettings.school) + '"></div><div class="field"><label>Campus name</label><input name="campus" value="' + escape(schoolSettings.campus) + '"></div><div class="field wide"><label>School address</label><textarea name="schoolAddress">' + escape(schoolSettings.schoolAddress) + '</textarea></div><div class="field"><label>School phone</label><input name="schoolPhone" value="' + escape(schoolSettings.schoolPhone) + '"></div><div class="field"><label>School email</label><input name="contact" type="email" value="' + escape(schoolSettings.contact) + '"></div><div class="field"><label>Registration / affiliation number</label><input name="registrationNumber" value="' + escape(schoolSettings.registrationNumber) + '"></div><div class="field"><label>Academic year</label><input name="academicYear" value="' + escape(schoolSettings.academicYear) + '"></div><div class="form-section-title">Public website copy</div><div class="field"><label>Tagline</label><input name="tagline" value="' + escape(schoolSettings.tagline) + '"></div><div class="field"><label>Homepage button label</label><input name="ctaLabel" value="' + escape(schoolSettings.ctaLabel) + '"></div><div class="field"><label>Hero line 1</label><input name="heroLine1" value="' + escape(schoolSettings.heroLine1) + '"></div><div class="field"><label>Hero line 2</label><input name="heroLine2" value="' + escape(schoolSettings.heroLine2) + '"></div><div class="field"><label>Hero line 3</label><input name="heroLine3" value="' + escape(schoolSettings.heroLine3) + '"></div><div class="field"><label>Accent color</label><input name="accent" type="color" value="' + escape(schoolSettings.accent) + '"></div><div class="field"><label>Feature 1 title</label><input name="feature1Title" value="' + escape(schoolSettings.feature1Title) + '"></div><div class="field"><label>Feature 2 title</label><input name="feature2Title" value="' + escape(schoolSettings.feature2Title) + '"></div><div class="field"><label>Feature 3 title</label><input name="feature3Title" value="' + escape(schoolSettings.feature3Title) + '"></div><div class="field wide"><label>Feature descriptions</label><textarea name="feature1Body" placeholder="Feature one">' + escape(schoolSettings.feature1Body) + '</textarea><textarea name="feature2Body" placeholder="Feature two">' + escape(schoolSettings.feature2Body) + '</textarea><textarea name="feature3Body" placeholder="Feature three">' + escape(schoolSettings.feature3Body) + '</textarea></div><div class="field wide"><label>Invoice footer</label><textarea name="invoiceFooter">' + escape(schoolSettings.invoiceFooter) + '</textarea></div><label class="field check-field"><input name="showStats" type="checkbox" ' + (schoolSettings.showStats ? 'checked' : '') + '><span>Show verified public statistics when configured</span></label></div><div class="actions"><button class="btn btn-primary" type="submit">Save shared settings</button></div></form></div>';
  }
  function appUsersPage() {
    var rows = userProfiles.map(function (row) {
      var studentOptions = '<option value="">No student link</option>' + students.map(function (student) { return '<option value="' + escape(student.dbId) + '" ' + (student.dbId === row.student_id ? 'selected' : '') + '>' + escape(student.name + ' · ' + student.id) + '</option>'; }).join('');
      return '<tr><td>' + escape(row.display_name || '—') + '</td><td>' + escape(row.email) + '</td><td><form data-role-form="true" data-id="' + escape(row.id) + '"><select name="role"><option value="owner" ' + (row.role === 'owner' ? 'selected' : '') + '>Owner</option><option value="office" ' + (row.role === 'office' ? 'selected' : '') + '>School office</option><option value="student" ' + (row.role === 'student' ? 'selected' : '') + '>Student</option><option value="unassigned" ' + (row.role === 'unassigned' ? 'selected' : '') + '>Unassigned</option></select><select name="student_id">' + studentOptions + '</select><button class="btn" type="submit">Save access</button></form></td></tr>';
    }).join('');
    var studentChoices = students.map(function (student) { return '<option value="' + escape(student.dbId) + '">' + escape(student.name + ' · ' + student.id) + '</option>'; }).join('');
    return '<div class="page">' + pageHeader('OWNER · ACCESS CONTROL','Users & access','Invite users by email. They set their password from the invitation link, then sign in using their assigned workspace.', '') + '<section class="panel panel-pad"><div class="panel-title">Invite school office or student</div><form id="inviteUserForm" class="form-grid" style="margin-top:14px"><div class="field"><label>Full name *</label><input name="display_name" required></div><div class="field"><label>Email address *</label><input name="email" type="email" required></div><div class="field"><label>Workspace</label><select name="role"><option value="office">School office</option><option value="student">Student</option></select></div><div class="field"><label>Linked student record</label><select name="student_id"><option value="">Select if inviting a student</option>' + studentChoices + '</select></div><div class="field wide"><button class="btn btn-primary" type="submit">Send secure invitation</button></div></form></section><section class="table-card" style="margin-top:14px"><div class="panel-title">Registered accounts</div>' + (rows ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>Name</th><th>Email</th><th>Role and student link</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : emptyState('No registered accounts','Invited accounts will appear here after the user accepts the email invitation.')) + '</section></div>';
  }
  function appAuditPage() {
    return '<div class="page">' + pageHeader('OWNER · ACCOUNTABILITY','Change history','Audit records capture who changed a record, when and which fields changed. Sensitive values are not duplicated in the log.') + '<section class="table-card"><div class="table-wrap">' + (auditRows.length ? '<table class="data-table"><thead><tr><th>When</th><th>Table</th><th>Record</th><th>Action</th><th>Fields changed</th><th>Account</th></tr></thead><tbody>' + auditRows.map(function (row) { var actor = userProfiles.find(function (p) { return p.id === row.changed_by; }); return '<tr><td>' + escape(new Date(row.changed_at).toLocaleString()) + '</td><td>' + escape(row.table_name) + '</td><td>' + escape(row.record_id) + '</td><td>' + escape(row.operation) + '</td><td>' + escape((row.changed_fields || []).join(', ')) + '</td><td>' + escape(actor ? actor.display_name || actor.email : row.changed_by || 'Public form') + '</td></tr>'; }).join('') + '</tbody></table>' : emptyState('No changes logged yet','Account, roster, attendance, enquiry and fee edits will be recorded here.')) + '</div></section></div>';
  }
  // Modal content is rebuilt on demand. Form submissions still pass through the
  // central handler below, including the local-demo read-only guard.
  function openModal(title, subtitle, contents) {
    document.getElementById('modal').innerHTML = '<div class="modal-head"><div><h3>' + escape(title) + '</h3><p>' + escape(subtitle || '') + '</p></div><button type="button" class="close" data-action="close-modal" aria-label="Close">×</button></div>' + contents;
    document.getElementById('overlay').classList.add('open');
  }
  function enquiryModal() {
    openModal('Record a family enquiry','Enter all contact details so the school team can follow up.', '<form id="modalForm" data-type="new-enquiry"><div class="form-grid"><div class="field"><label>Student name *</label><input name="student_name" required></div><div class="field"><label>Grade / class interested in *</label><input name="grade" required></div><div class="field"><label>Parent / guardian *</label><input name="guardian_name" required></div><div class="field"><label>Phone *</label><input name="phone" required type="tel"></div><div class="field"><label>Email</label><input name="email" type="email"></div><div class="field"><label>Date of birth</label><input name="date_of_birth" type="date"></div><div class="field"><label>Current school</label><input name="current_school"></div><div class="field wide"><label>Home address</label><textarea name="address"></textarea></div><div class="field wide"><label>Message / question</label><textarea name="message"></textarea></div></div><div class="modal-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn btn-primary" type="submit">Save enquiry</button></div></form>');
  }
  function leadDetails(id) {
    var lead = leads.find(function (row) { return row.id === id; });
    if (!lead) return say('This enquiry has already changed. Refresh the page.', true);
    openModal(lead.student_name, 'Full family enquiry · received ' + new Date(lead.created_at).toLocaleString(), '<form id="leadDetailsForm" data-id="' + escape(lead.id) + '"><div class="form-grid"><div class="field"><label>Grade / class</label><input readonly value="' + escape(lead.grade) + '"></div><div class="field"><label>Date of birth</label><input readonly value="' + escape(lead.date_of_birth || 'Not provided') + '"></div><div class="field"><label>Parent / guardian</label><input readonly value="' + escape(lead.guardian_name) + '"></div><div class="field"><label>Phone</label><input readonly value="' + escape(lead.phone) + '"></div><div class="field"><label>Email</label><input readonly value="' + escape(lead.email || 'Not provided') + '"></div><div class="field"><label>Current school</label><input readonly value="' + escape(lead.current_school || 'Not provided') + '"></div><div class="field wide"><label>Address</label><textarea readonly>' + escape(lead.address || 'Not provided') + '</textarea></div><div class="field wide"><label>Family message</label><textarea readonly>' + escape(lead.message || 'Not provided') + '</textarea></div><div class="field"><label>Admission stage</label><select name="status">' + ['New enquiry','Contacted','Application','Assessment','Offered','Admitted','Closed'].map(function (status) { return '<option ' + (status === lead.status ? 'selected' : '') + '>' + status + '</option>'; }).join('') + '</select></div><div class="field wide"><label>Private office notes</label><textarea name="office_notes">' + escape(lead.office_notes || '') + '</textarea></div></div><div class="modal-actions"><button type="button" class="btn" data-action="close-modal">Close</button><button class="btn btn-primary" type="submit">Save enquiry update</button></div></form>');
  }
  function studentDetails(id) {
    var student = students.find(function (row) { return row.dbId === id || row.id === id; });
    if (!student) return say('Student record was not found.', true);
    openModal(student.name, escape(classLabel(student)) + ' · ' + escape(student.student_code), '<div class="form-grid"><div class="field"><label>Student ID</label><input readonly value="' + escape(student.student_code) + '"></div><div class="field"><label>Date of birth</label><input readonly value="' + escape(student.dob || 'Not entered') + '"></div><div class="field"><label>Academic year</label><input readonly value="' + escape(student.academic_year) + '"></div><div class="field"><label>Previous school</label><input readonly value="' + escape(student.previous_school || 'Not entered') + '"></div><div class="field"><label>Parent / guardian</label><input readonly value="' + escape(student.guardian || 'Not entered') + '"></div><div class="field"><label>Relationship</label><input readonly value="' + escape(student.relationship || 'Not entered') + '"></div><div class="field"><label>Phone</label><input readonly value="' + escape(student.guardian_phone || 'Not entered') + '"></div><div class="field"><label>Email</label><input readonly value="' + escape(student.guardian_email || 'Not entered') + '"></div><div class="field wide"><label>Home address</label><textarea readonly>' + escape(student.address || 'Not entered') + '</textarea></div><div class="field"><label>Emergency contact</label><input readonly value="' + escape(student.emergency_name || 'Not entered') + '"></div><div class="field"><label>Emergency phone</label><input readonly value="' + escape(student.emergency_phone || 'Not entered') + '"></div><div class="field wide"><label>Health / learning support notes</label><textarea readonly>' + escape(student.support_notes || 'Not entered') + '</textarea></div></div>');
  }
  // Build scoped forms for fee requests, parent follow-ups, and owner fee decisions.
  // Database policy and owner-only RPCs enforce the actual role restrictions.
  function feeIdAction(action, id) {
    var fee = feeAccounts.find(function (row) { return row.id === id; });
    if (!fee) return say('Fee record was not found.', true);
    if (action === 'fee-payment-request') {
      if (!isOffice()) return say('Only school office accounts can request payment review.', true);
      var expectedAmount = Number(fee.amount) + (fee.due_date < currentISODate() ? Number(fee.late_fee || 0) : 0);
      openModal('Request fee payment approval','The owner will verify this payment before the status changes to Paid.', '<form id="modalForm" data-type="payment-request" data-id="' + escape(id) + '"><div class="form-grid"><div class="field"><label>Amount received *</label><input name="amount" type="number" min="0.01" step="0.01" value="' + escape(expectedAmount) + '" required></div><div class="field"><label>Payment method *</label><select name="method"><option>UPI</option><option>Bank transfer</option><option>Card</option><option>Cash</option><option>Cheque</option><option>Other</option></select></div><div class="field"><label>Reference / receipt number</label><input name="reference"></div><div class="field wide"><label>Message for owner</label><textarea name="note" placeholder="Who received it and what should the owner verify?"></textarea></div></div><div class="modal-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn btn-primary" type="submit">Send to owner</button></div></form>');
    }
    if (action === 'fee-followup') {
      var st = students.find(function (x) { return x.dbId === fee.student_id; });
      openModal('Record parent fee contact','Track why the family was contacted and when payment is expected.', '<form id="modalForm" data-type="fee-followup" data-id="' + escape(id) + '"><div class="form-grid"><div class="field"><label>Parent contact</label><input name="parent_contact" value="' + escape(st ? st.guardianPhone || st.guardian : '') + '"></div><div class="field"><label>Contact method</label><select name="method"><option>Phone call</option><option>SMS</option><option>WhatsApp</option><option>Email</option><option>In person</option></select></div><div class="field wide"><label>Reason for contact *</label><textarea name="reason" required placeholder="Fee reminder, parent requested an extension…"></textarea></div><div class="field"><label>Expected payment date</label><input name="promised_date" type="date"></div><div class="field"><label>Late fee discussed?</label><select name="late_fee_discussed"><option>No</option><option>Yes</option></select></div><div class="field wide"><label>Contact notes</label><textarea name="note"></textarea></div></div><div class="modal-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn btn-primary" type="submit">Save contact log</button></div></form>');
    }
    if (action === 'fee-status') {
      if (!isOwner()) return say('Only the owner can change a fee payment status.', true);
      openModal('Owner fee approval','Only this owner account can set payment status. An office request remains pending until approved.', '<form id="modalForm" data-type="owner-fee-status" data-id="' + escape(id) + '"><div class="form-grid"><div class="field"><label>Fee status</label><select name="status"><option ' + (fee.status === 'Unpaid' ? 'selected' : '') + '>Unpaid</option><option ' + (fee.status === 'Paid' ? 'selected' : '') + '>Paid</option><option ' + (fee.status === 'Waived' ? 'selected' : '') + '>Waived</option></select></div><div class="field"><label>Late fee amount (₹)</label><input name="late_fee" type="number" min="0" step="0.01" value="' + escape(fee.late_fee) + '"></div><div class="field"><label>Payment method</label><select name="method"><option>UPI</option><option>Bank transfer</option><option>Card</option><option>Cash</option><option>Cheque</option><option>Other</option></select></div><div class="field"><label>Reference / receipt</label><input name="reference" value="' + escape(fee.payment_reference) + '"></div><div class="field wide"><label>Reason / late-fee decision</label><textarea name="reason">' + escape(fee.late_fee_reason || '') + '</textarea></div></div><div class="modal-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn btn-primary" type="submit">Save owner decision</button></div></form>');
    }
  }
  function newFeeEntry() {
    if (!isOwner()) return say('Only the owner can create fee accounts.', true);
    if (!students.length) return say('Add the student roster before creating fee accounts.', true);
    var options = students.map(function (student) { return '<option value="' + escape(student.dbId) + '">' + escape(student.name + ' · ' + student.id + ' · ' + classLabel(student)) + '</option>'; }).join('');
    openModal('Add student fee account','Owner-created charges are synchronized and appear in the family fee view.', '<form id="modalForm" data-type="fee-entry"><div class="form-grid"><div class="field wide"><label>Student</label><select name="student_id">' + options + '</select></div><div class="field"><label>Academic year</label><input name="academic_year" value="' + escape(schoolSettings.academicYear) + '" required></div><div class="field"><label>Installment name</label><input name="installment" required placeholder="Term 1"></div><div class="field"><label>Fee amount (₹)</label><input name="amount" type="number" min="0.01" step="0.01" required></div><div class="field"><label>Due date</label><input name="due_date" type="date" required></div><div class="field"><label>Late fee (₹)</label><input name="late_fee" type="number" min="0" step="0.01" value="0"></div></div><div class="modal-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn btn-primary" type="submit">Create fee account</button></div></form>');
  }
  function generateClassFee(id) {
    if (!isOwner()) return say('Only the owner can generate a fee installment.', true);
    var cls = classRows.find(function (row) { return row.id === id; });
    if (!cls) return say('Class fee plan not found.', true);
    openModal('Generate a class installment',cls.grade + ' · ' + (cls.section || 'No section') + ' · ' + cls.academic_year, '<form id="modalForm" data-type="generate-class-fee" data-id="' + escape(id) + '"><div class="form-grid"><div class="field"><label>Installment label</label><input name="installment" required placeholder="Term 1"></div><div class="field"><label>Amount per student (₹)</label><input name="amount" type="number" min="0.01" step="0.01" value="' + escape(Number(cls.annual_fee || 0) / Math.max(1, (cls.installments || []).length || 1)) + '" required></div><div class="field wide"><label>Due date</label><input name="due_date" type="date" required></div></div><div class="login-note">The system creates one record for each student currently enrolled in this exact class, section and academic year. Existing installment IDs are skipped.</div><div class="modal-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn btn-primary" type="submit">Generate class fees</button></div></form>');
  }
  function editClassSetting(id) {
    if (!isOwner()) return say('Only the owner can edit class and fee plans.', true);
    var cls = classRows.find(function (row) { return row.id === id; });
    if (!cls) return say('Class fee plan not found.', true);
    var labels = (cls.installments || []).map(function (item) { return typeof item === 'string' ? item : item.name; }).join(', ');
    openModal('Edit class and fee plan','Changes apply to future installments. Existing student fee accounts stay intact.', '<form id="modalForm" data-type="edit-class" data-id="' + escape(id) + '"><div class="form-grid"><div class="field"><label>Grade / class</label><input name="grade" value="' + escape(cls.grade) + '" required></div><div class="field"><label>Section</label><input name="section" value="' + escape(cls.section) + '"></div><div class="field"><label>Academic year</label><input name="academic_year" value="' + escape(cls.academic_year) + '" required></div><div class="field"><label>Capacity</label><input name="capacity" type="number" min="1" value="' + escape(cls.capacity || '') + '"></div><div class="field"><label>Annual fee (₹)</label><input name="annual_fee" type="number" min="0" step="0.01" value="' + escape(cls.annual_fee) + '"></div><div class="field"><label>Late fee (₹)</label><input name="late_fee" type="number" min="0" step="0.01" value="' + escape(cls.late_fee) + '"></div><div class="field wide"><label>Installment labels</label><input name="installments" value="' + escape(labels) + '"></div></div><div class="modal-actions"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn btn-primary" type="submit">Save class settings</button></div></form>');
  }
  function openInvite() { navigate('users'); }
  // Create a printable receipt from the saved fee and student details; the browser's
  // print dialog can export it as PDF without sending invoice data to another service.
  function downloadInvoice(id) {
    var fee = feeAccounts.find(function (row) { return row.id === id; });
    if (!fee || fee.status !== 'Paid' || !isStaff() && profile.role !== 'student') return say('Paid invoice not available for this account.', true);
    var student = students.find(function (row) { return row.dbId === fee.student_id; });
    if (!student) return say('Student details could not be loaded for this invoice.', true);
    var amount = Number(fee.amount) + Number(fee.late_fee || 0);
    var lines = '<!doctype html><html><head><meta charset="utf-8"><title>' + escape(fee.receipt_number || 'Fee invoice') + '</title><style>body{font:15px Arial,sans-serif;color:#172234;margin:40px}header{display:flex;justify-content:space-between;border-bottom:2px solid #c9f06c;padding-bottom:18px}h1{margin:0;font-size:26px}.muted{color:#627082;line-height:1.6}.receipt{border:1px solid #dce2e6;border-radius:12px;margin:26px 0;overflow:hidden}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:15px;border-bottom:1px solid #e7ebee}th{background:#f5f7f8}.total{font-size:20px;font-weight:700;text-align:right;padding:20px}.no-print{margin-top:20px;padding:12px 18px}@media print{body{margin:15mm}.no-print{display:none}}</style></head><body><header><div><h1>' + escape(schoolSettings.school) + '</h1><div class="muted">' + escape(schoolSettings.schoolAddress) + '<br>' + escape(schoolSettings.schoolPhone) + ' · ' + escape(schoolSettings.contact) + '<br>' + (schoolSettings.registrationNumber ? 'Registration: ' + escape(schoolSettings.registrationNumber) : '') + '</div></div><div style="text-align:right"><b>FEE RECEIPT</b><div>' + escape(fee.receipt_number || '') + '</div><div class="muted">' + escape(new Date(fee.paid_at || fee.updated_at).toLocaleDateString()) + '</div></div></header><p><b>Student:</b> ' + escape(student.name) + '<br><b>Student ID:</b> ' + escape(student.student_code) + '<br><b>Class:</b> ' + escape(classLabel(student)) + '<br><b>Parent / guardian:</b> ' + escape(student.guardian) + '<br><b>Academic year:</b> ' + escape(fee.academic_year) + '</p><div class="receipt"><table><thead><tr><th>Description</th><th>Due date</th><th>Amount</th></tr></thead><tbody><tr><td>' + escape(fee.installment) + '</td><td>' + escape(fee.due_date) + '</td><td>' + formatMoney(fee.amount) + '</td></tr>' + (Number(fee.late_fee || 0) ? '<tr><td>Late fee</td><td>—</td><td>' + formatMoney(fee.late_fee) + '</td></tr>' : '') + '</tbody></table><div class="total">Total received: ' + formatMoney(amount) + '</div></div><p><b>Payment method:</b> ' + escape(fee.payment_method || 'Recorded by school') + '<br><b>Payment reference:</b> ' + escape(fee.payment_reference || '—') + '<br><b>Status:</b> Paid</p><p class="muted">' + escape(schoolSettings.invoiceFooter || 'Computer-generated school fee receipt.') + '</p><button class="no-print" onclick="window.print()">Print or save PDF</button></body></html>';
    var invoiceWindow = window.open('', '_blank');
    if (!invoiceWindow) return say('Allow pop-ups to print this invoice as a PDF.', true);
    invoiceWindow.document.open(); invoiceWindow.document.write(lines); invoiceWindow.document.close();
    setTimeout(function () { invoiceWindow.focus(); invoiceWindow.print(); }, 350);
  }
  // Replace the HTML prototype pages with database-backed renderers and append
  // authorized navigation entries that are specific to this version of the app.
  function wireRenderers() {
    pageRenderers.overview = appDashboard;
    pageRenderers.admissions = appAdmissions;
    pageRenderers.students = appStudentDirectory;
    pageRenderers['student-add'] = appStudentAdd;
    pageRenderers['student-import'] = appImportPage;
    pageRenderers.attendance = appAttendancePage;
    pageRenderers.fees = appFeesPage;
    pageRenderers['school-settings'] = appSettingsPage;
    pageRenderers['family-portal'] = appStudentHome;
    pageRenderers['class-fees'] = appClassFeesPage;
    pageRenderers.users = appUsersPage;
    pageRenderers.audit = appAuditPage;
    pageNames['class-fees'] = 'Classes & fees';
    pageNames.users = 'Users & access';
    pageNames.audit = 'Change history';
    var baseRender = render;
    render = function (page) {
      baseRender(page);
      var view = document.getElementById('view');
      if (view && demoMode) {
        var banner = document.createElement('div');
        banner.className = 'demo-mode-banner';
        banner.setAttribute('role', 'status');
        banner.innerHTML = '<b>Local demo · read-only</b><span>This preview has no database connection. Nothing you change here is saved.</span>';
        view.prepend(banner);
      }
      document.querySelectorAll('.nav-item[data-page]').forEach(function (item) {
        var key = item.dataset.page;
        var visible = profile && (profile.role === 'owner' || (profile.role === 'office' && !['school-settings','roadmap','class-fees','users','audit'].includes(key)) || (profile.role === 'student' && ['overview','family-portal','school-site'].includes(key)));
        item.hidden = !visible;
      });
    };
    var section = document.querySelector('#mainNav');
    if (section && !document.querySelector('[data-page="class-fees"]')) {
      section.insertAdjacentHTML('beforeend', '<button class="nav-item" data-page="class-fees">▦ &nbsp; Classes & fees</button><button class="nav-item" data-page="users">♙ &nbsp; Users & access</button><button class="nav-item" data-page="audit">⌁ &nbsp; Change history</button>');
    }
  }
  // Route every school-data write through a single form handler. The local demo check
  // runs before any Supabase operation, and RLS provides the server-side enforcement.
  async function submitForm(form, event) {
    event.preventDefault();
    if (demoMode && form.id !== 'loginForm') return say('This local demo is read-only. Connect a school database to save changes.', true);
    var data = Object.fromEntries(new FormData(form).entries());
    var type = form.dataset.type;
    try {
      if (form.id === 'loginForm') return await signIn(event);
      if (form.id === 'studentRecordForm') {
        if (!isStaff()) throw new Error('Only school office or owner accounts can add students.');
        var student = { student_code: data.id.trim(), name: data.name.trim(), dob: data.dob || null, academic_year: data.academicYear || schoolSettings.academicYear, grade: data.grade.trim(), section: data.section.trim(), previous_school: data.previousSchool, guardian: data.guardian, relationship: data.relationship, guardian_phone: data.guardianPhone, guardian_email: data.guardianEmail, address: data.address, emergency_name: data.emergencyName, emergency_phone: data.emergencyPhone, support_notes: data.supportNotes, created_by: user.id };
        must(await client.from('students').insert(student));
        await refreshData(false); closeModal(); render('students'); say('Student record saved to the shared school database.'); return;
      }
      if (form.id === 'schoolSettingsForm') {
        if (!isOwner()) throw new Error('Only the owner can edit school settings.');
        data.showStats = form.elements.showStats.checked;
        must(await client.from('school_settings').upsert(settingsPayload(data), { onConflict: 'id' }));
        await refreshData(false); render('school-settings'); say('School settings saved and synchronized.'); return;
      }
      if (form.id === 'classSettingsForm') {
        if (!isOwner()) throw new Error('Only the owner can change class and fee settings.');
        var installmentList = data.installments.split(',').map(function (name) { return name.trim(); }).filter(Boolean).map(function (name) { return { name: name }; });
        must(await client.from('class_settings').insert({ grade: data.grade.trim(), section: data.section.trim(), academic_year: data.academicYear.trim(), capacity: data.capacity ? Number(data.capacity) : null, annual_fee: Number(data.annualFee || 0), late_fee: Number(data.lateFee || 0), installments: installmentList }));
        await refreshData(false); render('class-fees'); say('Class and fee structure saved.'); return;
      }
      if (form.matches('[data-role-form]')) {
        if (!isOwner()) throw new Error('Only the owner can assign account roles.');
        var roleData = { role: data.role, student_id: data.role === 'student' ? (data.student_id || null) : null };
        must(await client.from('profiles').update(roleData).eq('id', form.dataset.id));
        await refreshData(false); render('users'); say('Account access updated.'); return;
      }
      if (form.id === 'inviteUserForm') {
        if (!isOwner()) throw new Error('Only the owner can invite accounts.');
        if (data.role === 'student' && !data.student_id) throw new Error('Link the invited student to a student record.');
        var invitation = await client.functions.invoke('invite-campus-user', { body: data });
        if (invitation.error) throw new Error(await edgeFunctionErrorMessage(invitation.error, 'invite-campus-user'));
        if (invitation.data && invitation.data.error) throw new Error(invitation.data.error);
        await refreshData(false); render('users'); say('Invitation sent to ' + data.email + '.'); return;
      }
      if (form.id === 'leadDetailsForm') {
        must(await client.from('admissions').update({ status: data.status, office_notes: data.office_notes }).eq('id', form.dataset.id));
        await refreshData(false); closeModal(); render('admissions'); say('Admission details saved.'); return;
      }
      if (type === 'new-enquiry') {
        must(await client.from('admissions').insert({ student_name: data.student_name, grade: data.grade, date_of_birth: data.date_of_birth || null, guardian_name: data.guardian_name, phone: data.phone, email: data.email, current_school: data.current_school, address: data.address, message: data.message, status: 'New enquiry', created_by: user.id }));
        await refreshData(false); closeModal(); render('admissions'); say('Enquiry saved and visible to the school team.'); return;
      }
      if (type === 'payment-request') {
        if (!isOffice()) throw new Error('Only school office users can request payment review.');
        must(await client.from('fee_payment_requests').insert({ fee_account_id: form.dataset.id, amount: Number(data.amount), method: data.method, reference: data.reference, note: data.note, requested_by: user.id }));
        await refreshData(false); closeModal(); render('fees'); say('Payment request sent to the owner. The fee remains unpaid until approved.'); return;
      }
      if (type === 'fee-followup') {
        must(await client.from('fee_followups').insert({ fee_account_id: form.dataset.id, parent_contact: data.parent_contact, method: data.method, reason: data.reason, promised_date: data.promised_date || null, late_fee_discussed: data.late_fee_discussed === 'Yes', note: data.note, contacted_by: user.id }));
        closeModal(); say('Parent contact and promised payment date were recorded.'); return;
      }
      if (type === 'owner-fee-status') {
        if (!isOwner()) throw new Error('Only the owner can change payment status.');
        must(await client.rpc('owner_set_fee_status', { p_fee_id: form.dataset.id, p_status: data.status, p_reason: data.reason, p_method: data.method, p_reference: data.reference, p_late_fee: Number(data.late_fee || 0) }));
        await refreshData(false); closeModal(); render('fees'); say('Owner fee decision saved. ' + (data.status === 'Paid' ? 'The invoice is ready to print as PDF.' : '')); return;
      }
      if (type === 'fee-entry') {
        if (!isOwner()) throw new Error('Only the owner can create a fee record.');
        must(await client.from('fee_accounts').insert({ student_id: data.student_id, academic_year: data.academic_year, installment: data.installment, amount: Number(data.amount), due_date: data.due_date, late_fee: Number(data.late_fee || 0), updated_by: user.id }));
        await refreshData(false); closeModal(); render('fees'); say('Fee account saved.'); return;
      }
      if (type === 'generate-class-fee') {
        var generated = must(await client.rpc('generate_class_fee', { p_class_id: form.dataset.id, p_installment: data.installment, p_amount: Number(data.amount), p_due_date: data.due_date }));
        await refreshData(false); closeModal(); render('fees'); say(Number(generated).toLocaleString() + ' fee accounts generated. Existing installment records were skipped.'); return;
      }
      if (type === 'edit-class') {
        if (!isOwner()) throw new Error('Only the owner can edit class and fee plans.');
        var labels = data.installments.split(',').map(function (name) { return name.trim(); }).filter(Boolean).map(function (name) { return { name: name }; });
        must(await client.from('class_settings').update({ grade: data.grade.trim(), section: data.section.trim(), academic_year: data.academic_year.trim(), capacity: data.capacity ? Number(data.capacity) : null, annual_fee: Number(data.annual_fee || 0), late_fee: Number(data.late_fee || 0), installments: labels, updated_at: new Date().toISOString() }).eq('id', form.dataset.id));
        await refreshData(false); closeModal(); render('class-fees'); say('Class fee plan updated. Existing fee accounts were not changed.'); return;
      }
      if (type === 'invite-password' || type === 'password-recovery') {
        if (data.password !== data.confirm) throw new Error('The passwords do not match.');
        if (data.password.length < 10) throw new Error('Use at least 10 characters for the password.');
        var invitedRole = null;
        if (type === 'invite-password') {
          if (!user) throw new Error('Your invitation session has expired. Ask the school Owner to send a new invitation.');
          var invitedProfile = must(await client.from('profiles').select('role').eq('id', user.id).maybeSingle());
          invitedRole = invitedProfile && invitedProfile.role;
          if (!['office','student'].includes(invitedRole)) throw new Error('This invitation has no school workspace assigned. Ask the school Owner for help.');
        }
        var changed = await client.auth.updateUser({ password: data.password });
        if (changed.error) throw changed.error;
        closeModal(); history.replaceState(null, '', location.pathname + location.search);
        if (type === 'invite-password') {
          await signOut();
          selectedRole = invitedRole;
          document.querySelectorAll('[data-login-role]').forEach(function (button) { button.classList.toggle('active', button.dataset.loginRole === selectedRole); });
          say('Account activated. Sign in as ' + roleLabels[invitedRole] + ' with the password you just created.');
          return;
        }
        await signOut(); say('Password updated. Sign in with your new password.'); return;
      }
      if (type === 'new-notice') { state.noticeList.unshift({ title: data.title, date: 'Draft · ' + new Date().toLocaleDateString(), body: data.body, channels: 'Not sent', icon: 'file' }); closeModal(); render(state.page); say('Draft saved in this session. Configure a messaging provider to publish.'); return; }
    } catch (error) { say(error.message || 'Could not save this record.', true); }
  }
  // Delegate clicks because page HTML is regenerated after navigation. Mutating actions
  // are blocked in demo mode; real writes call protected database queries/RPCs below.
  async function handleClick(event) {
    var target = event.target;
    var demoLogin = target.closest('[data-demo-login]');
    if (demoLogin) {
      event.preventDefault(); event.stopImmediatePropagation();
      var demoRole = demoLogin.dataset.demoLogin;
      var demoAccount = demoAccounts[demoRole];
      document.getElementById('loginName').value = demoAccount.email;
      document.getElementById('loginPassword').value = demoAccount.password;
      document.querySelectorAll('[data-login-role]').forEach(function (button) { button.classList.toggle('active', button.dataset.loginRole === demoRole); });
      return startDemoSession(demoRole);
    }
    var requestedAction = target.closest('[data-action]');
    var safeDemoActions = ['logout','close-modal','student-prev','student-next','export','download-template','invoice','site-preview','download-plan','notify','theme','remind','family-fees','book-meeting','connect','student-details','profile','lead-details'];
    if (demoMode && requestedAction && !safeDemoActions.includes(requestedAction.dataset.action)) {
      event.preventDefault(); event.stopImmediatePropagation();
      return say('This local demo is read-only. Connect a school database to save changes.', true);
    }
    var roleButton = target.closest('[data-login-role]');
    if (roleButton) {
      event.preventDefault(); event.stopImmediatePropagation();
      selectedRole = roleButton.dataset.loginRole;
      document.querySelectorAll('[data-login-role]').forEach(function (button) { button.classList.toggle('active', button === roleButton); });
      return;
    }
    if (target.closest('#resetPassword')) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (!client) return say('Connect the school database first.', true);
      var email = document.getElementById('loginName').value.trim();
      if (!email) return say('Enter your email address, then choose Forgot password.', true);
      var reset = await client.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      if (reset.error) return say(reset.error.message, true);
      return say('Password reset instructions sent if the account exists.');
    }
    if (target.closest('[data-page]')) { event.preventDefault(); event.stopImmediatePropagation(); return navigate(target.closest('[data-page]').dataset.page); }
    if (target.closest('[data-filter]')) { event.preventDefault(); event.stopImmediatePropagation(); state.attendanceFilter = target.closest('[data-filter]').dataset.filter; return render('attendance'); }
    if (target.closest('[data-fee]')) { event.preventDefault(); event.stopImmediatePropagation(); state.feeFilter = target.closest('[data-fee]').dataset.fee; return render('fees'); }
    var button = target.closest('[data-action]');
    if (!button) return;
    var handled = ['close-modal','logout','new-enquiry','lead-details','student-details','profile','fee-payment-request','fee-followup','fee-status','new-fee-entry','edit-class-setting','generate-class-fee','invoice','review-payment','mark-all','cycle-attendance','save-attendance','student-prev','student-next','export','download-template','clear-import','confirm-import','site-preview','download-plan'];
    if (!handled.includes(button.dataset.action)) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    var action = button.dataset.action;
    var id = button.dataset.id;
    if (action === 'close-modal') { closeModal(); return; }
    if (action === 'logout') return signOut();
    if (action === 'new-enquiry') return enquiryModal();
    if (action === 'lead-details') return leadDetails(id);
    if (action === 'student-details' || action === 'profile') return studentDetails(id || button.dataset.name);
    if (action === 'fee-payment-request' || action === 'fee-followup' || action === 'fee-status') return feeIdAction(action, id);
    if (action === 'new-fee-entry') return newFeeEntry();
    if (action === 'edit-class-setting') return editClassSetting(id);
    if (action === 'generate-class-fee') return generateClassFee(id);
    if (action === 'invoice') return downloadInvoice(id);
    if (action === 'review-payment') {
      if (!isOwner()) return say('Only the owner can approve payment.', true);
      if (!window.confirm(button.dataset.approve === 'true' ? 'Approve the office request and mark this fee Paid?' : 'Reject this payment request?')) return;
      try { must(await client.rpc('review_fee_payment_request', { p_request_id: id, p_approve: button.dataset.approve === 'true' })); await refreshData(false); render('fees'); say(button.dataset.approve === 'true' ? 'Payment approved and marked Paid.' : 'Payment request rejected.'); } catch (error) { say(error.message, true); }
      return;
    }
    if (action === 'mark-all') { attendance.forEach(function (row) { if (classLabel(row) === state.attendanceClass) row.status = 'Present'; }); return render('attendance'); }
    if (action === 'cycle-attendance') { var person = attendance.find(function (row) { return row.id === button.dataset.id; }); if (person) person.status = person.status === 'Present' ? 'Absent' : person.status === 'Absent' ? 'Late' : 'Present'; return render('attendance'); }
    if (action === 'save-attendance') {
      try {
        var payload = attendance.filter(function (row) { return classLabel(row) === state.attendanceClass; }).map(function (row) { return { student_id: row.dbId, attendance_date: currentISODate(), status: row.status, marked_by: user.id }; });
        if (payload.length) must(await client.from('attendance').upsert(payload, { onConflict: 'student_id,attendance_date' }));
        await refreshData(false); render('attendance'); say('Attendance register saved and synchronized.');
      } catch (error) { say(error.message, true); }
      return;
    }
    if (action === 'student-prev') { state.studentPage = Math.max(0, state.studentPage - 1); return render('students'); }
    if (action === 'student-next') { state.studentPage++; return render('students'); }
    if (action === 'export') return exportCsv();
    if (action === 'download-template') return downloadTemplate();
    if (action === 'clear-import') { state.importRows = []; state.importErrors = []; return render('student-import'); }
    if (action === 'confirm-import') {
      if (!isStaff()) return say('School office or owner permission is required for roster import.', true);
      var valid = state.importRows.filter(function (row) { return row.valid; });
      if (!valid.length) return say('There are no valid rows ready to import.', true);
      var importRows = valid.map(function (row) { return { student_code: row.id, name: row.name, grade: row.grade, section: row.section, guardian: row.guardian, guardian_phone: row.guardianPhone, guardian_email: row.guardianEmail, academic_year: row.academicYear || schoolSettings.academicYear }; });
      try {
        var imported = must(await client.rpc('import_students', { p_students: importRows }));
        state.importRows = []; state.importErrors = [];
        await refreshData(false); render('students'); say(Number(imported).toLocaleString() + ' student records saved in one database transaction.');
      } catch (error) { say('Roster import was rolled back. ' + error.message, true); }
      return;
    }
    if (action === 'site-preview') { window.open('./public.html', '_blank', 'noopener'); return; }
    if (action === 'download-plan') { window.print(); return; }
    if (action === 'notify') { document.getElementById('notifications').classList.toggle('open'); return; }
    if (action === 'theme') { document.body.classList.toggle('dark'); state.dark = document.body.classList.contains('dark'); return; }
    if (action === 'customize') return navigate('school-settings');
    if (action === 'remind') return say('Parent messages need an approved SMS or WhatsApp provider.');
    if (action === 'family-fees') return navigate('fees');
    if (action === 'book-meeting') return say('Meeting scheduling is not connected.');
    if (action === 'connect') return say('Connect the provider account in deployment settings.');
  }
  // Read roster CSV files locally for preview; import occurs only after explicit
  // confirmation and is sent as one database transaction by the SQL RPC.
  function handleChange(event) {
    var target = event.target;
    if (target.id === 'rosterFile') {
      event.stopImmediatePropagation();
      var file = target.files && target.files[0];
      if (!file) return;
      file.text().then(function (text) { state.importRows = parseCsv(text); state.importErrors = state.importRows.filter(function (row) { return !row.valid; }); render('student-import'); say('CSV checked in this browser. Review the preview, then import it.'); }).catch(function (error) { say(error.message, true); });
    }
    if (target.id === 'attendanceClassSelect') { event.stopImmediatePropagation(); state.attendanceClass = target.value; state.attendanceFilter = 'All'; render('attendance'); }
  }
  function handleInput(event) {
    if (event.target.id !== 'studentFilter') return;
    event.stopImmediatePropagation();
    var input = event.target; var value = input.value; var position = input.selectionStart;
    state.studentQuery = value; state.studentPage = 0; render('students');
    var next = document.getElementById('studentFilter'); if (next) { next.focus(); next.setSelectionRange(position, position); }
  }
  // Intercept connection setup and application forms before the original prototype
  // listeners. Local demo forms are stopped before they can change local or remote data.
  function handleSubmit(event) {
    var form = event.target;
    if (form.id === 'backendConfigForm') {
      event.stopImmediatePropagation();
      event.preventDefault();
      var cfg = { supabaseUrl: form.elements.projectUrl.value.trim().replace(/\/$/, ''), publishableKey: form.elements.publishableKey.value.trim() };
      try { connect({ url: cfg.supabaseUrl, key: cfg.publishableKey }); localStorage.setItem('campusSupabaseConfig', JSON.stringify(cfg)); say('Connection saved in this browser. For every device, set the same values in campus-config.js and deploy the site.'); client.auth.getSession().then(function (result) { if (result.data && result.data.session) { user = result.data.session.user; selectedRole = 'owner'; loadProfile(user).catch(function (error) { say(error.message, true); }); } }); } catch (error) { say(error.message, true); }
      return;
    }
    if (demoMode && form.id !== 'loginForm') {
      event.preventDefault(); event.stopImmediatePropagation();
      say('This local demo is read-only. Connect a school database to save changes.', true);
      return;
    }
    if (form.id === 'loginForm' || form.id === 'studentRecordForm' || form.id === 'schoolSettingsForm' || form.id === 'classSettingsForm' || form.id === 'inviteUserForm' || form.id === 'leadDetailsForm' || form.matches('[data-role-form]') || form.id === 'modalForm') { event.stopImmediatePropagation(); submitForm(form, event); }
  }
  // Capture events at document level so the persistence layer can safely intercept
  // controls created later by renderers and modals.
  function registerListeners() {
    document.addEventListener('click', function (event) { handleClick(event).catch(function (error) { say(error.message, true); }); }, true);
    document.addEventListener('submit', handleSubmit, true);
    document.addEventListener('change', handleChange, true);
    document.addEventListener('input', handleInput, true);
  }
  // Finish one-time DOM preparation and install the persistence handlers before login.
  function finalizeLayout() {
    var oldTop = document.getElementById('loginForm');
    if (oldTop) {
      var details = document.getElementById('connectionSetup');
      if (details && details.parentElement === oldTop) {
        var card = oldTop.parentElement;
        details.remove();
        card.appendChild(details);
      }
    }
    wireRenderers();
    setToday();
    document.body.classList.add('signed-out');
    setupConfigUI();
    registerListeners();
  }
  // Startup sequence: wire the UI, configure login, then restore any real auth session.
  async function start() {
    finalizeLayout();
    if (!client) return;
    try {
      var auth = client.auth.onAuthStateChange(function (event, session) {
        if (event === 'SIGNED_OUT') { clearPrivateData(); user = null; profile = null; document.body.classList.add('signed-out'); return; }
        if (event === 'PASSWORD_RECOVERY') { user = session && session.user; passwordRecoveryModal('recovery'); return; }
        if (session && !user) setTimeout(function () {
          user = session.user;
          if (authCallbackType() === 'invite') { passwordRecoveryModal('invite'); return; }
          selectedRole = profile ? profile.role : (document.querySelector('[data-login-role].active')?.dataset.loginRole || 'owner');
          loadProfile(user).catch(function (error) { document.body.classList.add('signed-out'); say(error.message, true); });
        }, 0);
      });
      window.__campusAuthSubscription = auth.data.subscription;
      await restoreSession();
    } catch (error) { document.body.classList.add('signed-out'); say(error.message || 'Could not open the shared workspace.', true); }
  }
  start();
})();
