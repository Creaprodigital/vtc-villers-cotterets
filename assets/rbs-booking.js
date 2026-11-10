/*!
 * Module de réservation RBS (Ride Booking System) — API publique
 * https://ridebookingsystem.com/docs/api
 *
 * Aucun widget ni iframe : le formulaire est rendu dans la page et appelle
 * directement les endpoints publics (CORS ouvert, pas d'authentification).
 *
 * Utilisation :
 *   <div data-rbs-booking></div>
 *   <script src="assets/rbs-booking.js" defer></script>
 *
 * Attributs optionnels sur le conteneur :
 *   data-tenant-id="…"   (par défaut : TENANT_ID ci-dessous)
 *   data-api-base="…"    (par défaut : https://ridebookingsystem.com/api)
 */
(function () {
  "use strict";

  var DEFAULT_API_BASE = "https://ridebookingsystem.com/api";
  var DEFAULT_TENANT_ID = "c24716e1-b673-4360-af88-f307a64e5947";

  var PAYMENT_LABELS = {
    cash_onboard: "Espèces à bord",
    card_onboard: "Carte bancaire à bord",
    card_online: "Carte bancaire en ligne (paiement sécurisé)",
  };
  var TRIP_LABELS = {
    one_way: "Aller simple",
    round_trip: "Aller-retour",
    hourly: "Mise à disposition",
  };

  /* ------------------------------------------------------------------ */
  /* Utilitaires                                                         */
  /* ------------------------------------------------------------------ */

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === "class") node.className = v;
        else if (k === "text") node.textContent = v;
        else if (k.slice(0, 2) === "on") node.addEventListener(k.slice(2), v);
        else if (v === true) node.setAttribute(k, "");
        else node.setAttribute(k, v);
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, ms);
    };
  }

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  // "YYYY-MM-DDTHH:MM" en heure locale (format attendu par l'API et datetime-local)
  function toLocalInput(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function formatPrice(v, currency) {
    if (typeof v !== "number" || isNaN(v)) return "—";
    try {
      return new Intl.NumberFormat("fr-FR", { style: "currency", currency: currency || "EUR" }).format(v);
    } catch (e) {
      return v.toFixed(2) + " €";
    }
  }

  function formatDateTime(s) {
    if (!s) return "";
    var d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return d.toLocaleString("fr-FR", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  }

  // Transforme une erreur FastAPI/Pydantic en message lisible
  function errorMessage(data, status) {
    if (data && data.detail) {
      if (typeof data.detail === "string") return data.detail;
      if (Array.isArray(data.detail)) {
        return data.detail.map(function (d) {
          var field = (d.loc || []).filter(function (x) { return x !== "body"; }).join(".");
          return (field ? field + " : " : "") + (d.msg || "valeur invalide");
        }).join(" · ");
      }
    }
    if (data && data.message) return data.message;
    return "Erreur " + (status || "réseau") + ". Merci de réessayer.";
  }

  /* ------------------------------------------------------------------ */
  /* Client API                                                          */
  /* ------------------------------------------------------------------ */

  function Api(base, tenantId) {
    this.base = base.replace(/\/+$/, "");
    this.origin = this.base.replace(/\/api$/, "");
    this.tenantId = tenantId;
  }

  Api.prototype.request = function (method, path, body, signal) {
    var opts = { method: method, headers: { Accept: "application/json" }, signal: signal };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    return fetch(this.base + path, opts).then(function (res) {
      return res.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = { detail: txt }; }
        if (!res.ok) {
          var err = new Error(errorMessage(data, res.status));
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  };

  Api.prototype.config = function () {
    return this.request("GET", "/public/widget/" + encodeURIComponent(this.tenantId));
  };
  Api.prototype.autocomplete = function (q, signal) {
    return this.request("GET", "/public/maps/autocomplete?q=" + encodeURIComponent(q) +
      "&tenant_id=" + encodeURIComponent(this.tenantId), undefined, signal);
  };
  Api.prototype.placeDetails = function (placeId) {
    return this.request("GET", "/public/maps/place-details?place_id=" + encodeURIComponent(placeId) +
      "&tenant_id=" + encodeURIComponent(this.tenantId));
  };
  Api.prototype.quoteAll = function (payload, signal) {
    return this.request("POST", "/public/quote-all-categories", payload, signal);
  };
  Api.prototype.booking = function (payload) {
    return this.request("POST", "/public/booking", payload);
  };
  Api.prototype.checkout = function (bookingId) {
    return this.request("POST", "/public/payment/checkout", {
      booking_id: bookingId,
      provider: "stripe",
      origin_url: window.location.origin,
    });
  };

  /* ------------------------------------------------------------------ */
  /* Champ adresse avec autocomplétion (proxy Google Places RBS)         */
  /* ------------------------------------------------------------------ */

  var acCounter = 0;

  function AddressField(api, opts) {
    var self = this;
    this.api = api;
    this.value = { address: "", lat: null, lng: null };
    this.onChange = opts.onChange || function () {};
    this.items = [];
    this.active = -1;
    this.controller = null;

    var listId = "rbs-ac-" + (++acCounter);
    this.input = el("input", {
      type: "text", id: opts.id, name: opts.name, class: "rbs-input",
      placeholder: opts.placeholder, autocomplete: "off", required: true,
      role: "combobox", "aria-autocomplete": "list", "aria-expanded": "false", "aria-controls": listId,
    });
    this.list = el("ul", { class: "rbs-ac-list", id: listId, role: "listbox", hidden: true });
    this.root = el("div", { class: "rbs-ac" }, [this.input, this.list]);

    var search = debounce(function () { self.search(); }, 250);
    this.input.addEventListener("input", function () {
      self.value = { address: self.input.value.trim(), lat: null, lng: null };
      self.onChange(self.value);
      search();
    });
    this.input.addEventListener("keydown", function (e) { self.onKey(e); });
    this.input.addEventListener("blur", function () { setTimeout(function () { self.close(); }, 150); });
  }

  AddressField.prototype.search = function () {
    var self = this;
    var q = this.input.value.trim();
    if (this.controller) this.controller.abort();
    if (q.length < 3) { this.close(); return; }
    this.controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    this.api.autocomplete(q, this.controller && this.controller.signal).then(function (data) {
      self.items = (data && data.items) || [];
      self.render();
    }).catch(function (e) {
      if (e.name !== "AbortError") self.close();
    });
  };

  AddressField.prototype.render = function () {
    var self = this;
    this.list.innerHTML = "";
    this.active = -1;
    if (!this.items.length) { this.close(); return; }
    this.items.forEach(function (it, i) {
      var li = el("li", { role: "option", class: "rbs-ac-item", id: self.list.id + "-" + i }, [
        el("span", { class: "rbs-ac-main", text: it.main || it.label }),
        it.secondary ? el("span", { class: "rbs-ac-sec", text: it.secondary }) : null,
      ]);
      li.addEventListener("mousedown", function (e) { e.preventDefault(); self.select(i); });
      self.list.appendChild(li);
    });
    this.list.hidden = false;
    this.input.setAttribute("aria-expanded", "true");
  };

  AddressField.prototype.close = function () {
    this.list.hidden = true;
    this.input.setAttribute("aria-expanded", "false");
    this.input.removeAttribute("aria-activedescendant");
  };

  AddressField.prototype.onKey = function (e) {
    if (this.list.hidden) return;
    var n = this.items.length;
    if (e.key === "ArrowDown") { e.preventDefault(); this.highlight((this.active + 1) % n); }
    else if (e.key === "ArrowUp") { e.preventDefault(); this.highlight((this.active - 1 + n) % n); }
    else if (e.key === "Enter" && this.active >= 0) { e.preventDefault(); this.select(this.active); }
    else if (e.key === "Escape") { this.close(); }
  };

  AddressField.prototype.highlight = function (i) {
    var nodes = this.list.children;
    for (var k = 0; k < nodes.length; k++) nodes[k].classList.toggle("is-active", k === i);
    this.active = i;
    if (nodes[i]) {
      this.input.setAttribute("aria-activedescendant", nodes[i].id);
      nodes[i].scrollIntoView({ block: "nearest" });
    }
  };

  AddressField.prototype.select = function (i) {
    var self = this;
    var it = this.items[i];
    if (!it) return;
    this.input.value = it.label;
    this.value = { address: it.label, lat: it.lat, lng: it.lng };
    this.close();
    this.onChange(this.value);
    if ((it.lat === null || it.lat === undefined) && it.place_id) {
      this.api.placeDetails(it.place_id).then(function (d) {
        if (d && d.found && self.value.address === it.label) {
          self.value = { address: it.label, lat: d.lat, lng: d.lng };
          self.onChange(self.value);
        }
      }).catch(function () { /* l'API sait géocoder l'adresse texte */ });
    }
  };

  /* ------------------------------------------------------------------ */
  /* Module de réservation                                               */
  /* ------------------------------------------------------------------ */

  function BookingModule(root) {
    this.root = root;
    this.api = new Api(root.getAttribute("data-api-base") || DEFAULT_API_BASE,
      root.getAttribute("data-tenant-id") || DEFAULT_TENANT_ID);
    this.cfg = null;
    this.state = {
      trip_type: "one_way",
      pickup: { address: "", lat: null, lng: null },
      dropoff: { address: "", lat: null, lng: null },
      pickup_at: "",
      return_at: "",
      duration_hours: 2,
      vehicle_type: "",
      options: [],
      quotes: {},
      quoteError: "",
      quoting: false,
      payment_method: "",
      submitting: false,
    };
    this.quoteSeq = 0;
    this.quoteController = null;
    this.refreshQuotes = debounce(this.fetchQuotes.bind(this), 400);
    this.init();
  }

  BookingModule.prototype.init = function () {
    var self = this;
    this.root.classList.add("rbs");
    this.root.innerHTML = "";
    this.root.appendChild(el("div", { class: "rbs-loading", role: "status" }, [
      el("span", { class: "rbs-spinner", "aria-hidden": "true" }), "Chargement du module de réservation…",
    ]));
    this.api.config().then(function (cfg) {
      self.cfg = cfg;
      self.applyTheme();
      self.render();
    }).catch(function (e) {
      self.root.innerHTML = "";
      self.root.appendChild(el("div", { class: "rbs-alert rbs-alert--error", role: "alert" }, [
        "Le module de réservation est momentanément indisponible. ", e.message || "",
      ]));
    });
  };

  BookingModule.prototype.applyTheme = function () {
    var color = this.cfg && this.cfg.config && this.cfg.config.primary_color;
    if (color && !this.root.style.getPropertyValue("--rbs-primary")) {
      this.root.style.setProperty("--rbs-primary", color);
    }
  };

  BookingModule.prototype.categories = function () {
    return ((this.cfg && this.cfg.vehicle_categories) || [])
      .filter(function (c) { return c.active !== false; })
      .sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
  };

  BookingModule.prototype.selectedCategory = function () {
    var id = this.state.vehicle_type;
    return this.categories().filter(function (c) { return c.id === id; })[0] || null;
  };

  BookingModule.prototype.enabledTripTypes = function () {
    var conf = (this.cfg && this.cfg.trip_types_config) || {};
    var types = ["one_way", "round_trip", "hourly"].filter(function (t) {
      return conf[t] ? conf[t].enabled !== false : t === "one_way";
    });
    return types.length ? types : ["one_way"];
  };

  /* ---------------------------- Rendu ------------------------------- */

  BookingModule.prototype.render = function () {
    var self = this;
    var cfg = this.cfg;
    var conf = cfg.config || {};
    this.root.innerHTML = "";

    var header = el("div", { class: "rbs-head" }, [
      el("h2", { class: "rbs-title", text: conf.title || "Réservez votre course" }),
      conf.subtitle ? el("p", { class: "rbs-subtitle", text: conf.subtitle }) : null,
    ]);
    this.root.appendChild(header);

    if (cfg.booking_pause && cfg.booking_pause.closed) {
      this.root.appendChild(el("div", { class: "rbs-alert rbs-alert--warn", role: "alert",
        text: cfg.booking_pause.message || "Les réservations en ligne sont temporairement suspendues." }));
      return;
    }

    var form = el("form", { class: "rbs-form", novalidate: true });
    this.form = form;

    form.appendChild(this.renderTripSection());
    form.appendChild(this.renderVehicleSection());
    if ((cfg.service_options || []).some(function (o) { return o.active !== false; })) {
      form.appendChild(this.renderOptionsSection());
    }
    form.appendChild(this.renderContactSection());
    form.appendChild(this.renderPaymentSection());

    this.summary = el("div", { class: "rbs-summary", "aria-live": "polite" });
    this.errorBox = el("div", { class: "rbs-alert rbs-alert--error", role: "alert", hidden: true });
    this.submitBtn = el("button", { type: "submit", class: "rbs-btn rbs-btn--primary rbs-submit",
      text: conf.button_text || "Réserver maintenant" });

    form.appendChild(el("div", { class: "rbs-footer" }, [this.summary, this.errorBox, this.submitBtn]));
    form.addEventListener("submit", function (e) { e.preventDefault(); self.submit(); });

    this.root.appendChild(form);
    this.updateTripType();
    this.updateSummary();
  };

  function section(num, title, children) {
    return el("fieldset", { class: "rbs-section" }, [
      el("legend", { class: "rbs-legend" }, [el("span", { class: "rbs-step", text: String(num) }), title]),
    ].concat(children));
  }

  function field(label, input, opts) {
    opts = opts || {};
    return el("div", { class: "rbs-field" + (opts.wide ? " rbs-field--wide" : ""), "data-field": opts.key || null }, [
      el("label", { class: "rbs-label", for: input.id || null, text: label }),
      input,
      opts.hint ? el("small", { class: "rbs-hint", text: opts.hint }) : null,
    ]);
  }

  BookingModule.prototype.renderTripSection = function () {
    var self = this;
    var s = this.state;
    var types = this.enabledTripTypes();
    s.trip_type = types.indexOf(s.trip_type) >= 0 ? s.trip_type : types[0];

    var tabs = null;
    if (types.length > 1) {
      tabs = el("div", { class: "rbs-tabs", role: "radiogroup", "aria-label": "Type de trajet" });
      types.forEach(function (t) {
        var id = "rbs-trip-" + t;
        tabs.appendChild(el("input", { type: "radio", name: "trip_type", id: id, value: t, class: "rbs-tab-input",
          checked: s.trip_type === t, onchange: function () { s.trip_type = t; self.updateTripType(); self.refreshQuotes(); } }));
        tabs.appendChild(el("label", { for: id, class: "rbs-tab", text: TRIP_LABELS[t] || t }));
      });
    }

    this.pickupField = new AddressField(this.api, {
      id: "rbs-pickup", name: "pickup_address", placeholder: "Adresse, gare, aéroport…",
      onChange: function (v) { s.pickup = v; self.refreshQuotes(); },
    });
    this.dropoffField = new AddressField(this.api, {
      id: "rbs-dropoff", name: "dropoff_address", placeholder: "Adresse, gare, aéroport…",
      onChange: function (v) { s.dropoff = v; self.refreshQuotes(); },
    });

    var now = new Date(Date.now() + 60 * 60 * 1000);
    now.setMinutes(Math.ceil(now.getMinutes() / 5) * 5, 0, 0);
    s.pickup_at = s.pickup_at || toLocalInput(now);

    this.pickupAtInput = el("input", { type: "datetime-local", id: "rbs-pickup-at", class: "rbs-input", required: true,
      value: s.pickup_at, min: toLocalInput(new Date()), step: 300,
      onchange: function (e) { s.pickup_at = e.target.value; self.returnAtInput.min = s.pickup_at; self.refreshQuotes(); } });
    this.returnAtInput = el("input", { type: "datetime-local", id: "rbs-return-at", class: "rbs-input",
      value: s.return_at, min: s.pickup_at, step: 300,
      onchange: function (e) { s.return_at = e.target.value; self.refreshQuotes(); } });

    var hourly = (this.cfg.trip_types_config || {}).hourly || {};
    this.durationInput = el("input", { type: "number", id: "rbs-duration", class: "rbs-input",
      min: hourly.min_hours || 1, max: hourly.max_hours || 12, step: 0.5, value: Math.max(s.duration_hours, hourly.min_hours || 1),
      onchange: function (e) { s.duration_hours = Number(e.target.value) || 0; self.refreshQuotes(); } });
    s.duration_hours = Number(this.durationInput.value);

    var swap = el("button", { type: "button", class: "rbs-swap", title: "Inverser départ et arrivée", "aria-label": "Inverser départ et arrivée",
      text: "⇅", onclick: function () {
        var a = s.pickup, b = s.dropoff;
        self.pickupField.value = b; self.pickupField.input.value = b.address; s.pickup = b;
        self.dropoffField.value = a; self.dropoffField.input.value = a.address; s.dropoff = a;
        self.refreshQuotes();
      } });

    return section(1, "Votre trajet", [
      tabs,
      el("div", { class: "rbs-grid" }, [
        field("Départ", this.pickupField.root, { wide: true }),
        el("div", { class: "rbs-swap-wrap rbs-field--wide", "data-field": "dropoff" }, [swap]),
        field("Arrivée", this.dropoffField.root, { wide: true, key: "dropoff" }),
        field("Date et heure de prise en charge", this.pickupAtInput),
        field("Date et heure du retour", this.returnAtInput, { key: "return_at" }),
        field("Durée (heures)", this.durationInput, { key: "duration",
          hint: "Entre " + (hourly.min_hours || 1) + " h et " + (hourly.max_hours || 12) + " h" }),
      ]),
    ]);
  };

  BookingModule.prototype.updateTripType = function () {
    var t = this.state.trip_type;
    var show = function (key, on) {
      var nodes = this.form.querySelectorAll('[data-field="' + key + '"]');
      for (var i = 0; i < nodes.length; i++) nodes[i].hidden = !on;
    }.bind(this);
    show("return_at", t === "round_trip");
    show("duration", t === "hourly");
    show("dropoff", t !== "hourly");
    this.returnAtInput.required = t === "round_trip";
    this.dropoffField.input.required = t !== "hourly";
  };

  BookingModule.prototype.renderVehicleSection = function () {
    var self = this;
    var s = this.state;
    var cats = this.categories();
    if (!s.vehicle_type && cats.length) s.vehicle_type = cats[0].id;

    this.vehicleList = el("div", { class: "rbs-vehicles", role: "radiogroup", "aria-label": "Catégorie de véhicule" });
    cats.forEach(function (c) {
      var id = "rbs-cat-" + c.id;
      var img = c.image_url ? el("img", { src: /^https?:/.test(c.image_url) ? c.image_url : self.api.origin + c.image_url,
        alt: "", loading: "lazy", class: "rbs-vehicle-img" }) : null;
      var input = el("input", { type: "radio", name: "vehicle_type", id: id, value: c.id, class: "rbs-vehicle-input",
        checked: s.vehicle_type === c.id, onchange: function () { s.vehicle_type = c.id; self.applyCapacity(); self.updateSummary(); } });
      var card = el("label", { for: id, class: "rbs-vehicle" }, [
        img,
        el("span", { class: "rbs-vehicle-body" }, [
          el("span", { class: "rbs-vehicle-name", text: c.label }),
          c.description ? el("span", { class: "rbs-vehicle-desc", text: c.description }) : null,
          el("span", { class: "rbs-vehicle-cap" }, [
            el("span", { text: "👤 " + (c.max_seats != null ? c.max_seats : "—") + " passagers max" }),
            el("span", { text: "🧳 " + (c.max_luggage != null ? c.max_luggage : "—") + " bagages max" }),
          ]),
        ]),
        el("span", { class: "rbs-vehicle-price", "data-price-for": c.id, text: "—" }),
      ]);
      self.vehicleList.appendChild(el("div", { class: "rbs-vehicle-wrap" }, [input, card]));
    });

    this.paxInput = el("input", { type: "number", id: "rbs-pax", class: "rbs-input", min: 1, value: 1, required: true,
      onchange: function () { self.applyCapacity(); } });
    this.bagsInput = el("input", { type: "number", id: "rbs-bags", class: "rbs-input", min: 0, value: 0,
      onchange: function () { self.applyCapacity(); } });

    this.quoteStatus = el("p", { class: "rbs-quote-status", "aria-live": "polite",
      text: "Renseignez votre trajet pour afficher les prix." });

    var sec = section(2, "Véhicule et passagers", [
      this.vehicleList,
      this.quoteStatus,
      el("div", { class: "rbs-grid" }, [
        field("Passagers", this.paxInput),
        field("Bagages", this.bagsInput),
      ]),
    ]);
    setTimeout(function () { self.applyCapacity(); }, 0);
    return sec;
  };

  // Borne passagers/bagages selon la capacité de la catégorie choisie
  BookingModule.prototype.applyCapacity = function () {
    var c = this.selectedCategory();
    if (!c || !this.paxInput) return;
    if (c.max_seats) {
      this.paxInput.max = c.max_seats;
      if (Number(this.paxInput.value) > c.max_seats) this.paxInput.value = c.max_seats;
    }
    if (c.max_luggage != null) {
      this.bagsInput.max = c.max_luggage;
      if (Number(this.bagsInput.value) > c.max_luggage) this.bagsInput.value = c.max_luggage;
    }
    if (Number(this.paxInput.value) < 1) this.paxInput.value = 1;
    if (Number(this.bagsInput.value) < 0) this.bagsInput.value = 0;
  };

  BookingModule.prototype.renderOptionsSection = function () {
    var self = this;
    var s = this.state;
    var list = el("div", { class: "rbs-options" });
    (this.cfg.service_options || []).filter(function (o) { return o.active !== false; })
      .sort(function (a, b) { return (a.order || 0) - (b.order || 0); })
      .forEach(function (o) {
        var id = "rbs-opt-" + o.id;
        list.appendChild(el("label", { class: "rbs-option", for: id }, [
          el("input", { type: "checkbox", id: id, value: o.id, onchange: function (e) {
            if (e.target.checked) s.options.push(o.id);
            else s.options = s.options.filter(function (x) { return x !== o.id; });
            self.refreshQuotes();
          } }),
          el("span", { class: "rbs-option-body" }, [
            el("span", { class: "rbs-option-name", text: o.label }),
            o.description ? el("span", { class: "rbs-option-desc", text: o.description }) : null,
          ]),
          el("span", { class: "rbs-option-price", text: o.price ? "+ " + formatPrice(o.price) : "Offert" }),
        ]));
      });
    return section(3, "Options", [list]);
  };

  BookingModule.prototype.renderContactSection = function () {
    var num = this.form.querySelectorAll(".rbs-section").length + 1;
    function input(name, type, label, attrs) {
      var i = el("input", Object.assign({ type: type, id: "rbs-" + name, name: name, class: "rbs-input" }, attrs || {}));
      return field(label, i);
    }
    return section(num, "Vos coordonnées", [
      el("div", { class: "rbs-grid" }, [
        input("first_name", "text", "Prénom", { required: true, autocomplete: "given-name" }),
        input("last_name", "text", "Nom", { required: true, autocomplete: "family-name" }),
        input("email", "email", "Email", { required: true, autocomplete: "email" }),
        input("phone", "tel", "Téléphone", { required: true, autocomplete: "tel", placeholder: "+33 6 12 34 56 78" }),
        input("flight_number", "text", "N° de vol (facultatif)", { placeholder: "ex. AF1234" }),
        input("train_number", "text", "N° de train (facultatif)", { placeholder: "ex. TER 847123" }),
        field("Informations complémentaires (facultatif)", el("textarea", { id: "rbs-other_info", name: "other_info",
          class: "rbs-input", rows: 3, placeholder: "Siège bébé, adresse précise, code d'accès…" }), { wide: true }),
      ]),
    ]);
  };

  BookingModule.prototype.renderPaymentSection = function () {
    var self = this;
    var s = this.state;
    var methods = (this.cfg.payment_methods && this.cfg.payment_methods.length) ? this.cfg.payment_methods : ["cash_onboard"];
    s.payment_method = methods[0];
    var num = this.form.querySelectorAll(".rbs-section").length + 1;
    var list = el("div", { class: "rbs-payments", role: "radiogroup", "aria-label": "Mode de paiement" });
    methods.forEach(function (m, i) {
      var id = "rbs-pay-" + m;
      list.appendChild(el("label", { class: "rbs-payment", for: id }, [
        el("input", { type: "radio", name: "payment_method", id: id, value: m, checked: i === 0,
          onchange: function () { s.payment_method = m; self.updateSummary(); } }),
        el("span", { text: PAYMENT_LABELS[m] || m.replace(/_/g, " ") }),
      ]));
    });
    this.promoInput = el("input", { type: "text", id: "rbs-promo", class: "rbs-input", placeholder: "Code promo (facultatif)",
      onchange: function () { self.refreshQuotes(); } });
    return section(num, "Paiement", [
      list,
      el("div", { class: "rbs-grid" }, [field("Code promo", this.promoInput)]),
    ]);
  };

  /* ---------------------------- Devis ------------------------------- */

  BookingModule.prototype.tripPayload = function () {
    var s = this.state;
    var hourly = s.trip_type === "hourly";
    var p = {
      tenant_id: this.api.tenantId,
      trip_type: s.trip_type,
      pickup_address: s.pickup.address,
      pickup_lat: s.pickup.lat,
      pickup_lng: s.pickup.lng,
      dropoff_address: hourly ? (s.dropoff.address || s.pickup.address) : s.dropoff.address,
      dropoff_lat: hourly ? (s.dropoff.lat != null ? s.dropoff.lat : s.pickup.lat) : s.dropoff.lat,
      dropoff_lng: hourly ? (s.dropoff.lng != null ? s.dropoff.lng : s.pickup.lng) : s.dropoff.lng,
      pickup_at: s.pickup_at,
      return_at: s.trip_type === "round_trip" && s.return_at ? s.return_at : null,
      duration_hours: hourly ? Number(s.duration_hours) || 0 : 0,
      promo_code: (this.promoInput && this.promoInput.value.trim()) || null,
      service_option_ids: s.options.slice(),
    };
    return p;
  };

  BookingModule.prototype.canQuote = function () {
    var s = this.state;
    if (!s.pickup.address || !s.pickup_at) return false;
    if (s.trip_type !== "hourly" && !s.dropoff.address) return false;
    if (s.trip_type === "round_trip" && !s.return_at) return false;
    return true;
  };

  BookingModule.prototype.fetchQuotes = function () {
    var self = this;
    var s = this.state;
    if (!this.canQuote()) {
      s.quotes = {}; s.quoteError = "";
      this.quoteStatus.textContent = "Renseignez votre trajet pour afficher les prix.";
      this.renderPrices();
      return;
    }
    if (this.quoteController) this.quoteController.abort();
    this.quoteController = typeof AbortController !== "undefined" ? new AbortController() : null;
    var seq = ++this.quoteSeq;
    s.quoting = true;
    this.quoteStatus.textContent = "Calcul du prix en cours…";
    this.root.classList.add("is-quoting");

    this.api.quoteAll(this.tripPayload(), this.quoteController && this.quoteController.signal).then(function (data) {
      if (seq !== self.quoteSeq) return;
      var map = {};
      ((data && data.items) || []).forEach(function (it) { map[it.category_id] = it; });
      s.quotes = map;
      s.quoteError = (data && data.promo_error) || "";
      var first = (data && data.items && data.items[0]) || null;
      self.quoteStatus.textContent = first
        ? "Distance estimée : " + (first.distance_km != null ? first.distance_km.toFixed(1) + " km" : "—") +
          (first.duration_min != null ? " · environ " + Math.round(first.duration_min) + " min" : "") +
          (s.quoteError ? " · Code promo : " + s.quoteError : "")
        : "Aucun tarif disponible pour ce trajet.";
    }).catch(function (e) {
      if (e.name === "AbortError" || seq !== self.quoteSeq) return;
      s.quotes = {};
      self.quoteStatus.textContent = "Impossible de calculer le prix : " + e.message;
    }).then(function () {
      if (seq !== self.quoteSeq) return;
      s.quoting = false;
      self.root.classList.remove("is-quoting");
      self.renderPrices();
    });
  };

  BookingModule.prototype.renderPrices = function () {
    var q = this.state.quotes;
    var nodes = this.root.querySelectorAll("[data-price-for]");
    for (var i = 0; i < nodes.length; i++) {
      var it = q[nodes[i].getAttribute("data-price-for")];
      nodes[i].innerHTML = "";
      if (!it) { nodes[i].textContent = "—"; continue; }
      if (it.discount && it.total_before_promo > it.total) {
        nodes[i].appendChild(el("s", { class: "rbs-old-price", text: formatPrice(it.total_before_promo) }));
      }
      nodes[i].appendChild(el("strong", { text: formatPrice(it.total) }));
      if (it.flat_rate_applied) nodes[i].appendChild(el("small", { text: "Forfait" }));
    }
    this.updateSummary();
  };

  BookingModule.prototype.updateSummary = function () {
    if (!this.summary) return;
    var c = this.selectedCategory();
    var q = c && this.state.quotes[c.id];
    this.summary.innerHTML = "";
    if (q) {
      this.summary.appendChild(el("span", { class: "rbs-summary-label", text: "Prix estimé · " + c.label }));
      this.summary.appendChild(el("span", { class: "rbs-summary-price", text: formatPrice(q.total) }));
    } else {
      this.summary.appendChild(el("span", { class: "rbs-summary-label", text: "Le prix s'affichera dès que le trajet sera complété." }));
    }
    if (this.submitBtn) {
      var conf = this.cfg.config || {};
      this.submitBtn.textContent = this.state.payment_method === "card_online"
        ? "Réserver et payer" : (conf.button_text || "Réserver maintenant");
    }
  };

  /* -------------------------- Validation ---------------------------- */

  BookingModule.prototype.validate = function () {
    var s = this.state;
    var f = this.form;
    var errors = [];
    var val = function (n) { var i = f.querySelector('[name="' + n + '"]'); return i ? i.value.trim() : ""; };

    if (!s.pickup.address) errors.push("Indiquez l'adresse de départ.");
    if (s.trip_type !== "hourly" && !s.dropoff.address) errors.push("Indiquez l'adresse d'arrivée.");
    if (!s.pickup_at) errors.push("Indiquez la date et l'heure de prise en charge.");
    else if (new Date(s.pickup_at).getTime() < Date.now()) errors.push("La date de prise en charge est déjà passée.");
    if (s.trip_type === "round_trip") {
      if (!s.return_at) errors.push("Indiquez la date et l'heure du retour.");
      else if (s.return_at <= s.pickup_at) errors.push("Le retour doit être postérieur à l'aller.");
    }
    if (!s.vehicle_type) errors.push("Choisissez un véhicule.");
    var c = this.selectedCategory();
    var pax = Number(this.paxInput.value) || 0;
    var bags = Number(this.bagsInput.value) || 0;
    if (pax < 1) errors.push("Indiquez au moins 1 passager.");
    if (c && c.max_seats && pax > c.max_seats) errors.push(c.label + " : " + c.max_seats + " passagers maximum.");
    if (c && c.max_luggage != null && bags > c.max_luggage) errors.push(c.label + " : " + c.max_luggage + " bagages maximum.");
    if (!val("first_name") || !val("last_name")) errors.push("Indiquez votre prénom et votre nom.");
    if (!/^\S+@\S+\.\S+$/.test(val("email"))) errors.push("Indiquez une adresse email valide.");
    if (val("phone").replace(/[^\d]/g, "").length < 9) errors.push("Indiquez un numéro de téléphone valide.");
    return errors;
  };

  BookingModule.prototype.showError = function (msg) {
    if (!msg) { this.errorBox.hidden = true; this.errorBox.innerHTML = ""; return; }
    this.errorBox.innerHTML = "";
    if (Array.isArray(msg)) {
      this.errorBox.appendChild(el("ul", null, msg.map(function (m) { return el("li", { text: m }); })));
    } else {
      this.errorBox.textContent = msg;
    }
    this.errorBox.hidden = false;
    this.errorBox.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  /* --------------------------- Réservation -------------------------- */

  BookingModule.prototype.submit = function () {
    var self = this;
    var s = this.state;
    if (s.submitting) return;
    var errors = this.validate();
    if (errors.length) { this.showError(errors); return; }
    this.showError(null);

    var f = this.form;
    var val = function (n) { var i = f.querySelector('[name="' + n + '"]'); return i ? i.value.trim() : ""; };
    var payload = Object.assign(this.tripPayload(), {
      schedule_mode: "later",
      pax: Number(this.paxInput.value) || 1,
      bags: Number(this.bagsInput.value) || 0,
      vehicle_type: s.vehicle_type,
      payment_method: s.payment_method,
      contact: {
        first_name: val("first_name"),
        last_name: val("last_name"),
        email: val("email"),
        phone: val("phone"),
      },
      flight_number: val("flight_number"),
      train_number: val("train_number"),
      other_info: val("other_info"),
      notes: "",
      locale: "fr",
    });

    s.submitting = true;
    this.submitBtn.disabled = true;
    this.submitBtn.textContent = "Envoi de la réservation…";

    this.api.booking(payload).then(function (res) {
      var booking = (res && res.booking) || res || {};
      if (s.payment_method === "card_online" && booking.id) {
        self.submitBtn.textContent = "Redirection vers le paiement…";
        return self.api.checkout(booking.id).then(function (co) {
          if (co && co.url) { window.location.href = co.url; return; }
          self.renderConfirmation(booking, payload,
            "Votre réservation est enregistrée, mais le paiement en ligne n'a pas pu être initié. Nous vous recontacterons.");
        });
      }
      self.renderConfirmation(booking, payload);
    }).catch(function (e) {
      self.showError(e.message || "La réservation n'a pas pu être enregistrée.");
    }).then(function () {
      s.submitting = false;
      if (self.submitBtn) { self.submitBtn.disabled = false; self.updateSummary(); }
    });
  };

  BookingModule.prototype.renderConfirmation = function (booking, payload, warning) {
    var self = this;
    var c = this.selectedCategory();
    var q = c && this.state.quotes[c.id];
    var price = (booking.pricing && booking.pricing.final) || booking.amount_total || booking.estimated_price_eur || (q && q.total);
    var ref = booking.reference || booking.booking_number || (booking.id ? String(booking.id).slice(0, 8).toUpperCase() : "");

    var rows = [
      ["Référence", ref],
      ["Trajet", TRIP_LABELS[payload.trip_type] || payload.trip_type],
      ["Départ", payload.pickup_address],
      payload.trip_type !== "hourly" ? ["Arrivée", payload.dropoff_address] : ["Durée", payload.duration_hours + " h"],
      ["Prise en charge", formatDateTime(payload.pickup_at)],
      payload.return_at ? ["Retour", formatDateTime(payload.return_at)] : null,
      ["Véhicule", c ? c.label : payload.vehicle_type],
      ["Passagers / bagages", payload.pax + " / " + payload.bags],
      ["Paiement", PAYMENT_LABELS[payload.payment_method] || payload.payment_method],
      price ? ["Prix estimé", formatPrice(Number(price))] : null,
    ].filter(Boolean);

    this.root.innerHTML = "";
    this.root.appendChild(el("div", { class: "rbs-confirm", role: "status", tabindex: "-1" }, [
      el("div", { class: "rbs-confirm-icon", "aria-hidden": "true", text: "✓" }),
      el("h2", { class: "rbs-title", text: "Réservation enregistrée" }),
      el("p", { class: "rbs-subtitle", text: "Merci " + payload.contact.first_name +
        " ! Un email de confirmation a été envoyé à " + payload.contact.email + "." }),
      warning ? el("div", { class: "rbs-alert rbs-alert--warn", text: warning }) : null,
      el("dl", { class: "rbs-recap" }, rows.reduce(function (acc, r) {
        acc.push(el("dt", { text: r[0] }), el("dd", { text: r[1] }));
        return acc;
      }, [])),
      el("button", { type: "button", class: "rbs-btn", text: "Faire une nouvelle réservation",
        onclick: function () {
          self.state.vehicle_type = ""; self.state.options = []; self.state.quotes = {};
          self.state.pickup = { address: "", lat: null, lng: null };
          self.state.dropoff = { address: "", lat: null, lng: null };
          self.state.pickup_at = ""; self.state.return_at = "";
          self.render();
        } }),
    ]));
    var box = this.root.querySelector(".rbs-confirm");
    box.scrollIntoView({ behavior: "smooth", block: "start" });
    box.focus({ preventScroll: true });
  };

  /* ------------------------------------------------------------------ */
  /* Montage                                                             */
  /* ------------------------------------------------------------------ */

  function mountAll() {
    var nodes = document.querySelectorAll("[data-rbs-booking]");
    for (var i = 0; i < nodes.length; i++) {
      if (!nodes[i].__rbs) nodes[i].__rbs = new BookingModule(nodes[i]);
    }
  }

  window.RBSBooking = { mount: function (node) { return node.__rbs || (node.__rbs = new BookingModule(node)); }, Api: Api };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountAll);
  else mountAll();
})();
