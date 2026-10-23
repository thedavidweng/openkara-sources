# OpenKara NetEase source

Streaming Source plugin (protocol 1.0) that lets OpenKara search, browse the liked tracks and
playlists of, preview and import music from NetEase Cloud Music accounts. It runs as a Node 24
worker speaking line-delimited JSON over stdio and drives
`@neteasecloudmusicapienhanced/api`.

- Sign-in is a web flow; credentials are the `MUSIC_U` and `__csrf` cookies.
- Media resolves only for tracks the signed-in account may play; trial clips, missing rights and
  missing media are returned as typed refusals.
- Requests that NetEase needs a mainland-China address for use one China Client Address per process.

License: AGPL-3.0-only (see `LICENSE`, `NOTICE`).
