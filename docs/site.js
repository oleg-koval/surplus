const weekly = document.querySelector("#weekly");
const session = document.querySelector("#session");
const weeklyOnly = document.querySelector("#weeklyOnly");
const hours = document.querySelector("#hours");
const allowed = document.querySelector("#allowed");
const fresh = document.querySelector("#fresh");
const resultPanel = document.querySelector(".result-panel");
const resultTitle = document.querySelector("#resultTitle");
const resultText = document.querySelector("#resultText");
const resultPill = document.querySelector("#resultPill");
const announcement = document.querySelector("#demoAnnouncement");
const presetButtons = [...document.querySelectorAll("[data-preset]")];

const presets = {
  room: { weekly: 40, session: 80, hours: 24, weeklyOnly: false, allowed: true, fresh: true },
  reserve: { weekly: 18, session: 80, hours: 24, weeklyOnly: false, allowed: true, fresh: true },
  days: { weekly: 29, session: 80, hours: 108, weeklyOnly: false, allowed: true, fresh: true },
};

function updatePolicy({ announceChange = false } = {}) {
  const weeklyPercent = Number(weekly.value);
  const sessionPercent = Number(session.value);
  const resetHours = Number(hours.value);

  session.disabled = weeklyOnly.checked;
  document.querySelector("#sessionControl").classList.toggle("is-disabled", weeklyOnly.checked);
  document.querySelector("#weeklyOut").value = `${weeklyPercent}%`;
  document.querySelector("#sessionOut").value = weeklyOnly.checked ? "not reported" : `${sessionPercent}%`;
  document.querySelector("#hoursOut").value = `${resetHours}h`;

  const hasWeeklyHeadroom = weeklyPercent >= 25 && weeklyPercent >= 10;
  const hasShortWindowHeadroom = weeklyOnly.checked || sessionPercent >= 25;
  const resetIsNear = resetHours > 0 && resetHours <= 48;
  const elapsedHours = 168 - resetHours;
  const hasPace = elapsedHours >= 24;
  const used = 100 - weeklyPercent;
  const projectedUnused = hasPace ? 100 - (used + used / (elapsedHours * 60) * 1.3 * (resetHours * 60)) : null;
  const fitsPace = hasPace ? projectedUnused >= 15 : resetIsNear;
  const eligible = fresh.checked && allowed.checked && hasWeeklyHeadroom && hasShortWindowHeadroom && resetHours > 0 && fitsPace;

  resultPanel.classList.toggle("is-off", !eligible);
  if (eligible) {
    resultTitle.textContent = "Premium window";
    resultText.textContent = hasPace
      ? `At the assumed stronger-settings burn rate, about ${Math.max(0, Math.round(projectedUnused))}% would remain at reset. That covers the 5% reserve and 10% pace margin.`
      : "Fresh usage windows have room in the final 48 hours. Your configured stronger settings can apply at the next new session.";
    resultPill.textContent = "UPGRADE ELIGIBLE";
  } else {
    resultTitle.textContent = "Use provider default";
    const reason = !fresh.checked
      ? "Usage data is stale."
      : !allowed.checked
        ? "The provider did not confirm included usage."
        : resetHours === 0
          ? "The weekly reset has passed."
          : weeklyPercent < 25
            ? "Weekly headroom is below the 25% threshold."
            : !weeklyOnly.checked && sessionPercent < 25
              ? "Five-hour headroom is below the 25% threshold."
              : hasPace
                ? `Projected unused allowance is about ${Math.max(0, Math.round(projectedUnused))}%, below the 15% reserve and margin.`
                : "There is less than a day of usage history, and the reset is more than 48 hours away.";
    resultText.textContent = `${reason} Surplus leaves your normal settings unchanged.`;
    resultPill.textContent = "NO UPGRADE";
  }

  if (announceChange) {
    announcement.textContent = `${resultTitle.textContent}. ${resultText.textContent}`;
  }
}

for (const control of [weekly, session, weeklyOnly, hours, allowed, fresh].filter(Boolean)) {
  control.addEventListener("input", () => {
    for (const button of presetButtons) button.setAttribute("aria-pressed", "false");
    updatePolicy();
  });
  control.addEventListener("change", () => updatePolicy({ announceChange: true }));
}

for (const button of presetButtons) {
  button.addEventListener("click", () => {
    const preset = presets[button.dataset.preset];
    if (!preset) return;

    weekly.value = preset.weekly;
    session.value = preset.session;
    hours.value = preset.hours;
    weeklyOnly.checked = preset.weeklyOnly;
    allowed.checked = preset.allowed;
    fresh.checked = preset.fresh;
    for (const otherButton of presetButtons) {
      otherButton.setAttribute("aria-pressed", String(otherButton === button));
    }
    updatePolicy({ announceChange: true });
  });
}

const themeToggle = document.querySelector("#themeToggle");
const themeColor = document.querySelector('meta[name="theme-color"]');
const storedTheme = (() => {
  try { return localStorage.getItem("surplus-theme"); } catch { return null; }
})();

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  const dark = theme === "dark" || (!theme && matchMedia("(prefers-color-scheme: dark)").matches);
  themeToggle.setAttribute("aria-label", `Switch to ${dark ? "light" : "dark"} mode`);
  themeColor.content = dark ? "#121b16" : "#f3f0e7";
}

applyTheme(storedTheme === "light" || storedTheme === "dark" ? storedTheme : null);
themeToggle.addEventListener("click", () => {
  const currentTheme = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const nextTheme = currentTheme === "dark" ? "light" : "dark";
  try { localStorage.setItem("surplus-theme", nextTheme); } catch { /* Theme still changes for this page view. */ }
  applyTheme(nextTheme);
});

if (weekly) updatePolicy();

const copyInstall = document.querySelector('#copyInstall');
if (copyInstall) {
  copyInstall.addEventListener('click', async () => {
    const feedback = document.querySelector('#copyFeedback');
    try {
      await navigator.clipboard.writeText(document.querySelector('#installCommand').textContent);
      feedback.textContent = 'Installation commands copied.';
    } catch {
      feedback.textContent = 'Copy unavailable. Select the commands above to copy them.';
    }
  });
}
