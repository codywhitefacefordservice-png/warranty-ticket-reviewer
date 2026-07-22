/* ClaimProof shared design system + app header.
   Loaded on every customer-facing page. It (1) injects the global modern-SaaS
   stylesheet, then (2) after /api/me resolves, builds the slim header — the
   customer's own logo, primary nav, a "More" menu, a live status pill, and a
   profile menu — plus a "Powered by ClaimProof" footer. The console, login and
   MFA pages do NOT load this file; they carry their own ClaimProof branding. */
(function () {
  /* ---------------- 1. Global stylesheet (synchronous) ---------------- */
  var CSS = `
  :root{
    --cp-bg:#f4f6f9; --cp-surface:#ffffff; --cp-ink:#141b2b; --cp-ink2:#5a6577; --cp-ink3:#8a93a3;
    --cp-line:#e6e9f0; --cp-line2:#eef1f6; --cp-brand:#123a86; --cp-brand2:#2f6bd8; --cp-tint:#eaf1fd;
    --cp-good:#0d8a4f; --cp-goodt:#e6f6ee; --cp-warn:#b7791f; --cp-warnt:#fbf1dd; --cp-danger:#c8102e; --cp-dangert:#fdecee;
    --cp-rad:14px; --cp-rad-sm:10px;
    --cp-shadow:0 1px 3px rgba(16,24,40,.07),0 12px 28px -18px rgba(16,24,40,.28);
    --cp-pop:0 8px 30px -8px rgba(16,24,40,.25);
    /* remap the pages' own tokens onto the new palette */
    color-scheme:light;
    --brand:#123a86; --brand-2:#2f6bd8; --accent:#2f6bd8;
    --page:#f4f6f9; --surface:#ffffff; --ink:#141b2b; --ink-2:#5a6577; --muted:#8a93a3;
    --grid:#eef1f6; --border:#e6e9f0; --good:#0d8a4f; --bad:#c8102e; --critical:#c8102e; --red:#c8102e;
    --serious:#c05621; --warning:#b7791f;
  }
  html,body{background:var(--cp-bg)}
  body{
    color:var(--cp-ink);
    font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased;
    background:
      radial-gradient(1100px 460px at 82% -220px, rgba(47,107,216,.09), transparent 60%),
      var(--cp-bg) !important;
  }
  /* retire the old hard rule under the header */
  .accent{display:none !important}

  /* ---- header ---- */
  .topbar{
    position:sticky;top:0;z-index:40;background:rgba(255,255,255,.85) !important;
    backdrop-filter:saturate(180%) blur(10px);border-bottom:1px solid var(--cp-line) !important;
  }
  .topbar-in{
    max-width:1120px;margin:0 auto;padding:0 22px !important;height:62px;
    display:flex;align-items:center;gap:20px;flex-wrap:nowrap !important;
  }
  .cp-brand{display:flex;align-items:center;gap:10px;text-decoration:none;flex-shrink:0;min-width:0}
  .cp-logo{height:38px;width:auto;max-width:230px;display:block;object-fit:contain}
  .cp-word{font-size:16px;font-weight:800;color:var(--cp-brand);letter-spacing:-.01em;white-space:nowrap}
  .cp-nav{display:flex;align-items:center;gap:2px;flex:1;min-width:0}
  .cp-nav a,.cp-navbtn{
    appearance:none;border:0;background:transparent;cursor:pointer;font-family:inherit;
    display:inline-flex;align-items:center;gap:6px;padding:8px 12px;border-radius:9px;
    font-size:14px;font-weight:600;color:var(--cp-ink2);text-decoration:none;white-space:nowrap;
    transition:background .13s,color .13s;
  }
  .cp-nav a:hover,.cp-navbtn:hover{background:var(--cp-line2);color:var(--cp-ink)}
  .cp-nav a.active{background:var(--cp-tint);color:var(--cp-brand)}
  .cp-navbtn .chev,.cp-av .chev{width:8px;height:8px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(45deg) translateY(-1px);opacity:.55}
  .cp-right{display:flex;align-items:center;gap:9px;flex-shrink:0;margin-left:auto}
  .cp-status{
    display:inline-flex;align-items:center;gap:7px;padding:6px 11px 6px 9px;border-radius:999px;text-decoration:none;
    font-size:12.5px;font-weight:700;border:1px solid transparent;transition:filter .13s;white-space:nowrap;
  }
  .cp-status .dot{width:7px;height:7px;border-radius:50%;background:currentColor;box-shadow:0 0 0 3px rgba(0,0,0,.06)}
  .cp-status.ok{background:var(--cp-goodt);color:var(--cp-good);border-color:rgba(13,138,79,.18)}
  .cp-status.warn{background:var(--cp-warnt);color:var(--cp-warn);border-color:rgba(183,121,31,.22)}
  .cp-status.down{background:var(--cp-dangert);color:var(--cp-danger);border-color:rgba(200,16,46,.2)}
  .cp-status:hover{filter:brightness(.97)}
  .cp-menu{position:relative}
  .cp-av{
    display:flex;align-items:center;gap:6px;cursor:pointer;border:0;background:transparent;padding:2px;border-radius:999px;
  }
  .cp-av .circ{
    width:36px;height:36px;border-radius:50%;border:2px solid #fff;
    background:linear-gradient(135deg,#2f6bd8,#123a86);color:#fff;
    display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;
    box-shadow:0 1px 4px rgba(18,58,134,.4);
  }
  .cp-pop{
    position:absolute;top:calc(100% + 10px);min-width:212px;background:#fff;border:1px solid var(--cp-line);
    border-radius:12px;box-shadow:var(--cp-pop);padding:6px;opacity:0;visibility:hidden;transform:translateY(-6px);
    transition:.14s;z-index:60;
  }
  .cp-pop.r{right:0}
  .cp-pop.open{opacity:1;visibility:visible;transform:translateY(0)}
  .cp-pop a,.cp-pop button{
    display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:9px 11px;border-radius:8px;
    font-size:14px;font-weight:600;color:var(--cp-ink);text-decoration:none;border:0;background:transparent;cursor:pointer;font-family:inherit;
  }
  .cp-pop a:hover,.cp-pop button:hover{background:var(--cp-line2)}
  .cp-pop .g{width:18px;text-align:center;color:var(--cp-ink3);flex-shrink:0}
  .cp-pop .sep{height:1px;background:var(--cp-line);margin:6px 4px}
  .cp-pop .who{padding:9px 11px 8px;border-bottom:1px solid var(--cp-line);margin-bottom:4px}
  .cp-pop .who b{display:block;font-size:13.5px;color:var(--cp-ink)}
  .cp-pop .who span{font-size:12px;color:var(--cp-ink3)}
  .cp-pop button.danger{color:var(--cp-danger)}
  @media(max-width:720px){
    .cp-word{display:none}
    .cp-status .txt{display:none}
    .cp-nav a,.cp-navbtn{padding:8px 9px}
  }

  /* ---- shared body components (uplift every page) ---- */
  .wrap{max-width:1120px !important;margin:0 auto;padding:30px 22px 80px !important}
  .page-title{font-size:24px !important;font-weight:800 !important;letter-spacing:-.02em;margin:0 0 5px !important}
  .page-sub{color:var(--cp-ink2) !important;font-size:14.5px !important;margin-bottom:24px !important}
  h2{color:var(--cp-brand) !important}
  .card{
    background:var(--cp-surface) !important;border:1px solid var(--cp-line) !important;border-radius:var(--cp-rad) !important;
    box-shadow:var(--cp-shadow) !important;padding:20px !important;margin-bottom:18px !important;
  }
  label{color:var(--cp-ink2) !important}
  input,select,textarea{
    border:1px solid #d9dee8 !important;border-radius:var(--cp-rad-sm) !important;background:#fff !important;color:var(--cp-ink) !important;
    padding:11px 13px !important;transition:border-color .13s,box-shadow .13s;
  }
  input:focus,select:focus,textarea:focus{
    outline:none !important;border-color:var(--cp-brand2) !important;box-shadow:0 0 0 3px rgba(47,107,216,.16) !important;
  }
  button{
    border-radius:var(--cp-rad-sm) !important;border:1px solid var(--cp-line) !important;background:#fff;color:var(--cp-ink);
    font-family:inherit;transition:.13s;
  }
  button:hover{border-color:#cdd4e0 !important;box-shadow:0 1px 2px rgba(16,24,40,.08)}
  button.primary{background:var(--cp-brand) !important;border-color:var(--cp-brand) !important;color:#fff !important;box-shadow:0 2px 8px rgba(18,58,134,.26)}
  button.primary:hover{background:#0f337a !important}
  table th{color:var(--cp-ink3) !important}
  table th,table td{border-bottom:1px solid var(--cp-line2) !important}
  .pill{border-radius:999px !important}

  /* footer */
  .cp-foot{
    max-width:1120px;margin:0 auto;padding:26px 22px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;
    color:var(--cp-ink3);font-size:12.5px;
  }
  .cp-foot a{color:var(--cp-ink2);text-decoration:none}
  .cp-foot a:hover{color:var(--cp-brand)}
  .cp-foot b{color:var(--cp-ink2);font-weight:800}
  `;
  var s = document.createElement("style");
  s.id = "cp-ds";
  s.textContent = CSS;
  document.head.appendChild(s);

  /* ---------------- 2. Header build (after /api/me) ---------------- */
  function initials(name, email) {
    var n = (name || "").trim();
    if (n) {
      var p = n.split(/\s+/);
      return ((p[0][0] || "") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
    }
    return (email || "?").slice(0, 2).toUpperCase();
  }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function link(href, label, active) {
    var a = el("a", active ? "active" : "");
    a.href = href; a.textContent = label;
    return a;
  }

  function apply(d) {
    var path = location.pathname.replace(/\/$/, "") || "/";
    var bar = document.querySelector(".topbar-in");
    if (!bar) return;
    var store = (d && d.store) || {};
    var user = (d && d.user) || {};
    var feat = store.features || { story: true, warranty: true };
    /* Appeals split from warranty (tiers): older payloads without the flag fall back to warranty. */
    var appeals = (feat.appeals === undefined) ? !!feat.warranty : !!feat.appeals;
    var isOwner = user.role === "owner";

    var home = feat.warranty ? "/" : (feat.story ? "/story" : "/account");

    /* brand: the customer's own logo, name as fallback */
    var brand = el("a", "cp-brand");
    brand.href = home;
    var word = el("span", "cp-word", (store.name || "ClaimProof"));
    if (store.logoUrl) {
      var img = el("img", "cp-logo");
      img.alt = store.name || "";
      img.onerror = function () { img.remove(); brand.appendChild(word); };
      img.src = store.logoUrl;
      brand.appendChild(img);
    } else {
      brand.appendChild(word);
    }

    /* primary nav */
    var nav = el("nav", "cp-nav");
    if (feat.warranty) nav.appendChild(link("/", "Reviewer", path === "/"));
    if (feat.story) nav.appendChild(link("/story", "Story", path === "/story"));
    if (appeals) nav.appendChild(link("/appeal", "Appeals", path === "/appeal"));
    if (feat.warranty) nav.appendChild(link("/chat", "Assistant", path === "/chat"));
    nav.appendChild(link("/history", "History", path === "/history"));

    /* More menu */
    var moreItems = [];
    if (feat.warranty || feat.story) moreItems.push(["/reports", "📊", "Reports"]);
    if (feat.warranty) moreItems.push(["/insights", "💡", "Insights"]);
    moreItems.push(["/resources", "📚", "Resources"]);
    moreItems.push(["__sep__", "", ""]);
    moreItems.push(["/status", "📶", "Service status"]);
    moreItems.push(["/support", "❔", "Help & support"]);
    var moreActive = ["/reports", "/insights", "/resources", "/status", "/support"].indexOf(path) >= 0;
    var moreMenu = el("div", "cp-menu");
    var moreBtn = el("button", "cp-navbtn" + (moreActive ? " active" : ""), 'More <span class="chev"></span>');
    if (moreActive) moreBtn.classList.add("active");
    var morePop = el("div", "cp-pop");
    moreItems.forEach(function (it) {
      if (it[0] === "__sep__") { morePop.appendChild(el("div", "sep")); return; }
      var a = el("a", "", '<span class="g">' + it[1] + "</span> " + it[2]);
      a.href = it[0];
      morePop.appendChild(a);
    });
    moreBtn.onclick = function (e) { e.stopPropagation(); toggle(morePop); };
    moreMenu.appendChild(moreBtn); moreMenu.appendChild(morePop);
    nav.appendChild(moreMenu);

    /* right side: status pill + profile */
    var right = el("div", "cp-right");
    var status = el("a", "cp-status ok", '<span class="dot"></span><span class="txt">Checking…</span>');
    status.href = "/status";
    right.appendChild(status);

    var prof = el("div", "cp-menu cp-profile");
    var av = el("button", "cp-av", '<span class="circ">' + initials(user.name, user.email) + '</span><span class="chev"></span>');
    var profPop = el("div", "cp-pop r");
    var who = el("div", "who");
    who.innerHTML = "<b>" + esc(user.name || user.email || "Signed in") + "</b><span>" +
      esc((isOwner ? "Owner" : (user.role || "User")) + (store.name ? " · " + store.name : "")) + "</span>";
    profPop.appendChild(who);
    var acct = el("a", "", '<span class="g">👤</span> Account'); acct.href = "/account"; profPop.appendChild(acct);
    if (isOwner) { var con = el("a", "", '<span class="g">⚙️</span> Owner console'); con.href = "/console"; profPop.appendChild(con); }
    profPop.appendChild(el("div", "sep"));
    var out = el("button", "danger", '<span class="g">↪</span> Sign out'); out.onclick = function () { location.href = "/logout"; };
    profPop.appendChild(out);
    av.onclick = function (e) { e.stopPropagation(); toggle(profPop); };
    prof.appendChild(av); prof.appendChild(profPop);
    right.appendChild(prof);

    bar.innerHTML = "";
    bar.appendChild(brand);
    bar.appendChild(nav);
    bar.appendChild(right);

    /* live status pill */
    fetch("/api/status").then(function (r) { return r.ok ? r.json() : null; }).then(function (st) {
      if (!st) { setStatus(status, "ok", "Online"); return; }
      var o = st.overall;
      if (o === "operational") setStatus(status, "ok", "All systems go");
      else if (o === "outage") setStatus(status, "down", "Service issue");
      else setStatus(status, "warn", "Partial slowdown");
    }).catch(function () { setStatus(status, "ok", "Online"); });

    /* page title tweak: drop "Whiteface Ford" if a page hard-coded it */
    try {
      if (document.title) document.title = document.title.replace(/Whiteface Ford/gi, store.name || "ClaimProof");
    } catch (e) {}

    /* footer */
    if (!document.querySelector(".cp-foot")) {
      var f = el("footer", "cp-foot");
      f.innerHTML = '<span>Powered by <b>ClaimProof</b></span>' +
        '<span><a href="/status">Service status</a> &nbsp;·&nbsp; <a href="/support">Help</a></span>';
      document.body.appendChild(f);
    }
  }

  function setStatus(node, cls, text) {
    node.className = "cp-status " + cls;
    node.innerHTML = '<span class="dot"></span><span class="txt">' + text + "</span>";
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function toggle(pop) {
    var isOpen = pop.classList.contains("open");
    document.querySelectorAll(".cp-pop.open").forEach(function (p) { p.classList.remove("open"); });
    if (!isOpen) pop.classList.add("open");
  }
  document.addEventListener("click", function (e) {
    if (!e.target.closest(".cp-menu")) document.querySelectorAll(".cp-pop.open").forEach(function (p) { p.classList.remove("open"); });
  });

  fetch("/api/me").then(function (r) { return r.ok ? r.json() : null; }).then(apply).catch(function () {});
})();
