
const statusTitle = document.getElementById("status-title");
const statusDescription = document.getElementById("status-description");

const refreshButton = document.getElementById("refresh-button");

async function checkCurrentWebsite() {

    statusTitle.textContent = "Checking...";
    statusDescription.textContent = "Reading current browser tab.";

    const tabs = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true
    });

    const currentTab = tabs[0];

    if (!currentTab || !currentTab.url) {
        statusTitle.textContent = "No active tab";
        statusDescription.textContent = "Unable to identify the current tab.";
        return;
    }

    const currentUrl = new URL(currentTab.url);

    if (currentUrl.hostname === "vtop.vit.ac.in") {

        statusTitle.textContent = "VTOP detected";
        statusDescription.textContent = "Ready for course integration.";

    } else {

        statusTitle.textContent = "VTOP not detected";
        statusDescription.textContent = "Open VTOP to use the organizer.";

    }
}

refreshButton.addEventListener("click", checkCurrentWebsite);

checkCurrentWebsite();
