// Presence template - minimal client behaviour. No third-party scripts.
(function () {
	"use strict";

	var yearEl = document.getElementById("year");
	if (yearEl) yearEl.textContent = String(new Date().getFullYear());

	var form = document.querySelector(".contact-form");
	var note = document.getElementById("form-note");
	if (form && note) {
		form.addEventListener("submit", function () {
			note.hidden = false;
			note.textContent =
				"Thanks. Enquiry delivery is not connected on this template yet.";
		});
	}
})();
