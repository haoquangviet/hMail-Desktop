/* hMail Desktop — OAuth for Microsoft Graph.
 *
 * Google needs nothing here. Thunderbird's own client already asks a Gmail
 * account for the calendar and address-book scopes alongside mail, and maps
 * apidata.googleusercontent.com / www.googleapis.com to it — so CalDAV,
 * CardDAV and the Calendar REST call that creates a Meet link all ride on
 * the token the mail account already holds. Registering a second Google
 * client only bought an extra consent screen at start-up.
 *
 * Microsoft is the opposite case: Thunderbird's client carries mail scopes
 * only, and Teams meetings need Microsoft Graph. That is what HQV's own
 * Azure app is for, under its own issuer so its refresh token sits beside
 * the mail one without touching it.
 *
 * The placeholder is filled in at build time from secrets/microsoft-oauth.json
 * (the repo is public, so credentials never appear here). Without that file
 * omni_tool.py drops the block and hMail simply has no Teams button.
 */
// MICROSOFT>>
kIssuers.set("hmail-microsoft-graph", {
  name: "hmail-microsoft-graph",
  builtIn: true,
  // Public client: the desktop flow sends no secret, so none is built in.
  clientId: "@MS_CLIENT_ID@",
  authorizationEndpoint:
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  tokenEndpoint:
    "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  redirectionEndpoint:
    "https://login.microsoftonline.com/common/oauth2/nativeclient",
});
kHostnames.set("graph.microsoft.com", [
  "hmail-microsoft-graph",
  "https://graph.microsoft.com/Calendars.ReadWrite " +
    "https://graph.microsoft.com/OnlineMeetings.ReadWrite offline_access",
]);
// <<MICROSOFT
