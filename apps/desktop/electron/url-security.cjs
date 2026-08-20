'use strict';

function hasTrustedOrigin(candidateURL, serverURL) {
  if (!candidateURL || !serverURL) return false;
  try {
    const candidate = new URL(String(candidateURL));
    const server = new URL(String(serverURL));
    if (!['http:', 'https:'].includes(server.protocol)) return false;
    return candidate.origin === server.origin;
  } catch (_) {
    return false;
  }
}

module.exports = { hasTrustedOrigin };
