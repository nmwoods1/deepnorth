/**
 * In-app link routing for the Capacitor Android shell.
 *
 * No-op on the plain web gig guide. When running inside Capacitor:
 *   - Spotify track/artist links → native Spotify app (falls back to Custom Tab).
 *   - All other outbound https links → Chrome Custom Tab via @capacitor/browser.
 *
 * Exposes window.DNNativeLinks.open(url) for callers that can't use an anchor
 * (e.g. the Google-search window.open in the gig guide's lineup chips).
 */
(function () {
  "use strict";

  if (!window.Capacitor?.isNativePlatform?.()) return;

  // The gig guide bundles no Capacitor runtime, so window.Capacitor.Plugins is
  // undefined inside the native app. Call plugins through the injected native
  // bridge's low-level transport instead.
  const nativeCall = (plugin, method, options) =>
    window.Capacitor.nativePromise(plugin, method, options || {});

  // Returns a spotify: URI for track/artist URLs, null for all other paths
  // (playlists, albums, episodes — those fall through to a Custom Tab).
  function toSpotifyUri(url) {
    const m = url.match(
      /^https?:\/\/open\.spotify\.com\/(track|artist)\/([A-Za-z0-9]+)/,
    );
    if (!m) return null;
    return `spotify:${m[1]}:${m[2]}`;
  }

  async function openUrl(url) {
    const spotifyUri = toSpotifyUri(url);
    if (spotifyUri) {
      try {
        const { value: canOpen } = await nativeCall("AppLauncher", "canOpenUrl", { url: "spotify:" });
        if (canOpen) {
          await nativeCall("AppLauncher", "openUrl", { url: spotifyUri });
          return;
        }
      } catch (_) {
        // AppLauncher unavailable or Spotify scheme query failed — fall through.
      }
    }
    nativeCall("Browser", "open", { url });
  }

  window.DNNativeLinks = { open: openUrl };

  // Intercept all target="_blank" anchor clicks with an http(s) href and
  // route them through openUrl instead of escaping to the external browser.
  document.addEventListener(
    "click",
    (e) => {
      const a = e.target.closest('a[target="_blank"]');
      if (!a || !a.href || !/^https?:/.test(a.href)) return;
      e.preventDefault();
      openUrl(a.href);
    },
    true,
  );
})();
