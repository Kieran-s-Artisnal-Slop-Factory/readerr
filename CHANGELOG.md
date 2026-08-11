# Unreleased

- Fixed a data-loss bug: a device opened after days away would auto-close its stale copy of the reading week before its first sync, overwriting the real history (done marks and read/slushed outcomes recorded on another device) on the server and every device. The reading list now syncs first and only closes a stale week after a successful sync; if the sync server can't be reached, the week stays open with a notice and closes automatically after the next successful sync. The manual "Close week" button gets the same protection (it adopts a close made elsewhere instead of overwriting it, and warns when the server can't confirm). Devices that have never synced to a server — and offline mode — keep closing locally as before.
- Background syncs no longer race each other: simultaneous sync triggers share one run, edits made during a long sync still push promptly afterwards, and switching sync servers in Settings/Onboarding always syncs against the newly configured server rather than a run that was already in flight.

# 0.1.0 July 22nd 2026

- initial release