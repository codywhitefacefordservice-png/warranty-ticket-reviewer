/* Shared "Decode VIN" widget. Auto-wires every element marked
   data-vin-decode="<inputId>" (the button) with a matching
   [data-vin-status="<inputId>"] element (the status line). Optional
   data-vin-fill="<otherInputId>" auto-fills that field with the decoded
   vehicle on success. Exposes window.VIN for submit-time guards. */
(function () {
  var S = {}; // inputId -> { vin, decoded, manual, vehicle, label }
  function $(id) { return document.getElementById(id); }
  function get(id) { return S[id] || (S[id] = { vin: "", decoded: false, manual: false, vehicle: "", label: "" }); }

  window.VIN = {
    state: function (id) { return get(id); },
    vehicle: function (id) { return get(id).vehicle; },
    // A VIN is typed but has NOT been decoded or manually confirmed.
    needsDecode: function (id) {
      var el = $(id); if (!el) return false;
      var v = (el.value || "").trim();
      var s = get(id);
      return !!v && !s.decoded && !s.manual;
    }
  };

  var T = { A:1,B:2,C:3,D:4,E:5,F:6,G:7,H:8,J:1,K:2,L:3,M:4,N:5,P:7,R:9,S:2,T:3,U:4,V:5,W:6,X:7,Y:8,Z:9,"0":0,"1":1,"2":2,"3":3,"4":4,"5":5,"6":6,"7":7,"8":8,"9":9 };
  var W = [8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];
  function fmtOk(v) { return /^[A-HJ-NPR-Z0-9]{17}$/.test(v); }
  function cdOk(v) {
    if (!fmtOk(v)) return false;
    var s = 0;
    for (var i = 0; i < 17; i++) { var c = v[i]; if (!(c in T)) return false; s += T[c] * W[i]; }
    var r = s % 11; var cd = r === 10 ? "X" : String(r);
    return v[8] === cd;
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function statusEl(id) { return document.querySelector('[data-vin-status="' + id + '"]'); }
  function setStatus(id, cls, html) { var e = statusEl(id); if (!e) return; e.className = "vinst " + cls; e.innerHTML = html; }

  function reset(id) {
    var s = get(id); s.decoded = false; s.manual = false; s.vehicle = ""; s.label = "";
    setStatus(id, "idle", "● VIN not decoded — press <b>Decode VIN</b>");
  }

  function decode(id, fillId) {
    var el = $(id); if (!el) return;
    var vin = (el.value || "").trim().toUpperCase(); el.value = vin;
    var s = get(id); s.vin = vin; s.decoded = false; s.manual = false;
    if (!vin) { setStatus(id, "bad", "Enter a VIN first."); return; }
    if (!fmtOk(vin)) { setStatus(id, "bad", "✗ Not a valid 17-character VIN."); return; }
    if (!cdOk(vin)) { setStatus(id, "bad", "✗ VIN check digit failed — re-check the characters."); return; }
    setStatus(id, "load", "Decoding…");
    fetch("/api/vin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ vin: vin }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok) {
          s.decoded = true; s.manual = false; s.vehicle = d.vehicle || ""; s.label = d.label || d.vehicle || "";
          setStatus(id, "ok", "✓ " + esc(s.label));
          if (fillId) { var f = $(fillId); if (f && !f.value.trim()) f.value = s.vehicle; }
        } else if (d && d.reason === "service") {
          showOverride(id, (d && d.error) || "The VIN decoder is unavailable right now.");
        } else {
          setStatus(id, "bad", "✗ " + esc((d && d.error) || "Couldn't decode this VIN."));
        }
      })
      .catch(function () { showOverride(id, "The VIN decoder is unavailable right now."); });
  }

  // Only offered after a genuine service outage — lets work continue with a
  // manually typed vehicle rather than halting when NHTSA is down.
  function showOverride(id, msg) {
    var e = statusEl(id); if (!e) return;
    e.className = "vinst bad";
    e.innerHTML = "✗ " + esc(msg) + ' <button type="button" class="vin-ovbtn">Enter vehicle manually</button>';
    var btn = e.querySelector(".vin-ovbtn");
    btn.addEventListener("click", function () {
      e.innerHTML = '<input type="text" class="vin-ovin" placeholder="Year Make Model (manual)"> <button type="button" class="vin-ovuse">Use this</button>';
      var inp = e.querySelector(".vin-ovin"), use = e.querySelector(".vin-ovuse");
      inp.focus();
      use.addEventListener("click", function () {
        var val = (inp.value || "").trim(); if (!val) { inp.focus(); return; }
        var s = get(id); s.manual = true; s.decoded = false; s.vehicle = val; s.label = val;
        e.className = "vinst warn"; e.innerHTML = "⚠ Manual entry (decoder was down): " + esc(val);
      });
    });
  }

  function wire() {
    var btns = document.querySelectorAll("[data-vin-decode]");
    for (var i = 0; i < btns.length; i++) {
      (function (btn) {
        var id = btn.getAttribute("data-vin-decode");
        var fill = btn.getAttribute("data-vin-fill") || "";
        btn.addEventListener("click", function (e) { e.preventDefault(); decode(id, fill); });
        var el = $(id);
        if (el) el.addEventListener("input", function () { reset(id); });
        reset(id);
      })(btns[i]);
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire); else wire();
})();
