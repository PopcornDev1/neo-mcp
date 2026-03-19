const statusEl = document.getElementById("status");
const dotEl = document.getElementById("dot");
const textEl = document.getElementById("status-text");

// Check connection status
chrome.runtime.sendMessage({ type: "get_status" }, (res) => {
    if (res?.connected) {
        statusEl.className = "status on";
        dotEl.className = "dot on";
        textEl.textContent = "Connected to Neo daemon";
    } else {
        statusEl.className = "status off";
        dotEl.className = "dot off";
        textEl.textContent = "Not connected";
    }
});

// Reconnect button
document.getElementById("btn-reconnect").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "reconnect" }, () => {
        textEl.textContent = "Reconnecting...";
        setTimeout(() => {
            chrome.runtime.sendMessage({ type: "get_status" }, (res) => {
                if (res?.connected) {
                    statusEl.className = "status on";
                    dotEl.className = "dot on";
                    textEl.textContent = "Connected to Neo daemon";
                } else {
                    textEl.textContent = "Still not connected";
                }
            });
        }, 2000);
    });
});

// Extract auth for current site
document.getElementById("btn-extract").addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;

    const hostname = new URL(tab.url).hostname.replace("www.", "");
    const serviceMap = {
        "slack.com": "slack",
        "discord.com": "discord",
        "linkedin.com": "linkedin",
        "x.com": "twitter",
        "twitter.com": "twitter",
        "github.com": "github",
        "notion.so": "notion",
    };

    let service = null;
    for (const [domain, svc] of Object.entries(serviceMap)) {
        if (hostname.endsWith(domain)) { service = svc; break; }
    }

    if (!service) {
        textEl.textContent = `No known service for ${hostname}`;
        return;
    }

    textEl.textContent = `Extracting ${service} auth...`;

    chrome.runtime.sendMessage({ type: "extract_auth", service }, (result) => {
        if (result) {
            // Send to daemon via background
            textEl.textContent = `Extracted ${service} auth!`;
        } else {
            textEl.textContent = `Failed to extract ${service}`;
        }
    });
});

// Show detected services
const servicesEl = document.getElementById("services");
const knownServices = ["slack", "discord", "linkedin", "twitter", "github", "notion", "gmail"];

async function checkServices() {
    let html = "<h3>Services</h3>";
    for (const service of knownServices) {
        // We can't easily check if logged in from popup,
        // just show the list with a generic state
        html += `<div class="service"><span class="name">${service}</span></div>`;
    }
    servicesEl.innerHTML = html;
}

checkServices();
