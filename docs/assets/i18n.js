/* hMail Desktop — Vietnamese/English switch
 * Giấy phép Cộng đồng hMail (xem LICENSE-HQV.md), Copyright (c) 2026 HQV Software
 *
 * Both languages ship in the markup as data-vi / data-en, so switching is
 * instant and the page still says something sensible with scripting off:
 * the Vietnamese text is what is written in the document itself.
 *
 * The choice is remembered where storage is available. On a local file the
 * page is opened from disk inside the app, where storage may be denied, so
 * every access is guarded rather than assumed.
 */

(function () {
  "use strict";

  var KEY = "hmail-lang";

  function remember(lang) {
    try {
      localStorage.setItem(KEY, lang);
    } catch (e) {}
  }

  function remembered() {
    try {
      return localStorage.getItem(KEY);
    } catch (e) {
      return null;
    }
  }

  function apply(lang) {
    var nodes = document.querySelectorAll("[data-vi]");
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var text = lang === "en" ? node.getAttribute("data-en")
                               : node.getAttribute("data-vi");
      if (text !== null) {
        node.textContent = text;
      }
    }
    document.documentElement.lang = lang;
    var buttons = document.querySelectorAll("[data-lang]");
    for (var j = 0; j < buttons.length; j++) {
      buttons[j].classList.toggle(
        "on", buttons[j].getAttribute("data-lang") === lang);
    }
    remember(lang);
  }

  function start() {
    // What the reader already asked for, else what their system suggests.
    var lang = remembered();
    if (lang !== "vi" && lang !== "en") {
      var nav = (navigator.language || "vi").toLowerCase();
      lang = nav.indexOf("vi") === 0 ? "vi" : "en";
    }
    apply(lang);

    var buttons = document.querySelectorAll("[data-lang]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener("click", function (event) {
        event.preventDefault();
        apply(this.getAttribute("data-lang"));
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
