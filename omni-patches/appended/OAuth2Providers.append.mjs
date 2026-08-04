/* hMail Desktop — OAuth for calendar and meetings.
 *
 * Mail sign-in stays on Thunderbird's stock clients: Google and Microsoft
 * have long since approved them for the mail scopes, so Gmail and Outlook
 * accounts just work. HQV Software's own registrations serve only the
 * calendar-side features — Google Calendar/Contacts sync plus Meet links,
 * and Teams meetings through Microsoft Graph — each under its own issuer
 * so the refresh tokens live next to the mail ones without touching them.
 *
 * The placeholders are filled in at build time from files under secrets/
 * (the repo is public, so credentials never appear here). A provider whose
 * secrets file is missing simply loses its extra feature: omni_tool.py
 * drops that block, marked by the GOOGLE>>/MICROSOFT>> comment fences.
 */
// GOOGLE>>
kIssuers.set("hmail-google-dav", {
  name: "hmail-google-dav",
  builtIn: true,
  clientId: "@GOOGLE_CLIENT_ID@",
  clientSecret: "@GOOGLE_CLIENT_SECRET@",
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
});
kHostnames.set("apidata.googleusercontent.com", [
  "hmail-google-dav",
  GOOGLE_SCOPES.caldav,
]);
kHostnames.set("www.googleapis.com", [
  "hmail-google-dav",
  GOOGLE_SCOPES.carddav,
]);
// <<GOOGLE
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
