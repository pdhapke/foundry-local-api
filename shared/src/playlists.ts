// Phase 17 — Playlists & Audio. Command names and payload shapes for the
// playlist-specific extras layered on top of the Phase 8 generic document
// CRUD (Playlist CRUD itself reuses DOCUMENT_COMMANDS with
// documentType: "Playlist", identical to Scene/Actor/Item/Macro/Combat):
// play/stop/pause of a single embedded PlaylistSound. Shared between the
// server's playlist endpoints (server/src/endpoints/playlists.ts) and the
// module's playlist command handlers (module/src/commands/playlists.ts).

export const PLAYLIST_COMMANDS = {
  PLAY_SOUND: "playlistPlaySound",
  STOP_SOUND: "playlistStopSound",
  PAUSE_SOUND: "playlistPauseSound",
} as const;

export interface PlaylistSoundIdInput {
  id: string;
  soundId: string;
}
