// Phase 17 — Playlists & Audio. Command names and payload shapes for the
// playlist-specific extras layered on top of the Phase 8 generic document
// CRUD (Playlist CRUD itself reuses DOCUMENT_COMMANDS with
// documentType: "Playlist", identical to Scene/Actor/Item/Macro/Combat):
// play/stop/pause of a single embedded PlaylistSound. Shared between the
// server's playlist endpoints (server/src/endpoints/playlists.ts) and the
// module's playlist command handlers (module/src/commands/playlists.ts).
//
// Phase 48 added playAll/stopAll — simultaneous playback of every sound in a
// playlist at once (`Playlist#playAll()`/`Playlist#stopAll()`), distinct from
// the single-sound play/stop above. From the backlog: "Playlist playAll/
// stopAll and global audio volume" — the volume half was deliberately left
// out, since it's just client settings (`core.globalPlaylistVolume` etc.)
// already reachable through Phase 7's generic settings endpoint, not a
// Playlist document method; see PLAN.md's Phase 48 write-up.

export const PLAYLIST_COMMANDS = {
  PLAY_SOUND: "playlistPlaySound",
  STOP_SOUND: "playlistStopSound",
  PAUSE_SOUND: "playlistPauseSound",
  PLAY_ALL: "playlistPlayAll",
  STOP_ALL: "playlistStopAll",
} as const;

export interface PlaylistSoundIdInput {
  id: string;
  soundId: string;
}

export interface PlaylistIdInput {
  id: string;
}
