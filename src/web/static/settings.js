// Settings page: keep the "not restricted" note honest while the allow-all checkbox is toggled (the saved state is what the server rendered).
const all = document.getElementById("review_all_projects");
const note = document.getElementById("review_projects_unrestricted");
const saved = !!note && !note.hidden;
const sync = () => {
  if (!all || !note) return;
  note.hidden = !all.checked && !saved;
  if (all.checked) note.textContent = saved ? "目前不限制：「允許所有被指派的 MR」已開啟，下列清單暫時不生效（內容保留）。" : "「允許所有被指派的 MR」已勾選，儲存後下列清單將暫時不生效（內容保留）。";
  else if (saved) note.textContent = "已取消勾選，儲存後才會恢復限制；目前仍不限制。";
};
all?.addEventListener("change", sync);
sync();
