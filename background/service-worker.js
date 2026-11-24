
// VTOP Organizer - Background Service Worker

chrome.runtime.onInstalled.addListener(() => {
    console.log("VTOP Organizer installed successfully.");
});

// Open the side panel when the extension icon is clicked.
chrome.sidePanel.setPanelBehavior({
    openPanelOnActionClick: true
}).catch((error) => {
    console.error("Side panel initialization failed:", error);
});
