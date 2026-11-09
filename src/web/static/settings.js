// Settings page: allowlist quick-add and allow-all visual state. Nothing is saved until the form is submitted.
const ta = document.getElementById("review_projects");
const all = document.getElementById("review_all_projects");
const seen = document.getElementById("seen_projects");
const status = document.getElementById("review_projects_status");

// Allow-all supersedes the list: dim it (not disabled, so the list is still submitted and kept) and hide the quick-add block.
const sync = () => {
  if (!all) return;
  ta?.classList.toggle("is-superseded", all.checked);
  if (seen) seen.hidden = all.checked || !seen.querySelector("li"); // stays hidden once every row was added
};
all?.addEventListener("change", sync);
sync();

document.querySelectorAll("[data-add-project]").forEach((b) => {
  b.addEventListener("click", () => {
    const path = (b.getAttribute("data-add-project") || "").toLowerCase();
    if (!ta || !path) return;
    const lines = ta.value.split("\n").map((l) => l.trim().toLowerCase());
    if (!lines.includes(path)) ta.value = (ta.value.trim() ? ta.value.replace(/\s*$/, "\n") : "") + path;
    const li = b.closest("li");
    const next = (li?.nextElementSibling || li?.previousElementSibling)?.querySelector("button");
    li?.remove();
    if (next) next.focus();
    else {
      if (seen) seen.hidden = true;
      ta.focus();
    }
    if (status) status.textContent = `已加入 ${path}（尚未儲存）`;
  });
});
