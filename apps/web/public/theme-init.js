// Applies the saved theme before the app loads, so dark mode doesn't flash white. Kept in its own file
// because the Content Security Policy allows no inline script. Must match src/context/theme-provider.tsx.
(() => {
    let theme = "system";
    try {
        theme = localStorage.getItem("triagent-theme") || "system";
    } catch {
        // storage blocked: follow the system
    }
    const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.add(dark ? "dark" : "light");
})();
