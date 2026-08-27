# Privacy and security

Telegram Media Downloader processes media locally in the user's browser. It has no analytics SDK, remote application server, account system, telemetry, advertising, or data sale. Media bytes are written directly to the directory explicitly selected by the user.

The extension does not read browser cookies, passwords, Telegram session storage, contact lists, or message text. It temporarily keeps only the media descriptors and queue state needed for the current Telegram Web tab. The selected directory handle is stored locally in the extension's IndexedDB so Chrome can restore the destination subject to browser permission rules.

## Security boundary

The media discovery and Telegram-native download integration run in Telegram Web's MAIN JavaScript world because the required media objects are page-owned. A script already executing in the Telegram page could therefore imitate a download request. Such a request remains limited to the user-authorized directory, and file names are sanitized to block path traversal; the extension never grants page scripts arbitrary filesystem access. This is a deliberate compatibility boundary, not a claim that a compromised Telegram page is trusted.

The extension does not bypass Telegram authentication, access controls, encryption, paywalls, or self-destruct behavior. Users are responsible for downloading only content they own, are authorized to save, or may lawfully retain.
