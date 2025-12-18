// ==UserScript==
// @name         Odoo - Disable Barcode Apply Button
// @namespace    batstyles
// @version      0.1.0
// @description  Hide the barcode "Apply" button in Odoo barcode client action.
// @match        *://odoo.camptocamp.ch/*
// @match        *://*.odoo.camptocamp.ch/*
// @run-at       document-start
// @grant        GM_addStyle
// ==/UserScript==

(() => {
  "use strict";

  const css = `
    .o_barcode_client_action .o_apply_page {
      display: none !important;
    }
  `;

  // Tampermonkey provides GM_addStyle; fallback covers other userscript engines.
  if (typeof GM_addStyle === "function") {
    GM_addStyle(css);
    return;
  }

  const style = document.createElement("style");
  style.type = "text/css";
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);
})();


