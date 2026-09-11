const DRIVE_LETTER = /^[A-Za-z]:/;

const encodeSegments = (value) => value.split("/").map(encodeURIComponent).join("/");

/**
 * A `file://` URL the renderer can hand straight to an `<audio>` element.
 *
 * Built in main, and written out rather than delegated to `url.pathToFileURL`, because that
 * resolves against the platform it runs on: a Windows path handed to it on any other platform
 * comes back resolved against the current directory. Doing it here keeps the Windows shape
 * testable everywhere.
 *
 * The naive `"file://" + encodeURI(path)` is wrong on Windows twice over — it percent-escapes
 * the backslashes, and `file://C:` parses the drive letter as a host — so the URL never
 * resolves and the control that uses it can only ever error.
 *
 * @param {string | null | undefined} filePath
 * @param {NodeJS.Platform} [platform]
 * @returns {string | null}
 */
function toPlayableAudioUrl(filePath, platform = process.platform) {
  if (typeof filePath !== "string" || filePath.length === 0) return null;

  if (platform !== "win32") {
    return `file://${encodeSegments(filePath)}`;
  }

  const slashed = filePath.replace(/\\/g, "/");

  if (slashed.startsWith("//")) {
    const [, , host, ...rest] = slashed.split("/");
    if (!host) return null;
    return `file://${encodeURIComponent(host)}/${encodeSegments(rest.join("/"))}`;
  }

  if (DRIVE_LETTER.test(slashed)) {
    return `file:///${slashed.slice(0, 2)}${encodeSegments(slashed.slice(2))}`;
  }

  return `file:///${encodeSegments(slashed.replace(/^\/+/, ""))}`;
}

module.exports = { toPlayableAudioUrl };
